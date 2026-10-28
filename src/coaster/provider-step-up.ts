import type { Bindings } from '../auth.server';
import type { Sql } from './session';
import { requireThat, type Actor } from './types';

/** Keep this predicate inside the authority rechecked on both sides of a connection write. */
export async function recentProviderSignIn(env: Bindings, actor: Actor, action: string): Promise<Sql> {
  const recent = { sql: 'EXISTS(SELECT 1 FROM oa_sessions WHERE id=? AND created_at>=unixepoch()*1000-600000)', params: [actor.session] };
  requireThat(await env.DB.prepare(`SELECT (${recent.sql}) AS ok`).bind(...recent.params).first<{ ok: number }>().then(row => row?.ok),
    `Sign in again before ${action}; a sign-in from the last 10 minutes is required`, 401);
  return recent;
}
