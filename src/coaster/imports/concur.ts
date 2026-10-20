import { canonicalJson, sha256, type Diagnostic, type ImportMapping, type SourceBundle, type SourceRecord } from '../../modules/import-kit/src/d1/index';
import { requireThat, type Data } from '../types';
import { concurReceipts, delimited, originalArtifact } from './concur-receipts';
import { refuseConcurFinancialData } from './concur-custody';
import type { FxResolver } from '../fx';

/** SAP Standard Accounting Extract v4: Report Data, Entry Data, Journal Entry Data and Allocation Data.
 * https://help.sap.com/docs/CONCUR_EXPENSE/bb83754b1c5541808d50c09901e11475/8bd1d4553ea24fb8abfe37e327c4fde4.html
 * Every SAE line is a journal allocation, not a new expense. The entry approved amount is counted once.
 * Other SAE versions/custom exports use explicit reviewed one-based columns or SAP field-name headers. */
export const CONCUR_SAE_V4 = { record: 1, employeeId: 5, report: 19, reportKey: 20, currency: 22, submitted: 24, approved: 26, reportName: 27, policy: 28, entry: 56, entryType: 57, expenseType: 58, date: 59, originalCurrency: 60, memo: 64, merchant: 65, originalAmount: 114, postedAmount: 115, amount: 116, account: 167, journalSide: 168, journalAmount: 169, journalId: 170, allocation: 189 } as const;
export const CONCUR_HEADERS = { record: 'Record Type', employeeId: 'Employee ID', employeeEmail: 'Employee Email Address', report: 'Report ID', reportKey: 'Report Number', currency: 'Report Currency Alpha Code', submitted: 'Report Submit Date', approved: 'Report Processing Payment Date', reportName: 'Report Name', policy: 'Report Policy Name', entry: 'Report Entry ID', entryType: 'Report Entry Transaction Type', expenseType: 'Report Entry Expense Type Name', date: 'Report Entry Transaction Date', originalCurrency: 'Report Entry Currency Alpha Code', memo: 'Report Entry Description', merchant: 'Report Entry Vendor Name', originalAmount: 'Report Entry Transaction Amount', postedAmount: 'Report Entry Posted Amount', amount: 'Report Entry Approved Amount', account: 'Journal Account Code', journalSide: 'Journal Debit Or Credit', journalAmount: 'Journal Amount', journalId: 'Journal Key', allocation: 'Allocation Key', approver: 'Approver Email', status: 'Report Status' } as const;
export type ConcurField = keyof typeof CONCUR_HEADERS;
export type ConcurMapping = { layout: 'sae-v4' | 'headers'; delimiter?: '|' | ',' | '\t'; columns?: Partial<Record<ConcurField, number | string>>; date?: 'YYYY-MM-DD' | 'YYYYMMDD' | 'MM/DD/YYYY' | 'DD/MM/YYYY'; employees?: Record<string, string>; categories?: Record<string, string>; imageFiles?: Record<string, string>; statuses?: Record<string, string> };
const required: ConcurField[] = ['employeeId', 'report', 'currency', 'entry', 'expenseType', 'date', 'merchant', 'amount', 'journalAmount', 'journalId'];
const address = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

/** SAE decimals may have eight places; extra zeroes are exact cents, nonzero subcents are refused, never rounded. */
export function concurMinor(value: string) {
  const match = /^([+-]?)(\d{1,10})(?:\.(\d{1,8}))?$/.exec(value.trim()); if (!match || /[1-9]/.test((match[3] ?? '').slice(2))) return null;
  const n = Number(match[2]) * 100 + Number((match[3] ?? '').slice(0, 2).padEnd(2, '0')); return match[1] === '-' ? -n : n;
}
function date(value: string, format: string) {
  let iso = value;
  if (format === 'YYYYMMDD') { const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value); if (!m) return null; iso = `${m[1]}-${m[2]}-${m[3]}`; }
  else if (format !== 'YYYY-MM-DD') { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value); if (!m) return null; iso = `${m[3]}-${format === 'MM/DD/YYYY' ? m[1] : m[2]}-${format === 'MM/DD/YYYY' ? m[2] : m[1]}`; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const time = Date.parse(iso + 'T00:00:00Z'); return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === iso ? iso : null;
}

/** Normalize source amounts before applying the optional transaction-date FX resolver; no database writes. */
export async function concurSource(raw: unknown, filename: unknown, config: unknown, receiptInput: unknown, currency: string, fx?: FxResolver) {
  requireThat(typeof raw === 'string' && raw.length > 0 && new TextEncoder().encode(raw).length <= 2_000_000, 'Choose the Concur accounting extract (at most 2 MB)');
  const name = typeof filename === 'string' && filename.trim() ? filename.trim().slice(0, 200) : 'concur-accounting.txt', options = config as ConcurMapping;
  requireThat(options && ['sae-v4', 'headers'].includes(options.layout), 'Choose SAE v4 or a mapped export with headers');
  const separator = options.delimiter ?? (options.layout === 'sae-v4' ? '|' : ','); requireThat(['|', ',', '\t'].includes(separator), 'Choose pipe, comma or tab separated input');
  const format = options.date ?? 'YYYY-MM-DD'; requireThat(['YYYY-MM-DD', 'YYYYMMDD', 'MM/DD/YYYY', 'DD/MM/YYYY'].includes(format), 'Choose the date format');
  const rows = delimited(raw, separator); requireThat(rows.length > 0 && rows.length <= 4001, 'Import at most 4,000 journal rows at a time');
  const extract = options.layout === 'sae-v4' ? rows[0] : null;
  if (extract) requireThat(extract[0] === 'EXTRACT' && extract.length >= 5 && /^\d+$/.test(extract[2]) && concurMinor(extract[3]) !== null, 'The SAE file needs its EXTRACT header with record count and signed journal total');
  const headers = options.layout === 'headers' ? rows.shift()!.map(h => h.trim()) : [];
  refuseConcurFinancialData(options.layout === 'sae-v4' ? rows.slice(1) : rows, headers, options.layout === 'sae-v4');
  requireThat(!headers.length || new Set(headers.map(h => h.toLowerCase())).size === headers.length, 'The extract headers must be unique');
  const columns: Partial<Record<ConcurField, number | string>> = { ...(options.layout === 'sae-v4' ? CONCUR_SAE_V4 : CONCUR_HEADERS), ...options.columns };
  const indexes = new Map<ConcurField, number>();
  for (const key of Object.keys(columns) as ConcurField[]) {
    const value = columns[key];
    if (typeof value === 'number') { requireThat(Number.isInteger(value) && value >= 1 && value <= 500, 'Column positions must be whole numbers from 1 to 500'); indexes.set(key, value - 1); }
    else if (typeof value === 'string') { requireThat(headers.length, 'Named column mappings need a header export'); const index = headers.findIndex(h => h.toLowerCase() === value.toLowerCase()); if (index >= 0) indexes.set(key, index); }
  }
  requireThat(required.every(k => indexes.has(k)), `Map the required Concur columns: ${required.filter(k => !indexes.has(k)).join(', ')}`);
  const bytes = new TextEncoder().encode(raw), artifactHash = sha256(bytes), receipts = await concurReceipts(receiptInput, options.imageFiles);
  const diagnostics: Diagnostic[] = [...receipts.diagnostics], entries = new Map<string, Data>(), reports = new Map<string, Data>(), journals = new Set<string>(), types = new Set<string>(), employeeIds = new Set<string>();
  let journalTotal = 0;
  const mapped = new Set(indexes.values());
  if (headers.length) { const unmapped = headers.filter((_, i) => !mapped.has(i)); if (unmapped.length) diagnostics.push({ severity: 'warning', code: 'IGNORED_COLUMNS', message: `Columns retained in the original but not mapped: ${unmapped.join(', ')}` }); }
  rows.forEach((row, i) => {
    const rowNumber = i + (headers.length ? 2 : 1), location = { artifact: name, row: rowNumber }, at = (key: ConcurField) => (row[indexes.get(key) ?? -1] ?? '').trim();
    const report = at('report'), id = at('entry'), journal = at('journalId'), fail = (code: string, message: string) => diagnostics.push({ severity: 'error', code, message: `Row ${rowNumber}: ${message}`, kind: 'expense', sourceId: id, location });
    if (options.layout === 'sae-v4' && i === 0) return;
    if (headers.length ? row.length !== headers.length : row.length <= Math.max(...required.map(k => indexes.get(k)!))) { fail('ROW_WIDTH', 'The row does not contain the mapped columns'); return; }
    if (indexes.has('record') && at('record') !== 'DETAIL') { fail('RECORD_TYPE', 'Only DETAIL accounting rows can be imported'); return; }
    if (!report || !id || !journal) { fail('MISSING_ID', 'Report ID, Report Entry ID and Journal Key are required'); return; }
    const employeeId = at('employeeId'), employee = (at('employeeEmail') || options.employees?.[employeeId] || '').toLowerCase(), expenseType = at('expenseType'), categoryId = options.categories?.[expenseType];
    employeeIds.add(employeeId); types.add(expenseType);
    if (!employeeId || !address(employee)) fail('UNMAPPED_EMPLOYEE', `Map employee ${employeeId || '(empty)'} to their email address`);
    if (!expenseType || !categoryId) fail('UNMAPPED_EXPENSE_TYPE', `Map expense type ${expenseType || '(empty)'} to a category`);
    const when = date(at('date'), format), amount = concurMinor(at('amount')), journalAmount = concurMinor(at('journalAmount'));
    if (!when) fail('BAD_DATE', `The transaction date is not a real ${format} date`);
    if (amount === null || amount === 0 || journalAmount === null) fail('BAD_AMOUNT', 'Approved and journal amounts must be exact cents; the entry amount cannot be zero');
    const reportCurrency = at('currency').toUpperCase(), originalCurrency = at('originalCurrency').toUpperCase();
    if (!/^[A-Z]{3}$/.test(reportCurrency) || (originalCurrency && !/^[A-Z]{3}$/.test(originalCurrency))) fail('BAD_CURRENCY', 'Report and transaction currencies must be three-letter currency codes');
    if (at('originalAmount') && concurMinor(at('originalAmount')) === null) fail('BAD_ORIGINAL_AMOUNT', 'The original transaction amount must be exact cents');
    if (!fx && reportCurrency !== currency) fail('OTHER_CURRENCY', `Foreign-currency Concur history needs conversion before import into ${currency}`);
    if (!at('merchant')) fail('MISSING_MERCHANT', 'The vendor name is empty');
    if (at('entryType') && !['REG', 'CHD'].includes(at('entryType'))) fail('ENTRY_TYPE', 'Only regular and itemized child entries are imported; parent amounts must not be counted twice');
    const side = at('journalSide'); if (side && (!['DR', 'CR'].includes(side) || (journalAmount !== null && journalAmount !== 0 && (side === 'CR') !== (journalAmount < 0)))) fail('JOURNAL_SIGN', 'The journal debit/credit flag disagrees with its signed amount');
    const approver = at('approver').toLowerCase(); if (approver && !address(approver)) fail('BAD_APPROVER', 'The approver must be an email address');
    const sourceStatus = at('status') || 'approved', mappedStatus = at('status') ? options.statuses?.[sourceStatus] : 'approved';
    if (!['open', 'submitted', 'approved', 'reimbursed', 'closed'].includes(mappedStatus ?? '')) fail('UNMAPPED_STATUS', `Map report status ${sourceStatus}`);
    const head = { report, reportKey: at('reportKey'), name: at('reportName') || report, employee, currency, reportCurrency, policy: at('policy'), submitted: at('submitted'), approved: at('approved'), approver, sourceStatus, status: mappedStatus ?? null };
    const knownReport = reports.get(report); if (knownReport && canonicalJson(knownReport.head) !== canonicalJson(head)) fail('INCONSISTENT_REPORT', `Report ${report} has inconsistent report fields`);
    if (!knownReport) reports.set(report, { head, location });
    const value = { source: 'concur', concur: true, label: `SAP Concur expense ${id}`, transactionId: id, report, employee, date: when, merchant: at('merchant'), amountMinor: amount, currency, reportAmountMinor: amount, reportCurrency, memo: at('memo'), category: expenseType, categoryId: categoryId ?? null, glCode: at('account'), approver, policy: at('policy'), originalAmount: at('originalAmount'), originalCurrency: at('originalCurrency'), postedAmount: at('postedAmount'), entryType: at('entryType') };
    const known = entries.get(id);
    // Account codes differ between allocated journals; expense identity and totals must not.
    const comparable = ({ glCode: _gl, ...v }: Data) => v;
    if (known && canonicalJson(comparable(known.value)) !== canonicalJson(comparable(value))) fail('INCONSISTENT_ENTRY', `Entry ${id} has inconsistent repeated fields`);
    if (!known) entries.set(id, { value, rows: [], journals: [], location });
    if (journals.has(journal)) { fail('DUPLICATE_JOURNAL', `Journal Key ${journal} appears more than once`); return; } journals.add(journal);
    journalTotal += journalAmount ?? 0;
    const entry = entries.get(id)!; entry.rows.push(headers.length ? Object.fromEntries(headers.map((h, n) => [h, row[n]])) : row);
    entry.journals.push({ id: journal, allocation: at('allocation'), accountCode: at('account'), amountMinor: journalAmount, side, sourceRow: rowNumber });
  });
  if (extract && (Number(extract[2]) !== rows.length - 1 || concurMinor(extract[3]) !== journalTotal)) diagnostics.push({ severity: 'error', code: 'EXTRACT_TOTAL', message: 'The SAE header record count or signed journal total does not match its detail rows' });
  if (!entries.size) diagnostics.push({ severity: 'error', code: 'EMPTY_EXTRACT', message: 'This extract contains no expense entries' });
  const values = new Map<string, Data>(), records: SourceRecord[] = [];
  for (const attachment of receipts.attachments) if (!reports.has(attachment.report) || (attachment.entry && entries.get(attachment.entry)?.value.report !== attachment.report)) diagnostics.push({ severity: 'error', code: 'UNMATCHED_RECEIPT', message: `Receipt ${attachment.name} references a report or entry absent from this extract` });
  for (const [id, entry] of entries) {
    if(entry.journals.reduce((n:number,j:Data)=>n+(j.amountMinor??0),0)!==entry.value.amountMinor) diagnostics.push({severity:'error',code:'ALLOCATION_TOTAL',message:`Entry ${id}: its signed journal allocations do not add up to its approved amount`});
    if (fx && entry.value.date && entry.value.amountMinor !== null) {
      try {
        const conversion = await fx(entry.value.amountMinor, entry.value.reportCurrency, entry.value.date);
        const allocations: Data[] = [];
        let allocated = 0;
        for (const [index, journal] of entry.journals.entries()) {
          const converted = await fx(journal.amountMinor, entry.value.reportCurrency, entry.value.date);
          // Source order is fixed by the reviewed file. Its final journal carries the cent remainder.
          const amountMinor = index === entry.journals.length - 1 ? conversion.amount_minor - allocated : converted.amount_minor;
          allocations.push({ ...journal, ...converted, amount_minor: amountMinor, amountMinor, sourceAmountMinor: journal.amountMinor, sourceCurrency: entry.value.reportCurrency, roundingAdjustmentMinor: amountMinor - converted.amount_minor });
          allocated += amountMinor;
        }
        entry.value = { ...entry.value, ...conversion, amountMinor: conversion.amount_minor };
        entry.journals = allocations;
      } catch (error) { diagnostics.push({ severity: 'error', code: 'FX_CONVERSION', message: `Entry ${id}: ${(error as Error).message}`, kind: 'expense', sourceId: id, location: entry.location }); }
    }
    const attachments = receipts.attachments.filter(r => r.report === entry.value.report && r.entry === id), payload = { employee: entry.value.employee, approver: entry.value.approver, rows: entry.rows };
    values.set(`expense:${id}`, { ...entry.value, glCode: [...new Set(entry.journals.map((j: Data) => j.accountCode))].join('; '), allocations: entry.journals, receipt: attachments[0] ?? null, receipts: attachments });
    records.push({ namespace: 'concur', kind: 'expense', sourceId: id, payload, payloadHash: sha256(canonicalJson(payload)), artifactHash, location: entry.location });
  }
  for (const [id, report] of reports) {
    const expenses = [...entries.values()].filter(e => e.value.report === id), payload = report.head;
    values.set(`report:${id}`, { source: 'concur', concur: true, reportId: id, ...payload, totalMinor: expenses.reduce((n, e) => n + (e.value.amountMinor ?? 0), 0), reportTotalMinor: expenses.reduce((n, e) => n + (e.value.reportAmountMinor ?? 0), 0), expenses: expenses.length, receipts: receipts.attachments.filter(r => r.report === id && !r.entry) });
    records.push({ namespace: 'concur', kind: 'report', sourceId: id, payload, payloadHash: sha256(canonicalJson(payload)), artifactHash, location: report.location });
  }
  // ZIP/index originals can identify the employee by upstream id without containing their address.
  // Bind them to structured provenance so erasure withdraws those originals too, including zero-effect custody.
  for(const artifact of receipts.artifacts.filter(a=>/\.(?:zip|csv)$/i.test(a.name)))for(const [report,data] of reports){
    const payload={employee:data.head.employee,approver:data.head.approver,report};
    records.push({namespace:'concur',kind:'receipt-custody',sourceId:`${artifact.sha256}:${report}`,payload,payloadHash:sha256(canonicalJson(payload)),artifactHash:artifact.sha256,location:{artifact:artifact.name}});
  }
  const blocked = diagnostics.some(d => d.severity === 'error');
  const source: SourceBundle = { diagnostics, records, artifacts: [originalArtifact(name, bytes), ...receipts.artifacts] };
  const mapping: ImportMapping = { version: sha256(canonicalJson({ kit: 'concur-sae-v4-2', options, currency, values: [...values] })), map: r => blocked ? { effects: [], rejection: 'Resolve the Concur import errors before importing' } : r.kind==='receipt-custody'?{effects:[]}:{ effects: [{ targetKind: r.kind, targetId: `concur:${r.kind}:${r.sourceId}`, value: values.get(`${r.kind}:${r.sourceId}`)! }] } };
  return { source, mapping, summary: { reports: reports.size, expenses: entries.size, charges: entries.size, journals: journals.size, totalMinor: [...entries.values()].reduce((n, e) => n + (e.value.amountMinor ?? 0), 0), receipts: receipts.attachments.length, expenseTypes: [...types], employeeIds: [...employeeIds], credits: [...entries].filter(([, e]) => e.value.reportAmountMinor < 0).map(([id]) => id), errors: diagnostics.filter(d => d.severity === 'error').map(d => d.message), warnings: diagnostics.filter(d => d.severity === 'warning').map(d => d.message) } };
}
