import { Fault, requireThat, type Data } from '../types';

export type Credentials = { client_id: string; secret: string; access_token?: string };
/** Sandbox only. Never follow redirects, retry, or expose a provider body in an error. */
export async function plaidJson(credentials: Credentials, path: string, body: Data = {}) {
  let response: Response;
  try {
    response = await fetch('https://sandbox.plaid.com' + path, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(25_000),
      headers: { 'content-type': 'application/json', 'Plaid-Version': '2020-09-14' },
      body: JSON.stringify({ ...body, ...credentials }),
    });
  } catch { throw new Fault(502, 'Plaid sandbox did not answer; inspect the original connection before trying again'); }
  requireThat(response.ok, `Plaid sandbox refused the request (HTTP ${response.status}); reconnect explicitly if required`, 502);
  const raw = await response.text();
  requireThat(raw.length <= 1_000_000, 'Plaid sandbox response is too large', 502);
  try { return JSON.parse(raw) as Data; } catch { throw new Fault(502, 'Plaid sandbox returned invalid JSON'); }
}
