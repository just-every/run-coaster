import type { Bindings } from '../../auth.server';
import { unseal } from '../public-api/crypto';
import { all, authority, type Sql } from '../session';
import { Fault, requireThat, type Actor } from '../types';
import { connectionState, type Connection } from './model';

export const GUSTO_SANDBOX = 'https://api.gusto-demo.com';
/** No redirects, retries, response bodies in errors, or configurable provider hosts. */
export async function gustoJson(token: string, path: string, method = 'GET', body?: unknown) {
  let response: Response;
  try { response = await fetch(GUSTO_SANDBOX + path, { method, redirect: 'manual', signal: AbortSignal.timeout(25_000), headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', 'X-Gusto-API-Version': '2026-06-15' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch { throw new Fault(502, 'Gusto did not answer. Read back this handoff before taking further action.'); }
  requireThat(response.ok, `Gusto request refused (HTTP ${response.status}). Read back the handoff before taking further action.`, 502);
  const raw = await response.text();
  requireThat(raw.length <= 4_000_000, 'Gusto response is too large', 502);
  try { return JSON.parse(raw); } catch { throw new Fault(502, 'Gusto returned invalid JSON'); }
}
export async function authorized(env: Bindings, actor: Actor, c: Connection, extra?: Sql) {
  const condition = all(authority(actor, 'owner'), connectionState(c), ...(extra ? [extra] : []));
  requireThat(await env.DB.prepare(`SELECT (${condition.sql}) AS ok`).bind(...condition.params).first<{ ok: number }>().then(r => r?.ok), 'Payroll authority or connection changed; reload', 409);
}
export async function request(env: Bindings, actor: Actor, c: Connection, path: string, method = 'GET', body?: unknown, extra?: Sql) {
  await authorized(env, actor, c, extra);
  let token: string;
  try { token = await unseal(env.SESSION_SECRET, 'gusto:' + c.company_uuid, c.token_sealed); }
  catch { throw new Fault(409, 'Reconnect Gusto in this installation'); }
  return gustoJson(token, path, method, body);
}
export async function employees(env: Bindings, actor: Actor, c: Connection) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const data = await request(env, actor, c, `/v1/companies/${c.company_uuid}/employees?page=${page}&per=100`);
    requireThat(Array.isArray(data), 'Gusto returned an invalid employee list', 502);
    rows.push(...data);
    if (data.length < 100) return rows;
  }
  throw new Fault(409, 'Gusto employee list exceeds this connection’s limit');
}
