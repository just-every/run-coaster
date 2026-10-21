import { money } from './exceptions';
import type { Data } from './types';
import type { Category } from './items';

export type AdvisorySignal = { code: string; label: 'possible, needs review'; reason: string; evidence?: Data };
export const observation = (code: string, reason: string, evidence: Data): AdvisorySignal => ({ code, label: 'possible, needs review', reason, evidence });
const normal = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const day = (s: string) => Date.parse(s + 'T00:00:00Z') / 86400000;
const weekend = (s: string) => [0, 6].includes(new Date(s + 'T00:00:00Z').getUTCDay());

/** Patterns require related purchases, not an isolated round amount or weekend.
 * Monthly subscriptions and attendee shares alone supply no such evidence. */
export function spendSignals(item: Data, population: Data[], categories: Category[], currency: string, rules: Data[] = []): AdvisorySignal[] {
  if (item.kind !== 'receipt') return [];
  const signals: AdvisorySignal[] = [];
  const related = population.filter(i => i.kind === 'receipt' && i.employee === item.employee && normal(i.merchant) === normal(item.merchant));
  const rows = (items: Data[]) => items.map(i => ({ item: i.id, claim: i.claim, date: i.spent_on, amountMinor: i.amount_minor }));
  limits: for (const category of categories) for (const limit of new Set([category.limit_minor, ...rules.filter(r => r.kind === 'per-expense-limit' && r.category === category.id).map(r => r.limit_minor)])) {
    if (!limit) continue;
    const amount = (i: Data) => i.allocations.filter((a: Data) => a.category_id === category.id).reduce((n: number, a: Data) => n + a.amount_minor, 0);
    const group = related.filter(i => i.spent_on === item.spent_on && (i.attendees?.length ?? 0) <= 1 && amount(i) > 0 && amount(i) <= limit && amount(i) * 5 >= limit * 4);
    const total = group.reduce((n, i) => n + amount(i), 0);
    if (group.some(i => i.id === item.id) && group.length >= 2 && total > limit) {
      signals.push(observation('split-charge', `${group.length} ${item.merchant} purchases on ${item.spent_on} total ${money(total, currency)} in ${category.name}; each is within, and at least 80% of, the ${money(limit, currency)} per-expense limit. Separate purchases can be legitimate.`, { category: category.id, limitMinor: limit, totalMinor: total, purchases: rows(group) }));
      break limits;
    }
  }
  const recent = related.filter(i => day(i.spent_on) <= day(item.spent_on) && day(i.spent_on) >= day(item.spent_on) - 14 && (i.attendees?.length ?? 0) <= 1);
  for (const [code, group, description] of [
    ['round-amount-pattern', recent.filter(i => i.amount_minor >= 10000 && i.amount_minor % 10000 === 0), 'round hundreds'],
    ['weekend-pattern', recent.filter(i => weekend(i.spent_on)), 'weekend purchases'],
  ] as const) {
    if (group.some(i => i.id === item.id) && new Set(group.map(i => i.spent_on)).size >= 3)
      signals.push(observation(code, `${group.length} ${description} at ${item.merchant} on at least three dates within 15 days ending ${item.spent_on}. Recurring business spend can be legitimate.`, { purchases: rows(group), from: new Date((day(item.spent_on) - 14) * 86400000).toISOString().slice(0, 10), through: item.spent_on }));
  }
  return signals;
}

/** Only published matching evidence is used, never an unmatched private inbox. */
export function cardDisagreement(item: Data): AdvisorySignal[] {
  if (!item.card_match_basis) return [];
  const basis = JSON.parse(item.card_match_basis);
  if (!basis.differenceMinor && basis.enteredDate === item.spent_on) return [];
  return [observation('card-disagreement', `Receipt entered as ${money(basis.enteredTotalMinor, basis.enteredCurrency)} on ${basis.enteredDate}; posted card charge ${money(item.amount_minor, item.currency)} on ${item.spent_on} differs by ${money(basis.differenceMinor, basis.differenceCurrency)} from ${basis.basis === 'fx' ? 'its reference conversion' : 'the entered receipt total'}. Match rule v${basis.ruleVersion} accepted ${basis.basis}; tips and exchange differences can be legitimate.`, { enteredTotalMinor: basis.enteredTotalMinor, enteredCurrency: basis.enteredCurrency, enteredDate: basis.enteredDate, postedMinor: item.amount_minor, currency: item.currency, ...basis })];
}
