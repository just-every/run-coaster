import type { Bindings } from '../../auth.server';
import { unseal } from '../public-api/crypto';
import { Fault, requireThat, type Data } from '../types';
import { providerSealId, type Provider } from './model';

export const PLAID_SANDBOX = 'https://sandbox.plaid.com';
export const STRIPE_API = 'https://api.stripe.com';
export type Credentials = { clientId?: string; secret?: string; secretKey?: string; publishableKey?: string };

/** No redirects, retries, provider hosts from input or response bodies in errors. Account and routing numbers never pass through Coaster: the browser gives them to the provider. */
async function send(name: string, url: string, init: RequestInit) {
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(25_000) }); }
  catch { throw new Fault(502, `${name} did not answer. Try again; nothing was saved.`); }
  const raw = await response.text();
  // A 4xx is the provider's answer about what was sent (wrong amounts, expired link); anything else is its failure.
  requireThat(response.ok && raw.length <= 1_000_000, `${name} refused the request (HTTP ${response.status}). Nothing was saved.`, response.status >= 400 && response.status < 500 ? 409 : 502);
  try { return JSON.parse(raw) as Data; } catch { throw new Fault(502, `${name} returned invalid JSON`); }
}
export const plaid = (c: Credentials, path: string, body: Data = {}) =>
  send('Plaid', PLAID_SANDBOX + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: c.clientId, secret: c.secret, ...body }) });
/** Stripe takes form bodies; a repeated key (amounts) is a list. */
export const stripe = (c: Credentials, method: 'GET' | 'POST', path: string, form?: [string, string][]) =>
  send('Stripe', STRIPE_API + path, { method, headers: { authorization: `Bearer ${c.secretKey}`, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, ...(form ? { body: new URLSearchParams(form).toString() } : {}) });

export async function credentials(env: Bindings, provider: Provider): Promise<Credentials> {
  const row = await env.DB.prepare('SELECT credentials_sealed FROM c_bank_providers WHERE provider=?').bind(provider).first<{ credentials_sealed: string }>();
  requireThat(row, `${provider === 'plaid' ? 'Plaid' : 'Stripe'} is not connected for bank verification; ask the owner`, 409);
  try { return JSON.parse(await unseal(env.SESSION_SECRET, providerSealId(provider), row.credentials_sealed)); }
  catch { throw new Fault(409, 'Reconnect this bank verification provider in this installation'); }
}
