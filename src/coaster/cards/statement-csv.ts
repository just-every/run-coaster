import { parseCsv } from '../imports/csv';
import { day, DATE_FORMATS } from '../imports/expensify';
import { requireThat, type Data } from '../types';
import type { StatementCard, StatementRow } from './statement';
import { maskStatementNumbers } from './statement-numbers';

const SIGNS = ['purchases-negative', 'purchases-positive'];
const KINDS: [StatementRow['kind'], RegExp][] = [['purchase', /^(sale|purchase|debit|pos)$/i], ['credit', /^(credit|refund|return)$/i], ['payment', /^(payment|pmt)$/i], ['fee', /^(fee|fees)$/i], ['interest', /^(interest|int)$/i]];
const PENDING = /^(pending|authori[sz]ed|auth|hold)$/i;
const column = (headers: string[], mapping: Data, key: string, required: boolean) => {
  const name = mapping[key];
  if (name === undefined || name === null || name === '') { requireThat(!required, `Map the ${key} column`); return null; }
  requireThat(typeof name === 'string' && headers.includes(name), `The ${key} column "${String(name)}" is not in the file`);
  return name;
};
const money = (v: string) => { const m = /^(-?)\$?(\d{1,3}(?:,\d{3})+|\d{1,10})(?:\.(\d{1,2}))?$/.exec(v.trim()); return m ? (m[1] ? -1 : 1) * (Number(m[2].replace(/,/g, '')) * 100 + Number((m[3] ?? '').padEnd(2, '0'))) : null; };

/** A statement CSV read through an explicit column mapping, never by guessing a layout. Posted date, description and
 * amount are required, with the date format and the sign convention chosen by the importer; the card comes from a column
 * (its last four digits) or the whole file is assigned to one card. Card numbers in the column are reduced to their last
 * four and replaced in the retained text. */
export function parseStatementCsv(raw: string, mapping: Data, currency: string): { cards: StatementCard[]; rows: StatementRow[]; period: { start: string | null; end: string | null }; currency: string; masked: string } {
  const { headers, rows: lines } = parseCsv(raw);
  requireThat(DATE_FORMATS.includes(mapping.dateFormat), 'Choose how the CSV writes dates');
  requireThat(SIGNS.includes(mapping.sign), 'Choose whether purchases are negative or positive amounts');
  const posted = column(headers, mapping, 'postedDate', true)!, description = column(headers, mapping, 'description', true)!, amount = column(headers, mapping, 'amount', true)!;
  const cardColumn = column(headers, mapping, 'card', false), txDate = column(headers, mapping, 'transactionDate', false), txId = column(headers, mapping, 'transactionId', false);
  const currencyColumn = column(headers, mapping, 'currency', false), statusColumn = column(headers, mapping, 'status', false), typeColumn = column(headers, mapping, 'type', false);
  column(headers, mapping, 'cardholder', false);
  const mccColumn=column(headers,mapping,'mcc',false);
  const whole = typeof mapping.wholeFileLast4 === 'string' ? mapping.wholeFileLast4.trim() : '';
  requireThat(cardColumn || /^\d{4}$/.test(whole), 'Map the card column, or assign the whole file to one card by its last four digits');
  requireThat(!(cardColumn && whole), 'Use the card column or one card for the whole file, not both');
  requireThat(lines.length > 0, 'The CSV has no rows');
  const accounts = new Map<string, string>();
  if (cardColumn) for (const row of lines) {
    const number = row[cardColumn].replace(/\D/g, ''), last4 = number.slice(-4);
    if (number.length <= 4) continue;
    requireThat(!accounts.has(last4) || accounts.get(last4) === number, `Two cards in this file share the last four ${last4}; import them in separate files`);
    accounts.set(last4, number);
  }
  const masked = maskStatementNumbers(raw, accounts.values(), cardColumn ? lines.map(row => row[cardColumn]) : []);
  if (masked !== raw) return parseStatementCsv(masked, mapping, currency);
  const seen = new Map<string, number>(), full = new Map<string, string>(), rows: StatementRow[] = [], cards: StatementCard[] = [];
  let first: string | null = null, last: string | null = null;
  for (const [index, r] of lines.entries()) {
    const problems: string[] = [];
    let last4 = whole;
    if (cardColumn) {
      const digits = r[cardColumn].replace(/\D/g, '');
      if (digits.length < 4) problems.push('the card column has no last four digits'); else { last4 = digits.slice(-4); if (digits.length > 4) { const known = full.get(last4); requireThat(!known || known === digits, `Two cards in this file share the last four ${last4}; import them in separate files`); full.set(last4, digits); } }
    }
    if (last4 && !cards.some(c => c.last4 === last4)) cards.push({ last4, label: `····${last4}` });
    const postedOn = day(r[posted], mapping.dateFormat), transactionOn = txDate && r[txDate].trim() ? day(r[txDate], mapping.dateFormat) : null;
    if (!postedOn) problems.push(`posted date "${r[posted]}" is not a ${mapping.dateFormat} date`);
    if (txDate && r[txDate].trim() && !transactionOn) problems.push(`transaction date "${r[txDate]}" is not a ${mapping.dateFormat} date`);
    const signed = money(r[amount]);
    if (signed === null || signed === 0) problems.push(`amount "${r[amount]}" must be a nonzero amount like 12.50`);
    const purchase = signed !== null && (mapping.sign === 'purchases-positive' ? signed > 0 : signed < 0);
    const typeText = typeColumn ? r[typeColumn].trim() : '';
    let kind: StatementRow['kind'] = signed === null ? 'other' : purchase ? 'purchase' : 'credit';
    if (typeColumn) kind = KINDS.find(([, re]) => re.test(typeText))?.[0] ?? 'other';
    if (typeColumn && kind === 'purchase' && !purchase && signed !== null) problems.push('a purchase row whose sign is the credit sign');
    const pending = !!statusColumn && PENDING.test(r[statusColumn].trim());
    const id = txId ? r[txId].trim() : '', descriptor = r[description].replace(/\s+/g, ' ').trim();
    const base = `${last4}|${postedOn}|${signed}|${descriptor.toLowerCase()}`, n = (seen.get(base) ?? 0) + 1;
    if (!id) seen.set(base, n);
    if (postedOn && (!first || postedOn < first)) first = postedOn;
    if (postedOn && (!last || postedOn > last)) last = postedOn;
    const cur = (currencyColumn ? r[currencyColumn].trim().toUpperCase() : '') || currency;
    const mcc=mccColumn?r[mccColumn].trim():'';if(mcc&&!/^\d{4}$/.test(mcc))problems.push('merchant category code must have four digits');
    rows.push({ ...(mcc?{mcc}:{}), line: index + 2, last4, key: id ? `id:${id}` : `row:${postedOn}|${signed}|${descriptor.toLowerCase()}|${n}`, kind, postedOn, transactionOn, descriptor, memo: '', amountMinor: signed === null ? null : Math.abs(signed), signed, currency: cur, originalCurrency: '', originalMinor: null, pending, problems });
  }
  return { cards, rows, period: { start: first, end: last }, currency, masked };
}
