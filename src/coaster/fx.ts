import { Fault, requireThat } from './types';

export const ECB_HISTORY = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml';
export type FxConversion = { amount_minor: number; original_minor: number; original_currency: string; fx_rate: string; fx_date: string; fx_source: string };
export type FxResolver = (minor: number, currency: string, date: string) => Promise<FxConversion>;
type Day = { date: string; rates: Map<string, bigint> };
const SCALE = 1000000000000n;
const rounded = (n: bigint, d: bigint) => (n + d / 2n) / d;
const rateText = (n: bigint) => `${n / SCALE}.${String(n % SCALE).padStart(12, '0')}`.replace(/\.?0+$/, '');

/** Rates are exact decimal ratios to EUR, never binary floating-point money. */
function parseRates(xml: string): Day[] {
  const days: Day[] = [];
  for (const match of xml.matchAll(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g)) {
    const rates = new Map<string, bigint>([['EUR', SCALE]]);
    for (const quote of match[2].matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"](\d+(?:\.\d{1,12})?)['"]\s*\/>/g)) {
      const [whole, fraction = ''] = quote[2].split('.');
      const value = BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, '0'));
      if (value > 0n) rates.set(quote[1], value);
    }
    if (rates.size > 1) days.push({ date: match[1], rates });
  }
  requireThat(days.length, 'ECB returned no usable reference rates', 502);
  return days.sort((a, b) => b.date.localeCompare(a.date));
}

/** One lazy public-rate download per operation; no expense, date, currency or identity is sent to ECB. */
export function createFx(enabled: boolean, baseCurrency: string): FxResolver {
  let history: Promise<Day[]> | undefined;
  return async (minor, inputCurrency, date) => {
    const currency = inputCurrency.toUpperCase();
    requireThat(/^[A-Z]{3}$/.test(currency), 'Currency must be a three-letter code');
    requireThat(Number.isSafeInteger(minor), 'Amount is too large');
    if (currency === baseCurrency) return { amount_minor: minor, original_minor: minor, original_currency: currency, fx_rate: '1', fx_date: date, fx_source: '' };
    requireThat(enabled, 'Ask the owner to enable ECB currency conversion in Settings', 409);
    requireThat(date <= new Date().toISOString().slice(0, 10), 'A foreign expense cannot use a future transaction date');
    history ??= (async () => {
      try {
        const response = await fetch(ECB_HISTORY, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
        requireThat(response.ok, 'ECB reference rates are unavailable; no expense was saved', 502);
        return parseRates(await response.text());
      } catch (error) { if (error instanceof Fault) throw error; throw new Fault(502, 'ECB reference rates could not be fetched; no expense was saved'); }
    })();
    const day = (await history).find(d => d.date <= date);
    requireThat(day, `ECB has no reference rates on or before ${date}`, 422);
    const from = day.rates.get(currency), to = day.rates.get(baseCurrency);
    requireThat(from && to, `ECB has no ${currency}/${baseCurrency} reference rate for ${day.date}`, 422);
    const converted = Number(rounded(BigInt(Math.abs(minor)) * to, from)) * Math.sign(minor);
    requireThat(Number.isSafeInteger(converted) && Math.abs(converted) <= 1e11, 'Converted amount is too large');
    return { amount_minor: converted, original_minor: minor, original_currency: currency, fx_rate: rateText(rounded(to * SCALE, from)), fx_date: day.date, fx_source: 'ECB reference rates' };
  };
}

/** An explicit employee-entered rate, never an automatic substitute for a failed lookup. */
export function manualFx(minor: number, currency: string, date: string, input: unknown): FxConversion {
  requireThat(typeof input === 'string' && /^\d{1,7}(?:\.\d{1,12})?$/.test(input.trim()), 'Enter the rate as business currency per original unit, up to 12 decimal places');
  const [whole, fraction = ''] = input.trim().split('.');
  const rate = BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, '0'));
  requireThat(rate > 0n, 'The entered rate must be more than zero');
  const converted = Number(rounded(BigInt(Math.abs(minor)) * rate, SCALE)) * Math.sign(minor);
  requireThat(Number.isSafeInteger(converted) && Math.abs(converted) <= 1e11, 'Converted amount is too large');
  return { amount_minor: converted, original_minor: minor, original_currency: currency, fx_rate: rateText(rate), fx_date: date, fx_source: 'rate entered by hand' };
}
