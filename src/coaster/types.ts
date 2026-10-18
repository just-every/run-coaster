export type Data = Record<string, any>;

/** A refusal with the HTTP status the API answers. */
export class Fault extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function requireThat(value: unknown, message: string, status = 400): asserts value {
  if (!value) throw new Fault(status, message);
}

export type Roles = { employee: boolean; manager: boolean; finance: boolean; owner: boolean };

/** A person signed in with a native session, or an agent key acting for one person. */
export type Actor = {
  kind: 'person' | 'agent';
  email: string;
  name: string;
  roles: Roles;
  operatorId?: string;
  session?: string;
  keyId?: string;
  agentLabel?: string;
};

export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

export function text(value: unknown, label: string, max = 500): string {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${label} is required (at most ${max} characters)`);
  return value.trim();
}
export function optionalText(value: unknown, label: string, max = 2000): string {
  if (value === undefined || value === null || value === '') return '';
  requireThat(typeof value === 'string' && value.length <= max, `${label} must be text of at most ${max} characters`);
  return value.trim();
}
export function email(value: unknown, label = 'Email'): string {
  const address = text(value, label, 254).toLowerCase();
  requireThat(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address), `${label} must be an email address`);
  return address;
}
export function isoDate(value: unknown, label = 'Date'): string {
  const day = text(value, label, 10);
  requireThat(/^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) === day, `${label} must be a real date (YYYY-MM-DD)`);
  return day;
}

/** "12.30" → 1230. Only plain non-negative decimals with at most two places. */
export function amount(value: unknown, label = 'Amount'): number {
  const raw = typeof value === 'number' ? String(value) : value;
  requireThat(typeof raw === 'string' && /^\d{1,10}(\.\d{1,2})?$/.test(raw.trim()), `${label} must be an amount like 12.50`);
  const [whole, fraction = ''] = raw.trim().split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  requireThat(Number.isSafeInteger(minor) && minor <= 1e11, `${label} is too large`);
  return minor;
}
/** A rate per unit with up to three places, "0.725" → 725 thousandths of the currency unit. */
export function rate(value: unknown, label: string): number {
  const raw = typeof value === 'number' ? String(value) : value;
  requireThat(typeof raw === 'string' && /^\d{1,7}(\.\d{1,3})?$/.test(raw.trim()), `${label} must be a rate like 0.725`);
  const [whole, fraction = ''] = raw.trim().split('.');
  return Number(whole) * 1000 + Number(fraction.padEnd(3, '0'));
}
export function optionalAmount(value: unknown, label: string): number | null {
  return value === undefined || value === null || value === '' ? null : amount(value, label);
}
export const decimal = (minor: number) => `${Math.trunc(minor / 100)}.${String(Math.abs(minor) % 100).padStart(2, '0')}`;

/** Distances in hundredths of a mile: "142" or "142.5" → 14200 / 14250. */
export function distance(value: unknown): number {
  const raw = typeof value === 'number' ? String(value) : value;
  requireThat(typeof raw === 'string' && /^\d{1,6}(\.\d{1,2})?$/.test(raw.trim()), 'Distance must be miles like 142 or 142.5');
  const [whole, fraction = ''] = raw.trim().split('.');
  const hundredths = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  requireThat(hundredths > 0, 'Distance must be more than zero');
  return hundredths;
}
/** Round half up once: distance (hundredths of a mile) × rate per mile (thousandths), in minor units. */
export const mileageMinor = (hundredths: number, rateThousandths: number) => Math.floor((hundredths * rateThousandths + 500) / 1000);
