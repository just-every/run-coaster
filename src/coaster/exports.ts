import { authority, commit, need } from './session';
import { event } from './events';
import { batchLines, batchNumber, csv, loadBatch, type Batch } from './batches';
import { business } from './settings';
import { nextDay, startOf } from './audit';
import { xlsx } from './xlsx';
import { decimal, isoDate, now, requireThat, text, uid, type Actor, type Data } from './types';

type Kind = 'accounting' | 'reimbursements';
type Column = { field: string; header: string };
type Row = Record<string, string | number>;

/** Every field each file can carry, in the default template's order. */
export const FIELDS: Record<Kind, string[]> = {
  accounting: ['batch', 'claim', 'employee', 'date', 'merchant', 'description', 'type', 'category', 'account_code', 'tax_code', 'cost_center', 'amount', 'currency', 'receipt_sha256', 'receipt_link', 'policy_exceptions', 'explanation', 'approved_by', 'approved_at', 'memo', 'billable', 'customer', 'project', 'taxable', 'form_1099_review'],
  reimbursements: ['batch', 'employee', 'name', 'claims', 'amount', 'currency', 'taxable_amount', 'form_1099_review'],
};
/** Fields kept in minor units and written as money. */
const MONEY = new Set(['amount', 'taxable_amount']);
const defaultColumns = (kind: Kind): Column[] => FIELDS[kind].map(field => ({ field, header: field }));
const exportReader = (actor: Actor) => requireThat(actor.roles.finance || actor.roles.auditor, 'Finance or auditor access required', 403);

export async function exportTemplates(db: D1Database) {
  const { results } = await db.prepare('SELECT id,name,kind,columns,created_by,created_at FROM c_export_templates ORDER BY name').all<Data>();
  return results.map(t => ({ ...t, columns: JSON.parse(t.columns) as Column[] }));
}

/** Finance (or the owner) saves a column template: chosen fields, in order, under their own headers. */
export async function saveExportTemplate(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'finance');
  requireThat(actor.kind === 'person', 'Only a person saves an export template', 403);
  const name = text(b.name, 'Template name', 80);
  requireThat(b.kind === 'accounting' || b.kind === 'reimbursements', 'Choose the accounting or the reimbursements file');
  const kind: Kind = b.kind;
  requireThat(Array.isArray(b.columns) && b.columns.length > 0 && b.columns.length <= 40, 'Choose between 1 and 40 columns');
  const columns: Column[] = b.columns.map((c: Data) => {
    requireThat(c && FIELDS[kind].includes(c.field), `Unknown ${kind} field: ${String(c?.field ?? '')}`);
    return { field: c.field, header: c.header === undefined || c.header === '' ? c.field : text(c.header, 'Column header', 60) };
  });
  requireThat(!(await db.prepare('SELECT 1 FROM c_export_templates WHERE name=?').bind(name).first()), 'A template with that name exists; choose another name', 409);
  const id = uid();
  await commit(db, authority(actor, 'finance'), [
    db.prepare('INSERT INTO c_export_templates(id,name,kind,columns,created_by,created_at) VALUES(?,?,?,?,?,?)').bind(id, name, kind, JSON.stringify(columns), actor.email, now()),
    event(db, actor, 'export-template-saved', {}, { id, name, kind, columns: columns.map(c => c.field) }),
  ]);
  return { id, name, kind, columns };
}

async function columnsFor(db: D1Database, kind: Kind, template: string | undefined) {
  if (!template) return defaultColumns(kind);
  const found = await db.prepare('SELECT kind,columns FROM c_export_templates WHERE id=?').bind(template).first<{ kind: string; columns: string }>();
  requireThat(found, 'Export template not found', 404);
  requireThat(found.kind === kind, `That template is for the ${found.kind} file`);
  return JSON.parse(found.columns) as Column[];
}

/** One batch's rows for a file, refusing a batch whose lines and people do not add up to its total. */
async function batchRows(db: D1Database, batch: Batch, kind: Kind, origin: string): Promise<Row[]> {
  const { lines, people } = await batchLines(db, batch.id), name = batchNumber(batch.number);
  requireThat(lines.reduce((n, l) => n + l.amountMinor, 0) === batch.total_minor && people.reduce((n, p) => n + p.amountMinor, 0) === batch.total_minor, 'The batch does not reconcile; do not pay it and report this', 500);
  return kind === 'accounting'
    ? lines.map(l => ({ batch: name, claim: l.claim, employee: l.employee, date: l.date, merchant: l.merchant, description: l.description, type: l.kind, category: l.category, account_code: l.account, tax_code: l.tax, cost_center: l.costCentre, amount: l.amountMinor, currency: batch.currency, receipt_sha256: l.receipt, receipt_link: l.receiptId ? `${origin}/api/coaster/receipts/${l.receiptId}` : '', policy_exceptions: l.exceptions, explanation: l.explanation, approved_by: l.approver, approved_at: l.approvedAt, memo: l.memo, billable: l.billable ? 'true' : 'false', customer: l.customer, project: l.project, employee_name: l.employeeName, taxable: l.taxable ? 'true' : 'false', form_1099_review: l.form1099 ? 'true' : 'false' }))
    : people.map(p => ({ batch: name, employee: p.email, name: p.name, claims: p.claims.join(' '), amount: p.amountMinor, currency: batch.currency, taxable_amount: p.taxableMinor, form_1099_review: p.form1099 ? 'true' : 'false' }));
}

/** QuickBooks Desktop IIF: one bill per claim to the employee as vendor, crediting Accounts Payable and debiting each
 * accounting line's account code (its category name when it has none), dated the day the batch was reviewed. */
function iif(rows: Row[], dates: Map<string, string>) {
  const clean = (v: unknown) => String(v ?? '').replace(/[\t\r\n"]/g, ' ');
  const out = ['!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO', '!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO', '!ENDTRNS'];
  const claims = new Map<string, Row[]>();
  for (const row of rows) claims.set(`${row.batch} ${row.claim}`, [...(claims.get(`${row.batch} ${row.claim}`) ?? []), row]);
  for (const [, lines] of claims) {
    const first = lines[0], date = dates.get(String(first.batch))!, vendor = clean(first.employee_name || first.employee), total = lines.reduce((n, l) => n + Number(l.amount), 0);
    out.push(['TRNS', '', 'BILL', date, 'Accounts Payable', vendor, decimal(-total), clean(first.claim), clean(`Coaster ${first.batch} ${first.claim}`)].join('\t'));
    for (const l of lines) out.push(['SPL', '', 'BILL', date, clean(l.account_code || l.category), vendor, decimal(Number(l.amount)), clean(l.claim), clean(`${l.merchant} · ${l.description || l.category}${l.receipt_sha256 ? ` · receipt ${l.receipt_sha256}` : ''}`)].join('\t'));
    out.push('ENDTRNS');
  }
  return out.join('\r\n') + '\r\n';
}

const localDate = (iso: string, timezone: string) => new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/** The file for these batches: CSV or XLSX through a column template, or IIF for the accounting lines. */
async function render(db: D1Database, batches: Batch[], kind: Kind, format: string, template: string | undefined, origin: string) {
  requireThat(['csv', 'xlsx', 'iif'].includes(format), 'Unknown export format', 404);
  requireThat(format !== 'iif' || kind === 'accounting', 'IIF carries the accounting lines only', 404);
  const rows = (await Promise.all(batches.map(b => batchRows(db, b, kind, origin)))).flat();
  if (format === 'iif') {
    const timezone = (await business(db))?.timezone ?? 'UTC';
    return { rows: rows.length, type: 'application/octet-stream', body: iif(rows, new Map(batches.map(b => [batchNumber(b.number), localDate(b.reviewed_at!, timezone)]))) as BodyInit };
  }
  const columns = await columnsFor(db, kind, template);
  // Amounts are decimal currency units in CSV and numbers in XLSX; every other field is text.
  const cells = rows.map(r => columns.map(c => MONEY.has(c.field) ? (format === 'xlsx' ? Number(r[c.field]) / 100 : decimal(Number(r[c.field]))) : String(r[c.field] ?? '')));
  const table = [columns.map(c => c.header), ...cells];
  return format === 'xlsx'
    ? { rows: rows.length, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: xlsx(table, new Date()) as BodyInit }
    : { rows: rows.length, type: 'text/csv; charset=utf-8', body: csv(table) as BodyInit };
}

const download = (body: BodyInit, type: string, filename: string) => new Response(body, { headers: { 'content-type': type, 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

/** Finance and auditors download a reviewed batch's files; the download is a history line. */
export async function batchFile(db: D1Database, actor: Actor, id: string, kind: string, format: string, template: string | undefined, origin: string) {
  exportReader(actor);
  const batch = await loadBatch(db, id);
  requireThat(batch.status !== 'draft', 'Review the batch before exporting it', 409);
  requireThat(kind === 'accounting' || kind === 'reimbursements', 'Unknown export', 404);
  const file = await render(db, [batch], kind, format, template, origin), name = batchNumber(batch.number);
  await commit(db, authority(actor, actor.roles.finance ? 'finance' : 'auditor'), [event(db, actor, 'batch-exported', { batch: id }, { file: kind, format, template: template ?? null, rows: file.rows, totalMinor: batch.total_minor })]);
  return download(file.body, file.type, `${name}-${kind}.${format}`);
}

/** Every batch reviewed in a period (from and to inclusive, as dates in the business time zone) in one file. */
export async function periodFile(db: D1Database, actor: Actor, kind: string, format: string, q: Record<string, string>, origin: string) {
  exportReader(actor);
  requireThat(kind === 'accounting' || kind === 'reimbursements', 'Unknown export', 404);
  const settings = await business(db);
  requireThat(settings, 'The owner has not set up the business yet', 409);
  const from = isoDate(q.from, 'From'), to = isoDate(q.to, 'Until');
  requireThat(to >= from, 'The period must end on or after it starts');
  const { results } = await db.prepare("SELECT * FROM c_batches WHERE status<>'draft' AND reviewed_at>=? AND reviewed_at<? ORDER BY number").bind(startOf(from, settings.timezone), startOf(nextDay(to), settings.timezone)).all<Batch>();
  const file = await render(db, results, kind, format, q.template || undefined, origin);
  await commit(db, authority(actor, actor.roles.finance ? 'finance' : 'auditor'), [event(db, actor, 'period-exported', {}, { file: kind, format, template: q.template || null, from, to, batches: results.length, rows: file.rows, totalMinor: results.reduce((n, b) => n + b.total_minor, 0) })]);
  return download(file.body, file.type, `coaster-${kind}-${from}-to-${to}.${format}`);
}
