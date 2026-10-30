import { isCardExpense, reimbursableMinor } from './card-expenses';
import { claimNumber } from './claims';
import { claimDetail, batchDetail } from './views';
import { requireThat, optionalText, type Actor, type Data } from './types';
import { money } from './exceptions';
import { PdfLayout } from './pdf-layout';
import { appendReceipt } from './pdf-receipts';
import { claimReceiptBytes } from './receipts/claim-storage';

/** The claim's normal visibility gate applies before querying receipt bytes. */
export async function claimPdf(db: D1Database, actor: Actor, id: string, customer?: string, project?: string, bucket?: R2Bucket) {
  const detail = await claimDetail(db, actor, id);
  const filter = billingFilter(customer, project);
  const layout = await PdfLayout.create();
  await appendClaim(db, layout, detail, filter, bucket);
  return download(await layout.finish(), `${claimNumber(detail.claim.number)}${filter.project ? '-project' : filter.customer ? '-customer' : ''}.pdf`);
}

/** A batch is one PDF, in claim-number order, with the same per-claim receipt ordering. */
export async function batchPdf(db: D1Database, actor: Actor, id: string, customer?: string, project?: string, bucket?: R2Bucket) {
  const detail = await batchDetail(db, actor, id);
  const filter = billingFilter(customer, project), layout = await PdfLayout.create();
  layout.newPage(`Reimbursement batch RB-${String(detail.batch.number).padStart(4, '0')}`);
  layout.text(`Status: ${detail.batch.status}`);
  layout.text(`Payment reference: ${detail.batch.paid_reference || 'Not paid'}${detail.batch.paid_on ? ` | ${detail.batch.paid_on}` : ''}`);
  if (filter.customer) layout.text(`Billable customer: ${filter.customer}`);
  if (filter.project) layout.text(`Project: ${filter.project}`);
  let total = 0, count = 0;
  for (const entry of detail.claims as Data[]) {
    const claim = await claimDetail(db, actor, entry.claim_id);
    const items = selectedItems(exportItems(claim), filter);
    if (filter.active && !items.length) continue;
    total += reimbursableMinor(items);
    count++;
    layout.text(`${claimNumber(claim.claim.number)} | ${claim.claim.title} | ${money(reimbursableMinor(items), claim.claim.currency)}`);
  }
  requireThat(count, 'No matching claims in this batch', 404);
  requireThat(filter.active || total === detail.batch.total_minor, 'The batch total no longer matches its claims; reload before downloading', 409);
  layout.text(`Total: ${money(total, detail.batch.currency)}`);
  for (const entry of detail.claims as Data[]) {
    const claim = await claimDetail(db, actor, entry.claim_id);
    if (!filter.active || selectedItems(exportItems(claim), filter).length) await appendClaim(db, layout, claim, filter, bucket);
  }
  return download(await layout.finish(), `RB-${String(detail.batch.number).padStart(4, '0')}${filter.project ? '-project' : filter.customer ? '-customer' : ''}.pdf`);
}

function billingFilter(customer?: string, project?: string) {
  const c = optionalText(customer, 'Customer', 200), p = optionalText(project, 'Project', 200);
  return { customer: c, project: p, active: !!(c || p) };
}
type BillingFilter = ReturnType<typeof billingFilter>;
const selectedItems = (items: Data[], filter: BillingFilter) => filter.active
  ? items.filter(i => i.billable && (!filter.customer || i.customer === filter.customer) && (!filter.project || i.project === filter.project))
  : items;

/** Submitted coding is evidence: later category renames and account changes cannot rewrite it. */
function exportItems(detail: Awaited<ReturnType<typeof claimDetail>>): Data[] {
  const snapshot = detail.revisions.at(-1)?.snapshot;
  if (['draft', 'returned'].includes(detail.claim.status) || !snapshot) return detail.items;
  return snapshot.items.map((item: Data) => ({ ...item, receipt_id: item.receipt?.id ?? item.receipt_id, receipt_sha256: item.receipt?.sha256, attendees: item.attendees ?? [], fields: item.fields ?? {} }));
}

async function appendClaim(db: D1Database, layout: PdfLayout, detail: Awaited<ReturnType<typeof claimDetail>>, filter: BillingFilter, bucket?: R2Bucket) {
  const { claim } = detail, items = selectedItems(exportItems(detail), filter);
  requireThat(!filter.active || items.length, 'No billable expenses match this customer and project on this claim', 404);
  const ids = new Set(items.map(i => i.id)), total = reimbursableMinor(items);
  requireThat(filter.active || total === claim.total_minor, 'The claim total no longer matches its expenses; reload before downloading', 409);
  const [members, payment] = await Promise.all([
    db.prepare('SELECT email,name FROM c_members').all<{ email: string; name: string }>(),
    claim.batch_id ? db.prepare('SELECT paid_reference,paid_on,paid_by,reviewed_by,reviewed_at FROM c_batches WHERE id=?').bind(claim.batch_id).first<Data>() : Promise.resolve(null),
  ]);
  const names = new Map(members.results.map(m => [m.email, `${m.name} <${m.email}>`])), who = (email: string) => names.get(email) ?? email;
  layout.newPage(`${claimNumber(claim.number)} - ${claim.title}`);
  layout.text(`Employee: ${who(claim.employee_email)}`);
  layout.text(`Status: ${claim.status} | Revision: ${claim.revision}`);
  const days = items.map(i => i.spent_on).sort();
  layout.text(`Period: ${days[0] ?? 'No expenses'}${days.length ? ` to ${days.at(-1)}` : ''}`);
  if (filter.customer) layout.text(`Billable customer: ${filter.customer}`);
  if (filter.project) layout.text(`Project: ${filter.project}`);
  layout.text(`${filter.customer ? 'Customer total' : filter.project ? 'Project total' : 'Claim total'}: ${money(total, claim.currency)} (${items.length} expenses)`, 14);
  layout.heading('Totals by category');
  const categories = new Map<string, number>();
  for (const item of items) {
    for (const part of item.allocations) categories.set(part.category_name, (categories.get(part.category_name) ?? 0) + part.amount_minor);
    if (item.sales_tax_minor) categories.set('Sales tax', (categories.get('Sales tax') ?? 0) + item.sales_tax_minor);
  }
  for (const [category, amount] of categories) layout.text(`${category}: ${money(amount, claim.currency)}`);
  layout.heading('Approval chain');
  for (const revision of detail.revisions as Data[]) {
    layout.text(`Revision ${revision.revision} submitted by ${who(revision.submitted_by)} at ${revision.submitted_at}`);
    if (revision.snapshot.approvalChain) layout.text(`Route: ${revision.snapshot.approvalChain.steps.map((step: Data) => who(step.email)).join(' then ')}`);
  }
  if (claim.status === 'submitted') layout.text(`Awaiting approval${claim.approver_email ? ` by ${who(claim.approver_email)}` : ''}`);
  else if (!detail.decisions.length) layout.text('No approval recorded');
  for (const decision of detail.decisions as Data[]) {
    layout.text(`Revision ${decision.revision}: ${decision.decision} by ${who(decision.actor_email)}${decision.on_behalf_of ? ` on behalf of ${who(decision.on_behalf_of)}` : ''} at ${decision.at}`);
    if (decision.reason) layout.text(`Reason: ${decision.reason}`);
  }
  layout.heading('Payment');
  layout.text(payment?.paid_reference ? `Reference: ${payment.paid_reference} | Paid on ${payment.paid_on} by ${who(payment.paid_by)}` : 'Not paid');
  if (payment?.reviewed_at) layout.text(`Batch reviewed by ${who(payment.reviewed_by)} at ${payment.reviewed_at}`);
  layout.newPage(`${claimNumber(claim.number)} - expenses`);
  for (const [index, item] of items.entries()) {
    layout.heading(`Expense ${index + 1}: ${item.merchant} | ${money(item.amount_minor, claim.currency)}`);
    layout.text(`${item.spent_on} | ${item.kind} | ${item.id}`);
    const expenseApproval=detail.revisions.at(-1)?.snapshot.expenseApprovals?.find((a:Data)=>a.item===item.id);
    if(expenseApproval)layout.text(`Approved at submission by ${expenseApproval.actor}${expenseApproval.onBehalfOf?` on behalf of ${expenseApproval.onBehalfOf}`:''}: ${expenseApproval.reason}`);
    if (isCardExpense(item) && item.card_liability === 'individual') layout.text(`Individual liability ····${item.card_last4 ?? ''} | ${item.card_personal ? 'personal, excluded from reimbursement' : 'business, reimbursable to employee'}`);
    else if (isCardExpense(item)) layout.text(`Company card ${item.card_issuer ?? ''} ····${item.card_last4 ?? ''} | paid by the company, not reimbursed`);
    if (item.original_minor != null && item.original_currency !== claim.currency) {
      layout.text(`Original amount: ${money(item.original_minor, item.original_currency)}`);
      layout.text(`Exchange rate: 1 ${item.original_currency} = ${item.fx_rate} ${claim.currency} | Rate date: ${item.fx_date} | Source: ${item.fx_source}`);
      if (item.fx_source === 'ECB reference rates') layout.text('ECB reference rate, not your card’s rate.');
    }
    if (item.card_match_basis) {
      const basis = JSON.parse(item.card_match_basis);
      layout.text(`Matched receipt: ${money(basis.enteredTotalMinor, basis.enteredCurrency)} on ${basis.enteredDate} | Match rule v${basis.ruleVersion} | ${basis.basis}`);
      if (basis.fxRate) {
        layout.text(`Reference conversion: ${money(item.amount_minor - basis.differenceMinor, basis.differenceCurrency)} | Posted card amount: ${money(item.amount_minor, claim.currency)}`);
        layout.text(`Exchange rate: 1 ${basis.enteredCurrency} = ${basis.fxRate} ${basis.differenceCurrency} | Rate date: ${basis.fxDate} | Source: ${basis.fxSource}`);
        if (basis.fxSource === 'ECB reference rates') layout.text('ECB reference rate, not your card’s rate.');
      }
    }
    if (item.description) layout.text(`Purpose: ${item.description}`);
    if (item.kind === 'mileage') layout.text(`${item.distance_hundredths / 100} miles at ${item.rate_thousandths / 1000} ${claim.currency} per mile`);
    if (item.per_diem) {
      layout.text(`${item.per_diem.method} | ${item.per_diem.location} | ${item.per_diem.startDate} to ${item.per_diem.endDate}`);
      for (const d of item.per_diem.days) {
        layout.text(`${d.date} | FY${d.fiscalYear} | M&IE ${money(d.mieRateMinor, 'USD')} x ${d.travelPercent}% less ${money(d.deductionMinor, 'USD')} (${d.providedMeals.join(', ') || 'no provided meals'}) = ${money(d.mieMinor, 'USD')} | Lodging ${money(d.lodgingMinor, 'USD')}`);
        layout.text(`Source: ${d.source} | Effective ${d.effectiveFrom} to ${d.effectiveTo}`);
      }
    } else if (item.kind === 'per_diem') layout.text(`${item.days} days at ${item.rate_thousandths / 1000} ${claim.currency} per day (company rate)`);
    if (item.customer) layout.text(`Customer: ${item.customer} | ${item.billable ? 'Billable' : 'Not billable'}`);
    if (item.project) layout.text(`Project: ${item.project}`);
    for (const part of item.allocations) layout.text(`Coding: ${part.category_name} | Account ${part.account_code} | Tax ${part.tax_code}${part.cost_centre ? ` | Cost center ${part.cost_centre}` : ''}${part.description ? ` | ${part.description}` : ''} | ${money(part.amount_minor, claim.currency)}${part.original_minor != null && item.original_currency !== claim.currency ? ` | Original ${money(part.original_minor, item.original_currency)}` : ''}`);
    if (item.sales_tax_minor) layout.text(`Sales tax: ${money(item.sales_tax_minor, claim.currency)} | Account ${item.sales_tax_account} | Tax ${item.sales_tax_code}${item.original_sales_tax_minor != null && item.original_currency !== claim.currency ? ` | Original ${money(item.original_sales_tax_minor, item.original_currency)}` : ''}`);
    for (const exception of detail.exceptions.filter((x: Data) => x.item === item.id)) layout.text(`Exception: ${exception.message}`);
    if (item.explanation) layout.text(`Explanation: ${item.explanation}`);
    if (item.attendees.length) layout.text(`Attendees: ${item.attendees.map((a: Data) => `${a.name}${a.email ? ` <${a.email}>` : ''} (${a.kind})`).join(', ')}`);
    for (const [key, value] of Object.entries(item.fields)) layout.text(`${key}: ${value}`);
    layout.text(item.receipt_id ? `Receipt SHA-256: ${item.receipt_sha256}` : 'No receipt');
  }
  const comments = (detail.comments as Data[]).filter(c => !c.item_id || ids.has(c.item_id));
  if (comments.length) {
    layout.heading('Comments');
    for (const comment of comments) {
      layout.text(`${who(comment.author_email)}${comment.on_behalf_of ? ` on behalf of ${who(comment.on_behalf_of)}` : ''} at ${comment.created_at}${comment.item_id ? ` | Expense ${items.findIndex(i => i.id === comment.item_id) + 1}` : ''}${comment.parent_id ? ' | Reply' : ''}`);
      if (comment.edited_at) layout.text(`Edited at ${comment.edited_at}`);
      if (comment.asks_email) layout.text(`Question for ${who(comment.asks_email)}${comment.open ? ' (open)' : ' (answered)'}`);
      layout.text(comment.body);
    }
  }
  for (const [index, item] of items.entries()) if (item.receipt_id) {
    const receipt = await db.prepare('SELECT * FROM c_receipts WHERE id=? AND claim_id=?').bind(item.receipt_id, claim.id).first<Data>();
    requireThat(receipt, 'A receipt is missing from this claim', 409);
    const bytes = await claimReceiptBytes(db, receipt, bucket);
    await appendReceipt(layout, item, { ...receipt, bytes }, `${claimNumber(claim.number)} expense ${index + 1}`);
  }
}

function download(bytes: Uint8Array, name: string) {
  return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
}
