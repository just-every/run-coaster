import { createHash } from 'node:crypto';
import { PortabilityError } from '@runeditrun/rer/modules/portability';
import { validateCaptureArchive } from './capture-archive.mjs';
import { validateAutomaticCodingArchive } from './automatic-coding-archive.mjs';
import { validateCodingArchive } from './coding-archive.mjs';

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
    check(claim.total_minor === own.reduce((n, i) => n + (i.card_charge_id ? 0 : i.amount_minor), 0), 'claim_total');
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
  const cards=await read('c_cards'), charges=await read('c_card_charges'), files=await read('c_statement_files'), events=await read('c_events');
  for(const card of cards) check(/^\d{4}$/.test(card.last4),'card_last_four');
  const undone=await read('c_card_charge_undo_history');
  check(new Set([...charges,...undone].map(c=>c.id)).size===charges.length+undone.length,'card_charge');
  for(const charge of [...charges,...undone]) {
    check(cards.some(c=>c.id===charge.card_id)&&files.some(f=>f.id===charge.file_id),'card_charge');
    const item=items.find(i=>i.id===charge.item_id), claim=item&&claims.find(c=>c.id===item.claim_id);
    if(undone.some(c=>c.id===charge.id)) check(!item&&files.some(f=>f.id===charge.file_id&&f.undone_at),'card_charge');
    else if(item) check(claim&&item.card_charge_id===charge.id&&claim.employee_email===charge.employee_email&&item.amount_minor===charge.amount_minor
      && item.merchant===charge.descriptor&&item.spent_on===(charge.transaction_on??charge.posted_on),'card_charge');
    else check(typeof charge.claim_id==='string'&&charge.claim_id.length>0&&events.some(e=>e.action==='claim-expired'&&e.claim_id===charge.claim_id),'card_charge');
  }
  for(const item of items.filter(i=>i.card_charge_id)) check(charges.some(c=>c.id===item.card_charge_id&&c.item_id===item.id),'card_charge');
  // FEED-005: a closed statement carries its ledger, and the card account equals the statement balance at every close.
  const statements=await read('c_card_statements'), resolutions=await read('c_card_statement_resolutions'), ledger=await read('c_card_ledger');
  for(const st of statements) check(cards.some(c=>c.id===st.card_id)&&files.some(f=>f.id===st.file_id)&&Boolean(st.closed_at)===ledger.some(l=>l.statement_id===st.id),'card_statement');
  for(const r of resolutions) check(statements.some(st=>st.id===r.statement_id),'card_statement');
  for(const l of ledger) check(statements.some(st=>st.id===l.statement_id&&st.card_id===l.card_id&&st.closed_at===l.posted_at),'card_statement');
  for(const card of cards) {
    const account=`Card liability · ${card.issuer} ····${card.last4}`;
    for(const st of statements.filter(x=>x.card_id===card.id&&x.closed_at)) {
      const owed=ledger.filter(l=>l.card_id===card.id&&l.posted_at<=st.closed_at).reduce((n,l)=>n+(l.credit_account===account?l.amount_minor:0)-(l.debit_account===account?l.amount_minor:0),0);
      check(owed===st.statement_minor,'card_statement');
    }
  }
  await validateCaptureArchive(read, manifest);
  await validateCodingArchive(read);
  await validateAutomaticCodingArchive(read);
  return true;
}

// Match evaluation epochs/generations/checks are derived caches. Restore rebuilds them; consent, rejections,
// rule versions, original bytes, aliases and private lifecycle evidence are all portable.
// People and sessions stay with each installation (operator-auth tables are
// excluded by default); Coaster roles are keyed by email, so restored people
// sign in again natively and keep their roles.
export default {
  product: 'just-every/coaster',
  buckets: { COASTER_RECEIPTS: { prefix: 'receipt-inbox/', objectReferences: { table: 'c_capture_receipts', keyColumn: 'object_key' } } },
  excludeTables: ['rer_dependency_keys', 'rer_dependency_pending', 'rer_dependency_codes', 'c_agent_keys', 'c_guard', 'c_card_match_epoch', 'c_card_match_generations', 'c_card_match_checks', 'c_public_keys', 'c_public_oauth_clients', 'c_public_oauth_codes', 'c_public_webhooks', 'c_public_webhook_deliveries', 'c_qbo_connections', 'c_qbo_oauth_states'],
  requiredConfiguration: ['OWNER_EMAIL', 'SESSION_SECRET', 'SETUP_TOKEN', 'AUTH_ORIGIN', 'MAIL_PROVIDER', 'MAIL_FROM'],
  validateStaged: async ({ read, manifest }) => validateCoasterArchive(read, manifest),
};
