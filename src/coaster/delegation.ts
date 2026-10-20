import { authority, commit, need } from './session';
import { event } from './events';
import { email, isoDate, now, requireThat, uid, type Actor, type Data } from './types';

/** Today's date in the business's time zone, as YYYY-MM-DD. */
export const localDay = (timezone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const activeManager = (db: D1Database, address: string) => db.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_manager=1').bind(address).first();

/** An approver (or the owner for anyone) hands approvals to another active manager for a date range. */
export async function saveDelegation(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'manager');
  requireThat(actor.kind === 'person' && !actor.delegate, 'Only the approver themselves delegates approvals', 403);
  const approver = b.approver ? email(b.approver, 'Approver') : actor.email;
  requireThat(approver === actor.email || actor.roles.owner, 'Only the owner sets delegation for someone else', 403);
  const delegate = email(b.delegate, 'Delegate');
  requireThat(delegate !== approver, 'Choose someone else to approve on your behalf');
  requireThat(await activeManager(db, delegate), 'The delegate must be an active member with the manager role');
  const starts = isoDate(b.startsOn, 'From'), ends = isoDate(b.endsOn, 'Until');
  requireThat(ends >= starts, 'The delegation must end on or after it starts');
  const id = uid();
  await commit(db, authority(actor, 'manager'), [
    db.prepare('INSERT INTO c_delegations(id,approver_email,delegate_email,starts_on,ends_on,created_by,created_at) VALUES(?,?,?,?,?,?,?)').bind(id, approver, delegate, starts, ends, actor.email, now()),
    event(db, actor, 'delegation-set', {}, { id, approver, delegate, startsOn: starts, endsOn: ends }),
  ]);
  return db.prepare('SELECT * FROM c_delegations WHERE id=?').bind(id).first();
}

export async function revokeDelegation(db: D1Database, actor: Actor, id: string) {
  need(actor, 'manager');
  requireThat(!actor.delegate, 'Only the approver themselves ends a delegation', 403);
  const found = await db.prepare('SELECT * FROM c_delegations WHERE id=? AND revoked_at IS NULL').bind(id).first<Data>();
  requireThat(found, 'Delegation not found', 404);
  requireThat(found.approver_email === actor.email || actor.roles.owner, 'Only the approver or the owner ends a delegation', 403);
  await commit(db, authority(actor, 'manager'), [
    db.prepare('UPDATE c_delegations SET revoked_by=?,revoked_at=? WHERE id=?').bind(actor.email, now(), id),
    event(db, actor, 'delegation-ended', {}, { id, approver: found.approver_email, delegate: found.delegate_email }),
  ]);
  return { ok: true };
}

/** Delegations this person set, received or (for the owner) everyone's, newest first. */
export async function delegations(db: D1Database, actor: Actor) {
  const rows = await db.prepare('SELECT * FROM c_delegations WHERE revoked_at IS NULL ORDER BY starts_on DESC, created_at DESC').all<Data>();
  return rows.results.filter(d => actor.roles.owner || d.approver_email === actor.email || d.delegate_email === actor.email);
}

/** Who a claim submitted today goes to: the approver, or their delegate while a delegation covers today. */
export async function routeFor(db: D1Database, approver: string, employee: string, day: string): Promise<{ approver: string; onBehalfOf: string | null }> {
  const delegate = await db.prepare("SELECT d.delegate_email FROM c_delegations d JOIN c_members m ON m.email=d.delegate_email AND m.active=1 AND m.is_manager=1 WHERE d.approver_email=? AND d.revoked_at IS NULL AND d.starts_on<=? AND d.ends_on>=? AND d.delegate_email<>? ORDER BY d.created_at DESC LIMIT 1").bind(approver, day, day, employee).first<{ delegate_email: string }>();
  return delegate ? { approver: delegate.delegate_email, onBehalfOf: approver } : { approver, onBehalfOf: null };
}

/** A deactivated approver's waiting claims move to that approver's own manager, each with a history line. Claims their manager submitted stay for the owner to reassign. */
export async function queueMoves(db: D1Database, actor: Actor, address: string, manager: string | null) {
  if (!manager || !await activeManager(db, manager)) return [];
  const tasks=await db.prepare("SELECT t.*,c.employee_email FROM c_workflow_tasks t JOIN c_claims c ON t.kind='claim' AND c.id=t.record_id AND c.revision=t.revision WHERE t.email=? AND t.status='waiting' AND t.role='manager' AND c.status='submitted' AND c.employee_email<>?").bind(address,manager).all<Data>();
  const taskWrites=tasks.results.flatMap(t=>[db.prepare("UPDATE c_workflow_tasks SET email=?,on_behalf_of=NULL WHERE kind='claim' AND record_id=? AND revision=? AND slot=?").bind(manager,t.record_id,t.revision,t.slot),db.prepare('UPDATE c_claims SET version=version+1,updated_at=? WHERE id=?').bind(now(),t.record_id),event(db,actor,'workflow-review-reassigned',{claim:t.record_id},{from:address,to:manager,slot:t.slot,reason:'Approver deactivated'})]);
  const waiting = await db.prepare("SELECT id FROM c_claims WHERE approver_email=? AND status='submitted' AND employee_email<>? AND NOT EXISTS(SELECT 1 FROM c_workflow_tasks t WHERE t.kind='claim' AND t.record_id=c_claims.id AND t.revision=c_claims.revision AND t.email=c_claims.approver_email AND t.role='finance')").bind(address, manager).all<{ id: string }>();
  return [...taskWrites,...waiting.results.flatMap(c => [
    db.prepare("UPDATE c_claims SET approver_email=?,on_behalf_of=NULL,version=version+1,updated_at=? WHERE id=? AND status='submitted'").bind(manager, now(), c.id),
    event(db, actor, 'claim-reassigned', { claim: c.id }, { from: address, to: manager, reason: 'Approver deactivated' }),
  ])];
}
