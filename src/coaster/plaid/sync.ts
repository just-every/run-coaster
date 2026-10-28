import type { Bindings } from '../../auth.server';
import { all, commit, type Sql } from '../session';
import { event } from '../events';
import { runCardMatching } from '../receipts/card-matching';
import { now, requireThat, uid, type Actor, type Data } from '../types';
import { openPlaid } from './connections';
import { plaidAccess } from './accounts';
import { reservePlaidMonth } from './metering';
import { syncPages } from './pages';
import { financialBatch, prepareSync } from './sync-batch';

type State = { version: number; cursor: string; in_progress: number; attempt_id: string | null; lease_until: number | null };
const leaseMilliseconds = 120000;
async function check(db: D1Database, guard: Sql) {
  requireThat(await db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.params).first(), 'Plaid authority, connection or cursor changed; reload', 409);
}

/** Fetch all pages, then commit bounded batches under one renewable, exclusive attempt. */
export async function syncPlaid(env: Bindings, actor: Actor, id: string) {
  const db = env.DB, { connection: c, guard: access } = await plaidAccess(env, actor, id);
  requireThat(c.status === 'connected', 'Verify this connection before syncing', 409);
  const state = await db.prepare('SELECT * FROM c_plaid_sync_state WHERE connection_id=?').bind(id).first<State>() ?? { version: 0, cursor: '', in_progress: 0, attempt_id: null, lease_until: null };
  const stable: Sql = { sql: `COALESCE((SELECT version FROM c_plaid_sync_state WHERE connection_id=?),0)=?
    AND COALESCE((SELECT cursor FROM c_plaid_sync_state WHERE connection_id=?),'')=?
    AND (SELECT attempt_id FROM c_plaid_sync_state WHERE connection_id=?) IS ?
    AND (SELECT lease_until FROM c_plaid_sync_state WHERE connection_id=?) IS ?
    AND (? IS NULL OR ?<=unixepoch()*1000)`,
    params: [id, state.version, id, state.cursor, id, state.attempt_id, id, state.lease_until, state.attempt_id, state.lease_until] };
  const paid = await reservePlaidMonth(env, actor, c, access);
  const assignments = (await db.prepare('SELECT * FROM c_plaid_assignments WHERE connection_id=? ORDER BY account_id').bind(id).all<Data>()).results;
  requireThat(assignments.length === JSON.parse(c.accounts).length, 'Assign every verified account to an active cardholder and category before syncing', 409);
  const credentials = await openPlaid(env, 'plaid:' + id, c.credentials_sealed);
  const { changes, cursor, pages } = await syncPages(credentials, state.cursor, new Set((JSON.parse(c.accounts) as Data[]).map(a => a.id)), () => check(db, all(paid, stable)));
  await check(db, all(paid, stable));
  const plan = await prepareSync(db, c, assignments, changes), attempt = uid();
  // A new explicit sync can take over an expired attempt, replaying from its unchanged cursor.
  // Exact source identities already committed by that attempt are reused by prepareSync.
  // Reserving advances the state version, fencing snapshots from even a released failed attempt.
  const owner: Sql = { sql: 'EXISTS(SELECT 1 FROM c_plaid_sync_state WHERE connection_id=? AND version=? AND cursor=? AND in_progress=1 AND attempt_id=?)', params: [id, state.version + 1, state.cursor, attempt] };
  const live = all(owner, { sql: 'EXISTS(SELECT 1 FROM c_plaid_sync_state WHERE connection_id=? AND lease_until>unixepoch()*1000)', params: [id] });
  const extend = () => db.prepare('UPDATE c_plaid_sync_state SET lease_until=? WHERE connection_id=?').bind(Date.now() + leaseMilliseconds, id);
  await commit(db, all(paid, stable), [
    db.prepare(`INSERT INTO c_plaid_sync_state(connection_id,version,cursor,in_progress,attempt_id,lease_until) VALUES(?,?,?,1,?,?)
      ON CONFLICT(connection_id) DO UPDATE SET version=excluded.version,in_progress=1,attempt_id=excluded.attempt_id,lease_until=excluded.lease_until`)
      .bind(id, state.version + 1, state.cursor, attempt, Date.now() + leaseMilliseconds),
    event(db, actor, 'plaid-sync-started', {}, { connection: id, attempt, channel: 'app' }),
  ]);
  let expenses = 0;
  try {
    for (let offset = 0; offset < plan.rows.length;) {
      await commit(db, all(paid, live), [extend()]);
      let count = Math.min(25, plan.rows.length - offset);
      let batch, condition: Sql;
      // Different cardholders and coding rules can add more fences than an ordinary month.
      // Reduce only this batch until its guard fits D1's 100 bound-parameter limit.
      for (;;) {
        batch = await financialBatch(env, actor, c, assignments, plan, plan.rows.slice(offset, offset + count).map(row => ({ ...row })));
        const guards = [...new Map(batch.guards.map(g => [JSON.stringify(g), g])).values()];
        condition = all(paid, live, ...guards);
        if (condition.params.length <= 100) break;
        requireThat(count > 1, 'Plaid financial guards exceed the database parameter limit; the cursor was not advanced', 409);
        count = Math.max(1, Math.floor(count / 2));
      }
      await commit(db, condition, [...batch.writes, extend()]);
      expenses += batch.expenses;
      offset += count;
    }
    await commit(db, all(paid, live), [
      db.prepare('UPDATE c_plaid_sync_state SET version=?,cursor=?,last_sync_at=?,in_progress=0,attempt_id=NULL,lease_until=NULL WHERE connection_id=?').bind(state.version + 2, cursor, now(), id),
      event(db, actor, 'plaid-synced', {}, { connection: id, scope: c.scope, added: plan.added, modified: plan.modified, removed: plan.removed, expenses, pages, channel: 'app' }),
    ]);
  } catch (error) {
    // Retain the financial hold and old cursor. Only a complete explicit replay clears them.
    // An authority change can prevent release; the bounded lease then expires naturally.
    try { await commit(db, all(paid, owner), [db.prepare('UPDATE c_plaid_sync_state SET attempt_id=NULL,lease_until=NULL WHERE connection_id=?').bind(id)]); } catch { /* Ownership or authority has changed. */ }
    throw error;
  }
  await runCardMatching(db, new Date());
  return { added: plan.added, modified: plan.modified, removed: plan.removed, expenses, cursor };
}
