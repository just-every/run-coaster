import type { Sql } from '../session';
import { requireThat } from '../types';

/** Provider corrections cannot silently rewrite frozen expenses or permit payment of disputed source facts. */
export async function requirePlaidClear(db: D1Database, claim: string): Promise<Sql> {
  const guard = { sql: "NOT EXISTS(SELECT 1 FROM c_plaid_transactions t JOIN c_items i ON i.id=t.item_id WHERE i.claim_id=? AND (t.status='review' OR EXISTS(SELECT 1 FROM c_plaid_sync_state sync WHERE sync.connection_id=t.connection_id AND sync.in_progress=1) OR (t.scope='personal' AND EXISTS(SELECT 1 FROM c_plaid_transactions credit WHERE credit.account_id=t.account_id AND credit.employee_email=t.employee_email AND credit.scope='personal' AND credit.status='credit'))))", params: [claim] };
  requireThat(await db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(claim).first(), 'A Plaid posted correction, removal or personal credit needs reconciliation before submission or payment', 409);
  return guard;
}
export function plaidBatchClear(id: string): Sql {
  return { sql: "NOT EXISTS(SELECT 1 FROM c_batch_claims bc JOIN c_items i ON i.claim_id=bc.claim_id JOIN c_plaid_transactions t ON t.item_id=i.id WHERE bc.batch_id=? AND (t.status='review' OR EXISTS(SELECT 1 FROM c_plaid_sync_state sync WHERE sync.connection_id=t.connection_id AND sync.in_progress=1) OR (t.scope='personal' AND EXISTS(SELECT 1 FROM c_plaid_transactions credit WHERE credit.account_id=t.account_id AND credit.employee_email=t.employee_email AND credit.scope='personal' AND credit.status='credit'))))", params: [id] };
}
export async function requirePlaidBatchClear(db: D1Database, id: string) {
  const guard = plaidBatchClear(id);
  requireThat(await db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(id).first(), 'A Plaid posted correction, removal or personal credit needs reconciliation before releasing or recording payment', 409);
}
