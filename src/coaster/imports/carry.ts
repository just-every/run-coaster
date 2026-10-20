import { sha256 } from '../../modules/import-kit/src/d1/index';
import { all, authority, commit, need } from '../session';
import { insertClaim, insertItem, claimTotal, loadClaim } from '../claims';
import { categories, itemInput } from '../items';
import { requireBusiness } from '../settings';
import { event } from '../events';
import { requireThat, text, uid, type Actor, type Data } from '../types';

export const sourceKey = (kind: string, id: string) => sha256(`expensify:${kind}:${id}`);

/** Carry history into a draft, never import an approval or payment authority. */
export async function carryOpenReport(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'employee');
  requireThat(actor.kind === 'person', 'Agents prepare proposals only', 403);
  requireThat(typeof b.report === 'string' && b.report.length > 0 && b.report.length <= 200, 'Choose an imported report');
  const rows = (await db.prepare("SELECT id,value FROM c_history WHERE destination='main' AND (id=? OR (kind='expense' AND json_extract(value,'$.source')='expensify' AND json_extract(value,'$.report')=?)) ORDER BY id").bind(`expensify:report:${b.report}`, b.report).all<{id:string;value:string}>()).results;
  const head = rows.find(r => r.id === `expensify:report:${b.report}`), report = head && JSON.parse(head.value);
  requireThat(report && report.source === 'expensify' && report.employee === actor.email, 'Your imported report was not found', 404);
  requireThat(['open','submitted','approved'].includes(report.status), 'Only an open, submitted or approved source report can be carried', 409);
  const reportKey = sourceKey('report', b.report);
  requireThat(!await db.prepare('SELECT 1 FROM c_cutover_reports WHERE source_key=?').bind(reportKey).first(), 'This source report has already been carried', 409);
  const business = await requireBusiness(db), known = await categories(db);
  requireThat(report.currency === business.currency, 'The source currency differs from this business', 409);
  const expenses = rows.filter(r => r !== head).map(r => ({ row:r, value:JSON.parse(r.value) as Data }));
  requireThat(expenses.length === report.expenses && expenses.length <= 100 && expenses.length > 0, 'Carry requires a complete report of 1–100 expenses', 409);
  requireThat(expenses.every(e => e.value.employee === actor.email && e.value.currency === business.currency), 'Source report expenses are inconsistent', 409);
  requireThat(expenses.reduce((n,e)=>n+e.value.amountMinor,0) === report.totalMinor, 'Source report total does not reconcile', 409);
  const payable = expenses.filter(e => e.value.reimbursable);
  requireThat(payable.length > 0, 'This source report has no reimbursable expenses', 409);
  requireThat(b.categories && typeof b.categories === 'object' && !Array.isArray(b.categories), 'Map every reimbursable source expense to a category');
  const id = uid(), statements = [insertClaim(db, id, actor.email, text(report.name, 'Report name', 200), business.currency, null), db.prepare('INSERT INTO c_cutover_reports VALUES(?,?)').bind(reportKey, id)];
  for (const [position, {value}] of payable.entries()) {
    requireThat(!value.distance, 'Mileage carry requires explicit native trip entry; nothing was carried', 409);
    const item = itemInput({ kind:'receipt', date:value.date, merchant:value.merchant, amount:(value.amountMinor / 100).toFixed(2), category:b.categories[value.transactionId], costCentre:value.tag, description:value.comment, explanation:'' }, business, known);
    const itemId = uid(), key = sourceKey('expense', value.transactionId);
    requireThat(!await db.prepare('SELECT 1 FROM c_cutover_items WHERE source_key=?').bind(key).first(), 'A source expense has already been carried', 409);
    statements.push(...insertItem(db, id, itemId, position, item, null), db.prepare('INSERT INTO c_cutover_items VALUES(?,?,?)').bind(key, id, itemId));
  }
  statements.push(claimTotal(db, id), event(db, actor, 'open-report-carried', { claim:id }, { source:'expensify', reportKey, expenses:payable.length }));
  const unchanged = rows.map(row => ({ sql:"EXISTS(SELECT 1 FROM c_history WHERE destination='main' AND id=? AND value=?)", params:[row.id,row.value] }));
  await commit(db, all(authority(actor, 'employee'), ...unchanged,
    {sql:"(SELECT COUNT(*) FROM c_history WHERE destination='main' AND kind='expense' AND json_extract(value,'$.source')='expensify' AND json_extract(value,'$.report')=?)=?",params:[b.report,expenses.length]},
    {sql:'NOT EXISTS(SELECT 1 FROM c_cutover_reports WHERE source_key=?)',params:[reportKey]}), statements);
  return loadClaim(db, id);
}
