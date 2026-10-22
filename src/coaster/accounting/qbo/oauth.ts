import { all, commit, sha256Hex } from '../../session';
import { event } from '../../events';
import { requireThat, text, now, type Actor, type Data } from '../../types';
import { callbackUri, companyKey, config, connection, connectionState, nativeAuthority, publicConnection, type QboBindings } from './model';
import { exchange } from './network';
import { sealTokens } from './sealing';
import { advanceCatalog, catalogState } from '../../coding/model';

export async function startQbo(env: QboBindings, actor: Actor, body: Data) {
  const auth = nativeAuthority(actor, 'connections'), c = config(env);
  requireThat(body.consent === true, 'Confirm that QuickBooks may share its accounting dimensions with Coaster');
  const held = await connection(env.DB), state = crypto.randomUUID() + crypto.randomUUID();
  await commit(env.DB, all(auth, connectionState(held?.version ?? 0)), [
    env.DB.prepare('DELETE FROM c_qbo_oauth_states WHERE expires_at<?').bind(Date.now()),
    env.DB.prepare('INSERT INTO c_qbo_oauth_states(state_hash,session_id,actor_email,origin,environment,expires_at,connection_version) VALUES(?,?,?,?,?,?,?)').bind(await sha256Hex(state), actor.session!, actor.email, env.AUTH_ORIGIN, c.environment, Date.now() + 600_000, held?.version ?? 0),
    event(env.DB, actor, 'quickbooks-consent-started', {}, { environment: c.environment, scope: 'accounting dimensions only' }),
  ]);
  const url = new URL('https://appcenter.intuit.com/connect/oauth2');
  for (const [key, value] of Object.entries({ client_id: c.client, response_type: 'code', scope: 'com.intuit.quickbooks.accounting', redirect_uri: callbackUri(env), state })) url.searchParams.set(key, value);
  return { authorizationUrl: url.href };
}

export async function finishQbo(env: QboBindings, actor: Actor, url: URL) {
  const auth = nativeAuthority(actor, 'connections'), c = config(env);
  requireThat(url.origin === env.AUTH_ORIGIN && url.pathname === '/api/coaster/accounting/qbo/callback', 'Invalid QuickBooks callback origin', 403);
  const hash = await sha256Hex(text(url.searchParams.get('state'), 'QuickBooks state', 200));
  const state = await env.DB.prepare('SELECT * FROM c_qbo_oauth_states WHERE state_hash=?').bind(hash).first<{ session_id: string; actor_email: string; origin: string; environment: string; expires_at: number; consumed_at: number | null; connection_version: number }>();
  requireThat(state && state.session_id === actor.session && state.actor_email === actor.email && state.origin === env.AUTH_ORIGIN && state.environment === c.environment && state.expires_at > Date.now() && !state.consumed_at, 'QuickBooks consent expired or belongs to another session; connect again', 409);
  const held = await connection(env.DB);
  requireThat(!held?.lease_id || held.lease_until < Date.now(), 'QuickBooks is refreshing; connect again after it finishes', 409);
  // Consume before exchanging: duplicate callbacks can never race the same authorization code.
  await commit(env.DB, all(auth, connectionState(state.connection_version), { sql: 'EXISTS(SELECT 1 FROM c_qbo_oauth_states WHERE state_hash=? AND session_id=? AND consumed_at IS NULL AND expires_at>?)', params: [hash, actor.session, Date.now()] }), [env.DB.prepare('UPDATE c_qbo_oauth_states SET consumed_at=? WHERE state_hash=?').bind(Date.now(), hash)]);
  requireThat(!url.searchParams.has('error'), 'QuickBooks connection was not authorized; connect again', 400);
  const code = text(url.searchParams.get('code'), 'QuickBooks authorization code', 4000), realm = text(url.searchParams.get('realmId'), 'QuickBooks company', 50);
  requireThat(/^[a-zA-Z0-9-]+$/.test(realm), 'Invalid QuickBooks company');
  requireThat(!held || held.realm_id === realm && held.environment === c.environment, 'This installation is connected to another QuickBooks company; disconnect it before changing companies', 409);
  const tokens = await exchange(env, new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUri(env) }));
  const sealed = await sealTokens(env, companyKey({ realm_id: realm, environment: c.environment }), tokens);
  await commit(env.DB, all(auth, connectionState(state.connection_version), { sql: 'NOT EXISTS(SELECT 1 FROM c_qbo_connections WHERE id=1 AND lease_until>?) AND EXISTS(SELECT 1 FROM c_qbo_oauth_states WHERE state_hash=? AND session_id=? AND consumed_at IS NOT NULL)', params: [Date.now(), hash, actor.session] }), [
    env.DB.prepare('INSERT INTO c_qbo_connections(id,realm_id,environment,tokens_sealed,version,connected_by,connected_at) VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET tokens_sealed=excluded.tokens_sealed,version=c_qbo_connections.version+1,connected_by=excluded.connected_by,connected_at=excluded.connected_at,last_error=NULL,lease_id=NULL,lease_until=0').bind(realm, c.environment, sealed, 1, actor.email, now()),
    event(env.DB, actor, 'quickbooks-connected', {}, { realm, environment: c.environment, scope: 'accounting dimensions only' }),
  ]);
  return publicConnection(await connection(env.DB));
}

/** Withdraw this installation's consent immediately, including a refresh already fetching pages. */
export async function disconnectQbo(env: QboBindings, actor: Actor, body: Data) {
  const auth = nativeAuthority(actor, 'connections'), c = await connection(env.DB);
  requireThat(body.consent === true, 'Confirm disconnecting this QuickBooks company');
  requireThat(c && body.version === c.version, 'QuickBooks connection changed; reload before disconnecting', 409);
  const catalog = await env.DB.prepare('SELECT version FROM c_coding_version WHERE id=1').first<{ version: number }>();
  requireThat(catalog, 'The accounting-dimension catalog is not installed', 409);
  await commit(env.DB, all(auth, connectionState(c.version), catalogState(catalog.version)), [
    env.DB.prepare("UPDATE c_coding_values SET active=0,updated_at=? WHERE dimension_id IN (SELECT id FROM c_coding_dimensions WHERE source='quickbooks' AND source_company=?)").bind(now(), companyKey(c)),
    env.DB.prepare("UPDATE c_coding_dimensions SET active=0,updated_at=? WHERE source='quickbooks' AND source_company=?").bind(now(), companyKey(c)),
    advanceCatalog(env.DB),
    env.DB.prepare('DELETE FROM c_qbo_connections WHERE id=1'),
    env.DB.prepare('DELETE FROM c_qbo_oauth_states'),
    event(env.DB, actor, 'quickbooks-disconnected', {}, { realm: c.realm_id, environment: c.environment, credentialsRemoved: true }),
  ]);
  return { connected: false };
}
