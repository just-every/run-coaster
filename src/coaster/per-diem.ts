import rates from './per-diem-data/rates.json';
import { isoDate, requireThat, text, type Data } from './types';

export type PerDiemRate = {
  id: string; method: 'gsa' | 'state' | 'high-low'; country: string; state: string; city: string; county: string;
  effectiveFrom: string; effectiveTo: string; lodging: number[]; mie: number;
  breakfast: number; lunch: number; dinner: number; incidentals: number; source: string;
};
const tables = rates as PerDiemRate[];
const meals = ['breakfast', 'lunch', 'dinner'] as const;
export type Meal = typeof meals[number];
export type PerDiemDay = {
  date: string; fiscalYear: number; rateId: string; source: string; effectiveFrom: string; effectiveTo: string;
  mieRateMinor: number; lodgingRateMinor: number; travelPercent: number; providedMeals: Meal[];
  mealRates: Record<Meal, number>; deductionMinor: number; mieMinor: number; lodgingMinor: number; totalMinor: number;
};
export type PerDiemTrip = {
  method: PerDiemRate['method']; locationId: string; location: string; component: 'mie' | 'lodging' | 'both';
  startDate: string; endDate: string; currency: 'USD'; days: PerDiemDay[]; totalMinor: number;
};

export const perDiemLabel = (r: PerDiemRate) => [r.city, r.county, r.state, r.country].filter(Boolean).join(' · ');

/** Public reference data only: no trip, employee or expense leaves this installation. */
export function perDiemLocations(method: unknown) {
  requireThat(['gsa', 'state', 'high-low'].includes(String(method)), 'Choose GSA, State Department or IRS high-low');
  return { locations: [...new Map(tables.filter(r => r.method === method).map(r => [r.id, { id: r.id, label: perDiemLabel(r) }])).values()].sort((a, b) => a.label.localeCompare(b.label)) };
}

/** Entered dates are inclusive calendar days, never timestamps. A one-day trip is reduced once. */
export function tripDates(start: unknown, end: unknown): string[] {
  const from = isoDate(start, 'Travel start date'), to = isoDate(end, 'Travel end date');
  const count = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000 + 1;
  requireThat(Number.isInteger(count) && count >= 1 && count <= 60, 'A trip must last from 1 to 60 calendar days');
  return Array.from({ length: count }, (_, i) => new Date(Date.parse(from + 'T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10));
}

/** Select each day's actual effective table. Missing years/locations refuse; another year's rate is never substituted. */
export function pricePerDiem(start: unknown, input: unknown): PerDiemTrip {
  requireThat(input && typeof input === 'object' && !Array.isArray(input), 'Choose the per diem method and trip');
  const b = input as Data, method = b.method;
  requireThat(['gsa', 'state', 'high-low'].includes(method), 'Choose GSA, State Department or IRS high-low');
  const locationId = text(b.locationId, 'Per diem location', 500), dates = tripDates(start, b.endDate);
  const component = b.component ?? 'mie';
  requireThat(['mie', 'lodging', 'both'].includes(component), 'Choose meals, lodging or both');
  const provided = b.providedMeals ?? [];
  requireThat(Array.isArray(provided) && provided.length <= 60, 'List provided meals by travel date');
  const byDay = new Map<string, Meal[]>();
  for (const row of provided) {
    requireThat(row && typeof row === 'object' && dates.includes(row.date) && !byDay.has(row.date), 'Provided meals must name distinct dates on this trip');
    requireThat(Array.isArray(row.meals) && row.meals.every((m: unknown) => meals.includes(m as Meal)) && new Set(row.meals).size === row.meals.length, 'Choose breakfast, lunch or dinner once per date');
    byDay.set(row.date, row.meals);
  }
  let location = '';
  const days = dates.map((date, i): PerDiemDay => {
    const matching = tables.filter(r => r.id === locationId && r.method === method && r.effectiveFrom <= date && r.effectiveTo >= date);
    requireThat(matching.length === 1, matching.length ? `Ambiguous published per diem rates for ${date}` : `No published ${method} rate for this location on ${date}; refresh the official tables or choose the company rate`, 409);
    const r = matching[0]; location = perDiemLabel(r);
    const month = Number(date.slice(5, 7)), travelPercent = i === 0 || i === dates.length - 1 ? 75 : 100;
    const providedMeals = byDay.get(date) ?? [], mealRates = { breakfast: r.breakfast, lunch: r.lunch, dinner: r.dinner };
    const deductionMinor = providedMeals.reduce((sum, meal) => sum + r[meal], 0);
    // Full furnished-meal deductions follow the travel-day reduction; incidental expenses remain payable.
    const mieMinor = component === 'lodging' ? 0 : Math.max(r.incidentals, Math.floor((r.mie * travelPercent + 50) / 100) - deductionMinor);
    const lodgingRateMinor = r.lodging[month - 1];
    requireThat(Number.isSafeInteger(lodgingRateMinor) && lodgingRateMinor >= 0, `Invalid published lodging rate for ${date}`, 409);
    // Lodging is an overnight allowance: the departure night through the night before returning.
    const lodgingMinor = component === 'mie' || i === dates.length - 1 ? 0 : lodgingRateMinor;
    return { date, fiscalYear: Number(date.slice(0, 4)) + (month >= 10 ? 1 : 0), rateId: r.id, source: r.source, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, mieRateMinor: r.mie, lodgingRateMinor, travelPercent, providedMeals, mealRates, deductionMinor, mieMinor, lodgingMinor, totalMinor: mieMinor + lodgingMinor };
  });
  return { method, locationId, location, component, startDate: dates[0], endDate: dates.at(-1)!, currency: 'USD', days, totalMinor: days.reduce((sum, d) => sum + d.totalMinor, 0) };
}
