import { batchCorrections } from './accounting/coding-corrections';
import { combinedCoding, freezeBatchCoding } from './accounting/accounting-corrections';
import { all, authority, commit, need, sha256Hex, type Sql } from './session';
import { finalApproval } from './approval-chain';
import { event, ruleEvent } from './events';
import { business } from './settings';
import { claimNumber, claimItems, type Claim } from './claims';
import { exactKey } from './exceptions';
import { isCardExpense, isReimbursable } from './card-expenses';
import { normalDescriptor } from './cards/statement';
import { advanceNumber, advancesUnchanged, appliedTo } from './advances';
import { batchNotHeld, requireBatchNotHeld, requireNotHeld, heldAmong } from './bank/holds';
import { isoDate, now, optionalText, requireThat, text, uid, type Actor, type Data } from './types';

export type Batch = { id: string; number: number; status: string; currency: string; total_minor: number; version: number; created_by: string; created_at: string; prepared_by: string | null; reviewed_by: string | null; reviewed_at: string | null; paid_reference: string | null; paid_on: string | null; paid_by: string | null; first_released_by: string | null; first_released_at: string | null; released_by: string | null; released_at: string | null };
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
  const keys: { key: string; claim: Claim; item: string; alias?: {receipt:string|null;employee:string;date:string;amount:number;keys:string} }[] = [];
  for (const claim of claims) for (const item of await claimItems(db, claim.id)) {
    // Only cash expenses and individual business charges reserve reimbursement keys.
    if (!isReimbursable(item)) continue;
    // An out-of-pocket expense for a purchase the company card already paid cannot also be reimbursed: the same receipt as a
    // card expense carries, or the same person, date, merchant and amount as a card charge (FEED-004, COA-005).
    const same = item.receipt_sha256 ? await db.prepare('SELECT ch.descriptor FROM c_items i JOIN c_receipts r ON r.id=i.receipt_id JOIN c_card_charges ch ON ch.id=i.card_charge_id WHERE r.sha256=? LIMIT 1').bind(item.receipt_sha256).first<{ descriptor: string }>() : null;
    const twin = same ?? (await db.prepare('SELECT descriptor FROM c_card_charges WHERE employee_email=? AND COALESCE(transaction_on,posted_on)=? AND amount_minor=?').bind(claim.employee_email, item.spent_on, item.amount_minor).all<{ descriptor: string }>()).results.find(c => normalDescriptor(c.descriptor) === normalDescriptor(item.merchant));
    requireThat(isCardExpense(item) || !twin, `${claimNumber(claim.number)} repeats ${twin?.descriptor} (${item.spent_on}), a charge the company card already paid; it cannot also be reimbursed`, 409);
    let alias: (typeof keys)[number]['alias'];
    if (isCardExpense(item)) {
      // A card transaction and an earlier cash purchase use different source keys but cannot pay twice.
      const sql=`SELECT k.key,cash.merchant FROM c_reimbursement_keys k JOIN c_items cash ON cash.id=k.item_id JOIN c_claims c ON c.id=k.claim_id LEFT JOIN c_receipts r ON r.id=cash.receipt_id
        WHERE cash.card_charge_id IS NULL AND ((? IS NOT NULL AND r.sha256=?) OR (c.employee_email=? AND cash.spent_on=? AND cash.amount_minor=?))`;
      const params=[item.receipt_sha256??null,item.receipt_sha256??null,claim.employee_email,item.spent_on,item.amount_minor];
      const candidates=(await db.prepare(sql).bind(...params).all<{key:string;merchant:string}>()).results;
      const receiptKey=item.receipt_sha256 ? `receipt:${item.receipt_sha256}` : null;
      requireThat(!candidates.some(c=>c.key===receiptKey || normalDescriptor(c.merchant)===normalDescriptor(item.merchant)), `${claimNumber(claim.number)} repeats a reimbursed out-of-pocket purchase`,409);
      // Refuse if another batch reserves a possible alias between this read and the committing transaction.
      alias={receipt:item.receipt_sha256??null,employee:claim.employee_email,date:item.spent_on,amount:item.amount_minor,keys:JSON.stringify(candidates.map(c=>c.key).sort())};
    }
    keys.push({ key: exactKey(claim.employee_email, item), claim, item: item.id, alias });
  }
  const seen = new Map<string, Claim>();
  for (const k of keys) {
    const twin = seen.get(k.key);
    requireThat(!twin, `${claimNumber(k.claim.number)} and ${claimNumber(twin?.number ?? 0)} hold the same exact expense; only one can be reimbursed`, 409);
    seen.set(k.key, k.claim);
    const taken = await db.prepare('SELECT c.number, b.number AS batch FROM c_reimbursement_keys k JOIN c_claims c ON c.id=k.claim_id JOIN c_batches b ON b.id=k.batch_id WHERE k.key=?').bind(k.key).first<{ number: number; batch: number }>();
    requireThat(!taken, `${claimNumber(k.claim.number)} repeats an expense already reimbursed through ${claimNumber(taken?.number ?? 0)} in ${batchNumber(taken?.batch ?? 0)}`, 409);
    // A claim removed under the retention policy (RETAIN-001) leaves its keys behind as SHA-256.
    const expired = await db.prepare('SELECT claim_number FROM c_expired_keys WHERE key_sha256=?').bind(await sha256Hex(k.key)).first<{ claim_number: number }>();
    requireThat(!expired, `${claimNumber(k.claim.number)} repeats an expense already reimbursed through ${claimNumber(expired?.claim_number ?? 0)}, since removed under the retention policy`, 409);
  }
  return keys;
}

/** One binding guards every possible cash alias, including a large batch of card expenses. */
function reimbursementState(keys: Awaited<ReturnType<typeof reimbursementKeys>>): Sql {
  return {sql:`NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE
    (SELECT json_group_array(key) FROM (SELECT k.key FROM c_reimbursement_keys k JOIN c_items cash ON cash.id=k.item_id JOIN c_claims c ON c.id=k.claim_id LEFT JOIN c_receipts r ON r.id=cash.receipt_id
      WHERE cash.card_charge_id IS NULL AND ((json_extract(e.value,'$.receipt') IS NOT NULL AND r.sha256=json_extract(e.value,'$.receipt')) OR
        (c.employee_email=json_extract(e.value,'$.employee') AND cash.spent_on=json_extract(e.value,'$.date') AND cash.amount_minor=json_extract(e.value,'$.amount'))) ORDER BY k.key))<>json_extract(e.value,'$.keys'))`,
    params:[JSON.stringify(keys.flatMap(k=>k.alias?[k.alias]:[]))]};
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
    requireThat(claim.total_minor > 0, `${claimNumber(claim.number)} holds only company-card expenses; there is nothing to reimburse`, 409);
    claims.push(claim);
  }
  requireThat(new Set(claims.map(c => c.currency)).size === 1, 'A batch reimburses in one currency');
  await requireNotHeld(db, claims.map(c => c.employee_email));
  const keys = await reimbursementKeys(db, claims), id = uid(), applied = await appliedTo(db, claims);
  await commit(db, all(authority(actor, 'finance'), unchanged(claims), advancesUnchanged(applied), reimbursementState(keys)), await openBatch(db, id, claims, keys, applied, actor.email, (action, target, detail) => event(db, actor, action, target, detail), { preparedBy }));
  return loadBatch(db, id);
}

type Line = (action: string, target: { claim?: string; batch?: string }, detail: Data) => D1PreparedStatement;
const unchanged = (claims: Claim[]): Sql => ({ sql: "(SELECT COUNT(*) FROM c_claims c JOIN json_each(?) chosen ON c.id=json_extract(chosen.value,'$.id') AND c.version=json_extract(chosen.value,'$.version') WHERE c.status='approved')=?", params: [JSON.stringify(claims.map(c=>({id:c.id,version:c.version}))), claims.length] });

/** The writes that open a draft batch of these claims, each history line written by `line`. A claim drawing down a cash
 * advance (CLAIM-004) is paid its total less what the advance covers. */
async function openBatch(db: D1Database, id: string, claims: Claim[], keys: Awaited<ReturnType<typeof reimbursementKeys>>, applied: Awaited<ReturnType<typeof appliedTo>>, by: string, line: Line, detail: Data) {
  const at = now(), pays = (c: Claim) => c.total_minor - (applied.get(c.id)?.appliedMinor ?? 0), total = claims.reduce((n, c) => n + pays(c), 0);
  const next = await db.prepare('SELECT COALESCE(MAX(number),0)+1 AS n FROM c_batches').first<{ n: number }>(), number = next?.n ?? 1;
  return [
    db.prepare("INSERT INTO c_batches(id,number,status,currency,total_minor,created_by,created_at,prepared_by) VALUES(?,?,'draft',?,?,?,?,?)").bind(id, number, claims[0].currency, total, by, at, detail.preparedBy ?? null),
    ...await Promise.all(claims.map(c => freezeBatchCoding(db, id, c))),
    ...claims.flatMap(c => [
      db.prepare('INSERT INTO c_batch_coding(batch_id,claim_id,revision,correction_sequence) SELECT ?,?,?,COALESCE(MAX(sequence),0) FROM c_account_corrections WHERE claim_id=?').bind(id,c.id,c.revision,c.id),
      db.prepare('INSERT INTO c_batch_claims(batch_id,claim_id,revision,amount_minor) VALUES(?,?,?,?)').bind(id, c.id, c.revision, pays(c)),
      db.prepare("UPDATE c_claims SET status='batched',batch_id=?,version=version+1,updated_at=? WHERE id=?").bind(id, at, c.id),
      line('claim-batched', { claim: c.id, batch: id }, { claim: claimNumber(c.number), batch: batchNumber(number), ...(applied.has(c.id) ? { advance: advanceNumber(applied.get(c.id)!.number), advanceAppliedMinor: applied.get(c.id)!.appliedMinor, amountMinor: pays(c) } : {}) }),
    ]),
    ...keys.map(k => db.prepare('INSERT INTO c_reimbursement_keys(key,batch_id,claim_id,item_id) VALUES(?,?,?,?)').bind(k.key, id, k.claim.id, k.item)),
    line('batch-created', { batch: id }, { claims: claims.length, totalMinor: total, ...detail }),
  ];
}

/** The name the reimbursement schedule writes under. */
export const PAY_SCHEDULE = 'pay schedule';
/** The schedule opens its batch at the first hourly run at or after this hour (business time zone). */
const PAY_HOUR = 9;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The hourly run: on the owner's reimbursement weekday at or after 9:00 (business time zone), once that day, every
 * approved claim not yet in a batch goes into one draft batch for finance to review, oldest claim first and at most 200
 * (the rest wait for the next pay day). A claim whose exact expense is already reimbursed stays out, as createBatch would
 * refuse it. The schedule only opens the batch: review and release stay with people. */
export async function runPaySchedule(db: D1Database, at: Date) {
  const settings = await business(db);
  if (settings?.pay_weekday == null) return;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'long' }).formatToParts(at).map(p => [p.type, p.value]));
  if (parts.weekday !== WEEKDAYS[settings.pay_weekday] || Number(parts.hour) < PAY_HOUR) return;
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  if (await db.prepare('SELECT 1 FROM c_pay_runs WHERE day=?').bind(day).first()) return;
  const { results } = await db.prepare("SELECT * FROM c_claims WHERE status='approved' AND currency=? AND total_minor>0 ORDER BY number LIMIT 200").bind(settings.currency).all<Claim>();
  // A person whose bank details just changed waits for a later pay day (PAY-002).
  const held = new Set((await heldAmong(db, results.map(c => c.employee_email))).map(h => h.email));
  const claims: Claim[] = [];
  for (const claim of results.filter(c => !held.has(c.employee_email))) if (await reimbursementKeys(db, [...claims, claim]).then(() => true, () => false)) claims.push(claim);
  const id = uid(), run = db.prepare('INSERT INTO c_pay_runs(day,ran_at,batch_id) VALUES(?,?,?)').bind(day, at.toISOString(), claims.length ? id : null);
  if (!claims.length) { await run.run(); return; }
  const applied = await appliedTo(db, claims), keys=await reimbursementKeys(db,claims);
  await commit(db, all({ sql: '1', params: [] }, unchanged(claims), advancesUnchanged(applied), reimbursementState(keys)), [run, ...await openBatch(db, id, claims, keys, applied, PAY_SCHEDULE, (action, target, detail) => ruleEvent(db, PAY_SCHEDULE, action, target, detail), { payDay: day })]);
}

export async function removeFromBatch(db: D1Database, actor: Actor, id: string, b: Data, codingCorrection = false) {
  need(actor, 'finance');
  const batch = await loadBatch(db, id);
  requireThat((codingCorrection ? ['draft','approved'] : ['draft']).includes(batch.status) && !batch.first_released_at && !batch.released_at && b.version === batch.version, codingCorrection ? 'Only an unpaid batch without release authorization accepts a coding removal; reload' : 'Only an unreviewed draft batch can change; reload', 409);
  if (codingCorrection) requireThat(b.confirm === true, 'Confirm removing this claim for a coding correction and a new batch review');
  const notPosted: Sql = { sql: `NOT EXISTS(SELECT 1 FROM c_qbd_requests WHERE json_extract(payload,'$.batch')=? AND status IN('sent','uncertain','succeeded')) AND NOT EXISTS(SELECT 1 FROM c_payroll_handoffs WHERE batch_id=?)`, params: [id,id] };
  requireThat(await db.prepare('SELECT ' + notPosted.sql + ' AS ok').bind(...notPosted.params).first<{ok:number}>().then(r=>r?.ok), 'Reconcile this batch ledger posting or payroll handoff before removing a claim',409);
  requireThat(typeof b.claim === 'string' && b.claim, 'Choose the claim to take out of the batch');
  const row = await db.prepare('SELECT claim_id,amount_minor FROM c_batch_claims WHERE batch_id=? AND claim_id=?').bind(id, b.claim).first<{ claim_id: string; amount_minor: number }>();
  requireThat(row, 'That claim is not in this batch', 404);
  const at = now();
  await commit(db, all(authority(actor, 'finance'), batchState(id, batch.version, batch.status), notPosted), [
    db.prepare("DELETE FROM c_qbd_requests WHERE json_extract(payload,'$.batch')=? AND status IN('pending','failed')").bind(id),
    db.prepare('DELETE FROM c_reimbursement_keys WHERE batch_id=? AND claim_id=?').bind(id, row.claim_id),
    db.prepare('DELETE FROM c_batch_claims WHERE batch_id=? AND claim_id=?').bind(id, row.claim_id),
    db.prepare("UPDATE c_claims SET status='approved',batch_id=NULL,version=version+1,updated_at=? WHERE id=?").bind(at, row.claim_id),
    db.prepare("UPDATE c_batches SET status='draft',reviewed_by=NULL,reviewed_at=NULL,total_minor=(SELECT COALESCE(SUM(amount_minor),0) FROM c_batch_claims WHERE batch_id=?),version=version+1 WHERE id=?").bind(id, id),
    event(db, actor, 'claim-unbatched', { claim: row.claim_id, batch: id }, { previousStatus: batch.status, previousReviewer: batch.reviewed_by, previousReviewedAt: batch.reviewed_at, requiresReview: true, ...(codingCorrection ? { codingCorrection: true } : {}) }),
  ]);
  return loadBatch(db, id);
}

/** Explicit coding removal invalidates review; ordinary reviewed-batch removal stays locked. */
export function removeForCoding(db: D1Database, actor: Actor, id: string, b: Data) {
  return removeFromBatch(db, actor, id, b, true);
}

/** Review locks the batch: the reviewer confirms the reconciled total and may not review their own claims, nor, as a
 * delegate (ADMIN-005), those of the person they act for. */
export async function approveBatch(db: D1Database, actor: Actor, id: string, b: Data) {
  need(actor, 'finance');
  requireThat(actor.kind === 'person', 'Only a person reviews a batch', 403);
  const batch = await loadBatch(db, id);
  requireThat(batch.status === 'draft' && b.version === batch.version, 'This batch changed or is already reviewed; reload', 409);
  const sum = await db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bc.amount_minor),0) AS total, SUM(c.employee_email IN (?,?)) AS own FROM c_batch_claims bc JOIN c_claims c ON c.id=bc.claim_id WHERE bc.batch_id=?').bind(actor.email, actor.delegate?.email ?? actor.email, id).first<{ n: number; total: number; own: number }>();
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

/** A release needs a sign-in completed within this many minutes (PAY-004's step-up; no second factor exists, so it is a
 * recent sign-in, not MFA). Base sessions are never extended, so the session's creation time is the sign-in time. */
export const RELEASE_SIGN_IN_MINUTES = 10;

/** Release a reviewed batch for payment: the owner, or a finance member the owner granted release, signed in as themselves
 * within the last 10 minutes, with no claim of their own in the batch. Above the owner's dual-release amount the first
 * release is recorded and the batch waits for a second, different releaser. */
export async function releaseBatch(db: D1Database, actor: Actor, id: string, b: Data) {
  need(actor, 'finance');
  requireThat(actor.kind === 'person' && !actor.delegate, 'Only a person with release access, signed in as themselves, releases a batch', 403);
  const batch = await loadBatch(db, id);
  requireThat(batch.status === 'approved' && !batch.released_at && b.version === batch.version, 'Only a reviewed batch not yet released can be released; reload', 409);
  const granted = actor.roles.owner || !!await db.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_finance=1 AND may_release=1').bind(actor.email).first();
  requireThat(granted, 'The owner has not given you release access', 403);
  const own = await db.prepare('SELECT COUNT(*) AS n FROM c_batch_claims bc JOIN c_claims c ON c.id=bc.claim_id WHERE bc.batch_id=? AND c.employee_email=?').bind(id, actor.email).first<{ n: number }>();
  requireThat(!own?.n, 'Someone else must release a batch holding your own claim', 403);
  const recent: Sql = { sql: 'EXISTS(SELECT 1 FROM oa_sessions WHERE id=? AND created_at>=unixepoch()*1000-?)', params: [actor.session, RELEASE_SIGN_IN_MINUTES * 60_000] };
  const signedIn = await db.prepare('SELECT created_at FROM oa_sessions WHERE id=? AND created_at>=?').bind(actor.session, Date.now() - RELEASE_SIGN_IN_MINUTES * 60_000).first<{ created_at: number }>();
  requireThat(signedIn, `Sign in again to release: releasing needs a sign-in within the last ${RELEASE_SIGN_IN_MINUTES} minutes`, 401);
  const threshold = (await business(db))?.dual_release_over_minor ?? null, dual = threshold !== null && batch.total_minor > threshold;
  requireThat(!dual || batch.first_released_by !== actor.email, 'A second, different person must release this batch', 409);
  await requireBatchNotHeld(db, id);
  const first = dual && !batch.first_released_by, at = now(), signedInAt = new Date(signedIn.created_at).toISOString();
  const grant: Sql = actor.roles.owner ? authority(actor, 'owner') : { sql: `(${authority(actor, 'finance').sql}) AND EXISTS(SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_finance=1 AND may_release=1)`, params: [...authority(actor, 'finance').params, actor.email] };
  await commit(db, all({ sql: `(${grant.sql}) AND (${recent.sql})`, params: [...grant.params, ...recent.params] }, batchState(id, batch.version, 'approved'), batchNotHeld(id)), [
    first
      ? db.prepare('UPDATE c_batches SET first_released_by=?,first_released_at=?,version=version+1 WHERE id=?').bind(actor.email, at, id)
      : db.prepare('UPDATE c_batches SET released_by=?,released_at=?,version=version+1 WHERE id=?').bind(actor.email, at, id),
    event(db, actor, first ? 'batch-release-first' : 'batch-released', { batch: id }, { totalMinor: batch.total_minor, recentSignIn: signedInAt, ...(dual ? { dualReleaseOverMinor: threshold, firstReleasedBy: first ? actor.email : batch.first_released_by } : {}) }),
  ]);
  return loadBatch(db, id);
}

/** Record that the released batch was paid outside Coaster. Coaster never moves money. */
export async function markReimbursed(db: D1Database, actor: Actor, id: string, b: Data) {
  need(actor, 'finance');
  requireThat(actor.kind === 'person', 'Only a person records payment', 403);
  const batch = await loadBatch(db, id);
  requireThat(batch.status === 'approved' && b.version === batch.version, 'Only a reviewed batch can be marked paid; reload', 409);
  requireThat(batch.released_at, 'Release the batch before recording its payment', 409);
  requireThat(!await db.prepare('SELECT 1 FROM c_payroll_handoffs WHERE batch_id=?').bind(id).first(), 'Read the provider payroll confirmation for this batch; manual payment cannot override a handoff', 409);
  await requireBatchNotHeld(db, id);
  const reference = text(b.reference, 'Payment reference', 200), paidOn = isoDate(b.paidOn, 'Paid on'), at = now();
  await commit(db, all(authority(actor, 'finance'), batchState(id, batch.version, 'approved'), batchNotHeld(id)), [
    db.prepare("UPDATE c_batches SET status='reimbursed',paid_reference=?,paid_on=?,paid_by=?,version=version+1 WHERE id=?").bind(reference, paidOn, actor.email, id),
    db.prepare("UPDATE c_claims SET status='reimbursed',version=version+1,updated_at=? WHERE batch_id=? AND status='batched'").bind(at, id),
    event(db, actor, 'batch-reimbursed', { batch: id }, { reference, paidOn, note: optionalText(b.note, 'Note', 500) }),
  ]);
  return loadBatch(db, id);
}

// A plain number (a negative amount such as an applied cash advance) cannot be a formula and is written as it is.
const cell = (v: unknown) => '"' + (/^-?\d+(\.\d+)?$/.test(String(v ?? '')) ? String(v) : String(v ?? '').replace(/"/g, '""').replace(/^[=+@\-\t\r]/, "'$&")) + '"';
export const csv = (rows: unknown[][]) => rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';

/** Accounting lines (one per category split) and per-employee totals, both from the approved revisions. */
export async function batchLines(db: D1Database, id: string) {
  const { results } = await db.prepare(`SELECT bc.claim_id, bc.revision, bc.amount_minor, c.number, c.employee_email, m.name AS employee_name, r.snapshot, r.submitted_by, d.actor_email AS approver, d.on_behalf_of, d.at AS approved_at, d.reason AS approval_reason, a.number AS advance_number, a.paid_on AS advance_paid_on, c.total_minor AS claim_total_minor FROM c_batch_claims bc JOIN c_claims c ON c.id=bc.claim_id LEFT JOIN c_advances a ON a.claim_id=bc.claim_id LEFT JOIN c_members m ON m.email=c.employee_email JOIN c_revisions r ON r.claim_id=bc.claim_id AND r.revision=bc.revision LEFT JOIN c_decisions d ON d.claim_id=bc.claim_id AND d.revision=bc.revision AND ${finalApproval('d')} WHERE bc.batch_id=? ORDER BY c.number`).bind(id).all<Data>();
  const lines: Data[] = [], people = new Map<string, Data>();
  // Accountable-plan treatment (CLAIM-008): expenses finance marked non-accountable and taxable stipends are taxable pay;
  // a contractor's reimbursements are flagged for 1099 review. Coaster only labels them; taxability stays with the accountant.
  const advanceAccount = (await db.prepare('SELECT advance_account FROM c_business WHERE id=1').first<{ advance_account: string }>())?.advance_account ?? '';
  const [marked, taxableAllowances, contractors] = await db.batch([
    db.prepare('SELECT n.item_id AS id FROM c_nonaccountable n JOIN c_batch_claims bc ON bc.claim_id=n.claim_id WHERE bc.batch_id=?').bind(id),
    db.prepare("SELECT id FROM c_allowances WHERE tax='taxable'"),
    db.prepare('SELECT email AS id FROM c_members WHERE is_contractor=1'),
  ]).then(r => r.map(x => new Set((x.results as { id: string }[]).map(y => y.id))));
  for (const row of results) {
    const snapshot = JSON.parse(row.snapshot), corrections = await batchCorrections(db, id, row.claim_id, row.revision);
    const frozen = await db.prepare('SELECT selections FROM c_batch_accounting_coding WHERE batch_id=? AND claim_id=? AND revision=? ORDER BY generation DESC LIMIT 1').bind(id,row.claim_id,row.revision).first<{selections:string}>();
    snapshot.items = await combinedCoding(db, snapshot.items, corrections, frozen ? JSON.parse(frozen.selections) : []);
    // The ledger memo names anyone who acted for someone else: a delegate who submitted, or approved on an approver's behalf.
    const memo = [row.submitted_by !== row.employee_email && `submitted by ${row.submitted_by} on behalf of ${row.employee_email}`, row.on_behalf_of && `approved by ${row.approver} on behalf of ${row.on_behalf_of}`,
      snapshot.exceptions.some((e: Data) => e.code === 'needs-pre-approval') && `approved without a spend request: ${row.approval_reason}`].filter(Boolean).join('; ');
    const form1099 = contractors.has(row.employee_email);
    let taxableMinor = 0;
    for (const item of snapshot.items) {
      // Company charges and individual personal charges have no reimbursement accounting line.
      if (!isReimbursable(item)) continue;
      const taxable = marked.has(item.id) || (!!item.allowance_id && taxableAllowances.has(item.allowance_id));
      if (taxable) taxableMinor += item.amount_minor;
      const expenseApproval=snapshot.expenseApprovals?.find((a:Data)=>a.item===item.id);
      const flags = snapshot.exceptions.filter((e: Data) => e.item === item.id).map((e: Data) => e.code).join(' ');
      // An itemized part's own description (room, tax, in-room dining) stands for the expense's on its accounting line.
      const line = (category: string, account: string, tax: string, costCentre: string, amountMinor: number, part = '', originalMinor: number | null = null) => lines.push({ claim: claimNumber(row.number), employee: row.employee_email, date: item.spent_on, merchant: item.merchant, description: part || item.description, kind: item.kind, billable: !!item.billable, customer: item.customer ?? '', project: item.project ?? '', category, account, tax, costCentre, amountMinor, originalMinor, originalCurrency: item.original_currency ?? '', exchangeRate: item.fx_rate ?? '', rateDate: item.fx_date ?? '', rateSource: item.fx_source ?? '', perDiem: item.per_diem ? JSON.stringify(item.per_diem) : '', receipt: item.receipt?.sha256 ?? '', receiptId: item.receipt?.id ?? '', employeeName: row.employee_name ?? row.employee_email, exceptions: flags, explanation: flags ? item.explanation : '', approver: expenseApproval?.actor??row.approver, approvedAt: expenseApproval?.at??row.approved_at, memo, taxable, form1099 });
      for (const part of item.allocations) {
        line(part.category_name, part.account_code, part.tax_code, part.cost_centre, part.amount_minor, part.description, part.original_minor ?? null);
      }
      // A receipt's sales tax posts on its own line to the sales tax account and code copied onto the expense.
      if (item.sales_tax_minor) line('Sales tax', item.sales_tax_account, item.sales_tax_code, '', item.sales_tax_minor, '', item.original_sales_tax_minor ?? null);
    }
    // A cash advance the claim draws down (CLAIM-004) posts as one negative line to the owner's advance account, so the
    // lines add up to what the batch pays.
    const advanceApplied = row.advance_number ? row.claim_total_minor - row.amount_minor : 0;
    if (advanceApplied) lines.push({ claim: claimNumber(row.number), employee: row.employee_email, date: row.advance_paid_on, merchant: '', description: `Cash advance ${advanceNumber(row.advance_number)} applied`, kind: 'advance', billable: false, customer: '', project: '', category: 'Cash advance applied', account: advanceAccount, tax: '', costCentre: '', amountMinor: -advanceApplied, receipt: '', receiptId: '', employeeName: row.employee_name ?? row.employee_email, exceptions: '', explanation: '', approver: row.approver, approvedAt: row.approved_at, memo, taxable: false, form1099 });
    const person = people.get(row.employee_email) ?? { email: row.employee_email, name: row.employee_name ?? row.employee_email, claims: [] as string[], amountMinor: 0, taxableMinor: 0, form1099 };
    person.claims.push(claimNumber(row.number)); person.amountMinor += row.amount_minor; person.taxableMinor += taxableMinor;
    people.set(row.employee_email, person);
  }
  return { lines, people: [...people.values()] };
}
