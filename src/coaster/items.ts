import type { Business } from './settings';
import { rateOn } from './mileage';
import { amount, distance, isoDate, mileageMinor, optionalAmount, optionalText, requireThat, text, type Data } from './types';

export type Category = { id: string; name: string; account_code: string; tax_code: string; limit_minor: number | null; active: number; receipt_always: number };
export type Allocation = { category_id: string; cost_centre: string; amount_minor: number };
export type ItemInput = {
  kind: 'receipt' | 'mileage' | 'per_diem'; spent_on: string; merchant: string; description: string; amount_minor: number;
  distance_hundredths: number | null; days: number | null; rate_thousandths: number | null; explanation: string; allocations: Allocation[];
  sales_tax_minor: number; sales_tax_account: string; sales_tax_code: string;
};

export async function categories(db: D1Database): Promise<Category[]> {
  return (await db.prepare('SELECT * FROM c_categories ORDER BY name').all<Category>()).results;
}

/** One expense line, priced from policy (mileage at the rate in force on its trip date) and split across categories; a receipt's sales tax is its own line. */
export function itemInput(b: Data, business: Business, known: Category[]): ItemInput {
  requireThat(['receipt', 'mileage', 'per_diem'].includes(b.kind), 'Choose a receipt, mileage or per diem expense');
  const kind = b.kind as ItemInput['kind'];
  const spent_on = isoDate(b.date, 'Expense date');
  let amount_minor: number, distance_hundredths: number | null = null, days: number | null = null, rate_thousandths: number | null = null, merchant: string, sales_tax_minor = 0;
  if (kind === 'receipt') {
    merchant = text(b.merchant, 'Merchant', 200);
    amount_minor = amount(b.amount, 'Amount');
    sales_tax_minor = optionalAmount(b.salesTax, 'Sales tax') ?? 0;
    requireThat(sales_tax_minor < amount_minor, 'Sales tax must be less than the amount it is part of');
    requireThat(!sales_tax_minor || business.sales_tax_account, 'Ask the owner to set the sales tax account before recording sales tax');
  } else if (kind === 'mileage') {
    requireThat(business.mileage_rates.length, 'Mileage is not enabled for this business');
    distance_hundredths = distance(b.distance);
    rate_thousandths = rateOn(business.mileage_rates, spent_on);
    requireThat(rate_thousandths, `No mileage rate is in force on ${spent_on}; ask the owner to add one`);
    amount_minor = mileageMinor(distance_hundredths, rate_thousandths);
    merchant = optionalText(b.merchant, 'Route', 200) || 'Mileage';
  } else {
    requireThat(business.per_diem_minor > 0, 'Per diem is not enabled for this business');
    requireThat(Number.isSafeInteger(Number(b.days)) && Number(b.days) >= 1 && Number(b.days) <= 60, 'Per diem days must be a whole number from 1 to 60');
    days = Number(b.days);
    rate_thousandths = business.per_diem_minor * 10;
    amount_minor = days * business.per_diem_minor;
    merchant = optionalText(b.merchant, 'Location', 200) || 'Per diem';
  }
  requireThat(amount_minor > 0, 'Amount must be more than zero');
  const active = new Map(known.filter(c => c.active === 1).map(c => [c.id, c]));
  const raw: Data[] = Array.isArray(b.allocations) && b.allocations.length ? b.allocations : [{ category: b.category, costCentre: b.costCentre, amount: null }];
  requireThat(raw.length <= 10, 'Split an expense into at most 10 parts');
  const allocations = raw.map((a, i): Allocation => {
    requireThat(typeof a.category === 'string' && active.has(a.category), `Choose an active category for part ${i + 1}`);
    const part = raw.length === 1 && (a.amount === null || a.amount === undefined || a.amount === '') ? amount_minor - sales_tax_minor : amount(a.amount, `Amount for part ${i + 1}`);
    requireThat(part > 0, `Part ${i + 1} must be more than zero`);
    return { category_id: a.category, cost_centre: optionalText(a.costCentre, 'Cost center', 80), amount_minor: part };
  });
  const sum = allocations.reduce((n, a) => n + a.amount_minor, 0);
  requireThat(sum === amount_minor - sales_tax_minor, sales_tax_minor ? 'The split must add up exactly to the expense amount less its sales tax' : 'The split must add up exactly to the expense amount');
  return { kind, spent_on, merchant, description: optionalText(b.description, 'Description', 500), amount_minor, distance_hundredths, days, rate_thousandths, explanation: optionalText(b.explanation, 'Explanation', 1000), allocations,
    sales_tax_minor, sales_tax_account: sales_tax_minor ? business.sales_tax_account : '', sales_tax_code: sales_tax_minor ? business.sales_tax_code : '' };
}
