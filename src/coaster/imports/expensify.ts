import { canonicalJson, sha256, type Diagnostic, type ImportMapping, type SourceBundle, type SourceRecord } from '../../modules/import-kit/src/d1/index';
import { parseCsv } from './csv';
import { requireThat, type Data } from '../types';

/** The Expensify move-in kit reads a report-template CSV built from Expensify's documented export fields (IMPORTING.md). */
export const NAMESPACE = 'expensify';
export const REQUIRED = ['reportID', 'reportName', 'accountEmail', 'status', 'transactionID', 'created', 'merchant', 'amount', 'currency'];
export const OPTIONAL = ['managerEmail', 'submitted', 'approved', 'reimbursed', 'category', 'categoryGlCode', 'tag', 'comment', 'reimbursable', 'billable', 'isDistance', 'units.count', 'units.rate', 'receiptID', 'receiptFilename', 'receiptObject.url'];
export const HISTORY_STATUSES = ['open', 'submitted', 'approved', 'reimbursed', 'closed'];
const REPORT_FIELDS = ['reportName', 'accountEmail', 'managerEmail', 'status', 'submitted', 'approved', 'reimbursed'];
export const DATE_FORMATS = ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY'];

export type ExpensifyMapping = { date: string; statuses: Record<string, string> };

export function day(value: string, format: string): string | null {
  const v = value.trim().slice(0, 10);
  let y: string, m: string, d: string;
  if (format === 'YYYY-MM-DD') { const x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v); if (!x) return null; [, y, m, d] = x; }
  else { const x = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v); if (!x) return null; y = x[3]; [m, d] = format === 'MM/DD/YYYY' ? [x[1], x[2]] : [x[2], x[1]]; }
  const iso = `${y}-${m}-${d}`;
  return new Date(iso + 'T00:00:00Z').toISOString().slice(0, 10) === iso ? iso : null;
}
export const minor = (value: string) => /^\d{1,10}(\.\d{1,2})?$/.test(value.trim()) ? Number(value.trim().split('.')[0]) * 100 + Number((value.trim().split('.')[1] ?? '').padEnd(2, '0')) : null;
const yes = (value: string | undefined) => ['true', 'yes', '1', 'y'].includes((value ?? '').trim().toLowerCase());

/** Plan input for import-kit: report and expense records, exact bytes, and diagnostics that block commit. */
export function expensifySource(raw: unknown, filename: unknown, config: unknown, currency: string) {
  requireThat(typeof raw === 'string' && raw.length > 0 && raw.length <= 2_000_000, 'Choose the Expensify CSV (at most 2 MB)');
  const name = typeof filename === 'string' && filename.trim() ? filename.trim().slice(0, 200) : 'expensify.csv';
  const mapping = (config ?? {}) as ExpensifyMapping;
  requireThat(DATE_FORMATS.includes(mapping.date), 'Choose how the CSV writes dates');
  requireThat(mapping.statuses && typeof mapping.statuses === 'object', 'Map each Expensify report status');
  const { headers, rows } = parseCsv(raw);
  const missing = REQUIRED.filter(h => !headers.includes(h));
  requireThat(!missing.length, `The CSV is missing required columns: ${missing.join(', ')}`);
  requireThat(rows.length <= 2000, 'Import at most 2,000 expenses per file');
  const bytes = new TextEncoder().encode(raw), artifactHash = sha256(bytes);
  const diagnostics: Diagnostic[] = [], expenses = new Map<string, Data>(), reports = new Map<string, Data>();
  const unknownColumns = headers.filter(h => !REQUIRED.includes(h) && !OPTIONAL.includes(h));
  if (unknownColumns.length) diagnostics.push({ severity: 'warning', code: 'IGNORED_COLUMNS', message: `Columns kept in the original file but not mapped: ${unknownColumns.join(', ')}` });
  const statuses = new Set<string>();
  rows.forEach((r, index) => {
    const location = { artifact: name, row: index + 2 };
    const fail = (code: string, message: string) => diagnostics.push({ severity: 'error', code, message: `Row ${index + 2}: ${message}`, kind: 'expense', sourceId: r.transactionID, location });
    const report = r.reportID.trim(), transaction = r.transactionID.trim();
    if (!report) return fail('MISSING_REPORT', 'reportID is empty');
    if (!transaction) return fail('MISSING_TRANSACTION', 'transactionID is empty');
    if (expenses.has(transaction)) return fail('DUPLICATE_TRANSACTION', `transactionID ${transaction} appears twice`);
    const date = day(r.created, mapping.date), amount = minor(r.amount);
    if (!date) fail('BAD_DATE', `created "${r.created}" is not a ${mapping.date} date`);
    if (amount === null || amount === 0) fail('BAD_AMOUNT', `amount "${r.amount}" must be a positive amount like 12.50 (credits and refunds are not imported)`);
    if (r.currency.trim().toUpperCase() !== currency) fail('OTHER_CURRENCY', `currency ${r.currency} is not this business's ${currency}`);
    const status = r.status.trim();
    statuses.add(status);
    if (!HISTORY_STATUSES.includes(mapping.statuses[status])) fail('UNMAPPED_STATUS', `report status "${status}" is not mapped`);
    const head = Object.fromEntries(REPORT_FIELDS.map(f => [f, (r[f] ?? '').trim()]));
    const known = reports.get(report);
    if (known && canonicalJson(known.head) !== canonicalJson(head)) fail('INCONSISTENT_REPORT', `report ${report} has different report fields than on row ${known.location.row}`);
    if (!known) reports.set(report, { head, location, total: 0, expenses: 0 });
    const entry = reports.get(report)!;
    entry.total += amount ?? 0; entry.expenses += 1;
    expenses.set(transaction, { payload: r, location, value: {
      source: 'expensify', transactionId: transaction, report, employee: r.accountEmail.trim().toLowerCase(), date, merchant: r.merchant.trim(), amountMinor: amount, currency,
      category: (r.category ?? '').trim(), glCode: (r.categoryGlCode ?? '').trim(), tag: (r.tag ?? '').trim(), comment: (r.comment ?? '').trim(),
      reimbursable: yes(r.reimbursable), billable: yes(r.billable), distance: yes(r.isDistance) ? { count: (r['units.count'] ?? '').trim(), rate: (r['units.rate'] ?? '').trim() } : null,
      receipt: { id: (r.receiptID ?? '').trim(), filename: (r.receiptFilename ?? '').trim(), url: (r['receiptObject.url'] ?? '').trim() },
      mappedStatus: mapping.statuses[status] ?? null,
    } });
  });
  const records: SourceRecord[] = [];
  for (const [id, report] of reports) records.push({ namespace: NAMESPACE, kind: 'report', sourceId: id, payload: report.head, payloadHash: sha256(canonicalJson(report.head)), artifactHash, location: report.location });
  for (const [id, expense] of expenses) records.push({ namespace: NAMESPACE, kind: 'expense', sourceId: id, payload: expense.payload, payloadHash: sha256(canonicalJson(expense.payload)), artifactHash, location: expense.location });
  const blocked = diagnostics.some(d => d.severity === 'error');
  const values = new Map<string, Data>();
  for (const [id, report] of reports) values.set('report:' + id, { source: 'expensify', reportId: id, name: report.head.reportName, employee: report.head.accountEmail.toLowerCase(), manager: report.head.managerEmail.toLowerCase(), sourceStatus: report.head.status, status: mapping.statuses[report.head.status] ?? null, submitted: report.head.submitted, approved: report.head.approved, reimbursed: report.head.reimbursed, totalMinor: report.total, expenses: report.expenses, currency });
  for (const [id, expense] of expenses) values.set('expense:' + id, expense.value);
  const source: SourceBundle = { diagnostics, artifacts: [{ name, sha256: artifactHash, size: bytes.length, original: { status: 'available', base64: btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')) } }], records };
  const importMapping: ImportMapping = {
    version: sha256(canonicalJson({ kit: 'expensify-report-template-v1', date: mapping.date, statuses: mapping.statuses, currency })),
    map: record => blocked ? { effects: [], rejection: 'Resolve the file errors before importing' } : { effects: [{ targetKind: record.kind, targetId: `expensify:${record.kind}:${record.sourceId}`, value: values.get(`${record.kind}:${record.sourceId}`)! }] },
  };
  return { source, mapping: importMapping, summary: { reports: reports.size, expenses: expenses.size, totalMinor: [...reports.values()].reduce((n, r) => n + r.total, 0), statuses: [...statuses], unmappedStatuses: [...statuses].filter(s => !HISTORY_STATUSES.includes(mapping.statuses[s])), errors: diagnostics.filter(d => d.severity === 'error').map(d => d.message), warnings: diagnostics.filter(d => d.severity === 'warning').map(d => d.message) } };
}
