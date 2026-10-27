import type { Bindings } from '../../auth.server';
import { seal, unseal } from '../public-api/crypto';
import { all, authority, commit, need, sha256Hex, type Sql } from '../session';
import { needRow, rowAuthority } from '../permissions';
import { event } from '../events';
import { amount, Fault, now, requireThat, text, uid, type Actor, type Data } from '../types';
import { plaidJson, type Credentials } from './network';

type Settings = { version: number; credentials_sealed: string; account_monthly_minor: number; monthly_cap_minor: number | null };
type Connection = { status: string; id: string; scope: string; personal_email: string | null; item_id: string; credentials_sealed: string; accounts: string; connected_by: string; connected_at: string };
const settings = (env: Bindings) => env.DB.prepare('SELECT * FROM c_plaid_settings WHERE id=1').first<Settings>();
const month = () => now().slice(0, 7);
const costTotal = "SELECT COALESCE(SUM(c.usd_minor),0) FROM c_plaid_costs c WHERE c.month=? AND (c.kind='settled' OR NOT EXISTS(SELECT 1 FROM c_plaid_costs s WHERE s.month=c.month AND s.connection_id=c.connection_id AND s.kind='settled'))";
const usage = async (env: Bindings) => (await env.DB.prepare(`SELECT (${costTotal}) AS total`).bind(month()).first<{total:number}>())!.total;
function native(actor: Actor, companyDelegate = false) {
  requireThat(actor.kind === 'person' && (!actor.delegate || companyDelegate) && !actor.publicCredential, 'Use your own native session to connect Plaid', 403);
}
async function recent(env: Bindings, actor: Actor): Promise<Sql> {
  const condition = { sql: 'EXISTS(SELECT 1 FROM oa_sessions WHERE id=? AND created_at>=unixepoch()*1000-600000)', params: [actor.session] };
  requireThat(await env.DB.prepare(`SELECT (${condition.sql}) AS ok`).bind(...condition.params).first<{ok:number}>().then(r=>r?.ok), 'Sign in again before connecting Plaid; a sign-in from the last 10 minutes is required', 401);
  return condition;
}
async function permission(env: Bindings, actor: Actor, scope: string) {
  requireThat(scope === 'company' || scope === 'personal', 'Choose company or personal');
  native(actor, scope === 'company');
  if (scope === 'company') { needRow(actor, 'connections'); return all(rowAuthority(actor, 'connections'), await recent(env, actor)); }
  need(actor, 'employee'); return all(authority(actor, 'employee'), await recent(env, actor));
}
const settingsState = (s: Settings): Sql => ({ sql: 'EXISTS(SELECT 1 FROM c_plaid_settings WHERE id=1 AND version=?)', params: [s.version] });
async function check(env: Bindings, condition: Sql) {
  requireThat(await env.DB.prepare(`SELECT (${condition.sql}) AS ok`).bind(...condition.params).first<{ ok: number }>().then(r => r?.ok), 'Plaid authority or configuration changed; reload', 409);
}
async function open(env: Bindings, label: string, encrypted: string) {
  try { return JSON.parse(await unseal(env.SESSION_SECRET, label, encrypted)) as Credentials; }
  catch { throw new Fault(409, 'Plaid credentials cannot be opened in this installation; reconnect explicitly'); }
}
export async function plaidSettings(env: Bindings, actor: Actor) {
  native(actor); need(actor, 'owner');
  const s = await settings(env);
  return { configured: !!s, version: s?.version ?? 0, environment: 'sandbox', accountMonthlyMinor: s?.account_monthly_minor ?? null, monthlyCapMinor: s?.monthly_cap_minor ?? null, month: month(), monthToDateMinor: await usage(env), basis: 'Owner-configured USD estimate per connected account; not a provider invoice. Each exchange reserves at least one full account month; verified accounts settle the full estimate. Unknown outcomes retain reservations and overruns pause activation. Disconnect does not refund estimates. No provider billing guarantee is made.' };
}
export async function savePlaidSettings(env: Bindings, actor: Actor, body: Data) {
  native(actor); need(actor, 'owner');
  requireThat(body.consent === true, 'Explicitly authorize this Plaid sandbox application');
  const signIn = await recent(env, actor), previous = await settings(env), version = previous?.version ?? 0;
  requireThat(body.version === version, 'Reload Plaid settings before saving', 409);
  const credentials = { client_id: text(body.clientId, 'Plaid client id', 200), secret: text(body.secret, 'Plaid sandbox secret', 500) };
  const price = amount(body.accountMonthly, 'USD per account per month'), cap = body.monthlyCap === '' || body.monthlyCap == null ? null : amount(body.monthlyCap, 'Monthly USD cap');
  await commit(env.DB, all(authority(actor, 'owner'), signIn, { sql: 'COALESCE((SELECT version FROM c_plaid_settings WHERE id=1),0)=?', params: [version] }), [
    env.DB.prepare('INSERT INTO c_plaid_settings VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,credentials_sealed=excluded.credentials_sealed,account_monthly_minor=excluded.account_monthly_minor,monthly_cap_minor=excluded.monthly_cap_minor,set_by=excluded.set_by,set_at=excluded.set_at').bind(version + 1, await seal(env.SESSION_SECRET, 'plaid-settings', JSON.stringify(credentials)), price, cap, actor.email, now()),
    event(env.DB, actor, 'plaid-settings-saved', {}, { version: version + 1, environment: 'sandbox', accountMonthlyMinor: price, monthlyCapMinor: cap, consent: true }),
  ]);
  return plaidSettings(env, actor);
}
export async function createPlaidLink(env: Bindings, actor: Actor, body: Data) {
  const scope = body.scope, auth = await permission(env, actor, scope), s = await settings(env);
  requireThat(s, 'The owner must configure Plaid sandbox credentials and USD costs first', 409);
  requireThat(body.consent === true, 'Explicitly authorize sharing this connection with Plaid sandbox');
  requireThat(s.monthly_cap_minor === null || (await usage(env)) + s.account_monthly_minor <= s.monthly_cap_minor, 'The owner monthly Plaid cap pauses new connections; manual claims remain available', 409);
  const id = uid();
  await check(env, all(auth, settingsState(s)));
  const credentials = await open(env, 'plaid-settings', s.credentials_sealed);
  const result = await plaidJson(credentials, '/link/token/create', { user: { client_user_id: id }, client_name: 'Coaster', products: ['transactions'], country_codes: ['US'], language: 'en', account_filters: { credit: { account_subtypes: ['credit card'] }, ...(scope === 'company' ? { depository: { account_subtypes: ['checking', 'savings'] } } : {}) } });
  const expiration = Date.parse(result.expiration);
  requireThat(typeof result.link_token === 'string' && Number.isFinite(expiration) && expiration > Date.now(), 'Plaid returned an invalid Link token', 502);
  await commit(env.DB, all(auth, settingsState(s)), [
    env.DB.prepare('INSERT INTO c_plaid_links(id,member_email,session_id,scope,settings_version,expires_at,delegate_grant) VALUES(?,?,?,?,?,?,?)').bind(id, actor.email, actor.session!, scope, s.version, expiration, actor.delegate?.grant ?? null),
    event(env.DB, actor, 'plaid-link-started', {}, { link: id, scope, environment: 'sandbox', consent: true, channel: 'app' }),
  ]);
  return { id, linkToken: result.link_token, expiration: result.expiration, environment: 'sandbox', accountMonthlyMinor: s.account_monthly_minor, notice: 'No transaction sync or expense creation is enabled in this foundation.' };
}
export async function exchangePlaidLink(env: Bindings, actor: Actor, body: Data) {
  native(actor, true);
  const id = text(body.link, 'Link request', 100), s = await settings(env);
  requireThat(s, 'Configure Plaid sandbox first', 409);
  const flow = await env.DB.prepare('SELECT * FROM c_plaid_links WHERE id=?').bind(id).first<Data>();
  requireThat(flow && flow.member_email === actor.email && flow.session_id === actor.session && flow.delegate_grant === (actor.delegate?.grant ?? null), 'This Link request belongs to another native session', 403);
  const auth = await permission(env, actor, flow.scope), token = text(body.publicToken, 'Plaid public token', 1000);
  requireThat(body.consent === true, 'Explicitly confirm the accounts returned by Plaid Link');
  const state: Sql = { sql: 'EXISTS(SELECT 1 FROM c_plaid_links WHERE id=? AND reserved_at IS NULL AND expires_at>? AND settings_version=?)', params: [id, Date.now(), s.version] };
  const reserve = { sql: 'NOT EXISTS(SELECT 1 FROM c_plaid_links WHERE public_token_hash=?)', params: [await sha256Hex(token)] };
  const connection = uid(), at = now(), currentMonth = month();
  const initialBudget: Sql = { sql: `? IS NULL OR (${costTotal})+?<=?`, params: [s.monthly_cap_minor,currentMonth,s.account_monthly_minor,s.monthly_cap_minor] };
  const before = all(auth, settingsState(s), state, reserve, initialBudget);
  const credentials = await open(env, 'plaid-settings', s.credentials_sealed);
  // Consuming the request before exchange forbids concurrent replay and automatic retries after uncertainty.
  await commit(env.DB, before, [env.DB.prepare('UPDATE c_plaid_links SET reserved_at=?,public_token_hash=? WHERE id=?').bind(now(), await sha256Hex(token), id), env.DB.prepare("INSERT INTO c_plaid_costs VALUES(?,?,'reserved',1,?,?,?)").bind(currentMonth,connection,s.account_monthly_minor,s.account_monthly_minor,at), event(env.DB, actor, 'plaid-exchange-reserved', {}, { link: id, connection, scope: flow.scope, channel: 'app' })]);
  const response = await plaidJson(credentials, '/item/public_token/exchange', { public_token: token });
  requireThat(typeof response.access_token === 'string' && typeof response.item_id === 'string', 'Plaid returned an invalid connection', 502);
  const access = { ...credentials, access_token: response.access_token };
  await commit(env.DB, all(auth, settingsState(s)), [env.DB.prepare("INSERT INTO c_plaid_connections VALUES(?,?,?,?,?,'pending','[]',?,?)").bind(connection, flow.scope, flow.scope === 'personal' ? actor.email : null, response.item_id, await seal(env.SESSION_SECRET, 'plaid:' + connection, JSON.stringify(access)), actor.email, at), event(env.DB, actor, 'plaid-connection-pending', {}, { connection, scope: flow.scope, channel: 'app' })]);
  // Preserve custody for explicit disconnection if validation, configuration or the cap refuses activation.
  await check(env, all(auth, settingsState(s)));
  const result = await plaidJson(access, '/accounts/get');
  requireThat(result.item?.item_id === response.item_id && Array.isArray(result.accounts) && result.accounts.length > 0 && result.accounts.length <= 100, 'Plaid returned incomplete account ownership', 502);
  const accounts = result.accounts.map((a: Data) => {
    requireThat(typeof a.account_id === 'string' && /^\d{4}$/.test(a.mask) && ((a.type === 'credit' && a.subtype === 'credit card') || (flow.scope === 'company' && a.type === 'depository' && ['checking', 'savings'].includes(a.subtype))), 'Only masked US card accounts and company checking or savings accounts are supported', 409);
    return { id: a.account_id, last4: a.mask, type: a.type, subtype: a.subtype };
  });
  requireThat(new Set(accounts.map((a: Data) => a.id)).size === accounts.length, 'Plaid returned duplicate accounts', 502);
  const cost = accounts.length * s.account_monthly_minor;
  const pending: Sql = { sql: "EXISTS(SELECT 1 FROM c_plaid_connections WHERE id=? AND status='pending')", params: [connection] };
  await commit(env.DB,all(auth,settingsState(s),pending),[
    env.DB.prepare("INSERT INTO c_plaid_costs VALUES(?,?,'settled',?,?,?,?)").bind(currentMonth,connection,accounts.length,s.account_monthly_minor,cost,now()),
    env.DB.prepare('UPDATE c_plaid_connections SET accounts=? WHERE id=?').bind(JSON.stringify(accounts),connection),
    event(env.DB,actor,'plaid-accounts-verified',{}, {connection,accounts:accounts.length,estimatedUsdMinor:cost,channel:'app'}),
  ]);
  const budget: Sql = { sql: `? IS NULL OR (${costTotal})<=?`, params: [s.monthly_cap_minor,currentMonth,s.monthly_cap_minor] };
  await commit(env.DB, all(auth, settingsState(s), budget, { sql: "EXISTS(SELECT 1 FROM c_plaid_connections WHERE id=? AND status='pending')", params: [connection] }), [
    env.DB.prepare("UPDATE c_plaid_connections SET status='connected',accounts=? WHERE id=?").bind(JSON.stringify(accounts), connection),
    event(env.DB, actor, 'plaid-connected', {}, { connection, scope: flow.scope, accounts: accounts.length, environment: 'sandbox', estimatedUsdMinor: cost, channel: 'app' }),
  ]);
  return { id: connection, scope: flow.scope, accounts, estimatedUsdMinor: cost, environment: 'sandbox' };
}
export async function plaidConnections(env: Bindings, actor: Actor) {
  native(actor, true);
  const rows = (await env.DB.prepare('SELECT id,scope,personal_email,status,accounts,connected_at FROM c_plaid_connections ORDER BY connected_at,id').all<Connection>()).results;
  return { environment: 'sandbox', connections: rows.filter(c => c.scope === 'personal' ? !actor.delegate && c.personal_email === actor.email : actor.roles.owner || actor.roles.admin || actor.roles.finance).map(c => ({ id: c.id, scope: c.scope, status: c.status, accounts: JSON.parse(c.accounts), connectedAt: c.connected_at })), transactionSync: false };
}
export async function disconnectPlaid(env: Bindings, actor: Actor, id: string) {
  native(actor, true);
  const c = await env.DB.prepare('SELECT * FROM c_plaid_connections WHERE id=?').bind(id).first<Connection>();
  requireThat(c, 'Plaid connection not found', 404);
  requireThat(c.scope !== 'personal' || c.personal_email === actor.email, 'Only the personal card owner disconnects it', 403);
  const auth = await permission(env, actor, c.scope), state: Sql = { sql: 'EXISTS(SELECT 1 FROM c_plaid_connections WHERE id=? AND credentials_sealed=?)', params: [id, c.credentials_sealed] };
  await check(env, all(auth, state));
  await plaidJson(await open(env, 'plaid:' + id, c.credentials_sealed), '/item/remove');
  await commit(env.DB, all(auth, state), [env.DB.prepare('DELETE FROM c_plaid_connections WHERE id=?').bind(id), event(env.DB, actor, 'plaid-disconnected', {}, { connection: id, scope: c.scope, providerRemovalConfirmed: true, channel: 'app' })]);
  return { disconnected: true };
}
