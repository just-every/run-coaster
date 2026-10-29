import { authority, commit, type Sql } from '../session';
import { rowAuthority } from '../permissions';
import { loadClaim, visible, type Claim } from '../claims';
import { event } from '../events';
import { now, requireThat, text, uid, type Actor, type Data } from '../types';

export const correctionSequence = (claim: string): Sql => ({ sql: 'SELECT COALESCE(MAX(sequence),0) FROM c_account_corrections WHERE claim_id=?', params: [claim] });
export const correctionsFor = async (db: D1Database, claim: string) => (await db.prepare('SELECT * FROM c_account_corrections WHERE claim_id=? ORDER BY sequence').bind(claim).all<Data>()).results;

/** Any existing posting, including an unsuccessful or uncertain attempt, needs ledger reconciliation. */
function noPosting(id: string): Sql {
  return { sql: `NOT EXISTS(SELECT 1 FROM c_qbd_requests q WHERE json_extract(q.payload,'$.claim')=?
    OR json_extract(q.payload,'$.batch') IN (SELECT batch_id FROM c_batch_coding WHERE claim_id=? UNION SELECT batch_id FROM c_batch_claims WHERE claim_id=?))`, params: [id, id, id] };
}

/** Full delegates retain the granting person's row; native agent keys never gain this verb. */
function codingAuthority(actor: Actor, claim: Claim): Sql {
  const global = rowAuthority(actor, 'coding'), reviewer = authority(actor, 'manager');
  return { sql: `((${global.sql}) OR ((${reviewer.sql}) AND EXISTS(SELECT 1 FROM c_claims c WHERE c.id=? AND c.status='submitted'
    AND c.employee_email<>? AND c.employee_email<>? AND (EXISTS(SELECT 1 FROM c_workflow_tasks t WHERE t.kind='claim' AND t.record_id=c.id AND t.revision=c.revision AND t.status='waiting' AND t.email=?)
      OR (NOT EXISTS(SELECT 1 FROM c_workflow_tasks t WHERE t.kind='claim' AND t.record_id=c.id AND t.revision=c.revision) AND c.approver_email=?))
    AND NOT EXISTS(SELECT 1 FROM c_decisions d WHERE d.claim_id=c.id AND d.revision=c.revision AND (d.actor_email IN (?,?) OR d.on_behalf_of=?)))))`,
    params: [...global.params, ...reviewer.params, claim.id, actor.email, actor.delegate?.email ?? actor.email, actor.email, actor.email, actor.email, actor.delegate?.email ?? actor.email, actor.email] };
}

export async function accountCoding(db: D1Database, actor: Actor, claim: Claim) {
  const corrections = await correctionsFor(db, claim.id), auth = codingAuthority(actor, claim), posting = noPosting(claim.id);
  const allowed = actor.kind === 'person' && !!await db.prepare(`SELECT 1 WHERE (${auth.sql}) AND (${posting.sql})`).bind(...auth.params, ...posting.params).first();
  return { corrections, sequence: corrections.at(-1)?.sequence ?? 0, mayCorrect: allowed && ['submitted','approved'].includes(claim.status) && !claim.batch_id };
}

/** The caller names the exact submitted allocation and correction sequence they reviewed. */
export async function correctAccount(db: D1Database, actor: Actor, id: string, b: Data) {
  requireThat(actor.kind === 'person' && !actor.publicCredential, 'Use a native person session to correct account coding', 403);
  const claim = await loadClaim(db, id), auth = codingAuthority(actor, claim);
  requireThat(await db.prepare(`SELECT 1 WHERE ${auth.sql}`).bind(...auth.params).first(), 'Your role or current review assignment does not allow account correction', 403);
  visible(actor, claim);
  requireThat(['submitted','approved'].includes(claim.status) && !claim.batch_id, 'Only unbatched submitted or approved purchases can be corrected', 409);
  requireThat(b.version === claim.version && b.revision === claim.revision, 'This claim changed; reload the submitted revision', 409);
  const sequence = correctionSequence(id);
  const rows = await correctionsFor(db, id), expected = rows.at(-1)?.sequence ?? 0;
  requireThat(b.sequence === expected, 'Account coding changed; reload before correcting it', 409);
  const revision = await db.prepare('SELECT snapshot FROM c_revisions WHERE claim_id=? AND revision=?').bind(id, claim.revision).first<{snapshot:string}>();
  requireThat(revision, 'Submitted revision not found', 409);
  const snapshot = JSON.parse(revision.snapshot), item = snapshot.items.find((i: Data) => i.id === b.item), part = item?.allocations.find((p: Data) => p.position === b.allocation);
  requireThat(item && item.kind === 'receipt' && !item.card_charge_id && !item.allowance_id && part, 'Choose a submitted manual purchase allocation', 409);
  requireThat(Number.isInteger(b.allocation) && b.allocation >= 0, 'Choose an allocation');
  const before = rows.filter(r => r.revision === claim.revision && r.item_id === item.id && r.allocation_position === part.position).at(-1)?.after_account ?? part.account_code;
  const after = text(b.accountCode, 'Account code', 100), reason = text(b.reason, 'Correction reason', 1000);
  requireThat(after !== before, 'Choose a different account code', 409);
  const posting = noPosting(id);
  requireThat(await db.prepare(`SELECT 1 WHERE ${posting.sql}`).bind(...posting.params).first(), 'Ledger posting already exists; reconcile it before correcting coding', 409);
  const state = (version: number, seq: number): Sql => ({ sql: `EXISTS(SELECT 1 FROM c_claims WHERE id=? AND version=? AND revision=? AND status IN ('submitted','approved') AND batch_id IS NULL)
    AND NOT EXISTS(SELECT 1 FROM c_batch_claims WHERE claim_id=?) AND (${sequence.sql})=?
    AND EXISTS(SELECT 1 FROM c_revisions WHERE claim_id=? AND revision=? AND snapshot=?) AND (${posting.sql})`,
    params: [id, version, claim.revision, id, ...sequence.params, seq, id, claim.revision, revision.snapshot, ...posting.params] });
  const condition = (version: number, seq: number): Sql => { const s = state(version, seq); return { sql: `(${auth.sql}) AND (${s.sql})`, params: [...auth.params, ...s.params] }; };
  const at = now(), correction = uid(), detail = { correction, revision: claim.revision, item: item.id, allocation: part.position, sequence: expected + 1, before, after, reason };
  const first = condition(claim.version, expected);
  await commit(db, { ...first, after: condition(claim.version + 1, expected + 1) }, [
    db.prepare('INSERT INTO c_account_corrections(id,claim_id,revision,item_id,allocation_position,sequence,before_account,after_account,reason,actor_email,acting_for,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(correction,id,claim.revision,item.id,part.position,expected+1,before,after,reason,actor.delegate?.email ?? actor.email,actor.delegate ? actor.email : null,at),
    db.prepare('UPDATE c_claims SET version=version+1,updated_at=? WHERE id=?').bind(at,id),
    event(db, actor, 'account-code-corrected', { claim: id }, detail),
  ]);
  return loadClaim(db, id);
}

/** Select only corrections frozen by this particular batch and revision. */
export async function batchCorrections(db: D1Database, batch: string, claim: string, revision: number) {
  return (await db.prepare(`SELECT c.* FROM c_account_corrections c JOIN c_batch_coding f ON f.claim_id=c.claim_id AND f.revision=c.revision AND c.sequence<=f.correction_sequence WHERE f.batch_id=? AND c.claim_id=? AND c.revision=? ORDER BY c.sequence`).bind(batch,claim,revision).all<Data>()).results;
}
