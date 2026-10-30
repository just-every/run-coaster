import type { Business } from './settings';
import { categoryAccountViews, type CategoryAccount } from './coding/category-accounts';
import { codingInput, type CodingSnapshot } from './coding/model';
import { createFx, manualFx, type FxConversion } from './fx';
import { rateOn } from './mileage';
import { pricePerDiem, type PerDiemTrip } from './per-diem';
import { amount, distance, email, isoDate, mileageMinor, optionalAmount, optionalText, requireThat, text, type Data } from './types';

export type Category = { id: string; name: string; account_code: string; tax_code: string; limit_minor: number | null; active: number; receipt_always: number; per_person_limit_minor: number | null; required_fields: string[]; ledger_account_id?: string | null; ledger_account_snapshot?: string; ledger_account?: CategoryAccount | null; ledger_account_available?: boolean };
/** One categorized part of an expense; an itemized folio names each part (room, tax, in-room dining). */
export type Allocation = { category_id: string; cost_centre: string; amount_minor: number; description?: string; original_minor?: number };
/** Someone at a meal: a colleague (by their Coaster email) or a guest. */
export type Attendee = { name: string; kind: 'employee' | 'guest'; email?: string };
export type ItemInput = Partial<FxConversion> & {
  original_sales_tax_minor?: number;
  per_diem?: PerDiemTrip;
  kind: 'receipt' | 'mileage' | 'per_diem' | 'stipend'; spent_on: string; merchant: string; description: string; amount_minor: number;
  distance_hundredths: number | null; days: number | null; rate_thousandths: number | null; explanation: string; allocations: Allocation[];
  sales_tax_minor: number; sales_tax_account: string; sales_tax_code: string; attendees?: Attendee[]; fields?: Record<string, string>; request_id?: string | null;
  /** A stipend's allowance, or the cap a purchase is claimed against with the receipt's amount when it was capped (CLAIM-009). */
  allowance_id?: string | null; claimed_minor?: number | null;
  billable?: boolean; customer?: string; project?: string;
  coding?: Record<string,string>; codingSnapshot?: CodingSnapshot[]; codingVersion?: number;
  /** The statement charge a company-card expense carries (FEED-004); set only by the statement import. */
  card_charge_id?: string | null;
  card_liability?: 'company' | 'individual'; card_personal?: number;
  receipt_resolution?: string | null;
};

export async function categories(db: D1Database): Promise<Category[]> {
  const rows = (await db.prepare('SELECT * FROM c_categories ORDER BY name').all<Category & { required_fields: string }>()).results;
  return categoryAccountViews(db,rows.map(c => ({ ...c, required_fields: JSON.parse(c.required_fields) })));
}

/** One expense line, priced from policy (mileage at the rate in force on its trip date) and split across categories; a receipt's sales tax is its own line. */
export function itemInput(b: Data, business: Business, known: Category[]): ItemInput {
  requireThat(['receipt', 'mileage', 'per_diem'].includes(b.kind), 'Choose a receipt, mileage or per diem expense');
  const kind = b.kind as 'receipt' | 'mileage' | 'per_diem';
  const spent_on = isoDate(b.date, 'Expense date');
  let per_diem: PerDiemTrip | undefined;
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
  } else if (b.perDiem) {
    const trip = per_diem = pricePerDiem(spent_on, b.perDiem);
    amount_minor = trip.totalMinor;
    days = trip.days.length;
    merchant = trip.location;
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
    return { category_id: a.category, cost_centre: optionalText(a.costCentre, 'Cost center', 80), amount_minor: part, description: optionalText(a.description, `Item for part ${i + 1}`, 200) };
  });
  const sum = allocations.reduce((n, a) => n + a.amount_minor, 0);
  requireThat(sum === amount_minor - sales_tax_minor, sales_tax_minor ? 'The split must add up exactly to the expense amount less its sales tax' : 'The split must add up exactly to the expense amount');
  requireThat(b.billable === undefined || typeof b.billable === 'boolean', 'Billable must be true or false');
  const billable = b.billable === true, customer = optionalText(b.customer, 'Customer', 200), project = optionalText(b.project, 'Project', 200);
  const coding = codingInput(b.coding);
  requireThat(!billable || customer || Object.keys(coding).length, 'A billable expense needs a customer');
  return { ...(per_diem ? { per_diem } : {}), kind, spent_on, merchant, description: optionalText(b.description, 'Description', 500), amount_minor, distance_hundredths, days, rate_thousandths, explanation: optionalText(b.explanation, 'Explanation', 1000), allocations, billable, customer, project, coding,
    sales_tax_minor, sales_tax_account: sales_tax_minor ? business.sales_tax_account : '', sales_tax_code: sales_tax_minor ? business.sales_tax_code : '', attendees: attendees(b.attendees), fields: customFields(b.fields) };
}

/** Attendees as entered: each a colleague with their email or a named guest. */
function attendees(value: unknown): Attendee[] {
  if (value === undefined || value === null || value === '') return [];
  requireThat(Array.isArray(value) && value.length <= 50, 'List at most 50 attendees');
  return value.map((a: Data, i): Attendee => {
    requireThat(a && (a.kind === 'employee' || a.kind === 'guest'), `Say whether attendee ${i + 1} is a colleague or a guest`);
    const name = text(a.name, `Name of attendee ${i + 1}`, 120);
    return a.kind === 'employee' ? { name, kind: 'employee', email: email(a.email, `Email of attendee ${i + 1}`) } : { name, kind: 'guest' };
  });
}

/** Custom field values by field name; blank values are left out, so a required field reads as missing. */
function customFields(value: unknown): Record<string, string> {
  if (value === undefined || value === null || value === '') return {};
  requireThat(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 20, 'Fields must be at most 20 named values');
  return Object.fromEntries(Object.entries(value as Data).map(([name, v]) => [text(name, 'Field name', 60), optionalText(v, name, 300)]).filter(([, v]) => v));
}

/** Validate in entered currency first, then price every part in business currency. */
export async function pricedItem(b: Data, business: Business, known: Category[]): Promise<ItemInput> {
  const item = itemInput(b, business, known);
  if (item.kind !== 'receipt' && !item.per_diem) return item;
  const currency = item.per_diem ? 'USD' : b.currency === undefined || b.currency === '' ? business.currency : text(b.currency, 'Currency', 3).toUpperCase();
  requireThat(/^[A-Z]{3}$/.test(currency), 'Currency must be a three-letter code');
  if (currency === business.currency) return item;
  const automatic = createFx(!!business.fx_enabled, business.currency);
  const fx = b.manualRate === undefined || b.manualRate === '' ? automatic : async (minor: number, original: string, date: string) => manualFx(minor, original, date, b.manualRate);
  const conversion = await fx(item.amount_minor, currency, item.spent_on);
  const tax = (await fx(item.sales_tax_minor, currency, item.spent_on)).amount_minor;
  let remainder = conversion.amount_minor - tax;
  const allocations = [];
  for (const [i, part] of item.allocations.entries()) {
    const converted = i === item.allocations.length - 1 ? remainder : (await fx(part.amount_minor, currency, item.spent_on)).amount_minor;
    requireThat(converted > 0, 'A converted split must be at least one cent');
    allocations.push({ ...part, original_minor: part.amount_minor, amount_minor: converted });
    remainder -= converted;
  }
  requireThat(conversion.amount_minor > 0, 'The converted expense must be at least one cent');
  return { ...item, ...conversion, original_sales_tax_minor: item.sales_tax_minor, sales_tax_minor: tax, allocations };
}
