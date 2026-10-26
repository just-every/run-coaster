import type { Bindings } from '../../auth.server';
import { seal } from '../public-api/crypto';
import { all, commit } from '../session';
import { event } from '../events';
import { now, requireThat, text, type Actor, type Data } from '../types';
import { connection, connectionState, nativeOwner, providerId } from './model';
import { employees, gustoJson } from './network';

export async function payrollConnection(env: Bindings, actor: Actor) {
  nativeOwner(actor);
  const c = await connection(env);
  return { connection: c ? { company_uuid: c.company_uuid, company_name: c.company_name, connected_at: c.connected_at } : null,
    employees: c ? (await employees(env, actor, c)).map(e => ({ uuid: e.uuid, first_name: e.first_name, last_name: e.last_name, email: e.email })) : [],
    mappings: (await env.DB.prepare('SELECT email,employee_uuid FROM c_gusto_employees').all()).results };
}
export async function connectPayroll(env: Bindings, actor: Actor, body: Data) {
  const auth = nativeOwner(actor);
  requireThat(body.consent === true, 'Explicit consent to connect this Gusto sandbox company is required');
  requireThat(!await connection(env), 'Disconnect the current company before replacing it', 409);
  const company = providerId(body.company), token = text(body.token, 'Gusto sandbox token', 4000);
  requireThat(await env.DB.prepare(`SELECT (${auth.sql}) AS ok`).bind(...auth.params).first<{ok:number}>().then(row=>row?.ok), 'Your payroll connection authority changed; sign in again', 403);
  const data = await gustoJson(token, `/v1/companies/${company}`);
  requireThat((data.uuid ?? data.company_uuid) === company, 'The token belongs to a different Gusto company', 409);
  await commit(env.DB, all(auth, { sql: 'NOT EXISTS(SELECT 1 FROM c_gusto_connection)', params: [] }), [
    env.DB.prepare('INSERT INTO c_gusto_connection(id,company_uuid,company_name,token_sealed,connected_by,connected_at) VALUES(1,?,?,?,?,?)').bind(company, text(data.name ?? data.trade_name, 'Company name', 200), await seal(env.SESSION_SECRET, 'gusto:' + company, token), actor.email, now()),
    event(env.DB, actor, 'payroll-connected', {}, { provider: 'Gusto sandbox', company, consent: true }),
  ]);
  return { connected: true };
}
export async function disconnectPayroll(env: Bindings, actor: Actor) {
  const auth = nativeOwner(actor), c = await connection(env);
  requireThat(c, 'Gusto is not connected', 409);
  await commit(env.DB, all(auth, connectionState(c)), [env.DB.prepare('DELETE FROM c_gusto_connection'), env.DB.prepare('DELETE FROM c_gusto_employees'), event(env.DB, actor, 'payroll-disconnected', {}, { company: c.company_uuid })]);
  return { connected: false };
}
export async function mapPayrollEmployee(env: Bindings, actor: Actor, body: Data) {
  const auth = nativeOwner(actor), c = await connection(env);
  requireThat(c, 'Connect Gusto first', 409);
  const email = text(body.email, 'Coaster employee', 254).toLowerCase(), employee = providerId(body.employee);
  requireThat(await env.DB.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_contractor=0').bind(email).first(), 'Choose an active Coaster employee; contractors use a separate payment route');
  requireThat((await employees(env, actor, c)).some(e => e.uuid === employee && !e.terminated), 'Choose an active employee in this Gusto company');
  await commit(env.DB, all(auth, connectionState(c)), [env.DB.prepare('INSERT INTO c_gusto_employees(email,company_uuid,employee_uuid) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET company_uuid=excluded.company_uuid,employee_uuid=excluded.employee_uuid').bind(email,c.company_uuid,employee), event(env.DB, actor, 'payroll-employee-mapped', {}, { email, employee, company: c.company_uuid })]);
  return { mapped: true };
}
