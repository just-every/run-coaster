import type { Bindings } from '../../auth.server';
import { event, ruleEvent } from '../events';
import { all, authority, commit, type Sql } from '../session';
import { requireThat, type Actor } from '../types';

type Settings = { version: number; account_monthly_minor: number; monthly_cap_minor: number | null };
type Settlement = { accounts: number; account_monthly_minor: number; usd_minor: number; recorded_at: string };
type Connection = { id: string; accounts: string };

// A verified settlement replaces that connection's reservation; uncertain exchanges retain theirs.
const total = `SELECT COALESCE(SUM(c.usd_minor),0) FROM c_plaid_costs c WHERE c.month=? AND
  (c.kind='settled' OR NOT EXISTS(SELECT 1 FROM c_plaid_costs s
    WHERE s.month=c.month AND s.connection_id=c.connection_id AND s.kind='settled'))`;
const basis = 'Owner-configured USD estimate per connected account; not a provider invoice. Each connected account counts for a full UTC month. Unknown exchanges retain reservations. Disconnect does not refund estimates. The monthly cap pauses optional sync. No provider billing guarantee is made.';

function native(actor: Actor) {
  requireThat(actor.kind === 'person' && !actor.publicCredential, 'Use your own native session to view Plaid costs or sync accounts', 403);
}

function monthAt(at: Date) {
  requireThat(Number.isFinite(at.getTime()), 'A valid Plaid accounting date is required');
  return at.toISOString().slice(0, 7);
}

async function check(env: Bindings, condition: Sql, message: string) {
  const row = await env.DB.prepare(`SELECT (${condition.sql}) AS ok`).bind(...condition.params).first<{ ok: number }>();
  requireThat(row?.ok, message, 409);
}

/** Safe for every current member using their own native session; never selects provider credentials. */
export async function plaidCosts(env: Bindings, actor: Actor, at = new Date()) {
  native(actor);
  await settlePlaidMonths(env,at);
  const month = monthAt(at), auth = authority(actor, ['employee', 'manager', 'finance', 'owner', 'auditor', 'admin', 'cardAdmin', 'bookkeeper']);
  // One statement observes authority, settings and the ledger in the same database snapshot.
  const result = await env.DB.prepare(`SELECT s.version,s.account_monthly_minor,s.monthly_cap_minor,
    (${total}) AS total FROM (SELECT 1) LEFT JOIN c_plaid_settings s ON s.id=1 WHERE (${auth.sql})`)
    .bind(month, ...auth.params).first<{ version: number | null; account_monthly_minor: number | null; monthly_cap_minor: number | null; total: number }>();
  requireThat(result, 'Your Plaid cost access changed; reload', 403);
  return { configured: result.version !== null, version: result.version ?? 0, accountMonthlyMinor: result.account_monthly_minor,
    monthlyCapMinor: result.monthly_cap_minor, monthToDateMinor: result.total, month, basis };
}

/** Settle the full verified account month before provider work, then return the sync commit guard. */
export async function reservePlaidMonth(env: Bindings, actor: Actor, connection: Connection, condition: Sql, at = new Date()): Promise<Sql> {
  native(actor);
  const month = monthAt(at);
  const settings = await env.DB.prepare('SELECT version,account_monthly_minor,monthly_cap_minor FROM c_plaid_settings WHERE id=1').first<Settings>();
  requireThat(settings, 'Configure Plaid sandbox costs before syncing accounts', 409);
  const stable: Sql = { sql: 'EXISTS(SELECT 1 FROM c_plaid_settings WHERE id=1 AND version=? AND account_monthly_minor=? AND monthly_cap_minor IS ?)',
    params: [settings.version, settings.account_monthly_minor, settings.monthly_cap_minor] };
  const custody: Sql = { sql: "EXISTS(SELECT 1 FROM c_plaid_connections WHERE id=? AND status='connected' AND accounts=? AND connected_at<=?)", params: [connection.id, connection.accounts, at.toISOString()] };
  const auth = all(condition, authority(actor), stable, custody);
  await check(env, auth, 'Plaid authority or configuration changed; reload');
  let settlement = await env.DB.prepare("SELECT accounts,account_monthly_minor,usd_minor,recorded_at FROM c_plaid_costs WHERE month=? AND connection_id=? AND kind='settled'")
    .bind(month, connection.id).first<Settlement>();
  if (!settlement) {
    let accounts: unknown;
    try { accounts = JSON.parse(connection.accounts); } catch { accounts = null; }
    requireThat(Array.isArray(accounts) && accounts.length > 0 && accounts.length <= 100, 'Reconnect Plaid to verify the connected accounts', 409);
    const count = accounts.length, cost = count * settings.account_monthly_minor;
    requireThat(Number.isSafeInteger(cost), 'Plaid account month estimate is too large', 409);
    settlement = { accounts: count, account_monthly_minor: settings.account_monthly_minor, usd_minor: cost, recorded_at: at.toISOString() };
    const missing: Sql = { sql: "NOT EXISTS(SELECT 1 FROM c_plaid_costs WHERE month=? AND connection_id=? AND kind='settled')", params: [month, connection.id] };
    // Costs are estimates of connected account months, even when they exceed the sync cap.
    // They survive a failed provider request or a refused sync and are never refunded.
    await commit(env.DB, all(auth, missing), [
      env.DB.prepare("INSERT INTO c_plaid_costs(month,connection_id,kind,accounts,account_monthly_minor,usd_minor,recorded_at) VALUES(?,?,'settled',?,?,?,?)")
        .bind(month, connection.id, count, settings.account_monthly_minor, cost, settlement.recorded_at),
      event(env.DB, actor, 'plaid-month-settled', {}, { connection: connection.id, month, accounts: count, accountMonthlyMinor: settings.account_monthly_minor, estimatedUsdMinor: cost, channel: 'app' }),
    ]);
  }
  const settled: Sql = { sql: "EXISTS(SELECT 1 FROM c_plaid_costs WHERE month=? AND connection_id=? AND kind='settled' AND accounts=? AND account_monthly_minor=? AND usd_minor=? AND recorded_at=?)",
    params: [month, connection.id, settlement.accounts, settlement.account_monthly_minor, settlement.usd_minor, settlement.recorded_at] };
  const budget: Sql = { sql: `? IS NULL OR (${total})<=?`, params: [settings.monthly_cap_minor, month, settings.monthly_cap_minor] };
  const guard = all(auth, settled, budget);
  // Recheck before provider work as well as when the caller commits its sync result.
  await check(env, guard, 'The monthly Plaid cap pauses optional sync, or Plaid authority or configuration changed; reload');
  return { ...guard, after: guard };
}

/** Connected months accrue even without a sync. This clock-controlled scheduler never contacts Plaid. */
export async function settlePlaidMonths(env: Bindings, at: Date) {
  const month = monthAt(at), accountingAt = at.toISOString(), db = env.DB;
  const settings = await db.prepare('SELECT version,account_monthly_minor FROM c_plaid_settings WHERE id=1').first<Settings>();
  if (!settings) return;
  const connections = (await db.prepare("SELECT id,accounts FROM c_plaid_connections WHERE status='connected' AND connected_at<=? ORDER BY id").bind(accountingAt).all<Connection>()).results;
  for (const connection of connections) {
    if (await db.prepare("SELECT 1 FROM c_plaid_costs WHERE month=? AND connection_id=? AND kind='settled'").bind(month,connection.id).first()) continue;
    const accounts = JSON.parse(connection.accounts).length, cost = accounts * settings.account_monthly_minor;
    requireThat(accounts > 0 && Number.isSafeInteger(cost), 'Reconnect Plaid to verify this account-month estimate',409);
    const state: Sql = {sql:"EXISTS(SELECT 1 FROM c_plaid_connections WHERE id=? AND status='connected' AND accounts=? AND connected_at<=?) AND EXISTS(SELECT 1 FROM c_plaid_settings WHERE id=1 AND version=?)",params:[connection.id,connection.accounts,accountingAt,settings.version]};
    const missing: Sql = {sql:"NOT EXISTS(SELECT 1 FROM c_plaid_costs WHERE month=? AND connection_id=? AND kind='settled')",params:[month,connection.id]};
    await commit(db,all(state,missing),[
      db.prepare("INSERT INTO c_plaid_costs VALUES(?,?,'settled',?,?,?,?)").bind(month,connection.id,accounts,settings.account_monthly_minor,cost,at.toISOString()),
      ruleEvent(db,'automation: Plaid account months','plaid-month-settled',{}, {connection:connection.id,month,accounts,accountMonthlyMinor:settings.account_monthly_minor,estimatedUsdMinor:cost,channel:'scheduled'}),
    ]);
  }
}
