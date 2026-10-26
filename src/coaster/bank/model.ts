import { RELEASE_SIGN_IN_MINUTES } from '../batches';
import { authority, need, type Sql } from '../session';
import { requireThat, type Actor } from '../types';

export type Provider = 'plaid' | 'stripe';
export const PROVIDERS: Provider[] = ['plaid', 'stripe'];
export type Account = { id: string; member_email: string; provider: Provider; method: 'instant' | 'microdeposit'; state: 'pending' | 'active' | 'replaced' | 'abandoned'; token_sealed: string | null; last4: string; label: string; created_at: string; verified_at: string | null; replaced_at: string | null; previous_id: string | null; hold_days: number | null; hold_until: string | null; hold_released_at: string | null };
export type Member = { email: string; name: string; member_id: string };

/** An employee's own bank details are theirs alone: a native session, never a delegate, agent key or public credential. */
export function nativeSelf(actor: Actor) {
  requireThat(actor.kind === 'person' && !actor.delegate && !actor.publicCredential, 'Bank details are changed only by the person themselves, signed in to their own session', 403);
  requireThat(actor.roles.employee, 'Only people who submit expenses have a bank account here', 403);
  return authority(actor);
}
/** Provider credentials and the cooling-off period's provider side belong to the owner's own native session. */
export function nativeOwner(actor: Actor) {
  need(actor, 'owner');
  requireThat(actor.kind === 'person' && !actor.delegate && !actor.publicCredential, 'Use the owner’s own native session for bank verification providers', 403);
  return authority(actor, 'owner');
}
/** Finance and the owner read statuses; a delegate never does, whoever they act for. */
export function noDelegate(actor: Actor) {
  requireThat(actor.kind === 'person' && !actor.delegate && !actor.publicCredential, 'Bank details are not available to delegates, agents or public credentials', 403);
}
/** Changing bank details needs a sign-in within the last 10 minutes, as a release does (SEC-001); sessions are never extended. */
export function recentSignIn(actor: Actor): Sql {
  return { sql: 'EXISTS(SELECT 1 FROM oa_sessions WHERE id=? AND created_at>=unixepoch()*1000-?)', params: [actor.session, RELEASE_SIGN_IN_MINUTES * 60_000] };
}
export async function requireRecentSignIn(db: D1Database, actor: Actor) {
  const recent = recentSignIn(actor);
  requireThat(await db.prepare(`SELECT (${recent.sql}) AS ok`).bind(...recent.params).first<{ ok: number }>().then(r => r?.ok), `Sign in again to change bank details: a sign-in within the last ${RELEASE_SIGN_IN_MINUTES} minutes is required`, 401);
}
export const activeMember = (db: D1Database, address: string) => db.prepare('SELECT email,name,member_id FROM c_members WHERE email=? AND active=1').bind(address).first<Member>();
export const accountOf = (db: D1Database, address: string, state: Account['state']) => db.prepare('SELECT * FROM c_bank_accounts WHERE member_email=? AND state=?').bind(address, state).first<Account>();
export const holdDays = async (db: D1Database) => (await db.prepare('SELECT hold_days FROM c_bank_settings WHERE id=1').first<{ hold_days: number }>())!.hold_days;
export const providerConnected = async (db: D1Database) => new Set((await db.prepare('SELECT provider FROM c_bank_providers').all<{ provider: Provider }>()).results.map(r => r.provider));

/** What a person or finance sees: status and last four, never the token. */
export const publicAccount = (a: Account | null) => a && { id: a.id, provider: a.provider, method: a.method, state: a.state, last4: a.last4, label: a.label, createdAt: a.created_at, verifiedAt: a.verified_at, holdDays: a.hold_days, holdUntil: a.hold_until, held: a.hold_until !== null && a.hold_released_at === null, holdReleasedAt: a.hold_released_at };
export const sealId = (id: string) => 'bank:' + id;
export const providerSealId = (provider: Provider) => 'bank-provider:' + provider;
