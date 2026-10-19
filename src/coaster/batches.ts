import { all, authority, commit, need, type Sql } from './session';
import { event } from './events';
import { claimNumber, claimItems, type Claim } from './claims';
import { exactKey } from './exceptions';
import { decimal, isoDate, now, optionalText, requireThat, text, uid, type Actor, type Data } from './types';

export type Batch = { id: string; number: number; status: string; currency: string; total_minor: number; version: number; created_by: string; created_at: string; prepared_by: string | null; reviewed_by: string | null; reviewed_at: string | null; paid_reference: string | null; paid_on: string | null; paid_by: string | null };
export const batchNumber = (n: number) => `RB-${String(n).padStart(4, '0')}`;

export async function loadBatch(db: D1Database, id: unknown): Promise<Batch> {
  requireThat(typeof id === 'string' && id.length <= 64, 'Batch not found', 404);
  const batch = await db.prepare('SELECT * FROM c_batches WHERE id=?').bind(id).first<Batch>();
  requireThat(batch, 'Batch not found', 404);
  return batch;
}
const batchState = (id: string, version: number, status: string): Sql => ({ sql: 'EXISTS(SELECT 1 FROM c_batches WHERE id=? AND version=? AND status=?)', params: [id, version, status] });

/** Keys every expense of these claims reimburses under; refuses any key already taken. */
async function reimbursementKeys(db: D1Database, claims: Claim[]) {
  const keys: { key: string; claim: Claim; item: string }[] = [];
  for (const claim of claims) for (const item of await claimItems(db, claim.id)) keys.push({ key: exactKey(claim.employee_email, item), claim, item: item.id });
  const seen = new Map<string, Claim>();
  for (const k of keys) {
    const twin = seen.get(k.key);
    requireThat(!twin, `${claimNumber(k.claim.number)} and ${claimNumber(twin?.number ?? 0)} hold the same exact expense; only one can be reimbursed`, 409);
    seen.set(k.key, k.claim);
    const taken = await db.prepare('SELECT c.number, b.number AS batch FROM c_reimbursement_keys k JOIN c_claims c ON c.id=k.claim_id JOIN c_batches b ON b.id=k.batch_id WHERE k.key=?').bind(k.key).first<{ number: number; batch: number }>();
    requireThat(!taken, `${claimNumber(k.claim.number)} repeats an expense already reimbursed through ${claimNumber(taken?.number ?? 0)} in ${batchNumber(taken?.batch ?? 0)}`, 409);
  }
  return keys;
}

/** Finance gathers approved claims into a draft batch; each exact expense can be in one batch only. */
export async function createBatch(db: D1Database, actor: Actor, b: Data, preparedBy: string | null = null) {
  need(actor, 'finance');
  requireThat(actor.kind === 'person', 'Agents propose batches; finance creates them', 403);
  requireThat(Array.isArray(b.claims) && b.claims.length > 0 && b.claims.length <= 200 && new Set(b.claims).size === b.claims.length, 'Choose between 1 and 200 approved claims');
  const claims: Claim[] = [];
  for (const id of b.claims) {
    const claim = await db.prepare("SELECT * FROM c_claims WHERE id=? AND status='approved'").bind(id).first<Claim>();
    requireThat(claim, 'Only approved claims can be batched', 409);
    claims.push(claim);
  }
  requireThat(new Set(claims.map(c => c.currency)).size === 1, 'A batch reimburses in one currency');
  const keys = await reimbursementKeys(db, claims), id = uid(), at = now(), total = claims.reduce((n, c) => n + c.total_minor, 0);
  const next = await db.prepare('SELECT COALESCE(MAX(number),0)+1 AS n FROM c_batches').first<{ n: number }>(), number = next?.n ?? 1;
  const unchanged: Sql = { sql: `(SELECT COUNT(*) FROM c_claims WHERE status='approved' AND (${claims.map(() => '(id=? AND version=?)').join(' OR ')}))=?`, params: [...claims.flatMap(c => [c.id, c.version]), claims.length] };
  await commit(db, all(authority(actor, 'finance'), unchanged), [
    db.prepare("INSERT INTO c_batches(id,number,status,currency,total_minor,created_by,created_at,prepared_by) VALUES(?,?,'draft',?,?,?,?,?)").bind(id, number, claims[0].currency, total, actor.email, at, preparedBy),
    ...claims.flatMap(c => [
      db.prepare('INSERT INTO c_batch_claims(batch_id,claim_id,revision,amount_minor) VALUES(?,?,?,?)').bind(id, c.id, c.revision, c.total_minor),
      db.prepare("UPDATE c_claims SET status='batched',batch_id=?,version=version+1,updated_at=? WHERE id=?").bind(id, at, c.id),
      event(db, actor, 'claim-batched', { claim: c.id, batch: id }, { claim: claimNumber(c.number), batch: batchNumber(number) }),
    ]),
    ...keys.map(k => db.prepare('INSERT INTO c_reimbursement_keys(key,batch_id,claim_id,item_id) VALUES(?,?,?,?)').bind(k.key, id, k.claim.id, k.item)),
    event(db, actor, 'batch-created', { batch: id }, { claims: claims.length, totalMinor: total, preparedBy }),
  ]);
  return loadBatch(db, id);
}

export async function removeFromBatch(db: D1Database, actor: Actor, id: string, b: Data) {
  need(actor, 'finance');
  const batch = await loadBatch(db, id);
  requireThat(batch.status === 'draft' && b.version === batch.version, 'Only an unreviewed draft batch can change; reload', 409);
  const row = await db.prepare('SELECT claim_id,amount_minor FROM c_batch_claims WHERE batch_id=? AND claim_id=?').bind(id, b.claim).first<{ claim_id: string; amount_minor: number }>();
  requireThat(row, 'That claim is not in this batch', 404);
  const at = now();
  await commit(db, all(authority(actor, 'finance'), batchState(id, batch.version, 'draft')), [
    db.prepare('DELETE FROM c_reimbursement_keys WHERE batch_id=? AND claim_id=?').bind(id, row.claim_id),
    db.prepare('DELETE FROM c_batch_claims WHERE batch_id=? AND claim_id=?').bind(id, row.claim_id),
    db.prepare("UPDATE c_claims SET status='approved',batch_id=NULL,version=version+1,updated_at=? WHERE id=?").bind(at, row.claim_id),
    db.prepare('UPDATE c_batches SET total_minor=(SELECT COALESCE(SUM(amount_minor),0) FROM c_batch_claims WHERE batch_id=?),version=version+1 WHERE id=?').bind(id, id),
    event(db, actor, 'claim-unbatched', { claim: row.claim_id, batch: id }, {}),
  ]);
  return loadBatch(db, id);
}

/** Review locks the batch: the reviewer confirms the reconciled total and may not review their own claims. */
export async function approveBatch(db: D1Database, actor: Actor, id: string, b: Data) {
  need(actor, 'finance');
  requireThat(actor.kind === 'person', 'Only a person reviews a batch', 403);
  const batch = await loadBatch(db, id);
  requireThat(batch.status === 'draft' && b.version === batch.version, 'This batch changed or is already reviewed; reload', 409);
  const sum = await db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bc.amount_minor),0) AS total, SUM(c.employee_email=?) AS own FROM c_batch_claims bc JOIN c_claims c ON c.id=bc.claim_id WHERE bc.batch_id=?').bind(actor.email, id).first<{ n: number; total: number; own: number }>();
  requireThat(sum && sum.n > 0, 'An empty batch cannot be reviewed', 409);
  requireThat(!sum.own, 'Someone else in finance must review a batch holding your own claim', 403);
  requireThat(sum.total === batch.total_minor && b.expectedTotal === batch.total_minor, 'The total you reviewed does not match the batch; reload and review again', 409);
  const at = now();
  await commit(db, all(authority(actor, 'finance'), batchState(id, batch.version, 'draft'), { sql: '(SELECT COALESCE(SUM(amount_minor),0) FROM c_batch_claims WHERE batch_id=?)=?', params: [id, batch.total_minor] }), [
    db.prepare("UPDATE c_batches SET status='approved',reviewed_by=?,reviewed_at=?,version=version+1 WHERE id=?").bind(actor.email, at, id),
    event(db, actor, 'batch-approved', { batch: id }, { totalMinor: batch.total_minor, claims: sum.n }),
  ]);
  return loadBatch(db, id);
}

/** Record that the batch was paid outside Coaster. Coaster never moves money. */
export async function markReimbursed(db: D1Database, actor: Actor, id: string, b: Data) {
  need(actor, 'finance');
  requireThat(actor.kind === 'person', 'Only a person records payment', 403);
  const batch = await loadBatch(db, id);
  requireThat(batch.status === 'approved' && b.version === batch.version, 'Only a reviewed batch can be marked paid; reload', 409);
  const reference = text(b.reference, 'Payment reference', 200), paidOn = isoDate(b.paidOn, 'Paid on'), at = now();
  await commit(db, all(authority(actor, 'finance'), batchState(id, batch.version, 'approved')), [
    db.prepare("UPDATE c_batches SET status='reimbursed',paid_reference=?,paid_on=?,paid_by=?,version=version+1 WHERE id=?").bind(reference, paidOn, actor.email, id),
    db.prepare("UPDATE c_claims SET status='reimbursed',version=version+1,updated_at=? WHERE batch_id=? AND status='batched'").bind(at, id),
    event(db, actor, 'batch-reimbursed', { batch: id }, { reference, paidOn, note: optionalText(b.note, 'Note', 500) }),
  ]);
  return loadBatch(db, id);
}

const cell = (v: unknown) => '"' + String(v ?? '').replace(/"/g, '""').replace(/^[=+@\-\t\r]/, "'$&") + '"';
export const csv = (rows: unknown[][]) => rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';

/** Accounting lines (one per category split) and per-employee totals, both from the approved revisions. */
export async function batchLines(db: D1Database, id: string) {
  const { results } = await db.prepare('SELECT bc.claim_id, bc.revision, bc.amount_minor, c.number, c.employee_email, m.name AS employee_name, r.snapshot, r.submitted_by, d.actor_email AS approver, d.on_behalf_of, d.at AS approved_at FROM c_batch_claims bc JOIN c_claims c ON c.id=bc.claim_id LEFT JOIN c_members m ON m.email=c.employee_email JOIN c_revisions r ON r.claim_id=bc.claim_id AND r.revision=bc.revision LEFT JOIN c_decisions d ON d.claim_id=bc.claim_id AND d.revision=bc.revision WHERE bc.batch_id=? ORDER BY c.number').bind(id).all<Data>();
  const lines: Data[] = [], people = new Map<string, Data>();
  for (const row of results) {
    const snapshot = JSON.parse(row.snapshot);
    // The ledger memo names anyone who acted for someone else: a delegate who submitted, or approved on an approver's behalf.
    const memo = [row.submitted_by !== row.employee_email && `submitted by ${row.submitted_by} on behalf of ${row.employee_email}`, row.on_behalf_of && `approved by ${row.approver} on behalf of ${row.on_behalf_of}`].filter(Boolean).join('; ');
    for (const item of snapshot.items) {
      const flags = snapshot.exceptions.filter((e: Data) => e.item === item.id).map((e: Data) => e.code).join(' ');
      // An itemized part's own description (room, tax, in-room dining) stands for the expense's on its accounting line.
      const line = (category: string, account: string, tax: string, costCentre: string, amountMinor: number, part = '') => lines.push({ claim: claimNumber(row.number), employee: row.employee_email, date: item.spent_on, merchant: item.merchant, description: part || item.description, kind: item.kind, category, account, tax, costCentre, amountMinor, receipt: item.receipt?.sha256 ?? '', exceptions: flags, explanation: flags ? item.explanation : '', approver: row.approver, approvedAt: row.approved_at, memo });
      for (const part of item.allocations) line(part.category_name, part.account_code, part.tax_code, part.cost_centre, part.amount_minor, part.description);
      // A receipt's sales tax posts on its own line to the sales tax account and code copied onto the expense.
      if (item.sales_tax_minor) line('Sales tax', item.sales_tax_account, item.sales_tax_code, '', item.sales_tax_minor);
    }
    const person = people.get(row.employee_email) ?? { email: row.employee_email, name: row.employee_name ?? row.employee_email, claims: [] as string[], amountMinor: 0 };
    person.claims.push(claimNumber(row.number)); person.amountMinor += row.amount_minor;
    people.set(row.employee_email, person);
  }
  return { lines, people: [...people.values()] };
}

/** Finance and auditors download a reviewed batch's files; the download is a history line. */
export async function batchFile(db: D1Database, actor: Actor, id: string, kind: string) {
  requireThat(actor.roles.finance || actor.roles.auditor, 'Finance or auditor access required', 403);
  const batch = await loadBatch(db, id);
  requireThat(batch.status !== 'draft', 'Review the batch before exporting it', 409);
  requireThat(kind === 'accounting' || kind === 'reimbursements', 'Unknown export', 404);
  const { lines, people } = await batchLines(db, id), name = batchNumber(batch.number);
  const lineTotal = lines.reduce((n, l) => n + l.amountMinor, 0);
  requireThat(lineTotal === batch.total_minor && people.reduce((n, p) => n + p.amountMinor, 0) === batch.total_minor, 'The batch does not reconcile; do not pay it and report this', 500);
  const body = kind === 'accounting'
    ? csv([['batch', 'claim', 'employee', 'date', 'merchant', 'description', 'type', 'category', 'account_code', 'tax_code', 'cost_center', 'amount', 'currency', 'receipt_sha256', 'policy_exceptions', 'explanation', 'approved_by', 'approved_at', 'memo'], ...lines.map(l => [name, l.claim, l.employee, l.date, l.merchant, l.description, l.kind, l.category, l.account, l.tax, l.costCentre, decimal(l.amountMinor), batch.currency, l.receipt, l.exceptions, l.explanation, l.approver, l.approvedAt, l.memo])])
    : csv([['batch', 'employee', 'name', 'claims', 'amount', 'currency'], ...people.map(p => [name, p.email, p.name, p.claims.join(' '), decimal(p.amountMinor), batch.currency])]);
  await commit(db, authority(actor, actor.roles.finance ? 'finance' : 'auditor'), [event(db, actor, 'batch-exported', { batch: id }, { file: kind, rows: kind === 'accounting' ? lines.length : people.length, totalMinor: batch.total_minor })]);
  return new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}-${kind}.csv"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
