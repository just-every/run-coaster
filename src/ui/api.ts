export type D = Record<string, any>;

/** Same-origin JSON call to the Coaster API; a refusal throws its plain-words message. */
export async function call(path: string, input?: D) {
  const response = await fetch('/api/coaster/' + path, input ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : undefined);
  const body: any = await response.json().catch(() => ({ error: 'The server answered unexpectedly' }));
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
}

const grouped = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** Exact minor units as "1,284.60", for a column already headed with its currency. */
export const amount = (minor: number) => { const [whole, fraction] = (minor / 100).toFixed(2).split('.'); return `${grouped(whole)}.${fraction}`; };
/** Exact minor units as "$1,284.60" in dollars, or "EUR 1,284.60" in any other currency. */
export const money = (minor: number, currency = 'USD') => currency === 'USD' ? `${minor < 0 ? '−' : ''}$${amount(Math.abs(minor))}` : `${currency} ${amount(minor)}`;
export const amountText = (minor?: number | null) => minor == null ? '' : (minor / 100).toFixed(2);
/** A rate kept in thousandths of the currency unit, with three places only when it needs them: "0.725", "68.00". */
export const rateText = (thousandths: number) => (thousandths / 1000).toFixed(thousandths % 10 ? 3 : 2);
/** A rate as "$0.725" a mile or "$68.00" a day, or "EUR 0.725" in any other currency. */
export const rate = (thousandths: number, currency = 'USD') => { const [whole, fraction] = rateText(thousandths).split('.'); return `${currency === 'USD' ? '$' : `${currency} `}${grouped(whole)}.${fraction}`; };
/** "1 claim", "3 claims"; `many` for a word that does not take an s ("person", "people"). */
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
export const claimNumber = (n: number) => `CL-${String(n).padStart(4, '0')}`;
export const batchNumber = (n: number) => `RB-${String(n).padStart(4, '0')}`;

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** A YYYY-MM-DD day as that calendar day, or a timestamp in the reader's own clock. */
const when = (iso: string) => /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) : new Date(iso);
const named = (t: Date) => `${weekdays[t.getDay()]} ${months[t.getMonth()]} ${t.getDate()}`;
/** "Tue Oct 13, 2026" for a day or timestamp. */
export const day = (iso?: string | null) => { if (!iso) return '—'; const t = when(iso); return Number.isFinite(t.getTime()) ? `${named(t)}, ${t.getFullYear()}` : '—'; };
/** "Tue Oct 13" this year, "Tue Oct 13, 2025" in any other, as the pick's table dates them. */
export const shortDay = (iso?: string | null) => { if (!iso) return '—'; const t = when(iso); if (!Number.isFinite(t.getTime())) return '—'; return t.getFullYear() === new Date().getFullYear() ? named(t) : `${named(t)}, ${t.getFullYear()}`; };
/** "8:41 AM" in the reader's own clock. */
export const clock = (t: Date) => `${t.getHours() % 12 || 12}:${String(t.getMinutes()).padStart(2, '0')} ${t.getHours() < 12 ? 'AM' : 'PM'}`;
/** "Fri Oct 16, 2026 at 8:41 AM" in the reader's own clock. */
export function moment(iso?: string | null) {
  if (!iso) return '—';
  const t = new Date(iso);
  return Number.isFinite(t.getTime()) ? `${day(iso)} at ${clock(t)}` : '—';
}
/** "MO" for Megan Ortiz; the first two letters of an address with no name. */
export const initials = (name?: string | null) => { const words = String(name ?? '').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean); return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase(); };
export const today = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };

export async function fileBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let raw = '';
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(raw);
}

export const statusWords: Record<string, string> = { draft: 'Draft', submitted: 'Submitted', returned: 'Returned', approved: 'Approved', rejected: 'Rejected', batched: 'In batch', reimbursed: 'Reimbursed', proposed: 'Prepared', accepted: 'Accepted', declined: 'Declined' };
/** A policy exception's code in the words a person reads. */
export const exceptionWords: Record<string, string> = { 'over-limit': 'Over a category limit', 'missing-receipt': 'No receipt', 'duplicate-receipt': 'Same receipt as another expense', 'possible-duplicate': 'Possible duplicate' };
/** Each status's colour family: green done, amber waiting, red failed, grey not started. */
export const statusTone: Record<string, string> = { draft: 'quiet', submitted: 'wait', returned: 'fail', approved: 'done', rejected: 'fail', batched: 'done', reimbursed: 'done', proposed: 'quiet', accepted: 'done', declined: 'quiet' };
export const batchWords: Record<string, string> = { draft: 'Draft · not reviewed', approved: 'Reviewed · ready to pay', reimbursed: 'Paid' };
