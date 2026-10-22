import { Fault, requireThat, type Data } from '../../types';
import { config, type Connection, type QboBindings, type Tokens } from './model';

export async function qboJson(url: string, init: RequestInit): Promise<Data> {
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20_000) }); }
  catch { throw new Fault(502, 'QuickBooks did not answer; the catalog has not been refreshed'); }
  requireThat(response.ok, response.status === 401 || response.status === 400 && url.includes('/tokens/') ? 'QuickBooks authorization was refused; reconnect this company' : `QuickBooks request failed (HTTP ${response.status}); the catalog has not been refreshed`, response.status === 401 ? 409 : 502);
  const raw = await response.text();
  requireThat(raw.length <= 10_000_000, 'QuickBooks response is too large to accept', 502);
  try {
    const value = JSON.parse(raw);
    requireThat(value && typeof value === 'object' && !Array.isArray(value) && !value.Fault, 'QuickBooks returned an invalid response', 502);
    return value;
  } catch (error) { if (error instanceof Fault) throw error; throw new Fault(502, 'QuickBooks returned invalid JSON'); }
}
export async function exchange(env: QboBindings, parameters: URLSearchParams, at = Date.now()): Promise<Tokens> {
  const c = config(env), basic = btoa(`${c.client}:${c.secret}`);
  const data = await qboJson('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', { method: 'POST', headers: { authorization: `Basic ${basic}`, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: parameters.toString() });
  requireThat(typeof data.access_token === 'string' && data.access_token.length > 0 && typeof data.refresh_token === 'string' && data.refresh_token.length > 0 && Number.isFinite(data.expires_in) && data.expires_in > 0 && Number.isFinite(data.x_refresh_token_expires_in) && data.x_refresh_token_expires_in > 0 && String(data.token_type).toLowerCase() === 'bearer', 'QuickBooks returned incomplete credentials; reconnect this company', 502);
  return { access: data.access_token, refresh: data.refresh_token, expires: at + data.expires_in * 1000, refreshExpires: at + data.x_refresh_token_expires_in * 1000 };
}
export const ENTITIES = ['Account', 'Class', 'Department', 'Customer', 'Vendor'] as const;
export type Entity = typeof ENTITIES[number];
export type Metadata = Record<Entity, Data[]>;
/** Complete list snapshots include inactive rows. A failed page never retires earlier choices. */
export async function metadata(c: Connection, access: string, authorized: () => Promise<void>): Promise<Metadata> {
  const host = c.environment === 'sandbox' ? 'sandbox-quickbooks.api.intuit.com' : 'quickbooks.api.intuit.com';
  const result = {} as Metadata;
  for (const entity of ENTITIES) {
    const rows: Data[] = [], seen = new Set<string>();
    for (let start = 1; ; start += 1000) {
      const url = new URL(`https://${host}/v3/company/${encodeURIComponent(c.realm_id)}/query`);
      url.searchParams.set('query', `SELECT * FROM ${entity} WHERE Active IN (true, false) STARTPOSITION ${start} MAXRESULTS 1000`);
      url.searchParams.set('minorversion', '75');
      await authorized();
      const value = await qboJson(url.href, { headers: { authorization: `Bearer ${access}`, accept: 'application/json' } });
      requireThat(value.QueryResponse && typeof value.QueryResponse === 'object' && !Array.isArray(value.QueryResponse), 'QuickBooks returned no query result', 502);
      const page = value.QueryResponse[entity] ?? [];
      requireThat(Array.isArray(page) && page.length <= 1000, 'QuickBooks returned an invalid catalog page', 502);
      for (const row of page) {
        requireThat(row && typeof row.Id === 'string' && row.Id.length > 0 && row.Id.length <= 100 && !seen.has(row.Id) && typeof row.Active === 'boolean', 'QuickBooks returned an invalid or repeated catalog choice', 502);
        seen.add(row.Id); rows.push(row);
      }
      if (page.length < 1000) break;
      requireThat(start < 100_000, 'QuickBooks catalog exceeds this refresh limit; no choices were changed', 502);
    }
    result[entity] = rows;
  }
  return result;
}
