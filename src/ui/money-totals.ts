import { money, type D } from './api';

/** Keep native currencies separate; an empty collection retains the screen's default zero. */
export function moneyTotals(rows: readonly D[], defaultCurrency: string): string {
  const byCurrency = new Map<string, number>();
  for (const row of rows) byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + row.total_minor);
  return byCurrency.size
    ? [...byCurrency].map(([currency, total]) => `${money(total, currency)}${currency === 'USD' ? ' USD' : ''}`).join(' · ')
    : money(0, defaultCurrency);
}
