import type { Policy } from './policy';
import { money, type ClaimItem, type PolicyException } from './exceptions';
import type { Business } from './settings';
import type { Category } from './items';
import { federalHolidays } from './business-days';
import { localDay } from './delegation';

const normal = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000);
const categoryAmount = (item: ClaimItem, category: string) => item.allocations.filter(a => a.category_id === category).reduce((n, a) => n + a.amount_minor, 0);

/** Category aggregates include drafts, submitted and paid spend, excluding rejected claims and the current claim's
 * database rows (counted from its current items instead). A trip is an approved spend request; a month is the expense
 * date's calendar month. Limits are inclusive integer cents. */
export async function evaluateRules(db: D1Database, policy: Pick<Policy, 'rules' | 'version'>, claim: { id: string; employee_email: string }, items: ClaimItem[], business: Business, known: Category[]) {
  const found: PolicyException[] = [], v = `policy v${policy.version}`, today = localDay(business.timezone), names = new Map(known.map(c => [c.id, c.name]));
  const add = (item: ClaimItem, code: PolicyException['code'], message: string, hard: boolean) => found.push({ item: item.id, code, message: `${message} (${v})`, policy: policy.version, hard });
  for (const r of policy.rules) {
    if (r.kind === 'receipt-threshold') for (const item of items.filter(i => i.kind === 'receipt' && !i.receipt_id && i.amount_minor > r.limit_minor))
      add(item, 'missing-receipt', `No receipt for an expense over ${money(r.limit_minor, business.currency)}`, r.hard);
    if (r.kind === 'required-field') for (const item of items.filter(i => i.allocations.some(a => a.category_id === r.category) && !i.fields[r.field]))
      add(item, 'missing-field', `Fill in ${r.field} for ${item.merchant} (${names.get(r.category)})`, r.hard);
    if (r.kind === 'per-expense-limit' || r.kind === 'attendee-limit') for (const item of items.filter(i => i.allocations.some(a => a.category_id === r.category))) {
      const total = categoryAmount(item, r.category), people = r.kind === 'attendee-limit' ? Math.max(1, item.attendees.length) : 1;
      if (total > r.limit_minor * people) add(item, r.kind === 'attendee-limit' ? 'over-per-person' : 'over-limit', `${names.get(r.category)} totals ${money(total, business.currency)} for ${people} ${people === 1 ? 'person' : 'people'}, over ${money(r.limit_minor, business.currency)} ${r.kind === 'attendee-limit' ? 'per attendee' : 'per expense'}`, r.hard);
    }
    if (r.kind === 'blocked-merchant') for (const item of items.filter(i => normal(i.merchant) === normal(r.merchant)))
      add(item, 'blocked-merchant', `${item.merchant} is a blocked merchant`, r.hard);
    if (r.kind === 'blocked-category' || r.kind === 'approval-required') for (const item of items.filter(i => i.allocations.some(a => a.category_id === r.category))) {
      if (r.kind === 'blocked-category') add(item, 'blocked-category', `${names.get(r.category)} is a blocked category`, r.hard);
      else if (!item.request_id) add(item, 'needs-pre-approval', `${names.get(r.category)} needs an approved spend request`, r.hard);
    }
    if (r.kind === 'weekend' || r.kind === 'holiday') for (const item of items) {
      const weekend = [0, 6].includes(new Date(item.spent_on + 'T00:00:00Z').getUTCDay());
      const holiday = federalHolidays(Number(item.spent_on.slice(0, 4))).has(item.spent_on);
      if (r.kind === 'weekend' ? weekend : holiday) add(item, r.kind === 'weekend' ? 'weekend-spend' : 'holiday-spend', `${item.spent_on} is ${r.kind === 'weekend' ? 'weekend' : 'an observed US federal holiday'} spend`, r.hard);
    }
    if (r.kind === 'deadline') for (const item of items.filter(i => daysBetween(i.spent_on, today) > r.days))
      add(item, 'past-deadline', `Spent on ${item.spent_on}, more than ${r.days} days before submission`, r.hard);
    if (r.kind === 'daily-limit' || r.kind === 'monthly-limit' || r.kind === 'trip-limit') {
      const kind = r.kind, bucket = (i: ClaimItem): string => kind === 'trip-limit' ? i.request_id ?? '' : kind === 'monthly-limit' ? i.spent_on.slice(0, 7) : i.spent_on;
      const eligible = items.filter(i => i.allocations.some(a => a.category_id === r.category));
      // Unlinked trip spend cannot evade a trip limit by omitting the trip.
      if (kind === 'trip-limit') for (const item of eligible.filter(i => !i.request_id)) add(item, 'needs-pre-approval', `${names.get(r.category)} needs a spend request to check its trip limit`, r.hard);
      for (const key of new Set(eligible.map(bucket).filter(Boolean))) {
        const here = eligible.filter(i => bucket(i) === key), mine = here.reduce((n, i) => n + categoryAmount(i, r.category), 0);
        const condition = kind === 'trip-limit' ? 'i.request_id=?' : kind === 'monthly-limit' ? 'substr(i.spent_on,1,7)=?' : 'i.spent_on=?';
        const other = await db.prepare(`SELECT COALESCE(SUM(a.amount_minor),0) AS n FROM c_allocations a JOIN c_items i ON i.id=a.item_id JOIN c_claims c ON c.id=i.claim_id WHERE c.employee_email=? AND c.id<>? AND c.status<>'rejected' AND ${condition} AND a.category_id=?`).bind(claim.employee_email, claim.id, key, r.category).first<{ n: number }>();
        const total = mine + (other?.n ?? 0), period = kind === 'daily-limit' ? 'daily' : kind === 'monthly-limit' ? 'monthly' : 'trip';
        if (total > r.limit_minor) for (const item of here) add(item, kind === 'daily-limit' ? 'over-daily-limit' : kind === 'monthly-limit' ? 'over-monthly-limit' : 'over-trip-limit', `${names.get(r.category) ?? 'This category'} ${kind === 'trip-limit' ? 'on its spend request' : 'on ' + key} totals ${money(total, business.currency)}, over the ${period} limit of ${money(r.limit_minor, business.currency)}`, r.hard);
      }
    }
  }
  return found;
}
