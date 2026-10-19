import { all, authority, commit, need } from './session';
import { event } from './events';
import { claimNumber, loadClaim } from './claims';
import { requireBusiness } from './settings';
import { now, optionalText, requireThat, text, uid, type Actor, type Data } from './types';

/** How much each exception weighs in the queue's risk order: duplicates first, then rule breaks, then missing evidence. */
export const RISK: Record<string, number> = { 'duplicate-receipt': 5, 'possible-duplicate': 4, 'needs-pre-approval': 3, 'over-limit': 3, 'over-per-person': 2, 'over-budget': 2, 'over-allowance': 2, 'missing-receipt': 2 };
const DAY = 86_400_000;

/** The approval just written is sampled when it crosses the next whole multiple of the percentage: the n-th approval
 * ever is sampled when floor(n × p / 100) > floor((n − 1) × p / 100), so exactly p in every 100 approvals are. Runs in the
 * approval's own write batch, after its decision row. */
export const auditSample = (db: D1Database, claimId: string, revision: number) => db.prepare(
  "INSERT INTO c_audit_samples(claim_id,revision,ordinal,percent,sampled_at) SELECT ?,?,a.n,b.audit_sample_percent,? FROM (SELECT COUNT(*) AS n FROM c_decisions WHERE decision='approved') a JOIN c_business b ON b.id=1 WHERE b.audit_sample_percent IS NOT NULL AND (a.n * b.audit_sample_percent) / 100 > ((a.n - 1) * b.audit_sample_percent) / 100",
).bind(claimId, revision, now());

const reader = (actor: Actor) => requireThat(actor.roles.finance || actor.roles.auditor, 'Finance or auditor access required', 403);

/** Every open exception on the current submitted revision of every claim that is not a draft, returned or rejected,
 * that finance has not reviewed yet; ordered by risk then age, or by age then risk. Plus the audit samples. */
export async function exceptionQueue(db: D1Database, actor: Actor, sort = 'risk') {
  reader(actor);
  const [claims, reviews, samples] = await db.batch([
    db.prepare("SELECT c.id,c.number,c.employee_email,c.title,c.status,c.revision,c.total_minor,c.currency,r.submitted_at,r.snapshot FROM c_claims c JOIN c_revisions r ON r.claim_id=c.id AND r.revision=c.revision WHERE c.status IN ('submitted','approved','batched','reimbursed')"),
    db.prepare('SELECT claim_id,revision,item_id,code FROM c_exception_reviews'),
    db.prepare('SELECT s.*, c.number, c.employee_email, c.title, c.total_minor, c.currency FROM c_audit_samples s JOIN c_claims c ON c.id=s.claim_id ORDER BY s.sampled_at DESC'),
  ]);
  const done = new Set((reviews.results as Data[]).map(r => `${r.claim_id}|${r.revision}|${r.item_id}|${r.code}`)), at = Date.now();
  const open: Data[] = [];
  for (const c of claims.results as Data[]) {
    const snapshot = JSON.parse(c.snapshot);
    for (const e of snapshot.exceptions as Data[]) {
      if (done.has(`${c.id}|${c.revision}|${e.item}|${e.code}`)) continue;
      const item = (snapshot.items as Data[]).find(i => i.id === e.item);
      open.push({ claim: c.id, number: claimNumber(c.number), employee: c.employee_email, title: c.title, status: c.status, revision: c.revision, submittedAt: c.submitted_at, ageDays: Math.floor((at - Date.parse(c.submitted_at)) / DAY), item: e.item, merchant: item?.merchant ?? '', amountMinor: item?.amount_minor ?? 0, currency: c.currency, code: e.code, message: e.message, explanation: item?.explanation ?? '', risk: RISK[e.code] ?? 1 });
    }
  }
  const byAge = (a: Data, b: Data) => a.submittedAt.localeCompare(b.submittedAt), byRisk = (a: Data, b: Data) => b.risk - a.risk;
  open.sort(sort === 'age' ? (a, b) => byAge(a, b) || byRisk(a, b) || a.number.localeCompare(b.number) : (a, b) => byRisk(a, b) || byAge(a, b) || a.number.localeCompare(b.number));
  const settings = await requireBusiness(db);
  return { sort: sort === 'age' ? 'age' : 'risk', open, samplePercent: settings.audit_sample_percent, samples: (samples.results as Data[]).map(s => ({ ...s, number: claimNumber(s.number) })) };
}

/** Finance reviews one open exception with a note; it leaves the queue and the review is a history line. */
export async function reviewException(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'finance');
  requireThat(actor.kind === 'person', 'Only a person reviews an exception', 403);
  const claim = await loadClaim(db, b.claim);
  requireThat(Number.isInteger(b.revision) && b.revision === claim.revision, 'That revision is no longer current; reload the queue', 409);
  const revision = await db.prepare('SELECT snapshot FROM c_revisions WHERE claim_id=? AND revision=?').bind(claim.id, claim.revision).first<{ snapshot: string }>();
  requireThat(revision && (JSON.parse(revision.snapshot).exceptions as Data[]).some(e => e.item === b.item && e.code === b.code), 'Exception not found on that revision', 404);
  const note = text(b.note, 'Review note', 1000);
  requireThat(!(await db.prepare('SELECT 1 FROM c_exception_reviews WHERE claim_id=? AND revision=? AND item_id=? AND code=?').bind(claim.id, claim.revision, b.item, b.code).first()), 'Someone already reviewed that exception', 409);
  await commit(db, authority(actor, 'finance'), [
    db.prepare('INSERT INTO c_exception_reviews(id,claim_id,revision,item_id,code,note,reviewed_by,reviewed_at) VALUES(?,?,?,?,?,?,?,?)').bind(uid(), claim.id, claim.revision, b.item, b.code, note, actor.delegate?.email ?? actor.email, now()),
    event(db, actor, 'exception-reviewed', { claim: claim.id }, { revision: claim.revision, item: b.item, code: b.code, note }),
  ]);
  return exceptionQueue(db, actor);
}

/** Finance sets the share of approvals sampled for post-approval audit (1 to 100 percent); empty turns sampling off. */
export async function saveAuditSample(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'finance');
  requireThat(actor.kind === 'person', 'Only a person changes audit sampling', 403);
  await requireBusiness(db);
  const raw = b.percent === null || b.percent === undefined ? '' : String(b.percent).trim();
  const percent = raw === '' ? null : Number(raw);
  requireThat(percent === null || (Number.isInteger(percent) && percent >= 1 && percent <= 100), 'Audit sample must be a whole percentage from 1 to 100, or empty for none');
  await commit(db, authority(actor, 'finance'), [
    db.prepare('UPDATE c_business SET audit_sample_percent=?,updated_at=? WHERE id=1').bind(percent, now()),
    event(db, actor, 'audit-sample-set', {}, { percent }),
  ]);
  return { percent };
}

/** Finance records the one finding on a sampled approval; nobody records a finding on their own claim. */
export async function recordFinding(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'finance');
  requireThat(actor.kind === 'person', 'Only a person records a finding', 403);
  const claim = await loadClaim(db, b.claim);
  const sample = await db.prepare('SELECT outcome FROM c_audit_samples WHERE claim_id=? AND revision=?').bind(claim.id, b.revision).first<{ outcome: string | null }>();
  requireThat(sample, 'That approval was not sampled', 404);
  requireThat(claim.employee_email !== actor.email && claim.employee_email !== actor.delegate?.email, 'Someone else in finance must audit your own claim', 403);
  requireThat(sample.outcome === null, 'This sample already has its finding', 409);
  requireThat(b.outcome === 'clean' || b.outcome === 'issue', 'Choose clean or issue found');
  const finding = b.outcome === 'issue' ? text(b.finding, 'Finding', 2000) : optionalText(b.finding, 'Finding', 2000);
  await commit(db, all(authority(actor, 'finance'), { sql: 'EXISTS(SELECT 1 FROM c_audit_samples WHERE claim_id=? AND revision=? AND outcome IS NULL)', params: [claim.id, b.revision] }), [
    db.prepare('UPDATE c_audit_samples SET outcome=?,finding=?,finding_by=?,finding_at=? WHERE claim_id=? AND revision=?').bind(b.outcome, finding, actor.delegate?.email ?? actor.email, now(), claim.id, b.revision),
    event(db, actor, 'audit-finding-recorded', { claim: claim.id }, { revision: b.revision, outcome: b.outcome, finding }),
  ]);
  return exceptionQueue(db, actor);
}
