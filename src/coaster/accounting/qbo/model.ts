import type { Bindings } from '../../../auth.server';
import { rowAuthority, needRow, can, type Row } from '../../permissions';
import { requireThat, type Actor } from '../../types';
import type { Sql } from '../../session';

export interface QboBindings extends Bindings {
  QBO_CLIENT_ID?: string;
  QBO_CLIENT_SECRET?: string;
  QBO_ENVIRONMENT?: 'sandbox' | 'production';
}
export type Environment = 'sandbox' | 'production';
export type Connection = { id: number; realm_id: string; environment: Environment; tokens_sealed: string; version: number; refresh_hour: number; last_refresh_day: string | null; last_refresh_at: string | null; last_error: string | null; connected_by: string; connected_at: string; lease_id: string | null; lease_until: number };
export type Tokens = { access: string; refresh: string; expires: number; refreshExpires: number };
export const connection = (db: D1Database) => db.prepare('SELECT * FROM c_qbo_connections WHERE id=1').first<Connection>();
export const connectionState = (version: number): Sql => ({ sql: 'COALESCE((SELECT version FROM c_qbo_connections WHERE id=1),0)=?', params: [version] });
export const callbackUri = (env: QboBindings) => env.AUTH_ORIGIN + '/api/coaster/accounting/qbo/callback';
export const companyKey = (c: Pick<Connection, 'realm_id' | 'environment'>) => `${c.environment}:${c.realm_id}`;
export function config(env: QboBindings) {
  requireThat(env.QBO_CLIENT_ID && env.QBO_CLIENT_SECRET, 'Configure the private QuickBooks app credentials before connecting', 409);
  const environment = env.QBO_ENVIRONMENT ?? 'sandbox';
  requireThat(environment === 'sandbox' || environment === 'production', 'QuickBooks environment must be sandbox or production', 409);
  return { client: env.QBO_CLIENT_ID, secret: env.QBO_CLIENT_SECRET, environment: environment as Environment };
}
/** OAuth consent is bound to the person's own native session, never a delegate or API credential. */
export function nativeAuthority(actor: Actor, row: Row) {
  requireThat(actor.kind === 'person' && !actor.publicCredential && !actor.delegate, 'Use your own native session for this QuickBooks connection', 403);
  needRow(actor, row);
  return rowAuthority(actor, row);
}
export const publicConnection = (c: Connection | null) => c ? { connected: true, realm: c.realm_id, environment: c.environment, version: c.version, hour: c.refresh_hour, lastRefreshAt: c.last_refresh_at, lastRefreshDay: c.last_refresh_day, error: c.last_error, connectedAt: c.connected_at } : { connected: false };

export async function qboStatus(env: QboBindings, actor: Actor) {
  nativeAuthority(actor, can(actor, 'connections') ? 'connections' : 'sync');
  return { ...publicConnection(await connection(env.DB)), configured: !!(env.QBO_CLIENT_ID && env.QBO_CLIENT_SECRET), environment: env.QBO_ENVIRONMENT ?? 'sandbox', callback: callbackUri(env) };
}
