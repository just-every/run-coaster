import { authority, commit } from './session';
import { event } from './events';
import { business } from './settings';
import { claimNumber } from './claims';
import { batchNumber, csv } from './batches';
import { zip } from './zip';
import { claimReceiptBytes } from './receipts/claim-storage';
import { isoDate, optionalText, requireThat, type Actor, type Data } from './types';

/** The owner, finance and auditors read the full history and export audit packs (ADMIN-001 matrix). */
function needAuditAccess(actor: Actor) {
  requireThat(actor.kind === 'person' && (actor.roles.owner || actor.roles.finance || actor.roles.auditor), 'Owner, finance or auditor access required', 403);
}

/** The UTC instant a calendar day starts in the business's time zone. */
export function startOf(day: string, timezone: string) {
  const guess = Date.parse(day + 'T00:00:00Z');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  const local = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
  return new Date(guess - (local - guess)).toISOString();
}
export const nextDay = (day: string) => new Date(Date.parse(day + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);

/** Which door a line came through (AUDIT-001): an agent key acting for a person, the owner's import door (the kit's
 * `role:owner` principal or an import run), the owner's approval rule ("rule vN"), the hourly run (written under its
 * name: schedule, allowance, budget, reminder, escalation, retention, report schedule), or a person in the app. */
export function channel(actor: string, action: string, detail: Data) {
  if (detail.agent && !action.startsWith('proposal-')) return 'agent';
  if (actor.startsWith('role:') || action.startsWith('import-')) return 'import';
  if (actor.startsWith('rule v')) return 'rule';
  return actor.includes('@') || actor.startsWith('former-member-') || detail.confirmedBy ? 'app' : 'schedule';
}

const LINE = `SELECT e.seq,e.at,e.actor_email,e.action,e.detail,e.claim_id,c.number AS claim_number,e.batch_id,b.number AS batch_number
  FROM c_events e LEFT JOIN c_claims c ON c.id=e.claim_id LEFT JOIN c_batches b ON b.id=e.batch_id`;
const line = (row: Data) => {
  const detail = JSON.parse(row.detail);
  return { seq: row.seq, at: row.at, actor_email: row.actor_email, action: row.action, detail, channel: channel(row.actor_email, row.action, detail), agent: detail.agent ?? null,
    claim: row.claim_id ? { id: row.claim_id, number: row.claim_number } : null, batch: row.batch_id ? { id: row.batch_id, number: row.batch_number } : null };
};

/** Search every history line: a claim number (with its batches' review, export and payment lines), a batch number, a person's email or any words, within business-time dates. */
export async function searchHistory(db: D1Database, actor: Actor, query: Record<string, string | undefined>) {
  needAuditAccess(actor);
  const timezone = (await business(db))?.timezone ?? 'UTC', where: string[] = [], params: unknown[] = [];
  const q = optionalText(query.q, 'Search', 200), claim = q.match(/^CL-(\d{1,9})$/i), batch = q.match(/^RB-(\d{1,9})$/i);
  if (claim) {
    const found = await db.prepare('SELECT id FROM c_claims WHERE number=?').bind(Number(claim[1])).first<{ id: string }>();
    requireThat(found, `No claim ${q.toUpperCase()}`, 404);
    where.push('(e.claim_id=? OR (e.claim_id IS NULL AND e.batch_id IN (SELECT batch_id FROM c_batch_claims WHERE claim_id=?)))'); params.push(found.id, found.id);
  } else if (batch) {
    const found = await db.prepare('SELECT id FROM c_batches WHERE number=?').bind(Number(batch[1])).first<{ id: string }>();
    requireThat(found, `No batch ${q.toUpperCase()}`, 404);
    where.push('e.batch_id=?'); params.push(found.id);
  } else if (q) {
    const needle = q.toLowerCase();
    where.push('(instr(lower(e.action),?)>0 OR instr(lower(e.actor_email),?)>0 OR instr(lower(e.detail),?)>0)'); params.push(needle, needle, needle);
  }
  if (query.from) { where.push('e.at>=?'); params.push(startOf(isoDate(query.from, 'From'), timezone)); }
  if (query.to) { where.push('e.at<?'); params.push(startOf(nextDay(isoDate(query.to, 'Until')), timezone)); }
  const rows = await db.prepare(`${LINE}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY e.seq DESC LIMIT 501`).bind(...params).all<Data>();
  return { lines: rows.results.slice(0, 500).reverse().map(line), more: rows.results.length > 500 };
}

const PACK_LIMIT = 60_000_000;
const safe = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, '_');

/** One ZIP for a period: every claim submitted in it with each revision's expenses, exceptions and explanations, the
 * decisions, payment references and every receipt's exact bytes beside its SHA-256, plus the period's history. */
export async function auditPack(db: D1Database, actor: Actor, from?: string, to?: string, bucket?: R2Bucket) {
  needAuditAccess(actor);
  const settings = await business(db);
  requireThat(settings, 'The owner has not set up the business yet', 409);
  const first = isoDate(from, 'From'), last = isoDate(to, 'Until');
  requireThat(last >= first, 'The period must end on or after it starts');
  requireThat(Date.parse(last) - Date.parse(first) <= 366 * 86_400_000, 'An audit pack covers at most one year');
  const start = startOf(first, settings.timezone), end = startOf(nextDay(last), settings.timezone);
  const inPeriod = 'SELECT DISTINCT claim_id FROM c_revisions WHERE submitted_at>=? AND submitted_at<?';
  const visibleReceipt = `(r.capture_receipt_id IS NULL OR EXISTS(SELECT 1 FROM c_revisions v,json_each(v.snapshot,'$.items') i WHERE v.claim_id=r.claim_id AND COALESCE(json_extract(i.value,'$.receipt.id'),json_extract(i.value,'$.receipt_id'))=r.id))`;
  const size = await db.prepare(`SELECT COALESCE(SUM(r.size),0) AS n FROM c_receipts r WHERE r.claim_id IN (${inPeriod}) AND ${visibleReceipt}`).bind(start, end).first<{ n: number }>();
  requireThat((size?.n ?? 0) <= PACK_LIMIT, 'The receipts in this period are too large for one pack; choose a shorter period', 413);
  const [claims, revisions, decisions, receipts, events] = await db.batch([
    db.prepare(`SELECT c.*, m.name AS employee_name, b.number AS batch_number, b.status AS batch_status, b.reviewed_by, b.reviewed_at, b.paid_reference, b.paid_on, b.paid_by FROM c_claims c LEFT JOIN c_members m ON m.email=c.employee_email LEFT JOIN c_batches b ON b.id=c.batch_id WHERE c.id IN (${inPeriod}) ORDER BY c.number`).bind(start, end),
    db.prepare(`SELECT * FROM c_revisions WHERE claim_id IN (${inPeriod}) ORDER BY claim_id, revision`).bind(start, end),
    db.prepare(`SELECT * FROM c_decisions WHERE claim_id IN (${inPeriod}) ORDER BY claim_id, revision`).bind(start, end),
    db.prepare(`SELECT r.* FROM c_receipts r WHERE r.claim_id IN (${inPeriod}) AND ${visibleReceipt} ORDER BY r.uploaded_at, r.id`).bind(start, end),
    db.prepare(`${LINE} WHERE e.at>=? AND e.at<? ORDER BY e.seq`).bind(start, end),
  ]);
  const numbers = new Map((claims.results as Data[]).map(c => [c.id, claimNumber(c.number)]));
  const files = await Promise.all((receipts.results as Data[]).map(async r => ({ receipt: r, name: `receipts/${numbers.get(r.claim_id)}/${r.sha256}-${safe(String(r.name))}`, bytes: await claimReceiptBytes(db, r, bucket) })));
  const fileOf = (sha: string | undefined) => files.find(f => f.receipt.sha256 === sha)?.name ?? null;
  const manifest = {
    business: settings.name, currency: settings.currency, timezone: settings.timezone, period: { from: first, to: last }, generatedAt: new Date().toISOString(), generatedBy: actor.email,
    claims: (claims.results as Data[]).map(c => ({
      number: claimNumber(c.number), id: c.id, employee: c.employee_email, employeeName: c.employee_name ?? c.employee_email, title: c.title, status: c.status, currency: c.currency, totalMinor: c.total_minor,
      revisions: (revisions.results as Data[]).filter(r => r.claim_id === c.id).map(r => {
        const s = JSON.parse(r.snapshot);
        return { revision: r.revision, submittedBy: r.submitted_by, submittedAt: r.submitted_at, totalMinor: r.total_minor, approver: s.approver, onBehalfOf: s.onBehalfOf ?? null, exceptions: s.exceptions,
          items: s.items.map((i: Data) => ({ id: i.id, date: i.spent_on, kind: i.kind, merchant: i.merchant, description: i.description, amountMinor: i.amount_minor, salesTaxMinor: i.sales_tax_minor ?? 0, explanation: i.explanation,
            allocations: i.allocations.map((a: Data) => ({ category: a.category_name, account: a.account_code, tax: a.tax_code, costCenter: a.cost_centre, amountMinor: a.amount_minor })),
            cardMatchBasis: i.card_match_basis ? JSON.parse(i.card_match_basis) : null,
            receipt: i.receipt ? { sha256: i.receipt.sha256, file: fileOf(i.receipt.sha256) } : null })) };
      }),
      decisions: (decisions.results as Data[]).filter(d => d.claim_id === c.id).map(d => ({ revision: d.revision, decision: d.decision, reason: d.reason, by: d.actor_email, onBehalfOf: d.on_behalf_of, at: d.at, exceptionsAcknowledged: JSON.parse(d.exceptions) })),
      payment: c.batch_number ? { batch: batchNumber(c.batch_number), status: c.batch_status, reviewedBy: c.reviewed_by, reviewedAt: c.reviewed_at, reference: c.paid_reference, paidOn: c.paid_on, paidBy: c.paid_by } : null,
    })),
    receipts: files.map(({ receipt: r, name }) => ({ id: r.id, claim: numbers.get(r.claim_id), name: r.name, mediaType: r.media_type, size: r.size, sha256: r.sha256, uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at, file: name })),
    history: { file: 'history.csv', lines: events.results.length },
  };
  const history = csv([['seq', 'at', 'actor', 'channel', 'agent', 'action', 'claim', 'batch', 'detail'], ...(events.results as Data[]).map(line).map(l => [l.seq, l.at, l.actor_email, l.channel, l.agent ?? '', l.action, l.claim?.number ? claimNumber(l.claim.number) : '', l.batch?.number ? batchNumber(l.batch.number) : '', JSON.stringify(l.detail)])]);
  const text = (s: string) => new TextEncoder().encode(s);
  const archive = zip([{ name: 'manifest.json', bytes: text(JSON.stringify(manifest, null, 2)) }, { name: 'history.csv', bytes: text(history) }, ...files], new Date(manifest.generatedAt));
  await commit(db, authority(actor, actor.roles.finance ? 'finance' : 'auditor'), [event(db, actor, 'audit-pack-exported', {}, { from: first, to: last, claims: manifest.claims.length, receipts: files.length, historyLines: events.results.length })]);
  return new Response(archive, { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="coaster-audit-pack-${first}-to-${last}.zip"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
