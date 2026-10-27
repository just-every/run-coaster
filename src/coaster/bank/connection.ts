import type { Bindings } from '../../auth.server';
import { seal } from '../public-api/crypto';
import { needRow, rowAuthority } from '../permissions';
import { all, commit } from '../session';
import { event } from '../events';
import { now, requireThat, text, type Actor, type Data } from '../types';
import { holdDays, nativeOwner, noDelegate, PROVIDERS, providerSealId, requireRecentSignIn, recentSignIn, type Provider } from './model';
import { plaid, stripe, type Credentials } from './network';

const NAMES: Record<Provider, string> = { plaid: 'Plaid sandbox', stripe: 'Stripe test mode' };
export const providerOf = (value: unknown): Provider => { requireThat(PROVIDERS.includes(value as Provider), 'Choose Plaid (instant verification) or Stripe (micro-deposits)'); return value as Provider; };

/** Which providers the owner connected, for the owner alone. */
export async function bankProviders(env: Bindings, actor: Actor) {
  nativeOwner(actor);
  return { providers: (await env.DB.prepare('SELECT provider,connected_by,connected_at FROM c_bank_providers ORDER BY provider').all()).results };
}
/** The owner connects a provider in their own session, with explicit consent; its credentials are sealed and never leave the installation. */
export async function connectBankProvider(env: Bindings, actor: Actor, b: Data) {
  const auth = nativeOwner(actor), provider = providerOf(b.provider);
  await requireRecentSignIn(env.DB, actor);
  requireThat(b.consent === true, `Explicit consent to connect ${NAMES[provider]} for employee bank verification is required`);
  requireThat(!await env.DB.prepare('SELECT 1 FROM c_bank_providers WHERE provider=?').bind(provider).first(), 'Disconnect the current credentials before replacing them', 409);
  const credentials: Credentials = provider === 'plaid' ? { clientId: text(b.clientId, 'Plaid client ID', 200), secret: text(b.secret, 'Plaid sandbox secret', 200) }
    : { secretKey: text(b.secretKey, 'Stripe test secret key', 300), publishableKey: text(b.publishableKey, 'Stripe test publishable key', 300) };
  // A live Stripe key or a Plaid key the sandbox does not know is refused before anything is stored.
  if (provider === 'plaid') await plaid(credentials, '/institutions/get_by_id', { institution_id: 'ins_109508', country_codes: ['US'] });
  else requireThat((await stripe(credentials, 'GET', '/v1/balance')).livemode === false, 'Only Stripe test mode can be connected here', 409);
  await commit(env.DB, all(auth, recentSignIn(actor), { sql: 'NOT EXISTS(SELECT 1 FROM c_bank_providers WHERE provider=?)', params: [provider] }), [
    env.DB.prepare('INSERT INTO c_bank_providers(provider,credentials_sealed,connected_by,connected_at) VALUES(?,?,?,?)').bind(provider, await seal(env.SESSION_SECRET, providerSealId(provider), JSON.stringify(credentials)), actor.email, now()),
    event(env.DB, actor, 'bank-provider-connected', {}, { provider: NAMES[provider], consent: true }),
  ]);
  return { connected: true };
}
export async function disconnectBankProvider(env: Bindings, actor: Actor, b: Data) {
  const auth = nativeOwner(actor), provider = providerOf(b.provider);
  await requireRecentSignIn(env.DB, actor);
  requireThat(await env.DB.prepare('SELECT 1 FROM c_bank_providers WHERE provider=?').bind(provider).first(), `${NAMES[provider]} is not connected`, 409);
  await commit(env.DB, all(auth), [env.DB.prepare('DELETE FROM c_bank_providers WHERE provider=?').bind(provider), event(env.DB, actor, 'bank-provider-disconnected', {}, { provider: NAMES[provider] })]);
  return { connected: false };
}

/** Finance (or the owner) sets how many whole days payments wait after a change of bank details; a change already made keeps the period it was made under. */
export async function setBankHold(env: Bindings, actor: Actor, b: Data) {
  noDelegate(actor); needRow(actor, 'bank');
  requireThat(Number.isInteger(b.days) && b.days >= 1 && b.days <= 30, 'Choose a cooling-off period of 1 to 30 days');
  const previous = await holdDays(env.DB);
  await commit(env.DB, all(rowAuthority(actor, 'bank')), [
    env.DB.prepare('UPDATE c_bank_settings SET hold_days=?,set_by=?,set_at=? WHERE id=1').bind(b.days, actor.email, now()),
    event(env.DB, actor, 'bank-hold-period-set', {}, { days: b.days, previousDays: previous }),
  ]);
  return { holdDays: b.days };
}
