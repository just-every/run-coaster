import { all, authority, commit, need, sha256Hex, type Sql } from './session';
import { event } from './events';
import { categories, itemInput, type Allocation, type ItemInput } from './items';
import { findExceptions, repeatedInClaim, type ClaimItem } from './exceptions';
import { requireBusiness } from './settings';
import { Fault, now, optionalText, requireThat, text, uid, type Actor, type Data } from './types';

export type Claim = { id: string; number: number; employee_email: string; approver_email: string | null; title: string; status: string; revision: number; version: number; total_minor: number; currency: string; prepared_by: string | null; batch_id: string | null; created_at: string; updated_at: string };

export const claimNumber = (n: number) => `CL-${String(n).padStart(4, '0')}`;
export const RECEIPT_LIMIT = 1_500_000;

export async function loadClaim(db: D1Database, id: unknown): Promise<Claim> {
  requireThat(typeof id === 'string' && id.length <= 64, 'Claim not found', 404);
  const claim = await db.prepare('SELECT * FROM c_claims WHERE id=?').bind(id).first<Claim>();
  requireThat(claim, 'Claim not found', 404);
  return claim;
}

/** Who may see a claim: its employee always; once submitted, its approver, finance and the owner. */
export function canSee(actor: Actor, claim: Claim) {
  if (claim.employee_email === actor.email) return true;
  if (claim.status === 'draft') return false;
  return (actor.roles.manager && claim.approver_email === actor.email) || actor.roles.finance || actor.roles.owner;
}
export function visible(actor: Actor, claim: Claim) {
  requireThat(canSee(actor, claim), 'This claim is outside your access', 403);
}

/** SQL conditions binding a write to the exact claim state it was decided on. */
export const claimState = (id: string, version: number, statuses: string[]): Sql => ({ sql: `EXISTS(SELECT 1 FROM c_claims WHERE id=? AND version=? AND status IN (${statuses.map(() => '?').join(',')}))`, params: [id, version, ...statuses] });

function editable(actor: Actor, claim: Claim, b: Data) {
  requireThat(actor.kind === 'person', 'Agents prepare proposals; the employee edits the claim', 403);
  requireThat(claim.employee_email === actor.email, 'Only the employee who owns a claim can change it', 403);
  requireThat(['draft', 'returned'].includes(claim.status), 'This claim can no longer be changed', 409);
  requireThat(b.version === claim.version, 'This claim changed; reload before trying again', 409);
}
const touch = (db: D1Database, id: string) => db.prepare('UPDATE c_claims SET total_minor=(SELECT COALESCE(SUM(amount_minor),0) FROM c_items WHERE claim_id=?),version=version+1,updated_at=? WHERE id=?').bind(id, now(), id);

export function insertClaim(db: D1Database, id: string, employee: string, title: string, currency: string, preparedBy: string | null) {
  const at = now();
  return db.prepare('INSERT INTO c_claims(id,number,employee_email,title,status,currency,prepared_by,created_at,updated_at) VALUES(?,(SELECT COALESCE(MAX(number),0)+1 FROM c_claims),?,?,\'draft\',?,?,?,?)').bind(id, employee, title, currency, preparedBy, at, at);
}

export function insertItem(db: D1Database, claimId: string, itemId: string, position: number, item: ItemInput, receiptId: string | null) {
  return [
    db.prepare('INSERT INTO c_items(id,claim_id,position,kind,spent_on,merchant,description,amount_minor,distance_hundredths,days,rate_thousandths,receipt_id,explanation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(itemId, claimId, position, item.kind, item.spent_on, item.merchant, item.description, item.amount_minor, item.distance_hundredths, item.days, item.rate_thousandths, receiptId, item.explanation),
    ...item.allocations.map((a: Allocation, i) => db.prepare('INSERT INTO c_allocations(item_id,position,category_id,cost_centre,amount_minor) VALUES(?,?,?,?,?)').bind(itemId, i, a.category_id, a.cost_centre, a.amount_minor)),
  ];
}

export async function createClaim(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'employee');
  requireThat(actor.kind === 'person', 'Agents prepare proposals instead of claims', 403);
  const business = await requireBusiness(db), id = uid(), title = text(b.title, 'Claim title', 200);
  await commit(db, authority(actor, 'employee'), [insertClaim(db, id, actor.email, title, business.currency, null), event(db, actor, 'claim-created', { claim: id }, { title })]);
  return loadClaim(db, id);
}

export async function renameClaim(db: D1Database, actor: Actor, id: string, b: Data) {
  const claim = await loadClaim(db, id);
  editable(actor, claim, b);
  const title = text(b.title, 'Claim title', 200);
  await commit(db, all(authority(actor, 'employee'), claimState(id, claim.version, ['draft', 'returned'])), [db.prepare('UPDATE c_claims SET title=?,version=version+1,updated_at=? WHERE id=?').bind(title, now(), id), event(db, actor, 'claim-renamed', { claim: id }, { title })]);
  return loadClaim(db, id);
}

async function ownReceipt(db: D1Database, claim: Claim, receiptId: unknown) {
  if (receiptId === undefined || receiptId === null || receiptId === '') return null;
  requireThat(typeof receiptId === 'string', 'Receipt not found', 404);
  const receipt = await db.prepare('SELECT id FROM c_receipts WHERE id=? AND claim_id=?').bind(receiptId, claim.id).first<{ id: string }>();
  requireThat(receipt, 'Receipt not found on this claim', 404);
  return receipt.id;
}

/** Add or replace one expense. A replaced item's receipt stays on the claim and in earlier revisions. */
export async function saveItem(db: D1Database, actor: Actor, id: string, b: Data) {
  const claim = await loadClaim(db, id);
  editable(actor, claim, b);
  const business = await requireBusiness(db), item = itemInput(b, business, await categories(db)), receiptId = await ownReceipt(db, claim, b.receipt);
  const statements: D1PreparedStatement[] = [];
  let itemId: string = uid(), position: number;
  if (b.item) {
    const existing = await db.prepare('SELECT id,position FROM c_items WHERE id=? AND claim_id=?').bind(b.item, claim.id).first<{ id: string; position: number }>();
    requireThat(existing, 'Expense not found on this claim', 404);
    itemId = existing.id; position = existing.position;
    statements.push(db.prepare('DELETE FROM c_items WHERE id=?').bind(itemId));
  } else {
    const count = await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position),-1) AS last FROM c_items WHERE claim_id=?').bind(claim.id).first<{ n: number; last: number }>();
    requireThat((count?.n ?? 0) < 100, 'A claim holds at most 100 expenses');
    position = (count?.last ?? -1) + 1;
  }
  statements.push(...insertItem(db, claim.id, itemId, position, item, receiptId), touch(db, claim.id), event(db, actor, b.item ? 'expense-changed' : 'expense-added', { claim: claim.id }, { item: itemId, merchant: item.merchant, amountMinor: item.amount_minor, receipt: receiptId }));
  await commit(db, all(authority(actor, 'employee'), claimState(claim.id, claim.version, ['draft', 'returned'])), statements);
  return loadClaim(db, id);
}

export async function removeItem(db: D1Database, actor: Actor, id: string, b: Data) {
  const claim = await loadClaim(db, id);
  editable(actor, claim, b);
  const existing = await db.prepare('SELECT id,merchant,amount_minor FROM c_items WHERE id=? AND claim_id=?').bind(b.item, claim.id).first<{ id: string; merchant: string; amount_minor: number }>();
  requireThat(existing, 'Expense not found on this claim', 404);
  await commit(db, all(authority(actor, 'employee'), claimState(claim.id, claim.version, ['draft', 'returned'])), [db.prepare('DELETE FROM c_items WHERE id=?').bind(existing.id), touch(db, claim.id), event(db, actor, 'expense-removed', { claim: claim.id }, { item: existing.id, merchant: existing.merchant, amountMinor: existing.amount_minor })]);
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
  editable(actor, claim, b);
  const { bytes, media, name } = receiptBytes(b), receiptId = uid(), sha = await sha256Hex(bytes);
  const source = b.source === 'camera' ? 'camera' : 'upload';
  const statements = [db.prepare('INSERT INTO c_receipts(id,claim_id,owner_email,name,media_type,size,sha256,bytes,source,uploaded_by,uploaded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(receiptId, claim.id, claim.employee_email, name, media, bytes.length, sha, bytes, source, actor.email, now())];
  if (b.item) {
    const item = await db.prepare('SELECT id FROM c_items WHERE id=? AND claim_id=?').bind(b.item, claim.id).first();
    requireThat(item, 'Expense not found on this claim', 404);
    statements.push(db.prepare('UPDATE c_items SET receipt_id=? WHERE id=?').bind(receiptId, b.item));
  }
  statements.push(touch(db, claim.id), event(db, actor, 'receipt-added', { claim: claim.id }, { receipt: receiptId, name, sha256: sha, size: bytes.length, item: b.item ?? null, source }));
  await commit(db, all(authority(actor, 'employee'), claimState(claim.id, claim.version, ['draft', 'returned'])), statements);
  return { claim: await loadClaim(db, id), receipt: receiptId };
}

/** Current items with their allocations and receipt fingerprints. */
export async function claimItems(db: D1Database, claimId: string): Promise<ClaimItem[]> {
  const [items, parts] = await db.batch([
    db.prepare('SELECT i.*, r.sha256 AS receipt_sha256, r.name AS receipt_name, r.media_type AS receipt_media, r.size AS receipt_size FROM c_items i LEFT JOIN c_receipts r ON r.id=i.receipt_id WHERE i.claim_id=? ORDER BY i.position').bind(claimId),
    db.prepare('SELECT a.*, c.name AS category_name, c.account_code, c.tax_code FROM c_allocations a JOIN c_items i ON i.id=a.item_id JOIN c_categories c ON c.id=a.category_id WHERE i.claim_id=? ORDER BY a.item_id, a.position').bind(claimId),
  ]);
  return (items.results as ClaimItem[]).map(item => ({ ...item, allocations: (parts.results as Data[]).filter(p => p.item_id === item.id) }));
}

/** Submission freezes the exact claim as a new revision and routes it to the employee's manager. */
export async function submitClaim(db: D1Database, actor: Actor, id: string, b: Data) {
  const claim = await loadClaim(db, id);
  editable(actor, claim, b);
  const items = await claimItems(db, claim.id);
  requireThat(items.length > 0, 'Add at least one expense before submitting');
  const member = await db.prepare('SELECT approver_email FROM c_members WHERE email=? AND active=1').bind(claim.employee_email).first<{ approver_email: string | null }>();
  const approver = member?.approver_email;
  requireThat(approver && approver !== claim.employee_email, 'Ask the owner to set your approving manager before submitting', 409);
  const repeated = repeatedInClaim(claim.employee_email, items);
  requireThat(!repeated.length, `${repeated.map(i => i.merchant).join(', ')} appears twice on this claim with the same ${repeated.some(i => i.receipt_sha256) ? 'receipt' : 'date, merchant and amount and no receipt'}; only one could be reimbursed. Attach each one's own receipt, or correct or remove one, before submitting`, 409);
  const business = await requireBusiness(db), exceptions = await findExceptions(db, claim, items, business, await categories(db));
  const unexplained = exceptions.filter(e => !items.find(i => i.id === e.item)?.explanation);
  requireThat(!unexplained.length, `Explain each policy exception before submitting: ${unexplained.map(e => e.message).join('; ')}`, 409);
  const revision = claim.revision + 1, total = items.reduce((n, i) => n + i.amount_minor, 0), at = now();
  const snapshot = { title: claim.title, approver, currency: claim.currency, total_minor: total, exceptions, items: items.map(({ receipt_sha256, receipt_name, receipt_media, receipt_size, ...item }) => ({ ...item, receipt: item.receipt_id ? { id: item.receipt_id, name: receipt_name, sha256: receipt_sha256, size: receipt_size, media_type: receipt_media } : null })) };
  await commit(db, all(authority(actor, 'employee'), claimState(claim.id, claim.version, ['draft', 'returned']), { sql: 'EXISTS(SELECT 1 FROM c_members WHERE email=? AND is_manager=1 AND active=1)', params: [approver] }), [
    db.prepare('INSERT INTO c_revisions(claim_id,revision,submitted_by,submitted_at,total_minor,snapshot) VALUES(?,?,?,?,?,?)').bind(claim.id, revision, actor.email, at, total, JSON.stringify(snapshot)),
    db.prepare("UPDATE c_claims SET status='submitted',revision=?,approver_email=?,total_minor=?,version=version+1,updated_at=? WHERE id=?").bind(revision, approver, total, at, claim.id),
    event(db, actor, revision === 1 ? 'claim-submitted' : 'claim-resubmitted', { claim: claim.id }, { revision, totalMinor: total, exceptions: exceptions.length, note: optionalText(b.note, 'Note', 1000) }),
  ]);
  return loadClaim(db, id);
}
