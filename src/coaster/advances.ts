import { all, authority, commit, need, type Sql } from './session';
import { event } from './events';
import { requireBusiness } from './settings';
import { localDay, routeFor } from './delegation';
import { claimNumber, claimState, loadClaim, type Claim } from './claims';
import { amount, isoDate, now, optionalText, requireThat, text, uid, type Actor, type Data } from './types';

/** IRS accountable-plan window for returning an advance's excess (CLAIM-004, CLAIM-008): due 120 calendar days after the
 * day finance recorded the advance paid; overdue from the next business-time-zone day while any of it is still owed. */
export const RETURN_DAYS = 120;

export type Advance = { id: string; number: number; employee_email: string; approver_email: string; on_behalf_of: string | null; purpose: string; amount_minor: number; currency: string; status: string; version: number; submitted_by: string; decided_by: string | null; decided_on_behalf_of: string | null; decided_at: string | null; reason: string; paid_by: string | null; paid_on: string | null; paid_reference: string | null; claim_id: string | null; returned_minor: number; claim_number: number | null; claim_status: string | null; claim_total_minor: number | null; applied_minor: number };
export const advanceNumber = (n: number) => `CA-${String(n).padStart(4, '0')}`;

/** A linked claim draws the advance down once it is submitted (draft, returned and rejected claims draw nothing), by its
 * total up to what is left after returns; a claim RETAIN-001 removed keeps what it drew. */
const APPLIED = "CASE WHEN c.id IS NULL THEN a.kept_applied_minor WHEN c.status IN ('submitted','approved','batched','reimbursed') THEN MIN(a.amount_minor-a.returned_minor, c.total_minor) ELSE 0 END";
const WITH_SETTLEMENT = `SELECT a.*, c.number AS claim_number, c.status AS claim_status, c.total_minor AS claim_total_minor, ${APPLIED} AS applied_minor FROM c_advances a LEFT JOIN c_claims c ON c.id=a.claim_id`;

const addDays = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

/** The settlement: what the claim reimburses beyond the advance, what the employee still owes back and when it is due. */
function settled(a: Advance, today: string) {
  const owedMinor = a.status === 'paid' ? a.amount_minor - a.applied_minor - a.returned_minor : 0, returnDueOn = a.paid_on ? addDays(a.paid_on, RETURN_DAYS) : null;
  return { ...a, advance: advanceNumber(a.number), claim: a.claim_number ? claimNumber(a.claim_number) : null, reimburseMinor: a.claim_total_minor === null ? null : a.claim_total_minor - a.applied_minor,
    owedMinor, returnDueOn, overdue: owedMinor > 0 && !!returnDueOn && today > returnDueOn, daysOverdue: owedMinor > 0 && returnDueOn && today > returnDueOn ? Math.round((Date.parse(today) - Date.parse(returnDueOn)) / 86_400_000) : 0 };
}

export async function loadAdvance(db: D1Database, id: unknown): Promise<Advance> {
  requireThat(typeof id === 'string' && id.length <= 64, 'Cash advance not found', 404);
  const found = await db.prepare(`${WITH_SETTLEMENT} WHERE a.id=?`).bind(id).first<Advance>();
  requireThat(found, 'Cash advance not found', 404);
  return found;
}

/** Who may see an advance: its employee, its approver (and whom they act for), finance, auditors and the owner. */
const canSee = (actor: Actor, a: Advance) => a.employee_email === actor.email || (actor.roles.manager && (a.approver_email === actor.email || a.on_behalf_of === actor.email)) || actor.roles.finance || actor.roles.auditor || actor.roles.owner;

async function view(db: D1Database, a: Advance) {
  const { timezone } = await requireBusiness(db), returns = (await db.prepare('SELECT amount_minor,returned_on,reference,recorded_by,recorded_at FROM c_advance_returns WHERE advance_id=? ORDER BY recorded_at').bind(a.id).all<Data>()).results;
  return { ...settled(a, localDay(timezone)), returns };
}

/** Every advance this person may see, with its settlement, and the overdue ones apart. */
export async function advancesFor(db: D1Database, actor: Actor) {
  const business = await requireBusiness(db), today = localDay(business.timezone);
  const rows = (await db.prepare(`${WITH_SETTLEMENT} ORDER BY a.number DESC`).all<Advance>()).results.filter(a => canSee(actor, a)).map(a => settled(a, today));
  return { returnDays: RETURN_DAYS, advances: rows, overdue: rows.filter(a => a.overdue) };
}

/** The advances whose excess is overdue, for finance's accountable-plan list (CLAIM-008). */
export async function overdueAdvances(db: D1Database, timezone: string) {
  const today = localDay(timezone);
  return (await db.prepare(`${WITH_SETTLEMENT} WHERE a.status='paid' ORDER BY a.number`).all<Advance>()).results.map(a => settled(a, today)).filter(a => a.overdue);
}

/** An employee asks for an advance for a trip; it routes to their approving manager (or that manager's delegate). */
export async function requestAdvance(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'employee');
  requireThat(actor.kind === 'person', 'Only a person requests a cash advance', 403);
  const business = await requireBusiness(db), purpose = text(b.purpose, 'What the advance is for', 200), value = amount(b.amount, 'Advance');
  requireThat(value > 0, 'The advance must be more than zero');
  const member = await db.prepare('SELECT approver_email FROM c_members WHERE email=? AND active=1').bind(actor.email).first<{ approver_email: string | null }>();
  requireThat(member?.approver_email && member.approver_email !== actor.email, 'Ask the owner to set your approving manager before requesting an advance', 409);
  const { approver, onBehalfOf } = await routeFor(db, member.approver_email, actor.email, localDay(business.timezone));
  const id = uid(), at = now();
  await commit(db, all(authority(actor, 'employee'), { sql: 'EXISTS(SELECT 1 FROM c_members WHERE email=? AND is_manager=1 AND active=1)', params: [approver] }), [
    db.prepare("INSERT INTO c_advances(id,number,employee_email,approver_email,on_behalf_of,purpose,amount_minor,currency,status,submitted_by,created_at,updated_at) VALUES(?,(SELECT COALESCE(MAX(number),0)+1 FROM c_advances),?,?,?,?,?,?,'submitted',?,?,?)").bind(id, actor.email, approver, onBehalfOf, purpose, value, business.currency, actor.delegate?.email ?? actor.email, at, at),
    event(db, actor, 'advance-requested', {}, { advance: id, purpose, amountMinor: value, approver, onBehalfOf }),
  ]);
  return view(db, await loadAdvance(db, id));
}

const advanceState = (a: Advance, status: string): Sql => ({ sql: 'EXISTS(SELECT 1 FROM c_advances WHERE id=? AND version=? AND status=?)', params: [a.id, a.version, status] });

/** The routed approver approves or rejects (with a reason) the exact advance they saw; nobody decides their own. */
export async function decideAdvance(db: D1Database, actor: Actor, id: string, b: Data) {
  need(actor, 'manager');
  requireThat(actor.kind === 'person', 'Only a person decides a cash advance', 403);
  const a = await loadAdvance(db, id);
  requireThat(a.employee_email !== actor.email && a.employee_email !== actor.delegate?.email, 'Nobody approves their own cash advance', 403);
  requireThat(a.approver_email === actor.email, 'This advance is waiting for another approver', 403);
  requireThat(a.status === 'submitted' && b.version === a.version, 'This advance is not waiting for a decision or changed since you opened it; reload', 409);
  requireThat(b.decision === 'approved' || b.decision === 'rejected', 'Choose approve or reject');
  const reason = optionalText(b.reason, 'Reason', 1000);
  requireThat(b.decision === 'approved' || reason, 'Give the reason for rejecting');
  const at = now(), onBehalfOf = actor.delegate ? actor.email : a.on_behalf_of;
  await commit(db, all(authority(actor, 'manager'), advanceState(a, 'submitted'), { sql: 'EXISTS(SELECT 1 FROM c_advances WHERE id=? AND approver_email=?)', params: [id, actor.email] }), [
    db.prepare('UPDATE c_advances SET status=?,decided_by=?,decided_on_behalf_of=?,decided_at=?,reason=?,version=version+1,updated_at=? WHERE id=?').bind(b.decision, actor.delegate?.email ?? actor.email, onBehalfOf, at, reason, at, id),
    event(db, actor, `advance-${b.decision}`, {}, { advance: id, amountMinor: a.amount_minor, reason, onBehalfOf }),
  ]);
  return view(db, await loadAdvance(db, id));
}

/** Finance records an approved advance as paid outside Coaster (Coaster never moves money; PAY-001 carries ACH payment). */
export async function payAdvance(db: D1Database, actor: Actor, id: string, b: Data) {
  need(actor, 'finance');
  requireThat(actor.kind === 'person' && !actor.delegate, 'Only a person in finance, signed in as themselves, records an advance paid', 403);
  const a = await loadAdvance(db, id);
  requireThat(a.employee_email !== actor.email, 'Someone else in finance must record your own advance paid', 403);
  requireThat(a.status === 'approved' && b.version === a.version, 'Only an approved advance not yet paid can be recorded paid; reload', 409);
  const reference = text(b.reference, 'Payment reference', 200), paidOn = isoDate(b.paidOn, 'Paid on'), at = now();
  await commit(db, all(authority(actor, 'finance'), advanceState(a, 'approved')), [
    db.prepare("UPDATE c_advances SET status='paid',paid_by=?,paid_on=?,paid_reference=?,version=version+1,updated_at=? WHERE id=?").bind(actor.email, paidOn, reference, at, id),
    event(db, actor, 'advance-paid', {}, { advance: id, amountMinor: a.amount_minor, reference, paidOn, returnDueOn: addDays(paidOn, RETURN_DAYS) }),
  ]);
  return view(db, await loadAdvance(db, id));
}

/** Finance records excess the employee returned, never more than is still owed. */
export async function recordReturn(db: D1Database, actor: Actor, id: string, b: Data) {
  need(actor, 'finance');
  requireThat(actor.kind === 'person' && !actor.delegate, 'Only a person in finance, signed in as themselves, records a returned advance', 403);
  const a = await loadAdvance(db, id);
  requireThat(a.employee_email !== actor.email, 'Someone else in finance must record your own returned advance', 403);
  requireThat(a.status === 'paid' && b.version === a.version, 'Only a paid advance takes a return; reload', 409);
  const owed = a.amount_minor - a.applied_minor - a.returned_minor, value = amount(b.amount, 'Returned'), returnedOn = isoDate(b.returnedOn, 'Returned on'), reference = text(b.reference, 'Reference', 200), at = now();
  requireThat(value > 0 && value <= owed, `Record a return between $0.01 and what is still owed (${(owed / 100).toFixed(2)})`, 409);
  await commit(db, all(authority(actor, 'finance'), advanceState(a, 'paid'), { sql: `(SELECT a.amount_minor-${APPLIED}-a.returned_minor FROM c_advances a LEFT JOIN c_claims c ON c.id=a.claim_id WHERE a.id=?)>=?`, params: [id, value] }), [
    db.prepare('INSERT INTO c_advance_returns(id,advance_id,amount_minor,returned_on,reference,recorded_by,recorded_at) VALUES(?,?,?,?,?,?,?)').bind(uid(), id, value, returnedOn, reference, actor.email, at),
    db.prepare('UPDATE c_advances SET returned_minor=returned_minor+?,version=version+1,updated_at=? WHERE id=?').bind(value, at, id),
    event(db, actor, 'advance-returned', a.claim_id ? { claim: a.claim_id } : {}, { advance: id, amountMinor: value, returnedOn, reference, owedMinor: owed - value }),
  ]);
  return view(db, await loadAdvance(db, id));
}

/** The claim's employee (or their delegate) links one of their paid advances to a draft or returned claim, or unlinks it
 * (`advance` empty). An advance settles on one claim, and a claim draws down one advance. */
export async function linkAdvance(db: D1Database, actor: Actor, claimId: string, b: Data) {
  const claim = await loadClaim(db, claimId);
  requireThat(actor.kind === 'person', 'Agents prepare proposals; the employee links an advance', 403);
  requireThat(claim.employee_email === actor.email, 'Only the employee who owns a claim can link an advance', 403);
  requireThat(['draft', 'returned'].includes(claim.status) && b.version === claim.version, 'Link an advance only to a draft or returned claim; reload', 409);
  const current = await db.prepare('SELECT id FROM c_advances WHERE claim_id=?').bind(claim.id).first<{ id: string }>();
  const target = b.advance ? await loadAdvance(db, b.advance) : null;
  if (target) {
    requireThat(target.employee_email === claim.employee_email, 'That advance belongs to someone else', 403);
    requireThat(target.status === 'paid', 'Link only an advance finance has recorded paid', 409);
    requireThat(!target.claim_id || target.claim_id === claim.id, `${advanceNumber(target.number)} already settles on another claim`, 409);
  }
  const at = now(), free: Sql[] = target ? [{ sql: "EXISTS(SELECT 1 FROM c_advances WHERE id=? AND status='paid' AND (claim_id IS NULL OR claim_id=?))", params: [target.id, claim.id] }] : [];
  await commit(db, all(authority(actor, 'employee'), claimState(claim.id, claim.version, ['draft', 'returned']), ...free), [
    db.prepare('UPDATE c_advances SET claim_id=NULL,version=version+1,updated_at=? WHERE claim_id=?').bind(at, claim.id),
    ...(target ? [db.prepare('UPDATE c_advances SET claim_id=?,version=version+1,updated_at=? WHERE id=?').bind(claim.id, at, target.id)] : []),
    db.prepare('UPDATE c_claims SET version=version+1,updated_at=? WHERE id=?').bind(at, claim.id),
    event(db, actor, target ? 'advance-linked' : 'advance-unlinked', { claim: claim.id }, { advance: target?.id ?? current?.id ?? null, claim: claimNumber(claim.number) }),
  ]);
  return loadClaim(db, claim.id);
}

/** The advance a claim draws down, with its settlement, for anyone who sees the claim. */
export async function claimAdvance(db: D1Database, claimId: string) {
  const found = await db.prepare(`${WITH_SETTLEMENT} WHERE a.claim_id=?`).bind(claimId).first<Advance>();
  return found ? view(db, found) : null;
}

/** What each of these approved claims draws from its advance; a batch pays each claim's total less this. */
export async function appliedTo(db: D1Database, claims: Claim[]) {
  const applied = new Map<string, { id: string; number: number; version: number; appliedMinor: number }>();
  if (!claims.length) return applied;
  const { results } = await db.prepare(`${WITH_SETTLEMENT} WHERE a.claim_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(claims.map(c => c.id))).all<Advance>();
  for (const a of results) applied.set(a.claim_id!, { id: a.id, number: a.number, version: a.version, appliedMinor: a.applied_minor });
  return applied;
}
/** Binds a batch write to the advances it netted, unchanged. */
export const advancesUnchanged = (applied: Awaited<ReturnType<typeof appliedTo>>): Sql => applied.size
  ? { sql: `(SELECT COUNT(*) FROM c_advances WHERE ${[...applied.values()].map(() => '(id=? AND version=?)').join(' OR ')})=?`, params: [...[...applied.values()].flatMap(a => [a.id, a.version]), applied.size] }
  : { sql: '1', params: [] };
