import { correctionsFor as accountCorrectionsFor } from './coding-corrections';
import { loadClaim, claimState, visible, type Claim } from '../claims';
import { all, authority, commit, type Sql } from '../session';
import { can, rowAuthority } from '../permissions';
import { event } from '../events';
import { now, requireThat, text, uid, type Actor, type Data } from '../types';

type Codes = { accounts: string[] };
type Correction = { id: string; claim_id: string; revision: number; item_id: string; sequence: number; before_json: string; after_json: string; reason: string; actor_email: string; on_behalf_of: string | null; at: string };
const originalCodes = (item: Data): Codes => ({ accounts: item.allocations.map((a: Data) => a.account_code) });
export const correctionsFor = async (db: D1Database, claim: string, revision: number) =>
  (await db.prepare('SELECT * FROM c_accounting_corrections WHERE claim_id=? AND revision=? ORDER BY item_id,sequence').bind(claim, revision).all<Correction>()).results;

/** Native accounting codes never rewrite submitted categories, amounts, receipt evidence or decisions. */
export function correctedItems(items: Data[], corrections: Correction[]) {
  return items.map(item => {
    const correction = corrections.filter(c => c.item_id === item.id).at(-1);
    if (!correction) return item;
    const codes = JSON.parse(correction.after_json) as Codes;
    return { ...item, accountingCorrection: correction.id, allocations: item.allocations.map((part: Data, i: number) => ({ ...part, account_code: codes.accounts[i] })) };
  });
}

/** Both native doors keep their own immutable chains; the later audit event wins per allocation. */
export async function combinedCoding(db: D1Database, items: Data[], legacy: Data[], accounting: Data[]) {
  const ids = new Set([...legacy, ...accounting].map(row => row.id));
  const audit = (await db.prepare("SELECT seq,detail FROM c_events WHERE action IN ('account-code-corrected','accounting-coding-corrected') ORDER BY seq").all<Data>()).results;
  const ordered = audit.map(e => ({ id: JSON.parse(e.detail).correction, seq: e.seq })).filter(e => ids.has(e.id));
  let effective: Data[] = items.map(item => ({ ...item, allocations: item.allocations.map((part: Data) => ({ ...part })) }));
  for (const entry of ordered) {
    const old = legacy.find(row => row.id === entry.id);
    if (old) {
      const item = effective.find(item => item.id === old.item_id);
      const part = item?.allocations.find((part: Data) => part.position === old.allocation_position);
      if (part) part.account_code = old.after_account;
    } else {
      const row = accounting.find(row => row.id === entry.id);
      if (row) effective = correctedItems(effective, [row as Correction]);
    }
  }
  return effective;
}

/** Scope legacy Desktop bills by their actual batch membership, never by another bill's retained selections. */
export function noExecutedPosting(claim: Claim, item: Data): Sql {
  return { sql: `NOT EXISTS(SELECT 1 FROM c_qbd_requests q WHERE q.status IN('sent','uncertain','succeeded') AND
    ((q.kind='CreditCardChargeAdd' AND json_extract(q.payload,'$.claim')=? AND q.source=?) OR
     (q.kind='BillAdd' AND json_extract(q.payload,'$.employee')=? AND
       (EXISTS(SELECT 1 FROM json_each(q.payload,'$.claims') c WHERE c.value=?) OR
        (json_type(q.payload,'$.claims') IS NULL AND EXISTS(SELECT 1 FROM c_batch_claims bc WHERE bc.batch_id=json_extract(q.payload,'$.batch') AND bc.claim_id=?))))))`,
    params: [claim.id, 'card:' + (item.card_charge_id ?? ''), claim.employee_email, claim.id, claim.id] };
}

function correctionAuthority(actor: Actor, claim: Claim): Sql {
  requireThat(actor.kind === 'person' && !actor.publicCredential, 'A native person must confirm accounting corrections', 403);
  if (can(actor, 'coding')) return rowAuthority(actor, 'coding');
  const routed = claim.assigned_emails?.length ? claim.assigned_emails.includes(actor.email) : claim.approver_email === actor.email;
  requireThat(actor.roles.manager && claim.status === 'submitted' && routed && claim.employee_email !== actor.email && claim.employee_email !== actor.delegate?.email, 'Only finance, the owner, the bookkeeper or the waiting routed approver corrects coding', 403);
  const route: Sql = { sql: `EXISTS(SELECT 1 FROM c_claims c WHERE c.id=? AND c.revision=? AND c.status='submitted' AND
    (EXISTS(SELECT 1 FROM c_workflow_tasks t WHERE t.kind='claim' AND t.record_id=c.id AND t.revision=c.revision AND t.status='waiting' AND t.email=?) OR
     (NOT EXISTS(SELECT 1 FROM c_workflow_tasks t WHERE t.kind='claim' AND t.record_id=c.id AND t.revision=c.revision) AND c.approver_email=?)))`, params: [claim.id, claim.revision, actor.email, actor.email] };
  const auth = all(authority(actor, 'manager'), route);
  return { sql: auth.sql, params: auth.params };
}

export async function accountingCoding(db: D1Database, actor: Actor, id: string) {
  const claim = await loadClaim(db, id);
  visible(actor, claim);
  const revision = await db.prepare('SELECT snapshot FROM c_revisions WHERE claim_id=? AND revision=?').bind(id, claim.revision).first<{ snapshot: string }>();
  const original = revision ? JSON.parse(revision.snapshot).items : [];
  const history = await correctionsFor(db, id, claim.revision);
  return { claim, original, effective: await combinedCoding(db, original, (await accountCorrectionsFor(db, id)).filter(row => row.revision === claim.revision), history), corrections: history.map(({ before_json, after_json, ...row }) => ({ ...row, before: JSON.parse(before_json), after: JSON.parse(after_json) })) };
}

export async function correctAccountingCoding(db: D1Database, actor: Actor, id: string, b: Data) {
  const claim = await loadClaim(db, id), auth = correctionAuthority(actor, claim);
  requireThat(['submitted','approved','batched'].includes(claim.status), 'Only submitted or approved unpaid expenses accept native account corrections', 409);
  const batch = claim.batch_id ? await db.prepare('SELECT * FROM c_batches WHERE id=?').bind(claim.batch_id).first<Data>() : null;
  requireThat(!claim.batch_id || batch && ['draft','approved'].includes(batch.status) && !batch.first_released_at && !batch.released_at, 'This batch has payment authority; reconcile it before changing accounting codes',409);
  const batchGuard: Sql = batch ? { sql: `EXISTS(SELECT 1 FROM c_batches WHERE id=? AND version=? AND status=? AND first_released_at IS NULL AND released_at IS NULL) AND EXISTS(SELECT 1 FROM c_batch_claims WHERE batch_id=? AND claim_id=? AND revision=?) AND NOT EXISTS(SELECT 1 FROM c_qbd_requests WHERE json_extract(payload,'$.batch')=? AND status IN('sent','uncertain','succeeded')) AND NOT EXISTS(SELECT 1 FROM c_payroll_handoffs WHERE batch_id=?)`, params: [batch.id,batch.version,batch.status,batch.id,id,claim.revision,batch.id,batch.id] } : { sql:'NOT EXISTS(SELECT 1 FROM c_batch_claims WHERE claim_id=?)',params:[id] };
  requireThat(await db.prepare('SELECT ' + batchGuard.sql + ' AS ok').bind(...batchGuard.params).first<{ok:number}>().then(r=>r?.ok), 'This batch changed or has an executed posting or payroll handoff; reconcile before changing accounting codes',409);
  requireThat(b.version === claim.version && b.revision === claim.revision, 'The claim changed; reload its exact submitted revision', 409);
  requireThat(Object.keys(b).every(k => ['version','revision','item','sequence','accounts','reason'].includes(k)), 'This door changes only native allocation account codes');
  const revision = await db.prepare('SELECT snapshot FROM c_revisions WHERE claim_id=? AND revision=?').bind(id, claim.revision).first<{ snapshot: string }>();
  const item = revision && JSON.parse(revision.snapshot).items.find((i: Data) => i.id === b.item);
  requireThat(item, 'Expense not found on this submitted revision', 404);
  const history = await correctionsFor(db, id, claim.revision), own = history.filter(c => c.item_id === item.id), sequence = own.at(-1)?.sequence ?? 0;
  requireThat(b.sequence === sequence, 'The account correction changed; reload before confirming', 409);
  requireThat(Array.isArray(b.accounts) && b.accounts.length === item.allocations.length, 'Choose an account code for every existing allocation');
  const after: Codes = { accounts: b.accounts.map((code: unknown) => text(code, 'Account code', 100)) }, before = own.length ? JSON.parse(own.at(-1)!.after_json) as Codes : originalCodes(item);
  requireThat(JSON.stringify(before) !== JSON.stringify(after), 'Choose a different account code', 409);
  const posting = noExecutedPosting(claim, item);
  requireThat(await db.prepare('SELECT ' + posting.sql + ' AS ok').bind(...posting.params).first<{ ok: number }>().then(r => r?.ok), 'This expense has an executed or unresolved ledger posting; reconcile its period and use the dated correction path', 409);
  const at = now(), correction = uid(), reason = text(b.reason, 'Correction reason', 1000);
  const state = { sql: `(SELECT COALESCE(MAX(sequence),0) FROM c_accounting_corrections WHERE claim_id=? AND revision=? AND item_id=?)=?`, params: [id, claim.revision, item.id, sequence] };
  const afterState = { ...state, params: [id, claim.revision, item.id, sequence + 1] };
  const condition = all(auth, claimState(id, claim.version, ['submitted','approved','batched']), state, posting, batchGuard);
  condition.after = all(auth, claimState(id, claim.version + 1, ['submitted','approved','batched']), afterState, posting, batch ? { ...batchGuard, params: [batch.id,batch.version+1,'draft',batch.id,id,claim.revision,batch.id,batch.id] } : batchGuard);
  const row: Correction = { id:correction,claim_id:id,revision:claim.revision,item_id:item.id,sequence:sequence+1,before_json:JSON.stringify(before),after_json:JSON.stringify(after),reason,actor_email:actor.delegate?.email??actor.email,on_behalf_of:actor.delegate?actor.email:null,at };
  await commit(db, condition, [
    db.prepare('INSERT INTO c_accounting_corrections VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(correction, id, claim.revision, item.id, sequence + 1, JSON.stringify(before), JSON.stringify(after), reason, actor.delegate?.email ?? actor.email, actor.delegate ? actor.email : null, at),
    db.prepare('UPDATE c_claims SET version=version+1,updated_at=? WHERE id=?').bind(at, id),
    ...(item.card_charge_id ? [db.prepare("DELETE FROM c_qbd_requests WHERE source=? AND json_extract(payload,'$.claim')=? AND status IN('pending','failed')").bind('card:'+item.card_charge_id,id)] : []),
    ...(batch ? [
      db.prepare('INSERT INTO c_batch_accounting_coding SELECT ?,?,?,COALESCE(MAX(generation),-1)+1,? FROM c_batch_accounting_coding WHERE batch_id=? AND claim_id=?').bind(batch.id,id,claim.revision,JSON.stringify([...history,row]),batch.id,id),
      db.prepare("DELETE FROM c_qbd_requests WHERE json_extract(payload,'$.batch')=? AND status IN('pending','failed')").bind(batch.id),
      db.prepare("UPDATE c_batches SET status='draft',reviewed_by=NULL,reviewed_at=NULL,version=version+1 WHERE id=?").bind(batch.id),
      event(db,actor,'batch-coding-review-required',{batch:batch.id},{claim:id,correction,previousStatus:batch.status,previousReviewedBy:batch.reviewed_by,previousReviewedAt:batch.reviewed_at}),
    ] : []),
    event(db, actor, 'accounting-coding-corrected', { claim: id }, { correction, item: item.id, revision: claim.revision, sequence: sequence + 1, before, after, reason, channel: 'native' }),
  ]);
  return accountingCoding(db, actor, id);
}

/** A batch freezes this exact correction identity; removal deliberately retains the old evidence. */
export async function freezeBatchCoding(db: D1Database, batch: string, claim: Claim) {
  const history = await correctionsFor(db, claim.id, claim.revision);
  return db.prepare('INSERT INTO c_batch_accounting_coding VALUES(?,?,?,0,?)').bind(batch, claim.id, claim.revision, JSON.stringify(history));
}
