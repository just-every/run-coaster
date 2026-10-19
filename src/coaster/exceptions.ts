import type { Business } from './settings';
import type { Category } from './items';
import type { Data } from './types';
import { overBudget } from './budgets';

export type PolicyException = { item: string; code: 'missing-receipt' | 'over-limit' | 'over-per-person' | 'needs-pre-approval' | 'duplicate-receipt' | 'possible-duplicate' | 'over-budget'; message: string };
export type ClaimItem = Data & { id: string; kind: string; spent_on: string; merchant: string; amount_minor: number; receipt_id: string | null; receipt_sha256?: string | null; allocations: Data[]; attendees: Data[]; fields: Record<string, string> };

/** Each required custom field (CLAIM-007) a current expense leaves blank, named with the expense and category. */
export function missingFields(items: ClaimItem[], known: Category[]) {
  const byId = new Map(known.map(c => [c.id, c]));
  return items.flatMap(item => [...new Set(item.allocations.map(a => a.category_id))].flatMap(id => {
    const category = byId.get(id);
    return (category?.required_fields ?? []).filter(name => !item.fields[name]).map(name => `${name} for ${item.merchant} (${category!.name})`);
  }));
}

const normal = (merchant: string) => merchant.trim().toLowerCase().replace(/\s+/g, ' ');
const money = (minor: number, currency: string) => { const text = (minor / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); return currency === 'USD' ? `$${text}` : `${currency} ${text}`; };

/** The one key an exact expense reimburses under: its receipt bytes, or without a receipt its full description. */
export function exactKey(employee: string, item: ClaimItem) {
  return item.receipt_sha256 ? `receipt:${item.receipt_sha256}` : `expense:${employee}|${item.spent_on}|${item.kind}|${normal(item.merchant)}|${item.amount_minor}`;
}

/** Each per-person limit an expense meets: the expense's total share in that category divided by everyone listed at it
 * (at least one). The share shown rounds half up to the cent; the limit is checked against the exact share, so it is over
 * when amount > limit × people. */
export function perPersonShares(item: { attendees?: Data[]; allocations: Data[] }, byId: Map<string, Category>) {
  const perCategory = new Map<string, number>();
  for (const part of item.allocations) perCategory.set(part.category_id, (perCategory.get(part.category_id) ?? 0) + part.amount_minor);
  const people = Math.max(1, item.attendees?.length ?? 0);
  return [...perCategory].flatMap(([id, amount]) => {
    const category = byId.get(id);
    if (category?.per_person_limit_minor == null) return [];
    return [{ category: category.name, people, amount_minor: amount, share_minor: Math.round(amount / people), limit_minor: category.per_person_limit_minor, over: amount > category.per_person_limit_minor * people }];
  });
}

/** Policy exceptions for a claim's current items. They are recorded with each submission and never hidden. */
export async function findExceptions(db: D1Database, claim: { id: string; employee_email: string }, items: ClaimItem[], business: Business, known: Category[]): Promise<PolicyException[]> {
  const found: PolicyException[] = [];
  const byId = new Map(known.map(c => [c.id, c]));
  for (const item of items) {
    const always = item.allocations.map(part => byId.get(part.category_id)).find(c => c?.receipt_always);
    if (item.kind === 'receipt' && !item.receipt_id && (always || item.amount_minor > business.receipt_threshold_minor))
      found.push({ item: item.id, code: 'missing-receipt', message: always ? `${always.name} always needs a receipt` : business.receipt_threshold_minor ? `No receipt for an expense over ${money(business.receipt_threshold_minor, business.currency)}` : 'No receipt attached' });
    if (business.preapproval_threshold_minor != null && item.amount_minor > business.preapproval_threshold_minor && !item.request_id)
      found.push({ item: item.id, code: 'needs-pre-approval', message: `Over ${money(business.preapproval_threshold_minor, business.currency)} without an approved spend request` });
    // A category's limit applies to the expense's whole amount in it, however many parts it is split into.
    const perCategory = new Map<string, number>();
    for (const part of item.allocations) perCategory.set(part.category_id, (perCategory.get(part.category_id) ?? 0) + part.amount_minor);
    for (const [id, amount] of perCategory) {
      const category = byId.get(id);
      if (category?.limit_minor != null && amount > category.limit_minor)
        found.push({ item: item.id, code: 'over-limit', message: `Over the ${category.name} limit of ${money(category.limit_minor, business.currency)}` });
    }
    for (const share of perPersonShares(item, byId).filter(s => s.over))
      found.push({ item: item.id, code: 'over-per-person', message: `${money(share.amount_minor, business.currency)} for ${share.people} ${share.people === 1 ? 'person' : 'people'} is ${money(share.share_minor, business.currency)} a person, over the ${share.category} limit of ${money(share.limit_minor, business.currency)} a person` });
    if (item.receipt_sha256) {
      const same = items.find(other => other.id !== item.id && other.receipt_sha256 === item.receipt_sha256);
      const elsewhere = await db.prepare("SELECT c.number FROM c_items i JOIN c_claims c ON c.id=i.claim_id JOIN c_receipts r ON r.id=i.receipt_id WHERE r.sha256=? AND i.id<>? AND c.status<>'rejected' ORDER BY c.number LIMIT 1").bind(item.receipt_sha256, item.id).first<{ number: number }>();
      if (same || elsewhere) found.push({ item: item.id, code: 'duplicate-receipt', message: elsewhere ? `Same receipt as claim CL-${String(elsewhere.number).padStart(4, '0')}` : 'Same receipt as another expense in this claim' });
    }
    // Same date, merchant and amount as another expense on this claim is a possible duplicate whatever receipts they carry; the same receipt twice is already flagged above.
    const sameHere = items.some(other => other.id !== item.id && other.spent_on === item.spent_on && other.amount_minor === item.amount_minor && normal(other.merchant) === normal(item.merchant) && !(item.receipt_sha256 && other.receipt_sha256 === item.receipt_sha256));
    if (sameHere) { found.push({ item: item.id, code: 'possible-duplicate', message: 'Same date, merchant and amount as another expense in this claim' }); continue; }
    const twin = await db.prepare("SELECT c.number FROM c_items i JOIN c_claims c ON c.id=i.claim_id WHERE c.employee_email=? AND i.spent_on=? AND i.amount_minor=? AND lower(trim(i.merchant))=? AND i.id<>? AND c.id<>? AND c.status<>'rejected' ORDER BY c.number LIMIT 1").bind(claim.employee_email, item.spent_on, item.amount_minor, normal(item.merchant), item.id, claim.id).first<{ number: number }>();
    const history = twin ? null : await db.prepare("SELECT json_extract(value,'$.report') AS report FROM c_history WHERE kind='expense' AND json_extract(value,'$.employee')=? AND json_extract(value,'$.date')=? AND json_extract(value,'$.amountMinor')=? AND lower(trim(json_extract(value,'$.merchant')))=? LIMIT 1").bind(claim.employee_email, item.spent_on, item.amount_minor, normal(item.merchant)).first<{ report: string }>();
    if (twin) found.push({ item: item.id, code: 'possible-duplicate', message: `Same date, merchant and amount as claim CL-${String(twin.number).padStart(4, '0')}` });
    else if (history) found.push({ item: item.id, code: 'possible-duplicate', message: `Same date, merchant and amount as imported report ${history.report}` });
  }
  // A budget whose policy rule is on marks the expense that would take it past its amount (REPORT-004).
  found.push(...await overBudget(db, claim, items));
  return found;
}

/** Expenses of one claim that share an exact key: only one of them could ever be reimbursed, so the claim cannot be submitted. */
export function repeatedInClaim(employee: string, items: ClaimItem[]) {
  const seen = new Set<string>();
  return items.filter(item => { const key = exactKey(employee, item); if (seen.has(key)) return true; seen.add(key); return false; });
}
