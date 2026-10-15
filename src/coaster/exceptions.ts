import type { Business } from './settings';
import type { Category } from './items';
import type { Data } from './types';

export type PolicyException = { item: string; code: 'missing-receipt' | 'over-limit' | 'duplicate-receipt' | 'possible-duplicate'; message: string };
export type ClaimItem = Data & { id: string; kind: string; spent_on: string; merchant: string; amount_minor: number; receipt_id: string | null; receipt_sha256?: string | null; allocations: Data[] };

const normal = (merchant: string) => merchant.trim().toLowerCase().replace(/\s+/g, ' ');
const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

/** The one key an exact expense reimburses under: its receipt bytes, or without a receipt its full description. */
export function exactKey(employee: string, item: ClaimItem) {
  return item.receipt_sha256 ? `receipt:${item.receipt_sha256}` : `expense:${employee}|${item.spent_on}|${item.kind}|${normal(item.merchant)}|${item.amount_minor}`;
}

/** Policy exceptions for a claim's current items. They are recorded with each submission and never hidden. */
export async function findExceptions(db: D1Database, claim: { id: string; employee_email: string }, items: ClaimItem[], business: Business, known: Category[]): Promise<PolicyException[]> {
  const found: PolicyException[] = [];
  const byId = new Map(known.map(c => [c.id, c]));
  for (const item of items) {
    if (item.kind === 'receipt' && !item.receipt_id && item.amount_minor > business.receipt_threshold_minor)
      found.push({ item: item.id, code: 'missing-receipt', message: business.receipt_threshold_minor ? `No receipt for an expense over ${money(business.receipt_threshold_minor, business.currency)}` : 'No receipt attached' });
    // A category's limit applies to the expense's whole amount in it, however many parts it is split into.
    const perCategory = new Map<string, number>();
    for (const part of item.allocations) perCategory.set(part.category_id, (perCategory.get(part.category_id) ?? 0) + part.amount_minor);
    for (const [id, amount] of perCategory) {
      const category = byId.get(id);
      if (category?.limit_minor != null && amount > category.limit_minor)
        found.push({ item: item.id, code: 'over-limit', message: `Over the ${category.name} limit of ${money(category.limit_minor, business.currency)}` });
    }
    if (item.receipt_sha256) {
      const same = items.find(other => other.id !== item.id && other.receipt_sha256 === item.receipt_sha256);
      const elsewhere = await db.prepare("SELECT c.number FROM c_items i JOIN c_claims c ON c.id=i.claim_id JOIN c_receipts r ON r.id=i.receipt_id WHERE r.sha256=? AND i.id<>? AND c.status<>'rejected' ORDER BY c.number LIMIT 1").bind(item.receipt_sha256, item.id).first<{ number: number }>();
      if (same || elsewhere) found.push({ item: item.id, code: 'duplicate-receipt', message: elsewhere ? `Same receipt as claim CL-${String(elsewhere.number).padStart(4, '0')}` : 'Same receipt as another expense in this claim' });
    }
    const sameHere = !item.receipt_sha256 && items.some(other => other.id !== item.id && !other.receipt_sha256 && exactKey(claim.employee_email, other) === exactKey(claim.employee_email, item));
    if (sameHere) { found.push({ item: item.id, code: 'possible-duplicate', message: 'Same date, merchant and amount as another expense in this claim' }); continue; }
    const twin = await db.prepare("SELECT c.number FROM c_items i JOIN c_claims c ON c.id=i.claim_id WHERE c.employee_email=? AND i.spent_on=? AND i.amount_minor=? AND lower(trim(i.merchant))=? AND i.id<>? AND c.id<>? AND c.status<>'rejected' ORDER BY c.number LIMIT 1").bind(claim.employee_email, item.spent_on, item.amount_minor, normal(item.merchant), item.id, claim.id).first<{ number: number }>();
    const history = twin ? null : await db.prepare("SELECT json_extract(value,'$.report') AS report FROM c_history WHERE kind='expense' AND json_extract(value,'$.employee')=? AND json_extract(value,'$.date')=? AND json_extract(value,'$.amountMinor')=? AND lower(trim(json_extract(value,'$.merchant')))=? LIMIT 1").bind(claim.employee_email, item.spent_on, item.amount_minor, normal(item.merchant)).first<{ report: string }>();
    if (twin) found.push({ item: item.id, code: 'possible-duplicate', message: `Same date, merchant and amount as claim CL-${String(twin.number).padStart(4, '0')}` });
    else if (history) found.push({ item: item.id, code: 'possible-duplicate', message: `Same date, merchant and amount as imported report ${history.report}` });
  }
  return found;
}

/** Expenses of one claim that share an exact key: only one of them could ever be reimbursed, so the claim cannot be submitted. */
export function repeatedInClaim(employee: string, items: ClaimItem[]) {
  const seen = new Set<string>();
  return items.filter(item => { const key = exactKey(employee, item); if (seen.has(key)) return true; seen.add(key); return false; });
}
