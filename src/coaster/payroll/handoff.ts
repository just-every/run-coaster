import type { Bindings } from '../../auth.server';
import { batchNumber, loadBatch } from '../batches';
import { all, authority, commit } from '../session';
import { event } from '../events';
import { now, requireThat, uid, type Actor, type Data } from '../types';
import { connection, connectionState, handoff, nativeOwner, publicHandoff, type Connection, type Handoff } from './model';
import { authorized, request } from './network';
import { cents, compensationPlan, payrollLines, sameCompensation } from './lines';

async function upcoming(env: Bindings, actor: Actor, c: Connection) {
  const result = await request(env, actor, c, `/v1/companies/${c.company_uuid}/payrolls?processing_statuses=unprocessed&per=100`);
  requireThat(Array.isArray(result) && result.length < 100, 'Gusto payroll list is incomplete; no handoff is allowed', 409);
  return result.filter(p => p.processed === false && p.off_cycle === false).sort((a,b) => String(a.check_date).localeCompare(String(b.check_date)) || String(a.payroll_uuid).localeCompare(String(b.payroll_uuid)));
}
async function readPayroll(env: Bindings, actor: Actor, c: Connection, id: string, prepare = false) {
  const path = `/v1/companies/${c.company_uuid}/payrolls/${id}`;
  const first = await request(env, actor, c, path + (prepare ? '/prepare?per=100' : '?per=100'), prepare ? 'PUT' : 'GET');
  requireThat(first.payroll_uuid === id && (!first.company_uuid || first.company_uuid === c.company_uuid) && Array.isArray(first.employee_compensations), 'Gusto returned a different payroll', 502);
  const employees = [...first.employee_compensations];
  for (let page = 2; employees.length % 100 === 0 && employees.length > 0; page++) {
    requireThat(page <= 20, 'Gusto payroll is too large to reconcile', 409);
    const next = await request(env, actor, c, path + `?page=${page}&per=100`);
    requireThat(next.payroll_uuid === id && Array.isArray(next.employee_compensations), 'Gusto returned an incomplete payroll page', 502);
    if (!next.employee_compensations.length) break;
    employees.push(...next.employee_compensations);
    if (next.employee_compensations.length < 100) break;
  }
  requireThat(new Set(employees.map(e => e.employee_uuid)).size === employees.length, 'Gusto repeated an employee page', 502);
  return { ...first, employee_compensations: employees };
}
export async function payrollReview(env: Bindings, actor: Actor, id: string) {
  requireThat(actor.roles.finance || actor.roles.auditor, 'Finance or auditor access required', 403);
  const batch = await loadBatch(env.DB, id), existing = await handoff(env, id), c = await connection(env);
  return { handoff: publicHandoff(existing), lines: existing ? JSON.parse(existing.lines) : await payrollLines(env,batch), payrolls: actor.roles.owner && !actor.delegate && c && !existing ? await upcoming(env,actor,c) : [] };
}
const batchState = (id: string, version: number) => ({ sql: "EXISTS(SELECT 1 FROM c_batches WHERE id=? AND version=? AND status='approved' AND released_at IS NOT NULL)", params: [id,version] });
export async function sendPayroll(env: Bindings, actor: Actor, id: string, body: Data) {
  const auth = nativeOwner(actor), batch = await loadBatch(env.DB,id), c = await connection(env);
  requireThat(c, 'Connect Gusto first', 409);
  requireThat(body.consent === true, 'Confirm the exact payroll amounts before sending');
  requireThat(batch.status === 'approved' && batch.released_at && batch.version === body.version && batch.currency === 'USD', 'Review and release this USD batch before sending; reload', 409);
  requireThat(!await handoff(env,id), 'This batch already has a handoff; read back its original run instead of sending again',409);
  requireThat(!await env.DB.prepare('SELECT 1 FROM c_batch_claims bc JOIN c_claims c ON c.id=bc.claim_id WHERE bc.batch_id=? AND c.employee_email=?').bind(id,actor.email).first(), 'Another owner must send a batch holding your own claim',403);
  const recent = { sql: 'EXISTS(SELECT 1 FROM oa_sessions WHERE id=? AND created_at>=unixepoch()*1000-600000)', params: [actor.session] };
  requireThat(await env.DB.prepare(`SELECT (${recent.sql}) AS ok`).bind(...recent.params).first<{ ok: number }>().then(r=>r?.ok), 'Sign in again before sending payroll; a sign-in from the last 10 minutes is required', 401);
  await authorized(env,actor,c,recent);
  const choices = await upcoming(env,actor,c), next = choices[0];
  requireThat(next && next.payroll_uuid === body.payroll, 'Choose the next unprocessed regular Gusto run; reload',409);
  const lines = await payrollLines(env,batch);
  requireThat(lines.length>0 && lines.length<=100 && lines.every(l => l.employeeUuid && l.reimbursementMinor>=0 && l.taxableMinor>=0) && lines.reduce((n,l)=>n+l.reimbursementMinor+l.taxableMinor,0)===batch.total_minor, 'Map every employee and reconcile the payroll total first',409);
  // Prepare is an explicit, consented provider operation with its own numbered audit line.
  await commit(env.DB,all(auth,connectionState(c),batchState(id,batch.version),recent),[event(env.DB,actor,'payroll-prepare-requested',{batch:id},{company:c.company_uuid,payroll:next.payroll_uuid})]);
  const payroll = await readPayroll(env,actor,c,next.payroll_uuid,true);
  requireThat(payroll.processed === false && payroll.off_cycle === false && !['calculating','submitting'].includes(payroll.processing_request?.status), 'The payroll is already being processed',409);
  const expected = compensationPlan(payroll,lines,`Coaster ${batchNumber(batch.number)}`), key=uid(), at=now();
  await commit(env.DB,all(auth,connectionState(c),batchState(id,batch.version),recent),[
    env.DB.prepare("INSERT INTO c_payroll_handoffs(id,batch_id,company_uuid,payroll_uuid,check_date,status,lines,expected,created_by,created_at) VALUES(?,?,?,?,?,'reserved',?,?,?,?)").bind(key,id,c.company_uuid,next.payroll_uuid,payroll.check_date,JSON.stringify(lines.map(({name,...line})=>line)),JSON.stringify(expected),actor.email,at),
    env.DB.prepare('UPDATE c_batches SET version=version+1 WHERE id=?').bind(id),
    event(env.DB,actor,'payroll-handoff-reserved',{batch:id},{handoff:key,company:c.company_uuid,payroll:next.payroll_uuid,consent:true,totalMinor:batch.total_minor}),
  ]);
  // Reservation is permanent before the only physical write. A lost acknowledgement is reconciled by GET, never retried.
  await request(env,actor,c,`/v1/companies/${c.company_uuid}/payrolls/${next.payroll_uuid}`,'PUT',{employee_compensations:expected},recent);
  return (await confirmPayroll(env,actor,id)).handoff;
}
async function markSent(env: Bindings,actor: Actor,c: Connection,h: Handoff) {
  if(h.status!=='reserved')return;
  await commit(env.DB,all(authority(actor,'owner'),connectionState(c),{sql:"EXISTS(SELECT 1 FROM c_payroll_handoffs WHERE id=? AND status='reserved')",params:[h.id]}),[
    env.DB.prepare("UPDATE c_payroll_handoffs SET status='sent' WHERE id=?").bind(h.id),
    event(env.DB,actor,'payroll-handoff-sent',{batch:h.batch_id},{handoff:h.id,payroll:h.payroll_uuid}),
  ]);
  h.status='sent';
}
export async function confirmPayroll(env: Bindings, actor: Actor, id: string) {
  const auth=nativeOwner(actor),h=await handoff(env,id),c=await connection(env);
  requireThat(h && c && h.company_uuid===c.company_uuid,'Reconnect the original Gusto company to read this handoff',409);
  if(h.status==='confirmed')return {handoff:publicHandoff(h),confirmed:true};
  const payroll=await readPayroll(env,actor,c,h.payroll_uuid),expected=JSON.parse(h.expected) as Data[];
  requireThat(payroll.check_date===h.check_date && expected.every(e=>payroll.employee_compensations.some((actual:Data)=>sameCompensation(actual,e))), 'Provider amounts differ from the reserved handoff. Claims remain unpaid; reconcile in Gusto.',409);
  await markSent(env,actor,c,h);
  if(payroll.processed!==true || ['calculating','submitting','processing_failed'].includes(payroll.processing_request?.status))return {handoff:publicHandoff(h),confirmed:false};
  const receipt=await request(env,actor,c,`/v1/payrolls/${h.payroll_uuid}/receipt?per=100`);
  requireThat(receipt.payroll_uuid===h.payroll_uuid && receipt.company_uuid===c.company_uuid && Array.isArray(receipt.employee_compensations), 'Gusto has not supplied the matching processed payroll receipt',409);
  requireThat(expected.every(e=>receipt.employee_compensations.some((r:Data)=>r.employee_uuid===e.employee_uuid && cents(r.total_reimbursement)===e.reimbursements.reduce((sum:number,r:Data)=>sum+cents(r.amount),0))), 'Gusto receipt reimbursements do not reconcile',409);
  const at=now(), reference=`Gusto ${h.payroll_uuid}`;
  await commit(env.DB,all(auth,connectionState(c),{sql:"EXISTS(SELECT 1 FROM c_payroll_handoffs WHERE id=? AND status='sent') AND EXISTS(SELECT 1 FROM c_batches WHERE id=? AND status='approved')",params:[h.id,id]}),[
    env.DB.prepare("UPDATE c_payroll_handoffs SET status='confirmed',confirmed_at=? WHERE id=?").bind(at,h.id),
    env.DB.prepare("UPDATE c_batches SET status='reimbursed',paid_reference=?,paid_on=?,paid_by=?,version=version+1 WHERE id=?").bind(reference,h.check_date,actor.email,id),
    env.DB.prepare("UPDATE c_claims SET status='reimbursed',version=version+1,updated_at=? WHERE batch_id=? AND status='batched'").bind(at,id),
    event(env.DB,actor,'batch-reimbursed',{batch:id},{provider:'Gusto sandbox',reference,paidOn:h.check_date,handoff:h.id,confirmation:'processed payroll receipt'}),
  ]);
  return {handoff:publicHandoff(await handoff(env,id)),confirmed:true};
}
