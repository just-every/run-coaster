import { all, authority, commit, guard, need } from './session';
import { event } from './events';
import { email, isoDate, now, requireThat, uid, type Actor, type Data } from './types';

/** Today's date in the business's time zone, as YYYY-MM-DD. */
export const localDay = (timezone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

type ReviewRole = 'manager' | 'finance';
const activeReviewer = (db: D1Database, address: string, role: ReviewRole) => db.prepare(`SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_${role}=1`).bind(address).first();
const activeManager = (db: D1Database, address: string) => db.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_manager=1').bind(address).first();

/** An approver (or owner for anyone) delegates a selected approval role over inclusive business-local dates. */
export async function saveDelegation(db: D1Database, actor: Actor, b: Data) {
  const role: ReviewRole = b.role ?? (actor.roles.manager ? 'manager' : 'finance');
  requireThat(role === 'manager' || role === 'finance', 'Choose manager or finance approvals');
  need(actor, role);
  requireThat(actor.kind === 'person' && !actor.delegate, 'Only the approver themselves delegates approvals', 403);
  const approver = b.approver ? email(b.approver, 'Approver') : actor.email;
  requireThat(approver === actor.email || actor.roles.owner, 'Only the owner sets delegation for someone else', 403);
  const delegate = email(b.delegate, 'Delegate');
  requireThat(delegate !== approver, 'Choose someone else to approve on your behalf');
  requireThat(await activeReviewer(db, delegate, role), `The delegate must be an active member with the ${role} role`);
  requireThat(await activeReviewer(db, approver, role) || (approver === actor.email && actor.roles.owner), `The approver must hold the ${role} role`);
  const starts = isoDate(b.startsOn, 'From'), ends = isoDate(b.endsOn, 'Until');
  requireThat(ends >= starts, 'The delegation must end on or after it starts');
  const id = uid();
  await commit(db, all(authority(actor, role), {sql:`EXISTS(SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_${role}=1)`,params:[delegate]}), [
    db.prepare('INSERT INTO c_delegations(id,approver_email,delegate_email,starts_on,ends_on,created_by,created_at,review_role) VALUES(?,?,?,?,?,?,?,?)').bind(id, approver, delegate, starts, ends, actor.email, now(),role),
    event(db, actor, 'delegation-set', {}, { id, approver, delegate, startsOn: starts, endsOn: ends, role }),
  ]);
  return db.prepare('SELECT * FROM c_delegations WHERE id=?').bind(id).first();
}

export async function revokeDelegation(db: D1Database, actor: Actor, id: string) {
  requireThat(actor.kind === 'person' && (actor.roles.manager || actor.roles.finance), 'Manager or finance access required',403);
  requireThat(!actor.delegate, 'Only the approver themselves ends a delegation', 403);
  const found = await db.prepare('SELECT * FROM c_delegations WHERE id=? AND revoked_at IS NULL').bind(id).first<Data>();
  requireThat(found, 'Delegation not found', 404);
  requireThat(found.approver_email === actor.email || actor.roles.owner, 'Only the approver or the owner ends a delegation', 403);
  await commit(db, authority(actor, actor.roles.owner ? 'owner' : found.review_role), [
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
export async function routeFor(db: D1Database, approver: string, employee: string, day: string, role: ReviewRole = 'manager'): Promise<{ approver: string; onBehalfOf: string | null }> {
  const delegate = await db.prepare("SELECT d.delegate_email FROM c_delegations d JOIN c_members m ON m.email=d.delegate_email AND m.active=1 AND (CASE WHEN ?='finance' THEN m.is_finance ELSE m.is_manager END)=1 WHERE d.approver_email=? AND d.review_role=? AND d.revoked_at IS NULL AND d.starts_on<=? AND d.ends_on>=? AND d.delegate_email<>? ORDER BY d.created_at DESC LIMIT 1").bind(role, approver, role, day, day, employee).first<{ delegate_email: string }>();
  return delegate ? { approver: delegate.delegate_email, onBehalfOf: approver } : { approver, onBehalfOf: null };
}

/** Deactivation preserves each task's required role; an unsuitable successor leaves it for owner reassignment. */
export async function queueMoves(db: D1Database, actor: Actor, address: string, manager: string | null) {
 if (!manager || !await activeManager(db, manager)) return [];
 const successor=await db.prepare('SELECT is_manager,is_finance FROM c_members WHERE email=? AND active=1').bind(manager).first<{is_manager:number;is_finance:number}>();
 const tasks=(await db.prepare("SELECT t.*,c.version,c.employee_email FROM c_workflow_tasks t JOIN c_claims c ON t.kind='claim' AND c.id=t.record_id AND c.revision=t.revision WHERE t.email=? AND t.status='waiting' AND c.status='submitted' UNION ALL SELECT t.*,r.version,r.employee_email FROM c_workflow_tasks t JOIN c_requests r ON t.kind='request' AND r.id=t.record_id AND t.revision=1 WHERE t.email=? AND t.status='waiting' AND r.status='submitted'").bind(address,address).all<Data>()).results;
 const writes:D1PreparedStatement[]=[];
 for(const task of tasks) {
  if(task.employee_email===manager || !(task.role==='finance'?successor?.is_finance:successor?.is_manager))continue;
  const duplicate=await db.prepare("SELECT 1 FROM c_workflow_tasks WHERE kind=? AND record_id=? AND revision=? AND status='waiting' AND email=? AND slot<>?").bind(task.kind,task.record_id,task.revision,manager,task.slot).first();
  if(duplicate)continue;
  const table=task.kind==='claim'?'c_claims':'c_requests';
  writes.push(
   guard(db,{sql:`EXISTS(SELECT 1 FROM ${table} WHERE id=? AND version=? AND status='submitted') AND EXISTS(SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_${task.role}=1)`,params:[task.record_id,task.version,manager]}),
   db.prepare('UPDATE c_workflow_tasks SET email=?,on_behalf_of=NULL WHERE kind=? AND record_id=? AND revision=? AND slot=?').bind(manager,task.kind,task.record_id,task.revision,task.slot),
   db.prepare(`UPDATE ${table} SET approver_email=CASE WHEN approver_email=? THEN ? ELSE approver_email END,on_behalf_of=CASE WHEN approver_email=? THEN NULL ELSE on_behalf_of END,version=version+1,updated_at=? WHERE id=?`).bind(address,manager,address,now(),task.record_id),
   event(db,actor,'workflow-review-reassigned',task.kind==='claim'?{claim:task.record_id}:{},{kind:task.kind,record:task.record_id,from:address,to:manager,slot:task.slot,role:task.role,reason:'Approver deactivated'}),
  );
 }
 const waiting=await db.prepare("SELECT id FROM c_claims WHERE approver_email=? AND status='submitted' AND employee_email<>? AND NOT EXISTS(SELECT 1 FROM c_workflow_tasks t WHERE t.kind='claim' AND t.record_id=c_claims.id AND t.revision=c_claims.revision)").bind(address,manager).all<{id:string}>();
 writes.push(...waiting.results.flatMap(c=>[
  db.prepare("UPDATE c_claims SET approver_email=?,on_behalf_of=NULL,version=version+1,updated_at=? WHERE id=? AND status='submitted'").bind(manager,now(),c.id),
  event(db,actor,'claim-reassigned',{claim:c.id},{from:address,to:manager,reason:'Approver deactivated'}),
 ]));
 const requests=await db.prepare("SELECT id FROM c_requests WHERE approver_email=? AND status='submitted' AND employee_email<>? AND workflow IS NULL").bind(address,manager).all<{id:string}>();
 writes.push(...requests.results.flatMap(r=>[
  db.prepare("UPDATE c_requests SET approver_email=?,on_behalf_of=NULL,version=version+1,updated_at=? WHERE id=? AND status='submitted'").bind(manager,now(),r.id),
  event(db,actor,'request-reassigned',{}, {request:r.id,from:address,to:manager,reason:'Approver deactivated'}),
 ]));
 return writes;
}
