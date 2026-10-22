import { now, optionalText, requireThat, type Data } from '../types';
import { catalogState, codingCatalog, offeredValue } from './model';
import type { Sql } from '../session';

export type CategoryAccount = { id: string; dimension: string; name: string; source: 'native' | 'quickbooks'; sourceCompany: string; sourceId: string; selectedAt: string };
/** Omission preserves the explicit mapping; an empty choice clears it. Native export account codes are independent. */
export async function categoryAccountInput(db: D1Database, input: unknown, previous?: Data | null): Promise<{ id: string | null; snapshot: string; guards: Sql[] }> {
  if (input === undefined) return { id: previous?.ledger_account_id ?? null, snapshot: previous?.ledger_account_snapshot ?? '{}', guards: [] };
  const id = optionalText(input, 'Chart account', 100);
  if (!id) return { id: null, snapshot: '{}', guards: [] };
  const catalog = await codingCatalog(db), value = catalog.values.find(v => v.id === id), dimension = catalog.dimensions.find(d => d.id === value?.dimension_id);
  requireThat(value && dimension?.kind === 'account' && offeredValue(catalog,value), 'Choose an active chart account; the selected mapping is unavailable');
  const snapshot: CategoryAccount = { id: value.id, dimension: dimension.id, name: value.name, source: dimension.source, sourceCompany: dimension.source_company, sourceId: value.source_id, selectedAt: now() };
  return { id, snapshot: JSON.stringify(snapshot), guards: [catalogState(catalog.version)] };
}
/** Expose saved provenance beside current availability. A provider refresh never rewrites the selected mapping. */
export async function categoryAccountViews<T extends Data>(db: D1Database, rows: T[]) {
  const catalog = rows.some(r => r.ledger_account_id) ? await codingCatalog(db) : null;
  return rows.map(row => {
    const value = catalog?.values.find(v => v.id === row.ledger_account_id), dimension = catalog?.dimensions.find(d => d.id === value?.dimension_id);
    return { ...row, ledger_account: row.ledger_account_id ? JSON.parse(row.ledger_account_snapshot) as CategoryAccount : null,
      ledger_account_available: !!(catalog && value && dimension?.kind === 'account' && offeredValue(catalog,value)) };
  });
}
