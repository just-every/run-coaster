export type D = Record<string, any>;

/** Same-origin JSON call to the Coaster API; a refusal throws its plain-words message. */
export async function call(path: string, input?: D) {
  const response = await fetch('/api/coaster/' + path, input ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : undefined);
  const body: any = await response.json().catch(() => ({ error: 'The server answered unexpectedly' }));
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
}

const grouped = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** Exact minor units as "AUD 1,284.60". */
/** Exact minor units as "1,284.60", for a column already headed with its currency. */
export const amount = (minor: number) => { const [whole, fraction] = (minor / 100).toFixed(2).split('.'); return `${grouped(whole)}.${fraction}`; };
export const money = (minor: number, currency = 'AUD') => `${currency} ${amount(minor)}`;
export const amountText = (minor?: number | null) => minor == null ? '' : (minor / 100).toFixed(2);
export const claimNumber = (n: number) => `CL-${String(n).padStart(4, '0')}`;
export const batchNumber = (n: number) => `RB-${String(n).padStart(4, '0')}`;

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "29 Apr 2025" for a YYYY-MM-DD day. */
export const day = (iso?: string | null) => { if (!iso) return '—'; const [y, m, d] = iso.slice(0, 10).split('-'); return `${Number(d)} ${months[Number(m) - 1]} ${y}`; };
/** "29 Apr 2025 at 2:14 PM" in the reader's own clock. */
export function moment(iso?: string | null) {
  if (!iso) return '—';
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return '—';
  const h = t.getHours(), m = String(t.getMinutes()).padStart(2, '0');
  return `${t.getDate()} ${months[t.getMonth()]} ${t.getFullYear()} at ${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}
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
export const batchWords: Record<string, string> = { draft: 'Draft · not reviewed', approved: 'Reviewed · ready to pay', reimbursed: 'Paid' };
