import { entity, entityBusiness, entityMember, requireEntityMember } from './entities';
import { all, authority, commit, need, sha256Hex, type Sql } from './session';
import { can } from './permissions';
import { event, ruleEvent } from './events';
import { categories, pricedItem, type Allocation, type ItemInput } from './items';
import { prepareItemInput, requestFields } from './coding/automatic/intake';
import { feedbackForEdit, humanObservation, suggestionSelect, suggestionViews } from './coding/automatic/storage';
import { itemFields, flatten } from './coding/automatic/model';
import { checkedCoding } from './coding/validation';
import { findExceptions, missingFields, repeatedInClaim, type ClaimItem } from './exceptions';
import { requireBusiness } from './settings';
import { localDay, routeFor } from './delegation';
import { linkableRequest } from './requests';
import { approvesByRule, currentRule, ruleApproval, ruleStill } from './auto-approval';
import { capToAllowance } from './allowances';
import { receiptSignals } from './receipt-signals';
import { evidencedPolicyReview } from './policy-review-evidence';
import { auditSample } from './audit-queue';
import { currentEnvelope } from './approval-envelopes';
import { expenseApprovals } from './expense-approvals';
import { policyConfiguration, policyStill } from './policy-configuration';
import { workflowPlan, resolveStage, insertTasks, workflowAccess } from './workflow-routing';
import { configuredChain, freezeChain } from './approval-chain';
import { noCardDuplicates } from './card-duplicates';
import { keepsStatementFacts, reimbursableMinor, REIMBURSABLE_SUM } from './card-expenses';
import { Fault, now, optionalText, requireThat, text, uid, type Actor, type Data } from './types';

export type Claim = { entity_id: string; id: string; number: number; employee_email: string; approver_email: string | null; title: string; status: string; revision: number; version: number; total_minor: number; currency: string; prepared_by: string | null; batch_id: string | null; created_at: string; updated_at: string; on_behalf_of: string | null; held_from: string | null; held_by: string | null; held_at: string | null; hold_reason: string | null; assigned_emails?: string[]; workflow_readers?: string[] };

export const claimNumber = (n: number) => `CL-${String(n).padStart(4, '0')}`;
export const RECEIPT_LIMIT = 1_500_000;

export async function loadClaim(db: D1Database, id: unknown): Promise<Claim> {
  requireThat(typeof id === 'string' && id.length <= 64, 'Claim not found', 404);
  const claim = await db.prepare('SELECT * FROM c_claims WHERE id=?').bind(id).first<Claim>();
  requireThat(claim, 'Claim not found', 404);
  return { ...claim, ...await workflowAccess(db, 'claim', claim.id, claim.revision) };
}

/** Who may see a claim: its employee always; once submitted, its approver (and the approver a delegate acts for), finance, auditors and the owner. */
export function canSee(actor: Actor, claim: Claim) {
  if (claim.employee_email === actor.email) return true;
  if (claim.status === 'draft') return false;
  return (claim.workflow_readers?.includes(actor.email) ?? false) || (actor.roles.manager && (claim.approver_email === actor.email || claim.on_behalf_of === actor.email)) || can(actor, 'readAll');
}
export function visible(actor: Actor, claim: Claim) {
  requireThat(canSee(actor, claim), 'This claim is outside your access', 403);
}

/** SQL conditions binding a write to the exact claim state it was decided on. */
export const claimState = (id: string, version: number, statuses: string[]): Sql => ({ sql: `EXISTS(SELECT 1 FROM c_claims WHERE id=? AND version=? AND status IN (${statuses.map(() => '?').join(',')}))`, params: [id, version, ...statuses] });

async function editable(db:D1Database,actor: Actor, claim: Claim, b: Data) {
  requireThat(actor.kind === 'person', 'Agents prepare proposals; the employee edits the claim', 403);
  requireThat(claim.employee_email === actor.email, 'Only the employee who owns a claim can change it', 403);
  requireThat(['draft', 'returned'].includes(claim.status), 'This claim can no longer be changed', 409);
  requireThat(b.version === claim.version, 'This claim changed; reload before trying again', 409);
  return requireEntityMember(db,claim.entity_id,actor.email);
}
/** Recount a claim's reimbursable total from its expenses (company-card expenses are not reimbursed) and move its version on. */
export const claimTotal = (db: D1Database, id: string) => db.prepare(`UPDATE c_claims SET total_minor=(SELECT ${REIMBURSABLE_SUM} FROM c_items WHERE claim_id=?),version=version+1,updated_at=? WHERE id=?`).bind(id, now(), id);

export function insertClaim(db: D1Database, id: string, employee: string, title: string, currency: string, preparedBy: string | null, entityId = 'primary') {
  const at = now();
  return db.prepare('INSERT INTO c_claims(id,number,employee_email,title,status,currency,prepared_by,created_at,updated_at,entity_id) VALUES(?,(SELECT COALESCE(MAX(number),0)+1 FROM c_claims),?,?,\'draft\',?,?,?,?,?)').bind(id, employee, title, currency, preparedBy, at, at, entityId);
}

export function insertItem(db: D1Database, claimId: string, itemId: string, position: number, item: ItemInput, receiptId: string | null) {
  return [
    db.prepare('INSERT INTO c_items(id,claim_id,position,kind,spent_on,merchant,description,amount_minor,distance_hundredths,days,rate_thousandths,receipt_id,explanation,sales_tax_minor,sales_tax_account,sales_tax_code,attendees,fields,request_id,allowance_id,claimed_minor,billable,customer,project,original_minor,original_currency,fx_rate,fx_date,fx_source,original_sales_tax_minor,per_diem,card_charge_id,coding,receipt_resolution) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(itemId, claimId, position, item.kind, item.spent_on, item.merchant, item.description, item.amount_minor, item.distance_hundredths, item.days, item.rate_thousandths, receiptId, item.explanation, item.sales_tax_minor, item.sales_tax_account, item.sales_tax_code, JSON.stringify(item.attendees ?? []), JSON.stringify(item.fields ?? {}), item.request_id ?? null, item.allowance_id ?? null, item.claimed_minor ?? null, item.billable ? 1 : 0, item.customer ?? '', item.project ?? '', item.original_minor ?? null, item.original_currency ?? '', item.fx_rate ?? '', item.fx_date ?? '', item.fx_source ?? '', item.original_sales_tax_minor ?? null, item.per_diem ? JSON.stringify(item.per_diem) : '', item.card_charge_id ?? null, JSON.stringify(item.coding ?? {}),item.receipt_resolution??null),
    ...item.allocations.map((a: Allocation, i) => db.prepare('INSERT INTO c_allocations(item_id,position,category_id,cost_centre,amount_minor,description,original_minor) VALUES(?,?,?,?,?,?,?)').bind(itemId, i, a.category_id, a.cost_centre, a.amount_minor, a.description ?? '', a.original_minor ?? null)),
  ];
}

export async function createClaim(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'employee');
  requireThat(actor.kind === 'person', 'Agents prepare proposals instead of claims', 403);
  const entityId=b.entityId===undefined?'primary':text(b.entityId,'Legal entity',64), business = await entityBusiness(db,entityId), id = uid(), title = text(b.title, 'Claim title', 200);
  const membership=await requireEntityMember(db,entityId,actor.email);
  requireThat(b.currency===undefined||b.currency===business.currency,'Claim currency must match its legal entity',409);
  await commit(db, all(authority(actor, 'employee'),membership), [insertClaim(db, id, actor.email, title, business.currency, null,entityId), event(db, actor, 'claim-created', { claim: id }, { title })]);
  return loadClaim(db, id);
}

export async function renameClaim(db: D1Database, actor: Actor, id: string, b: Data) {
  const claim = await loadClaim(db, id);
  const membership=await editable(db,actor, claim, b);
  const title = text(b.title, 'Claim title', 200);
  await commit(db, all(authority(actor, 'employee'),membership, claimState(id, claim.version, ['draft', 'returned'])), [db.prepare('UPDATE c_claims SET title=?,version=version+1,updated_at=? WHERE id=?').bind(title, now(), id), event(db, actor, 'claim-renamed', { claim: id }, { title })]);
  return loadClaim(db, id);
}

async function ownReceipt(db: D1Database, claim: Claim, receiptId: unknown, itemId: unknown) {
  if (receiptId === undefined || receiptId === null || receiptId === '') return null;
  requireThat(typeof receiptId === 'string', 'Receipt not found', 404);
  const receipt = await db.prepare('SELECT id,capture_receipt_id FROM c_receipts WHERE id=? AND claim_id=?').bind(receiptId, claim.id).first<{ id: string; capture_receipt_id: string | null }>();
  requireThat(receipt, 'Receipt not found on this claim', 404);
  if (receipt.capture_receipt_id) requireThat(typeof itemId === 'string' && await db.prepare('SELECT 1 FROM c_items WHERE id=? AND claim_id=? AND receipt_id=?').bind(itemId,claim.id,receipt.id).first(), 'Attach inbox originals through the receipt inbox', 409);
  return receipt.id;
}

/** Add or replace one expense. A replaced item's receipt stays on the claim and in earlier revisions. */
export async function saveItem(db: D1Database, actor: Actor, id: string, b: Data) {
  const claim = await loadClaim(db, id);
  const membership=await editable(db,actor, claim, b);
  const business = await entityBusiness(db,claim.entity_id), receiptId = await ownReceipt(db, claim, b.receipt, b.item);
  const proposedId=typeof b.item==='string'&&b.item?b.item:uid();
  requireThat(claim.entity_id==='primary'||(b.kind==='receipt'&&!b.request&&!b.allowance&&!Object.keys(b.coding??{}).length),'This entity currently supports manual receipt expenses with its native chart',409);
  const automatic=claim.entity_id==='primary'&&b.kind==='receipt'?await prepareItemInput(db,claim.employee_email,claim.id,proposedId,b):null;
  let item: ItemInput = { ...await pricedItem(automatic?.input??b, business, await categories(db,claim.entity_id)), request_id: await linkableRequest(db, claim.employee_email, b.request) };
  const coding = await checkedCoding(db,[item],claim.entity_id);
  item = coding.items[0];
  // A purchase claimed against a cap is reimbursed up to what is left of it (CLAIM-009).
  const allowance = b.allowance ? await capToAllowance(db, claim.employee_email, item, b.allowance, typeof b.item === 'string' ? b.item : null) : null;
  if (allowance) item = allowance.item;
  for (const a of item.attendees ?? []) if (a.email) requireThat(await db.prepare('SELECT 1 FROM c_members WHERE email=?').bind(a.email).first(), `${a.name} is not a Coaster member; add them as a guest`);
  const statements: D1PreparedStatement[] = [];
  let itemId: string = proposedId, position: number;
  if (b.item) {
    const existing = await db.prepare('SELECT i.id,i.position,i.receipt_id,i.card_charge_id,i.receipt_resolution,a.capture_receipt_id FROM c_items i LEFT JOIN c_receipts a ON a.id=i.receipt_id WHERE i.id=? AND i.claim_id=?').bind(b.item, claim.id).first<{ id: string; position: number; receipt_id: string | null; card_charge_id: string | null; receipt_resolution: string | null; capture_receipt_id: string | null }>();
    requireThat(existing, 'Expense not found on this claim', 404);
    if (existing.card_charge_id) {
      // Statement facts never change by any route (FEED-004); coding, memo, attendees and receipt stay editable.
      const charge = await db.prepare('SELECT descriptor,amount_minor,posted_on,transaction_on FROM c_card_charges WHERE id=?').bind(existing.card_charge_id).first<{ descriptor: string; amount_minor: number; posted_on: string; transaction_on: string | null }>();
      requireThat(charge, 'Card charge not found', 404);
      keepsStatementFacts(item, charge);
      item = { ...item, card_charge_id: existing.card_charge_id };
    }
    requireThat(!existing.capture_receipt_id || (receiptId === existing.receipt_id && item.kind === 'receipt'), 'Detach the inbox receipt before replacing it or changing its type', 409);
    itemId = existing.id; position = existing.position;
    if(receiptId===existing.receipt_id)item={...item,receipt_resolution:existing.receipt_resolution};
    statements.push(db.prepare('DELETE FROM c_items WHERE id=?').bind(itemId));
  } else {
    const count = await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position),-1) AS last FROM c_items WHERE claim_id=?').bind(claim.id).first<{ n: number; last: number }>();
    requireThat((count?.n ?? 0) < 100, 'A claim holds at most 100 expenses');
    position = (count?.last ?? -1) + 1;
  }
  if(automatic) {
    const fields=itemFields(item);
    statements.push(...automatic.writes);
    if(b.item)statements.push(...await feedbackForEdit(db,automatic.target,item,actor.delegate?.email??actor.email));
    const human=requestFields(b);
    if(Object.keys(flatten(human)).length)statements.push(...humanObservation(db,automatic.target,human,item.spent_on));
  }
  statements.push(...insertItem(db, claim.id, itemId, position, item, receiptId), claimTotal(db, claim.id), event(db, actor, b.item ? 'expense-changed' : 'expense-added', { claim: claim.id }, { item: itemId, merchant: item.merchant, amountMinor: item.amount_minor, receipt: receiptId, request: item.request_id, allowance: item.allowance_id ?? null, claimedMinor: item.claimed_minor ?? null }));
  await commit(db, all(authority(actor, 'employee'), membership, coding.guard, ...(automatic?[automatic.guard]:[]), ...(allowance ? [allowance.guard] : []), claimState(claim.id, claim.version, ['draft', 'returned'])), statements);
  return loadClaim(db, id);
}

export async function removeItem(db: D1Database, actor: Actor, id: string, b: Data) {
  const claim = await loadClaim(db, id);
  const membership=await editable(db,actor, claim, b);
  const existing = await db.prepare('SELECT id,merchant,amount_minor,card_charge_id FROM c_items WHERE id=? AND claim_id=?').bind(b.item, claim.id).first<{ id: string; merchant: string; amount_minor: number; card_charge_id: string | null }>();
  requireThat(existing, 'Expense not found on this claim', 404);
  requireThat(!existing.card_charge_id, 'A company-card expense comes from its statement and cannot be removed; undo the statement import instead', 409);
  requireThat(!await db.prepare('SELECT 1 FROM c_items i JOIN c_receipts a ON a.id=i.receipt_id WHERE i.id=? AND a.capture_receipt_id IS NOT NULL').bind(existing.id).first(), 'Detach the inbox receipt before removing this expense', 409);
  await commit(db, all(authority(actor, 'employee'),membership, claimState(claim.id, claim.version, ['draft', 'returned'])), [db.prepare("DELETE FROM c_auto_coding_contexts WHERE target_kind='item' AND target_id=?").bind(existing.id),db.prepare('DELETE FROM c_items WHERE id=?').bind(existing.id), claimTotal(db, claim.id), event(db, actor, 'expense-removed', { claim: claim.id }, { item: existing.id, merchant: existing.merchant, amountMinor: existing.amount_minor })]);
  return loadClaim(db, id);
}

const signatures: [string, number[]][] = [['image/jpeg', [0xff, 0xd8, 0xff]], ['image/png', [0x89, 0x50, 0x4e, 0x47]], ['application/pdf', [0x25, 0x50, 0x44, 0x46]]];
/** Receipt bytes from base64, typed by their own signature (JPEG, PNG, WebP, HEIC or PDF). */
export function receiptBytes(b: Data) {
  requireThat(typeof b.base64 === 'string' && b.base64.length > 0, 'Choose a receipt file');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(b.base64), c => c.charCodeAt(0)); } catch { throw new Fault(400, 'The receipt file could not be read'); }
  requireThat(bytes.length > 0 && bytes.length <= RECEIPT_LIMIT, `Receipts can be at most ${RECEIPT_LIMIT / 1_000_000} MB`);
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  let media = signatures.find(([, sig]) => sig.every((x, i) => bytes[i] === x))?.[0];
  if (!media && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') media = 'image/webp';
  if (!media && ascii(4, 8) === 'ftyp' && ['heic', 'heix', 'mif1'].includes(ascii(8, 12))) media = 'image/heic';
  requireThat(media, 'Receipts must be a photo (JPEG, PNG, WebP, HEIC) or a PDF');
  const name = text(b.name, 'File name', 200).replace(/[\u0000-\u001f]/g, '');
  return { bytes, media, name };
}

export async function uploadReceipt(db: D1Database, actor: Actor, id: string, b: Data) {
  const claim = await loadClaim(db, id);
  const membership=await editable(db,actor, claim, b);
  const { bytes, media, name } = receiptBytes(b), receiptId = uid(), sha = await sha256Hex(bytes);
  const source = b.source === 'camera' ? 'camera' : 'upload';
  const statements = [db.prepare('INSERT INTO c_receipts(id,claim_id,owner_email,name,media_type,size,sha256,bytes,source,uploaded_by,uploaded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(receiptId, claim.id, claim.employee_email, name, media, bytes.length, sha, bytes, source, actor.delegate?.email ?? actor.email, now())];
  if (b.item) {
    requireThat(!await db.prepare('SELECT 1 FROM c_items i JOIN c_receipts a ON a.id=i.receipt_id WHERE i.id=? AND i.claim_id=? AND a.capture_receipt_id IS NOT NULL').bind(b.item,claim.id).first(), 'Detach the inbox receipt before replacing it', 409);
    const item = await db.prepare('SELECT id FROM c_items WHERE id=? AND claim_id=?').bind(b.item, claim.id).first();
    requireThat(item, 'Expense not found on this claim', 404);
    statements.push(db.prepare('UPDATE c_items SET receipt_id=? WHERE id=?').bind(receiptId, b.item));
  }
  statements.push(claimTotal(db, claim.id), event(db, actor, 'receipt-added', { claim: claim.id }, { receipt: receiptId, name, sha256: sha, size: bytes.length, item: b.item ?? null, source }));
  await commit(db, all(authority(actor, 'employee'),membership, claimState(claim.id, claim.version, ['draft', 'returned'])), statements);
  return { claim: await loadClaim(db, id), receipt: receiptId };
}

/** Current items with their allocations and receipt fingerprints. */
export async function claimItems(db: D1Database, claimId: string): Promise<ClaimItem[]> {
  const [items, parts, advice] = await db.batch([
    db.prepare('SELECT i.*, r.sha256 AS receipt_sha256, r.name AS receipt_name, r.media_type AS receipt_media, r.size AS receipt_size, r.card_match_basis, ch.transaction_key AS card_transaction_key, cd.issuer AS card_issuer, cd.last4 AS card_last4 FROM c_items i LEFT JOIN c_receipts r ON r.id=i.receipt_id LEFT JOIN c_card_charges ch ON ch.id=i.card_charge_id LEFT JOIN c_cards cd ON cd.id=ch.card_id WHERE i.claim_id=? ORDER BY i.position').bind(claimId),
    db.prepare('SELECT a.*, c.name AS category_name, c.account_code, c.tax_code,c.ledger_account_id,c.ledger_account_snapshot FROM c_allocations a JOIN c_items i ON i.id=a.item_id JOIN c_categories c ON c.id=a.category_id WHERE i.claim_id=? ORDER BY a.item_id, a.position').bind(claimId),
    db.prepare(suggestionSelect+" WHERE s.target_kind='item' AND s.target_id IN (SELECT id FROM c_items WHERE claim_id=?) ORDER BY s.created_at,s.rowid").bind(claimId),
  ]);
  const suggestions=suggestionViews(advice.results as Data[]);
  return (items.results as ClaimItem[]).map(item => ({ ...item, codingSuggestions: suggestions.filter(s=>s.target_id===item.id), coding: JSON.parse(String(item.coding ?? '{}')), per_diem: item.per_diem ? JSON.parse(item.per_diem) : null, attendees: JSON.parse(String(item.attendees)), fields: JSON.parse(String(item.fields)), allocations: (parts.results as Data[]).filter(p => p.item_id === item.id).map(p => ({ ...p,ledger_account: p.ledger_account_id ? JSON.parse(p.ledger_account_snapshot) : null })) }) as ClaimItem);
}

/** Submission freezes the exact claim as a new revision and routes it to the employee's manager, or approves it at
 * once when the owner's approval rule covers every expense (APPROVE-004). */
export async function submitClaim(db: D1Database, actor: Actor, id: string, b: Data, bucket?: R2Bucket) {
  const claim = await loadClaim(db, id);
  const membership=await editable(db,actor, claim, b);
  return submission(db, claim, actor.delegate?.email ?? actor.email, all(authority(actor, 'employee'),membership), (action, detail) => event(db, actor, action, { claim: claim.id }, detail), optionalText(b.note, 'Note', 1000), bucket);
}

/** The hourly run submits a stipend's claim in the employee's name, recorded under the schedule's name (CLAIM-009). */
export async function submitScheduled(db: D1Database, id: string, by: string, bucket?: R2Bucket) {
  const claim = await loadClaim(db, id);
  requireThat(claim.status === 'draft', 'This claim can no longer be changed', 409);
  return submission(db, claim, by, { sql: '1', params: [] }, (action, detail) => ruleEvent(db, by, action, { claim: claim.id }, detail), '', bucket);
}

/** Everything a submission checks and writes once the submitter's authority is known. */
async function submission(db: D1Database, claim: Claim, by: string, auth: Sql, history: (action: string, detail: Data) => D1PreparedStatement, note: string, bucket?: R2Bucket) {
  const membership=await requireEntityMember(db,claim.entity_id,claim.employee_email), business=await entityBusiness(db,claim.entity_id);
  const coding = await checkedCoding(db,await claimItems(db, claim.id),claim.entity_id);
  const items = coding.items;
  requireThat(items.length > 0, 'Add at least one expense before submitting');
  const cardGuards = await noCardDuplicates(db, claim.employee_email, items);
  const configured = await configuredChain(db, claim.employee_email,claim.entity_id);
  const member = await db.prepare('SELECT approver_email FROM c_members WHERE email=? AND active=1').bind(claim.employee_email).first<{ approver_email: string | null }>();
  const first = configured.chain?.steps[0].email ?? member?.approver_email;
  requireThat(member && first && first !== claim.employee_email, 'Ask the owner to set your approving manager before submitting', 409);
  const active = await policyConfiguration(db, business, await categories(db,claim.entity_id));
  const known = active.categories, missing = missingFields(items, known);
  requireThat(!missing.length, `Fill in the required ${missing.length === 1 ? 'field' : 'fields'} before submitting: ${missing.join('; ')} (policy v${active.version})`, 409);
  const { approver, onBehalfOf } = await routeFor(db, first, claim.employee_email, localDay(business.timezone));
  const repeated = repeatedInClaim(claim.employee_email, items);
  requireThat(!repeated.length, `${repeated.map(i => i.merchant).join(', ')} appears twice on this claim with the same ${repeated.some(i => i.receipt_sha256) ? 'receipt' : 'date, merchant and amount and no receipt'}; only one could be reimbursed. Attach each one's own receipt, or correct or remove one, before submitting`, 409);
  const exceptions = await findExceptions(db, claim, items, business, known, active), hard = exceptions.filter(e => e.hard);
  requireThat(!hard.length, `This claim breaks a hard policy rule and cannot be submitted: ${hard.map(e => e.message).join('; ')}`, 409);
  const unexplained = exceptions.filter(e => !items.find(i => i.id === e.item)?.explanation);
  requireThat(!unexplained.length, `Explain each policy exception before submitting: ${unexplained.map(e => e.message).join('; ')}`, 409);
  const workflow = await workflowPlan(db, claim.employee_email, claim.total_minor, items, exceptions,false,claim.entity_id);
  const resolved = workflow ? await resolveStage(db, workflow.plan.stages[0], claim.employee_email, business.timezone) : null;
  const routed = resolved?.tasks[0];
  const reviewers=[approver,...(resolved?.tasks.map(t=>t.email)??[])];
  const reviewerGuards=await Promise.all([...new Set(reviewers)].map(address=>requireEntityMember(db,claim.entity_id,address)));
  const rule = claim.entity_id==='primary'?await currentRule(db):null, byRule = !workflow && !configured.chain && approvesByRule(rule, items, exceptions);
  const evidenced=await evidencedPolicyReview(db,items,exceptions,active,claim.employee_email,claim.currency);
  const envelope=claim.entity_id==='primary'?await currentEnvelope(db):null,individual=await expenseApprovals(db,items,exceptions,evidenced.review,rule,envelope,claim.employee_email,claim.currency,claim.entity_id);
  const byAgent=!workflow&&!configured.chain&&individual.approvals.length===items.length&&individual.approvals.some(a=>a.source==='agent');
  const approved=byRule||byAgent;
  const revision = claim.revision + 1, total = reimbursableMinor(items), at = now();
  const snapshot = { entity: await entity(db,claim.entity_id), receiptSignals: await receiptSignals(db, claim.id, bucket), policyReview: evidenced.review, ...(individual.approvals.length?{expenseApprovals:individual.approvals}:{}), ...(workflow ? { workflow: workflow.plan } : {}), policyVersion: active.version, title: claim.title, approver: routed?.email ?? approver, onBehalfOf: routed?.on_behalf_of ?? onBehalfOf, ...(configured.chain ? { approvalChain: configured.chain } : {}), currency: claim.currency, total_minor: total, exceptions, items: items.map(({ receipt_sha256, receipt_name, receipt_media, receipt_size, ...item }) => ({ ...item, receipt: item.receipt_id ? { id: item.receipt_id, name: receipt_name, sha256: receipt_sha256, size: receipt_size, media_type: receipt_media } : null })) };
  await commit(db, all(auth, membership, ...reviewerGuards, coding.guard, evidenced.guard, individual.guard, ...cardGuards, ...(workflow?.guards ?? []), ...(resolved?.guards ?? []), ...configured.guards, policyStill(active.version, business.timezone,claim.entity_id), claimState(claim.id, claim.version, ['draft', 'returned']), { sql: 'EXISTS(SELECT 1 FROM c_members WHERE email=? AND is_manager=1 AND active=1)', params: [approver] }, ...(rule ? [ruleStill(rule)] : [])), [
    db.prepare('INSERT INTO c_revisions(claim_id,revision,submitted_by,submitted_at,total_minor,snapshot) VALUES(?,?,?,?,?,?)').bind(claim.id, revision, by, at, total, JSON.stringify(snapshot)),
    ...(workflow && resolved ? insertTasks(db, 'claim', claim.id, revision, 0, 0, resolved.tasks) : []),
    ...(!workflow && configured.chain ? [freezeChain(db, claim.id, revision, configured.chain.id, configured.chain.steps)] : []),
    db.prepare('UPDATE c_claims SET status=?,revision=?,approver_email=?,on_behalf_of=?,total_minor=?,version=version+1,updated_at=? WHERE id=?').bind(approved ? 'approved' : 'submitted', revision, routed?.email ?? approver, routed?.on_behalf_of ?? onBehalfOf, total, at, claim.id),
    history(revision === 1 ? 'claim-submitted' : 'claim-resubmitted', { revision, totalMinor: total, exceptions: exceptions.length, note, approver, onBehalfOf }),
    ...individual.writes(claim.id,revision),
    ...(byRule ? ruleApproval(db, claim.id, revision, rule!, claim.currency) : []),
    ...(byAgent&&!byRule?[
      db.prepare("INSERT INTO c_decisions(id,claim_id,revision,decision,reason,actor_email,at,exceptions,on_behalf_of) VALUES(?,?,?,'approved',?,?,?,'[]',?)").bind(uid(),claim.id,revision,'Every expense is covered by the owner’s compliant-spend envelope',`policy agent v${envelope!.version}`,at,envelope!.set_by),
      auditSample(db,claim.id,revision),
      ruleEvent(db,`policy agent v${envelope!.version}`,'claim-approved',{claim:claim.id},{revision,envelope:envelope!.version,onBehalfOf:envelope!.set_by}),
    ]:[]),
  ]);
  return loadClaim(db, claim.id);
}
