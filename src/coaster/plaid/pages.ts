import { normalDescriptor } from '../cards/statement';
import { requireThat, text } from '../types';
import { plaidJson, type Credentials } from './network';
import { transactionFacts, type Transaction } from './transactions';

export type Change = { kind: 'added' | 'modified' | 'removed'; tx?: Transaction; merchants?: string[]; removed?: string };

/** No financial writes until every page is valid: postings can follow pending removals. */
export async function syncPages(credentials: Credentials, startingCursor: string, accounts: Set<string>, beforeRequest: () => Promise<void>) {
  const changes: Change[] = [];
  let cursor = startingCursor, pages = 0, more = true, received = 0;
  while (more) {
    await beforeRequest();
    const page = await plaidJson(credentials, '/transactions/sync', { ...(cursor ? { cursor } : {}), count: 100 });
    requireThat(Array.isArray(page.added) && Array.isArray(page.modified) && Array.isArray(page.removed) && typeof page.has_more === 'boolean', 'Plaid returned an incomplete sync page', 502);
    const next = text(page.next_cursor, 'Plaid next cursor', 2000);
    requireThat(!page.has_more || next !== cursor, 'Plaid did not advance its sync cursor', 502);
    for (const kind of ['added', 'modified'] as const) for (const raw of page[kind]) {
      if (!accounts.has(raw.account_id)) continue;
      changes.push({ kind, tx: transactionFacts(raw), merchants: [raw.name, raw.merchant_name].filter((value): value is string => typeof value === 'string' && value.length > 0).map(normalDescriptor) });
    }
    for (const raw of page.removed) changes.push({ kind: 'removed', removed: text(raw.transaction_id, 'Removed transaction id', 200) });
    received += page.added.length + page.modified.length + page.removed.length;
    requireThat(received <= 10000 && ++pages <= 100, 'This sync update exceeds the bounded import size; no cursor or expense was committed', 409);
    cursor = next; more = page.has_more;
  }
  return { changes, cursor, pages };
}
