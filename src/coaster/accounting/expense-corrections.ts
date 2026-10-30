import { authority, commit, type Sql } from '../session';
import { can, rowAuthority } from '../permissions';
import { loadClaim, type Claim } from '../claims';
import { event } from '../events';
import { now, requireThat, text, uid, type Actor, type Data } from '../types';

export type Correction = { id: string; claim_id: string; revision: number; item_id: string; allocation: number; sequence: number; before_code: string; after_code: string; reason: string; actor_email: string; on_behalf_of: string | null; at: string };
export const correctionsFor = async (db: D1Database, claim: string) => (await db.prepare('SELECT * FROM c_coding_corrections WHERE claim_id=? ORDER BY revision,item_id,allocation,sequence').bind(claim).all<Correction>()).results;
export function effectiveCode(rows: Correction[], revision: number, item: string, allocation: number, original: string) {
  return rows.filter(c => c.revision === revision && c.item_id === item && c.allocation === allocation).at(-1)?.after_code ?? original;
}

/** Current reviewer, including the existing Full delegate boundary, before that reviewer decides. */
function correctionAuthority(actor: Actor, claim: Claim): Sql {
  if (can(actor, 'coding')) return rowAuthority(actor, 'coding');
  const auth = authority(actor, ['manager', 'finance']);
  return { sql: `(${auth.sql}) AND EXISTS(SELECT 1 FROM c_claims c WHERE c.id=? AND c.revision=? AND c.status='submitted' AND c.employee_email NOT IN (?,?) AND (
    EXISTS(SELECT 1 FROM c_workflow_tasks t JOIN c_members m ON m.email=t.email AND m.active=1 WHERE ((t.role='finance' AND m.is_finance=1) OR (t.role='manager' AND m.is_manager=1)) AND t.kind='claim' AND t.record_id=c.id AND t.revision=c.revision AND t.status='waiting' AND t.email=?) OR
    (NOT EXISTS(SELECT 1 FROM c_workflow_tasks t WHERE t.kind='claim' AND t.record_id=c.id AND t.revision=c.revision) AND c.approver_email=? AND EXISTS(SELECT 1 FROM c_members m WHERE m.email=c.approver_email AND m.active=1 AND m.is_manager=1))))`,
    params: [...auth.params, claim.id, claim.revision, actor.email, actor.delegate?.email ?? actor.email, actor.email, actor.email] };
}

/** Posting identity comes from the actual request's expenses, never a retained selection alone.
 * Legacy bills still in their batch can be identified from that batch's employee membership. */
export const postingFacts = (claim: string, item: string): Sql => ({ sql: `SELECT json_group_array(json_object('id',id,'status',status,'payload',payload,'closed',closed)) AS facts FROM (
 SELECT q.id,q.status,q.payload,EXISTS(SELECT 1 FROM c_accounting_periods p WHERE p.ledger='desktop' AND p.closed_at IS NOT NULL AND json_extract(q.payload,'$.date') BETWEEN p.start_on AND p.end_on) AND q.status='succeeded' AS closed
 FROM c_qbd_requests q WHERE
 (q.kind='CreditCardChargeAdd' AND json_extract(q.payload,'$.claim')=? AND q.source='card:'||(SELECT card_charge_id FROM c_items WHERE id=? AND claim_id=?)) OR
 (q.kind='BillAdd' AND (EXISTS(SELECT 1 FROM json_each(q.payload,'$.expenses') e WHERE json_extract(e.value,'$.claim')=? AND json_extract(e.value,'$.item')=?) OR
 (json_type(q.payload,'$.expenses') IS NULL AND EXISTS(SELECT 1 FROM c_batch_claims bc JOIN c_claims c ON c.id=bc.claim_id JOIN c_items i ON i.claim_id=c.id WHERE bc.batch_id=json_extract(q.payload,'$.batch') AND c.employee_email=json_extract(q.payload,'$.employee') AND c.id=? AND i.id=?))))
 UNION ALL SELECT l.id,'succeeded',json_object('account',l.debit_account,'amount',l.amount_minor),1 FROM c_card_ledger l JOIN c_items i ON i.card_charge_id=l.ref JOIN c_card_statements s ON s.id=l.statement_id WHERE i.claim_id=? AND i.id=? AND l.kind='purchase' AND s.closed_at IS NOT NULL
 ORDER BY id)`, params: [claim,item,claim,claim,item,claim,item,claim,item] });
const valueOf = async (db: D1Database, s: Sql) => (await db.prepare(s.sql).bind(...s.params).first<{facts:string}>())!.facts;

export async function correctCoding(db: D1Database, actor: Actor, id: string, b: Data) {
  requireThat(actor.kind === 'person' && !actor.publicCredential, 'Use a native person session to correct accounting codes', 403);
  const claim = await loadClaim(db, id), auth = correctionAuthority(actor, claim);
  requireThat(await db.prepare(`SELECT 1 WHERE ${auth.sql}`).bind(...auth.params).first(), 'This correction needs finance, owner, bookkeeper or the waiting reviewer', 403);
  requireThat(['submitted','approved'].includes(claim.status) && !claim.batch_id, 'Take the claim out of its unreleased batch before correcting coding', 409);
  requireThat(b.version === claim.version && b.revision === claim.revision, 'The submitted revision changed; reload', 409);
  const revision = await db.prepare('SELECT snapshot FROM c_revisions WHERE claim_id=? AND revision=?').bind(id, claim.revision).first<{snapshot:string}>();
  const item = JSON.parse(revision!.snapshot).items.find((i: Data) => i.id === b.item);
  requireThat(item && Number.isInteger(b.allocation) && item.allocations[b.allocation], 'Choose an allocation from this submitted revision');
  const original = item.allocations[b.allocation].account_code, rows = await correctionsFor(db, id);
  const own = rows.filter(c => c.revision === claim.revision && c.item_id === item.id && c.allocation === b.allocation), sequence = own.at(-1)?.sequence ?? 0;
  requireThat(b.sequence === sequence, 'The account correction changed; reload', 409);
  const before = effectiveCode(rows, claim.revision, item.id, b.allocation, original), code = text(b.accountCode, 'Account code', 100), reason = text(b.reason, 'Correction reason', 1000);
  requireThat(code !== before, 'Choose a different account code', 409);
  const facts = postingFacts(id, item.id), observed = await valueOf(db, facts);
  requireThat(!JSON.parse(observed).some((p: Data) => p.closed), 'This expense has its own closed-period entry; use a dated reversal and new entry', 409);
  const state = (version: number, expectedSequence: number): Sql => ({ sql: `EXISTS(SELECT 1 FROM c_claims c WHERE c.id=? AND c.version=? AND c.revision=? AND c.status IN ('submitted','approved') AND c.batch_id IS NULL)
    AND NOT EXISTS(SELECT 1 FROM c_batch_claims WHERE claim_id=?)
    AND COALESCE((SELECT MAX(sequence) FROM c_coding_corrections WHERE claim_id=? AND revision=? AND item_id=? AND allocation=?),0)=?
    AND (SELECT snapshot FROM c_revisions WHERE claim_id=? AND revision=?)=? AND (${facts.sql})=?`,
    params: [id,version,claim.revision,id,id,claim.revision,item.id,b.allocation,expectedSequence,id,claim.revision,revision!.snapshot,...facts.params,observed] });
  const combine = (s: Sql): Sql => ({sql:`(${auth.sql}) AND (${s.sql})`,params:[...auth.params,...s.params]});
  const condition = combine(state(claim.version,sequence)); condition.after = combine(state(claim.version+1,sequence+1));
  const correction = uid(), at = now();
  await commit(db, condition, [
    db.prepare('INSERT INTO c_coding_corrections(id,claim_id,revision,item_id,allocation,sequence,before_code,after_code,reason,actor_email,on_behalf_of,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(correction,id,claim.revision,item.id,b.allocation,sequence+1,before,code,reason,actor.delegate?.email ?? actor.email,actor.delegate ? actor.email : null,at),
    db.prepare('UPDATE c_claims SET version=version+1,updated_at=? WHERE id=?').bind(at,id),
    event(db,actor,'expense-account-code-corrected',{claim:id},{correction,revision:claim.revision,item:item.id,allocation:b.allocation,sequence:sequence+1,before,after:code,reason}),
  ]);
  return loadClaim(db,id);
}

/** Claim version fences selection before it is frozen with the batch. */
export async function selectBatchCoding(db: D1Database, batch: string, claims: Claim[]) {
  const writes: D1PreparedStatement[] = [];
  for (const claim of claims) {
    const audit = (await db.prepare("SELECT seq,detail FROM c_events WHERE claim_id=? AND action IN ('account-code-corrected','expense-account-code-corrected') ORDER BY seq").bind(claim.id).all<Data>()).results;
    const rows = await correctionsFor(db,claim.id), legacy = (await db.prepare('SELECT * FROM c_account_corrections WHERE claim_id=? AND revision=? ORDER BY sequence').bind(claim.id,claim.revision).all<Data>()).results, snapshot = await db.prepare('SELECT snapshot FROM c_revisions WHERE claim_id=? AND revision=?').bind(claim.id,claim.revision).first<{snapshot:string}>();
    for (const item of JSON.parse(snapshot!.snapshot).items) for (const [allocation,part] of item.allocations.entries()) {
      const correction = rows.filter(c=>c.revision===claim.revision&&c.item_id===item.id&&c.allocation===allocation).at(-1);
      const prior = legacy.filter(c=>c.item_id===item.id&&c.allocation_position===part.position).at(-1);
      const order = (id: string) => audit.find(e=>JSON.parse(e.detail).correction===id)?.seq ?? 0;
      const selected = correction && (!prior || order(correction.id)>order(prior.id)) ? correction : null;
      writes.push(db.prepare('INSERT INTO c_coding_batch_selections(batch_id,claim_id,revision,item_id,allocation,correction_id,account_code) VALUES(?,?,?,?,?,?,?)').bind(batch,claim.id,claim.revision,item.id,allocation,selected?.id??null,selected?.after_code??prior?.after_account??part.account_code));
    }
  }
  return writes;
}
