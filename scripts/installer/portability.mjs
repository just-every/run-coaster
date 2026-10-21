import { createHash } from 'node:crypto';
import { PortabilityError } from '@runeditrun/rer/modules/portability';
import { validateCaptureArchive } from './capture-archive.mjs';

const refuse = code => { throw new PortabilityError('coaster_' + code, 409); };
const check = (ok, code) => { if (!ok) refuse(code); };
/** Staged BLOB cells arrive encoded ({blob: base64}) or as bytes. */
const bytes = cell => cell && typeof cell === 'object' && typeof cell.blob === 'string' ? Buffer.from(cell.blob, 'base64') : Buffer.from(cell instanceof ArrayBuffer ? new Uint8Array(cell) : cell ?? []);

/** Read-only checks on the staged archive before any row is written. */
export async function validateCoasterArchive(read, manifest) {
  const [claims, items, allocations, receipts, revisions, decisions, batches, batchClaims, keys, captureReceipts] = await Promise.all(['c_claims', 'c_items', 'c_allocations', 'c_receipts', 'c_revisions', 'c_decisions', 'c_batches', 'c_batch_claims', 'c_reimbursement_keys', 'c_capture_receipts'].map(t => read(t)));
  const claimIds = new Set(claims.map(c => c.id)), itemIds = new Set(items.map(i => i.id));
  for (const claim of claims) {
    const own = items.filter(i => i.claim_id === claim.id);
    check(claim.total_minor === own.reduce((n, i) => n + i.amount_minor, 0), 'claim_total');
    check(claim.revision === revisions.filter(r => r.claim_id === claim.id).length, 'claim_revisions');
  }
  for (const item of items) {
    check(claimIds.has(item.claim_id), 'item_claim');
    check(allocations.filter(a => a.item_id === item.id).reduce((n, a) => n + a.amount_minor, 0) === item.amount_minor - (item.sales_tax_minor ?? 0), 'item_split');
  }
  for (const a of allocations) check(itemIds.has(a.item_id), 'allocation_item');
  for (const r of receipts) {
    const body = bytes(r.bytes);
    if (r.capture_receipt_id == null) {
      check(body.length === r.size && createHash('sha256').update(body).digest('hex') === r.sha256, 'receipt_bytes');
    } else {
      const original = captureReceipts.find(original => original.id === r.capture_receipt_id);
      check(body.length === 0 && original && ['owner_email', 'name', 'media_type', 'size', 'sha256', 'source', 'uploaded_by', 'uploaded_at'].every(key => r[key] === original[key]), 'receipt_bytes');
      check(typeof r.claim_id === 'string' && r.proposal_id === null && claims.some(c=>c.id===r.claim_id && c.employee_email===original.owner_email), 'receipt_claim');
    }
    check(!r.claim_id || claimIds.has(r.claim_id), 'receipt_claim');
  }
  for (const r of revisions) { check(claimIds.has(r.claim_id), 'revision_claim'); JSON.parse(r.snapshot); }
  const tasks = await read('c_workflow_tasks'), requests = await read('c_requests');
  for(const t of tasks) {
    check(t.kind==='claim' ? revisions.some(r=>r.claim_id===t.record_id&&r.revision===t.revision&&JSON.parse(r.snapshot).workflow) : requests.some(r=>r.id===t.record_id&&r.workflow), 'workflow_task_record');
    check(t.kind==='request'||t.status!=='approved'||decisions.some(d=>d.claim_id===t.record_id&&d.revision===t.revision&&d.decision_step===t.slot&&d.decision==='approved'),'workflow_task_decision');
  }
  for(const c of claims) {
    const own=tasks.filter(t=>t.kind==='claim'&&t.record_id===c.id&&t.revision===c.revision);
    if(own.length&&['approved','batched','reimbursed'].includes(c.status)) check(own.every(t=>t.status==='approved')&&decisions.filter(d=>d.claim_id===c.id&&d.revision===c.revision&&d.decision==='approved'&&d.workflow_final===1).length===1,'workflow_completion');
  }
  for (const d of decisions) check(revisions.some(r => r.claim_id === d.claim_id && r.revision === d.revision), 'decision_revision');
  for (const b of batches) check(b.total_minor === batchClaims.filter(x => x.batch_id === b.id).reduce((n, x) => n + x.amount_minor, 0), 'batch_total');
  for (const k of keys) check(batchClaims.some(x => x.batch_id === k.batch_id && x.claim_id === k.claim_id), 'reimbursement_key');
  await validateCaptureArchive(read, manifest);
  return true;
}

// People and sessions stay with each installation (operator-auth tables are
// excluded by default); Coaster roles are keyed by email, so restored people
// sign in again natively and keep their roles.
export default {
  product: 'just-every/coaster',
  buckets: { COASTER_RECEIPTS: { prefix: 'receipt-inbox/', objectReferences: { table: 'c_capture_receipts', keyColumn: 'object_key' } } },
  excludeTables: ['rer_dependency_keys', 'rer_dependency_pending', 'rer_dependency_codes', 'c_agent_keys', 'c_guard'],
  requiredConfiguration: ['OWNER_EMAIL', 'SESSION_SECRET', 'SETUP_TOKEN', 'AUTH_ORIGIN', 'MAIL_PROVIDER', 'MAIL_FROM'],
  validateStaged: async ({ read, manifest }) => validateCoasterArchive(read, manifest),
};
