import { canonicalJson, sha256, type Diagnostic, type ImportMapping, type SourceBundle, type SourceRecord } from '../../modules/import-kit/src/d1/index';
import { parseCsv } from './csv';
import { day, DATE_FORMATS, minor } from './expensify';
import { receiptBytes } from '../claims';
import { Fault, requireThat, type Data } from '../types';

/** Card transactions from Ramp, Brex and Navan CSV exports come in as read-only history with their receipts and coding
 * (MOVE-004). Each profile names the columns that tool's transaction export uses (IMPORTING.md); the fixtures are
 * synthetic, and no call is made to any of them. */
export const CARD_SOURCES = {
  ramp: { label: 'Ramp', id: 'Transaction ID', date: 'Transaction Date', employee: 'User Email', merchant: 'Merchant Name', amount: 'Amount', currency: 'Currency', memo: 'Memo', category: 'Ramp Category', gl: 'Accounting Category', receipt: 'Receipt File' },
  brex: { label: 'Brex', id: 'Transaction ID', date: 'Posted Date', employee: 'Card Member Email', merchant: 'Merchant', amount: 'Amount', currency: 'Currency', memo: 'Memo', category: 'Category', gl: 'GL Account', receipt: 'Receipt File' },
  navan: { label: 'Navan', id: 'Transaction ID', date: 'Transaction Date', employee: 'Employee Email', merchant: 'Merchant', amount: 'Amount', currency: 'Currency', memo: 'Description', category: 'Expense Type', gl: 'GL Code', receipt: 'Receipt File' },
} as const;
export type CardSource = keyof typeof CARD_SOURCES;
const REQUIRED = ['id', 'date', 'employee', 'merchant', 'amount', 'currency'] as const;
const OPTIONAL = ['memo', 'category', 'gl', 'receipt'] as const;

/** Plan input for import-kit: one record per charge, the export and each receipt file kept as originals; diagnostics
 * that block commit. Refunds and credits come in as negative amounts. */
export function cardSource(source: CardSource, raw: unknown, filename: unknown, config: unknown, files: unknown, currency: string) {
  const profile = CARD_SOURCES[source];
  requireThat(typeof raw === 'string' && raw.length > 0 && raw.length <= 2_000_000, `Choose the ${profile.label} CSV (at most 2 MB)`);
  const name = typeof filename === 'string' && filename.trim() ? filename.trim().slice(0, 200) : `${source}.csv`;
  const date = (config as Data)?.date;
  requireThat(DATE_FORMATS.includes(date), 'Choose how the CSV writes dates');
  requireThat(files === undefined || (Array.isArray(files) && files.length <= 50), 'Add at most 50 receipt files per import');
  const receipts = new Map<string, { name: string; media: string; bytes: Uint8Array; sha: string }>();
  for (const f of (files ?? []) as Data[]) {
    let parsed: ReturnType<typeof receiptBytes>;
    try { parsed = receiptBytes(f); } catch (e) { throw new Fault(400, `${f?.name ?? 'A receipt file'}: ${(e as Error).message}`); }
    requireThat(!receipts.has(parsed.name), `Receipt file ${parsed.name} is there twice`);
    receipts.set(parsed.name, { name: parsed.name, media: parsed.media!, bytes: parsed.bytes, sha: sha256(parsed.bytes) });
  }
  const { headers, rows } = parseCsv(raw);
  const missing = REQUIRED.filter(k => !headers.includes(profile[k])).map(k => profile[k]);
  requireThat(!missing.length, `The ${profile.label} CSV is missing required columns: ${missing.join(', ')}`);
  requireThat(rows.length <= 2000, 'Import at most 2,000 charges per file');
  const bytes = new TextEncoder().encode(raw), artifactHash = sha256(bytes), known = new Set<string>([...REQUIRED, ...OPTIONAL].map(k => profile[k]));
  const diagnostics: Diagnostic[] = [], charges = new Map<string, Data>(), used = new Set<string>(), credits: string[] = [];
  const ignored = headers.filter(h => !known.has(h));
  if (ignored.length) diagnostics.push({ severity: 'warning', code: 'IGNORED_COLUMNS', message: `Columns kept in the original file but not mapped: ${ignored.join(', ')}` });
  rows.forEach((r, index) => {
    const location = { artifact: name, row: index + 2 }, id = r[profile.id].trim(), at = (col: string | undefined) => (col ? r[col] ?? '' : '').trim();
    const fail = (code: string, message: string) => diagnostics.push({ severity: 'error', code, message: `Row ${index + 2}: ${message}`, kind: 'expense', sourceId: id, location });
    if (!id) return fail('MISSING_TRANSACTION', `${profile.id} is empty`);
    if (charges.has(id)) return fail('DUPLICATE_TRANSACTION', `${profile.id} ${id} appears twice`);
    const amountText = at(profile.amount);
    // A refund or credit comes in as negative-amount history, so a later feed can match it as well.
    const credit = amountText.startsWith('-'), magnitude = minor(credit ? amountText.slice(1) : amountText), amount = magnitude === null ? null : credit ? -magnitude : magnitude;
    if (credit) credits.push(id);
    const when = day(at(profile.date), date), employee = at(profile.employee).toLowerCase(), file = at(profile.receipt);
    if (!when) fail('BAD_DATE', `${profile.date} "${at(profile.date)}" is not a ${date} date`);
    if (amount === null || amount === 0) fail('BAD_AMOUNT', `${profile.amount} "${amountText}" must be an amount like 12.50 (a refund or credit like -12.50)`);
    if (at(profile.currency).toUpperCase() !== currency) fail('OTHER_CURRENCY', `currency ${at(profile.currency)} is not this business's ${currency}`);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(employee)) fail('BAD_EMPLOYEE', `${profile.employee} "${employee}" is not an email address`);
    const receipt = file ? receipts.get(file) : undefined;
    if (file && !receipt) fail('MISSING_RECEIPT', `receipt ${file} was not added`);
    if (receipt) used.add(file);
    charges.set(id, { payload: r, location, value: {
      source, label: `${profile.label} card charge ${id}`, transactionId: id, employee, date: when, merchant: at(profile.merchant), amountMinor: amount, currency,
      memo: at(profile.memo), category: at(profile.category), glCode: at(profile.gl), card: true,
      receipt: receipt ? { name: receipt.name, sha256: receipt.sha, size: receipt.bytes.length, mediaType: receipt.media } : null,
    } });
  });
  for (const file of receipts.keys()) if (!used.has(file)) diagnostics.push({ severity: 'warning', code: 'UNUSED_RECEIPT', message: `Receipt file ${file} is not named by any charge and is not imported` });
  const records: SourceRecord[] = [...charges].map(([id, c]) => ({ namespace: source, kind: 'expense', sourceId: id, payload: c.payload, payloadHash: sha256(canonicalJson(c.payload)), artifactHash, location: c.location }));
  const blocked = diagnostics.some(d => d.severity === 'error');
  const original = (b: Uint8Array) => ({ status: 'available' as const, base64: btoa(Array.from(b, x => String.fromCharCode(x)).join('')) });
  const kept = [...receipts.values()].filter(r => used.has(r.name));
  const bundle: SourceBundle = { diagnostics, records, artifacts: [{ name, sha256: artifactHash, size: bytes.length, original: original(bytes) }, ...kept.map(r => ({ name: r.name, sha256: r.sha, size: r.bytes.length, original: original(r.bytes) }))] };
  const mapping: ImportMapping = {
    version: sha256(canonicalJson({ kit: `${source}-transactions-v1`, date, currency })),
    map: record => blocked ? { effects: [], rejection: 'Resolve the file errors before importing' } : { effects: [{ targetKind: 'expense', targetId: `${source}:expense:${record.sourceId}`, value: charges.get(record.sourceId)!.value }] },
  };
  const values = [...charges.values()].map(c => c.value);
  return { source: bundle, mapping, summary: { charges: charges.size, totalMinor: values.reduce((n, v) => n + (v.amountMinor ?? 0), 0), receipts: values.filter(v => v.receipt).length, credits, errors: diagnostics.filter(d => d.severity === 'error').map(d => d.message), warnings: diagnostics.filter(d => d.severity === 'warning').map(d => d.message) } };
}
