import type { Bindings } from '../../auth.server';
import { rowAuthority, needRow } from '../permissions';
import { requireThat, type Actor } from '../types';
import type { Data } from '../types';
import type { Sql } from '../session';

export type Feed = { id: string; issuer: string; credentials_sealed: string | null; mapping: string; category_id: string; cost_centre: string; interval_minutes: number; enabled: number; version: number; next_run_at: number; last_success_at: string | null; last_error: string | null; connected_by: string; connected_at: string; disconnected_at: string | null; lease_id: string | null; lease_until: number };
export const feed = (db: D1Database, id: string) => db.prepare('SELECT * FROM c_program_feeds WHERE id=?').bind(id).first<Feed>();
export const feedState = (id: string, version: number): Sql => ({ sql: 'EXISTS(SELECT 1 FROM c_program_feeds WHERE id=? AND version=? AND enabled=1)', params: [id, version] });
export function connectionAuthority(actor: Actor) {
  requireThat(actor.kind === 'person' && !actor.delegate && !actor.publicCredential, 'Use your own native sign-in to connect a program feed', 403);
  needRow(actor, 'connections'); return rowAuthority(actor, 'connections');
}
export const publicFeed = (f: Feed) => ({ id: f.id, issuer: f.issuer, kind: 'sftp-pull-csv', enabled: !!f.enabled, version: f.version, intervalMinutes: f.interval_minutes, nextRunAt: f.next_run_at, lastSuccessAt: f.last_success_at, error: f.last_error, connectedAt: f.connected_at, disconnectedAt: f.disconnected_at, mapping: JSON.parse(f.mapping) as Data, category: f.category_id, costCentre: f.cost_centre });

/** Production destinations are explicit global IPv4 literals; there is no DNS or private-address fallback. */
export function permittedHost(env: Bindings, host: string) {
  const pieces = host.split('.'), nums = pieces.map(Number);
  const ipv4 = pieces.length === 4 && pieces.every((s,i) => /^\d{1,3}$/.test(s) && String(nums[i]) === s && nums[i] <= 255);
  const [a,b] = nums;
  const global = ipv4 && a >= 1 && a < 224 && ![10,127].includes(a) && !(a===169&&b===254) && !(a===172&&b>=16&&b<=31) && !(a===192&&(b===168||b===0||b===2)) && !(a===198&&(b===18||b===19||b===51)) && !(a===203&&b===0) && !(a===100&&b>=64&&b<=127);
  const localOrigin = env.RER_DEV_ORIGIN && new URL(env.RER_DEV_ORIGIN).origin === env.AUTH_ORIGIN && ['localhost','127.0.0.1','[::1]'].includes(new URL(env.RER_DEV_ORIGIN).hostname);
  requireThat(global || host === '127.0.0.1' && env.AUTH_LOCAL === 'true' && localOrigin, 'Use an explicit public IPv4 SFTP host; local loopback is available only in native local development', 400);
}
