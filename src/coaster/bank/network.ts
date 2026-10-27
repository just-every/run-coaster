import type { Bindings } from '../../auth.server';
import { unseal } from '../public-api/crypto';
import { Fault, requireThat, type Actor, type Data } from '../types';
import { nativeSelf, providerSealId, recentSignIn, type Provider } from './model';
import { all, type Sql } from '../session';
import { plaidJson } from '../plaid/network';

export const PLAID_SANDBOX = 'https://sandbox.plaid.com';
export const STRIPE_API = 'https://api.stripe.com';
export type Credentials = { clientId?: string; secret?: string; secretKey?: string; publishableKey?: string; current?: () => Promise<void>; state?: Sql };

/** No redirects, retries, provider hosts from input or response bodies in errors. Account and routing numbers never pass through Coaster: the browser gives them to the provider. */
async function send(name: string, url: string, init: RequestInit) {
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(25_000) }); }
  catch { throw new Fault(502, `${name} did not answer. The provider outcome is uncertain; check status before starting again.`); }
  const raw = await response.text();
  // A 4xx is the provider's answer about what was sent (wrong amounts, expired link); anything else is its failure.
  requireThat(response.ok && raw.length <= 1_000_000, `${name} refused the request (HTTP ${response.status}). Nothing was saved.`, response.status >= 400 && response.status < 500 ? 409 : 502);
  try { return JSON.parse(raw) as Data; } catch { throw new Fault(502, `${name} returned invalid JSON`); }
}
export const plaid = async (c: Credentials, path: string, body: Data = {}) => {
  await c.current?.();
  return plaidJson({ client_id: c.clientId!, secret: c.secret! }, path, body);
};
/** Stripe takes form bodies; a repeated key (amounts) is a list. */
export const stripe = async (c: Credentials, method: 'GET' | 'POST', path: string, form?: [string, string][]) => {
  await c.current?.();
  return send('Stripe', STRIPE_API + path, { method, headers: { authorization: `Bearer ${c.secretKey}`, ...(form ? { 'content-type': ['application', 'x-www-form-urlencoded'].join('/') } : {}) }, ...(form ? { body: new URLSearchParams(form).toString() } : {}) });
};

export async function credentials(env: Bindings, provider: Provider, actor: Actor): Promise<Credentials> {
  const row = await env.DB.prepare('SELECT credentials_sealed FROM c_bank_providers WHERE provider=?').bind(provider).first<{ credentials_sealed: string }>();
  requireThat(row, `${provider === 'plaid' ? 'Plaid' : 'Stripe'} is not connected for bank verification; ask the owner`, 409);
  try {
    const value = JSON.parse(await unseal(env.SESSION_SECRET, providerSealId(provider), row.credentials_sealed));
    const state: Sql = { sql: 'EXISTS(SELECT 1 FROM c_bank_providers WHERE provider=? AND credentials_sealed=?)', params: [provider, row.credentials_sealed] };
    return { ...value, state, current: async () => {
      const condition = all(nativeSelf(actor), recentSignIn(actor), state);
      requireThat(await env.DB.prepare(`SELECT (${condition.sql}) AS ok`).bind(...condition.params).first<{ ok: number }>().then(r => r?.ok), 'Bank authority or connection changed; sign in and reload', 409);
    } };
  }
  catch { throw new Fault(409, 'Reconnect this bank verification provider in this installation'); }
}
