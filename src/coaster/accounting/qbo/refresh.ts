import { all, authority, commit, type Sql } from '../../session';
import { event, ruleEvent } from '../../events';
import { requireBusiness } from '../../settings';
import { requireThat, Fault, uid, now, type Actor, type Data } from '../../types';
import { connection, connectionState, companyKey, config, nativeAuthority, publicConnection, type QboBindings, type Connection } from './model';
import { openTokens, sealTokens } from './sealing';
import { exchange, metadata } from './network';
import { catalogWrites } from './catalog';

function leaseState(c: Connection, lease: string): Sql {
  return { sql: 'EXISTS(SELECT 1 FROM c_qbo_connections WHERE id=1 AND realm_id=? AND environment=? AND lease_id=? AND lease_until>?)', params: [c.realm_id, c.environment, lease, Date.now()] };
}
export async function saveQboSchedule(env: QboBindings, actor: Actor, body: Data) {
  nativeAuthority(actor, 'sync');
  requireThat(actor.roles.owner || actor.roles.finance, 'Finance access is required to set the QuickBooks refresh schedule', 403);
  const auth = authority(actor, ['owner', 'finance']), c = await connection(env.DB);
  requireThat(c, 'Connect QuickBooks first', 409);
  requireThat(Number.isInteger(body.hour) && body.hour >= 0 && body.hour <= 23, 'Choose a daily refresh hour from 0 to 23');
  requireThat(body.version === c.version, 'QuickBooks settings changed; reload before saving', 409);
  await commit(env.DB, all(auth, connectionState(c.version)), [
    env.DB.prepare('UPDATE c_qbo_connections SET refresh_hour=?,version=version+1 WHERE id=1').bind(body.hour),
    event(env.DB, actor, 'quickbooks-refresh-schedule-saved', {}, { hour: body.hour, timezone: (await requireBusiness(env.DB)).timezone }),
  ]);
  return publicConnection(await connection(env.DB));
}
export async function refreshQbo(env: QboBindings, actor: Actor) {
  const auth = nativeAuthority(actor, 'sync'), c = await connection(env.DB);
  requireThat(c, 'Connect QuickBooks first', 409);
  return refresh(env, c, auth, actor);
}
async function refresh(env: QboBindings, c: Connection, auth: Sql, actor?: Actor, day?: string) {
  requireThat(c.environment === config(env).environment, 'QuickBooks environment changed; restore its configuration before refreshing', 409);
  const lease = uid(), leaseUntil = Date.now() + 600_000;
  const available: Sql = { sql: `EXISTS(SELECT 1 FROM c_qbo_connections WHERE id=1 AND lease_until<?${day ? ' AND (last_refresh_day IS NULL OR last_refresh_day<?)' : ''})`, params: [Date.now(), ...(day ? [day] : [])] };
  await commit(env.DB, all(auth, connectionState(c.version), available), [env.DB.prepare('UPDATE c_qbo_connections SET lease_id=?,lease_until=? WHERE id=1').bind(lease, leaseUntil)]);
  const authorized = async () => {
    const condition = all(auth, leaseState(c, lease));
    requireThat(await env.DB.prepare(`SELECT 1 WHERE ${condition.sql}`).bind(...condition.params).first(), 'QuickBooks consent or your access changed; no further requests will be sent', 409);
  };
  try {
    let tokens = await openTokens(env, companyKey(c), c.tokens_sealed);
    if (tokens.expires <= Date.now() + 60_000) {
      requireThat(tokens.refreshExpires > Date.now(), 'QuickBooks authorization expired; reconnect this company', 409);
      await authorized();
      tokens = await exchange(env, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh }));
      // Persist rotation before the list calls so a later metadata failure does not lose the new refresh token.
      await commit(env.DB, all(auth, leaseState(c, lease)), [env.DB.prepare('UPDATE c_qbo_connections SET tokens_sealed=? WHERE id=1').bind(await sealTokens(env, companyKey(c), tokens))]);
    }
    const data = await metadata(c, tokens.access, authorized), at = now(), catalog = await catalogWrites(env.DB, c, data, at);
    const details = { realm: c.realm_id, environment: c.environment, counts: catalog.counts, scheduled: !!day, ...(day ? { day } : {}) };
    await commit(env.DB, all(auth, leaseState(c, lease), catalog.guard), [
      ...catalog.statements,
      env.DB.prepare('UPDATE c_qbo_connections SET last_refresh_at=?,last_refresh_day=COALESCE(?,last_refresh_day),last_error=NULL,lease_id=NULL,lease_until=0 WHERE id=1').bind(at, day ?? null),
      actor ? event(env.DB, actor, 'quickbooks-dimensions-refreshed', {}, details) : ruleEvent(env.DB, 'QuickBooks daily refresh', 'quickbooks-dimensions-refreshed', {}, details),
    ]);
    return { ...publicConnection(await connection(env.DB)), counts: catalog.counts };
  } catch (error) {
    const message = error instanceof Fault ? error.message : 'QuickBooks refresh could not be committed; no catalog choices were changed';
    const held = await connection(env.DB);
    if (held?.lease_id === lease) {
      // A revoked person's request cannot write an error either; the lease then expires naturally.
      try { await commit(env.DB, all(auth, leaseState(c, lease)), [env.DB.prepare('UPDATE c_qbo_connections SET last_error=?,lease_id=NULL,lease_until=0 WHERE id=1').bind(message)]); } catch { /* Original refusal remains the response. */ }
    }
    if (error instanceof Fault) throw error;
    throw new Fault(502, message);
  }
}
/** One complete daily pull after finance's chosen hour in the business zone; no manual sync is needed. */
export async function runQboDaily(env: QboBindings, at: Date) {
  const c = await connection(env.DB);
  if (!c || c.lease_until >= Date.now()) return;
  const business = await requireBusiness(env.DB);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: business.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(v => [v.type, v.value]));
  const day = `${p.year}-${p.month}-${p.day}`;
  if (Number(p.hour) < c.refresh_hour || c.last_refresh_day && c.last_refresh_day >= day) return;
  const auth: Sql = { sql: 'EXISTS(SELECT 1 FROM c_qbo_connections WHERE id=1 AND realm_id=? AND environment=?)', params: [c.realm_id, c.environment] };
  try { return await refresh(env, c, auth, undefined, day); }
  catch (error) {
    if (error instanceof Fault && error.status === 409) {
      const latest = await connection(env.DB);
      if (!latest || latest.lease_until >= Date.now() || latest.last_refresh_day && latest.last_refresh_day >= day) return;
    }
    throw error;
  }
}
