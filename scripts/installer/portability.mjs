import { createHash } from 'node:crypto';
import { PortabilityError } from '@runeditrun/rer/modules/portability';

const refuse = code => { throw new PortabilityError('coaster_' + code, 409); };
const check = (ok, code) => { if (!ok) refuse(code); };
/** Staged BLOB cells arrive encoded ({blob: base64}) or as bytes. */
const bytes = cell => cell && typeof cell === 'object' && typeof cell.blob === 'string' ? Buffer.from(cell.blob, 'base64') : Buffer.from(cell instanceof ArrayBuffer ? new Uint8Array(cell) : cell ?? []);

/** Read-only checks on the staged archive before any row is written. */
export async function validateCoasterArchive(read) {
  const [claims, items, allocations, receipts, revisions, decisions, batches, batchClaims, keys] = await Promise.all(['c_claims', 'c_items', 'c_allocations', 'c_receipts', 'c_revisions', 'c_decisions', 'c_batches', 'c_batch_claims', 'c_reimbursement_keys'].map(t => read(t)));
  const claimIds = new Set(claims.map(c => c.id)), itemIds = new Set(items.map(i => i.id));
  for (const claim of claims) {
    const own = items.filter(i => i.claim_id === claim.id);
    check(claim.total_minor === own.reduce((n, i) => n + i.amount_minor, 0), 'claim_total');
    check(claim.revision === revisions.filter(r => r.claim_id === claim.id).length, 'claim_revisions');
  }
  for (const item of items) {
    check(claimIds.has(item.claim_id), 'item_claim');
    check(allocations.filter(a => a.item_id === item.id).reduce((n, a) => n + a.amount_minor, 0) === item.amount_minor, 'item_split');
  }
  for (const a of allocations) check(itemIds.has(a.item_id), 'allocation_item');
  for (const r of receipts) {
    const body = bytes(r.bytes);
    check(body.length === r.size && createHash('sha256').update(body).digest('hex') === r.sha256, 'receipt_bytes');
    check(!r.claim_id || claimIds.has(r.claim_id), 'receipt_claim');
  }
  for (const r of revisions) { check(claimIds.has(r.claim_id), 'revision_claim'); JSON.parse(r.snapshot); }
  for (const d of decisions) check(revisions.some(r => r.claim_id === d.claim_id && r.revision === d.revision), 'decision_revision');
  for (const b of batches) check(b.total_minor === batchClaims.filter(x => x.batch_id === b.id).reduce((n, x) => n + x.amount_minor, 0), 'batch_total');
  for (const k of keys) check(batchClaims.some(x => x.batch_id === k.batch_id && x.claim_id === k.claim_id), 'reimbursement_key');
  return true;
}

// People and sessions stay with each installation (operator-auth tables are
// excluded by default); Coaster roles are keyed by email, so restored people
// sign in again natively and keep their roles.
export default {
  product: 'just-every/coaster',
  excludeTables: ['rer_dependency_keys', 'rer_dependency_pending', 'rer_dependency_codes', 'c_agent_keys', 'c_guard'],
  requiredConfiguration: ['OWNER_EMAIL', 'SESSION_SECRET', 'SETUP_TOKEN', 'AUTH_ORIGIN', 'MAIL_PROVIDER', 'MAIL_FROM'],
  validateStaged: async ({ read }) => validateCoasterArchive(read),
};
