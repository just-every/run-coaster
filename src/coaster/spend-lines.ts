import { claimNumber } from './claims';
import type { Data } from './types';

/** Submitted out-of-pocket spend and every posted company-card charge, counted once. Draft card rows reveal only
 * statement facts and coding, never their private receipt, entered matching details or lifecycle. */
export async function spendLines(db: D1Database, from: string, to: string, scope: { sql: string; params: unknown[] } = { sql: '', params: [] }) {
  const [claims, charges, allocations] = await db.batch([
    db.prepare(`SELECT c.id,c.number,c.employee_email,c.status,r.snapshot,m.name AS employee_name FROM c_claims c JOIN c_revisions r ON r.claim_id=c.id AND r.revision=c.revision LEFT JOIN c_members m ON m.email=c.employee_email WHERE c.status IN ('submitted','approved','batched','reimbursed')${scope.sql} ORDER BY c.number`).bind(...scope.params),
    db.prepare(`SELECT ch.*,cd.issuer,cd.last4,cd.id AS card_id,c.id AS live_claim,c.number,c.status,m.name AS employee_name,i.sales_tax_minor
      FROM c_card_charges ch JOIN c_cards cd ON cd.id=ch.card_id JOIN c_items i ON i.id=ch.item_id
      JOIN c_claims c ON c.id=i.claim_id LEFT JOIN c_members m ON m.email=ch.employee_email
      WHERE 1=1${scope.sql} ORDER BY ch.id`).bind(...scope.params),
    db.prepare('SELECT a.*,cat.name AS category_name FROM c_allocations a JOIN c_items i ON i.id=a.item_id JOIN c_categories cat ON cat.id=a.category_id WHERE i.card_charge_id IS NOT NULL'),
  ]);
  const cards = new Map((charges.results as Data[]).map(ch => [ch.id, ch]));
  const counted = new Set<string>(), out: Data[] = [];
  const append = (c: Data, item: Data, charge?: Data) => {
    if (item.spent_on < from || item.spent_on > to) return;
    if (charge) { if (counted.has(charge.id)) return; counted.add(charge.id); }
    const base = { claim: c.id, number: claimNumber(c.number), employee: c.employee_email, employeeName: c.employee_name ?? c.employee_email,
      status: ['approved', 'batched', 'reimbursed'].includes(c.status) ? 'approved' : 'pending', item: item.id, date: item.spent_on,
      merchant: item.merchant, receipt: item.receipt?.id ?? null, card: charge?.card_id ?? null,
      cardLabel: charge ? `${charge.issuer} ····${charge.last4}` : null, cardCharge: charge?.id ?? null };
    for (const part of item.allocations as Data[]) out.push({ ...base, category: part.category_id, categoryName: part.category_name, costCentre: part.cost_centre ?? '', amountMinor: part.amount_minor });
    if (item.sales_tax_minor) out.push({ ...base, category: 'sales-tax', categoryName: 'Sales tax', costCentre: '', amountMinor: item.sales_tax_minor });
  };
  for (const c of claims.results as Data[]) for (const item of JSON.parse(c.snapshot).items as Data[]) {
    append(c, item, item.card_charge_id ? cards.get(item.card_charge_id) : undefined);
  }
  for (const ch of charges.results as Data[]) {
    if (counted.has(ch.id)) continue;
    const parts = (allocations.results as Data[]).filter(a => a.item_id === ch.item_id);
    append({ ...ch, id: ch.live_claim }, { id: ch.item_id, spent_on: ch.transaction_on ?? ch.posted_on, merchant: ch.descriptor,
      allocations: parts, sales_tax_minor: ch.sales_tax_minor ?? 0 }, ch);
  }
  return out;
}
