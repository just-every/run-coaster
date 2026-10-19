/** US business days: Monday to Friday except the eleven US federal holidays as observed (a Saturday holiday is
 * observed the Friday before, a Sunday one the Monday after, so New Year's Day can be observed on 31 December). */
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const weekday = (day: string) => new Date(day + 'T00:00:00Z').getUTCDay();
const nth = (y: number, m: number, dow: number, n: number) => 1 + (dow - new Date(Date.UTC(y, m, 1)).getUTCDay() + 7) % 7 + 7 * (n - 1);
const last = (y: number, m: number, dow: number) => { const end = new Date(Date.UTC(y, m + 1, 0)); return end.getUTCDate() - (end.getUTCDay() - dow + 7) % 7; };
const observed = (y: number, m: number, d: number) => { const w = new Date(Date.UTC(y, m, d)).getUTCDay(); return iso(y, m, d + (w === 6 ? -1 : w === 0 ? 1 : 0)); };

export function federalHolidays(year: number) {
  return new Set([
    observed(year, 0, 1), iso(year, 0, nth(year, 0, 1, 3)), iso(year, 1, nth(year, 1, 1, 3)), iso(year, 4, last(year, 4, 1)), observed(year, 5, 19), observed(year, 6, 4),
    iso(year, 8, nth(year, 8, 1, 1)), iso(year, 9, nth(year, 9, 1, 2)), observed(year, 10, 11), iso(year, 10, nth(year, 10, 4, 4)), observed(year, 11, 25), observed(year + 1, 0, 1),
  ]);
}
export const isBusinessDay = (day: string) => ![0, 6].includes(weekday(day)) && !federalHolidays(Number(day.slice(0, 4))).has(day);

/** The first or last business day of the month holding `day`. */
export function businessDayOfMonth(day: string, which: 'first' | 'last') {
  const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)) - 1, days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const order = Array.from({ length: days }, (_, i) => iso(y, m, i + 1));
  return (which === 'first' ? order : order.reverse()).find(isBusinessDay)!;
}
