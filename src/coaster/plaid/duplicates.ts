import type { ClaimItem } from '../exceptions';
import { normalDescriptor } from '../cards/statement';
import { requireThat, type Data } from '../types';
import type { Sql } from '../session';

/** Removing a native personal-feed expense does not erase its once-only financial source identity. */
export async function noPersonalFeedDuplicates(db: D1Database, employee: string, items: ClaimItem[]): Promise<Sql> {
  const from = "FROM c_plaid_sources s JOIN c_plaid_transactions t ON t.transaction_id=s.transaction_id WHERE t.employee_email=? AND t.scope='personal'";
  const rows = (await db.prepare(`SELECT t.item_id,CAST(s.bytes AS TEXT) AS facts ${from}`).bind(employee).all<Data>()).results;
  for (const item of items) {
    const duplicate = rows.some(row => { const fact=JSON.parse(row.facts);return row.item_id!==item.id && fact.spent_on===item.spent_on && fact.amount_minor===item.amount_minor && normalDescriptor(fact.merchant)===normalDescriptor(item.merchant); });
    requireThat(!duplicate, 'This purchase already has a personal Plaid source expense; reconcile that expense before entering it again',409);
  }
  return {sql:`(SELECT COUNT(*) ${from})=?`,params:[employee,rows.length]};
}
