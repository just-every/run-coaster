import { all, authority, commit, need } from './session';
import { event } from './events';
import { requireBusiness } from './settings';
import { localDay, routeFor } from './delegation';
import { amount, optionalText, now, requireThat, text, uid, type Actor, type Data } from './types';

export type SpendRequest = { id: string; number: number; employee_email: string; approver_email: string; on_behalf_of: string | null; title: string; purpose: string; estimate_minor: number; currency: string; status: string; version: number; submitted_by: string; decided_by: string | null; decided_on_behalf_of: string | null; decided_at: string | null; reason: string; created_at: string; updated_at: string; actual_minor: number };
export const requestNumber = (n: number) => `SR-${String(n).padStart(4, '0')}`;

/** Each request with what has been spent against it so far: every linked expense on a claim that was not rejected. */
const WITH_ACTUAL = "SELECT r.*, COALESCE((SELECT SUM(i.amount_minor) FROM c_items i JOIN c_claims c ON c.id=i.claim_id WHERE i.request_id=r.id AND c.status<>'rejected'),0) AS actual_minor FROM c_requests r";

export async function loadRequest(db: D1Database, id: unknown): Promise<SpendRequest> {
  requireThat(typeof id === 'string' && id.length <= 64, 'Spend request not found', 404);
  const found = await db.prepare(`${WITH_ACTUAL} WHERE r.id=?`).bind(id).first<SpendRequest>();
  requireThat(found, 'Spend request not found', 404);
  return found;
}

/** Who may see a request: its employee, its approver (and whom they act for), finance, auditors and the owner. */
export const canSeeRequest = (actor: Actor, r: SpendRequest) => r.employee_email === actor.email || (actor.roles.manager && (r.approver_email === actor.email || r.on_behalf_of === actor.email)) || actor.roles.finance || actor.roles.auditor || actor.roles.owner;

export async function requestsFor(db: D1Database, actor: Actor) {
  return (await db.prepare(`${WITH_ACTUAL} ORDER BY r.number DESC`).all<SpendRequest>()).results.filter(r => canSeeRequest(actor, r));
}

/** An employee asks before spending, with an estimate; it routes to their approving manager (or that manager's delegate) like a claim. */
export async function createRequest(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'employee');
  requireThat(actor.kind === 'person', 'Only a person requests spend', 403);
  const business = await requireBusiness(db), title = text(b.title, 'What the spend is for', 200), purpose = optionalText(b.purpose, 'Purpose', 1000), estimate = amount(b.estimate, 'Estimate');
  requireThat(estimate > 0, 'The estimate must be more than zero');
  const member = await db.prepare('SELECT approver_email FROM c_members WHERE email=? AND active=1').bind(actor.email).first<{ approver_email: string | null }>();
  requireThat(member?.approver_email && member.approver_email !== actor.email, 'Ask the owner to set your approving manager before requesting spend', 409);
  const { approver, onBehalfOf } = await routeFor(db, member.approver_email, actor.email, localDay(business.timezone));
  const id = uid(), at = now();
  await commit(db, all(authority(actor, 'employee'), { sql: 'EXISTS(SELECT 1 FROM c_members WHERE email=? AND is_manager=1 AND active=1)', params: [approver] }), [
    db.prepare("INSERT INTO c_requests(id,number,employee_email,approver_email,on_behalf_of,title,purpose,estimate_minor,currency,status,submitted_by,created_at,updated_at) VALUES(?,(SELECT COALESCE(MAX(number),0)+1 FROM c_requests),?,?,?,?,?,?,?,'submitted',?,?,?)").bind(id, actor.email, approver, onBehalfOf, title, purpose, estimate, business.currency, actor.delegate?.email ?? actor.email, at, at),
    event(db, actor, 'request-submitted', {}, { request: id, title, estimateMinor: estimate, approver, onBehalfOf }),
  ]);
  return loadRequest(db, id);
}

/** The routed approver approves or rejects (with a reason) the exact request they saw; nobody decides their own. */
export async function decideRequest(db: D1Database, actor: Actor, id: string, b: Data) {
  need(actor, 'manager');
  requireThat(actor.kind === 'person', 'Only a person decides a spend request', 403);
  const r = await loadRequest(db, id);
  requireThat(r.employee_email !== actor.email && r.employee_email !== actor.delegate?.email, 'Nobody approves their own spend request', 403);
  requireThat(r.approver_email === actor.email, 'This request is waiting for another approver', 403);
  requireThat(r.status === 'submitted', 'This request is not waiting for a decision', 409);
  requireThat(b.version === r.version, 'The request changed since you opened it; reload and review it again', 409);
  requireThat(b.decision === 'approved' || b.decision === 'rejected', 'Choose approve or reject');
  const reason = optionalText(b.reason, 'Reason', 1000);
  requireThat(b.decision === 'approved' || reason, 'Give the reason for rejecting');
  const at = now(), onBehalfOf = actor.delegate ? actor.email : r.on_behalf_of;
  await commit(db, all(authority(actor, 'manager'), { sql: "EXISTS(SELECT 1 FROM c_requests WHERE id=? AND version=? AND status='submitted' AND approver_email=?)", params: [id, r.version, actor.email] }), [
    db.prepare('UPDATE c_requests SET status=?,decided_by=?,decided_on_behalf_of=?,decided_at=?,reason=?,version=version+1,updated_at=? WHERE id=?').bind(b.decision, actor.delegate?.email ?? actor.email, onBehalfOf, at, reason, at, id),
    event(db, actor, `request-${b.decision}`, {}, { request: id, title: r.title, reason, onBehalfOf }),
  ]);
  return loadRequest(db, id);
}

/** An expense links only to its own employee's approved request. */
export async function linkableRequest(db: D1Database, employee: string, value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const r = await loadRequest(db, value);
  requireThat(r.employee_email === employee, 'That spend request belongs to someone else', 403);
  requireThat(r.status === 'approved', 'Link expenses only to an approved spend request', 409);
  return r.id;
}
