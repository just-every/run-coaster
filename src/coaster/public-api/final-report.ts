import { canSee, loadClaim, visible } from '../claims';
import { finalApproval } from '../approval-chain';
import { sha256Hex } from '../session';
import { requireThat, type Actor, type Data } from '../types';

const fields = (row: Data, names: string) => Object.fromEntries(names.split(' ').filter(name => name in row).map(name => [name, row[name]]));

/** Project persisted submission facts only; never load live expenses, inbox readings or coding suggestions. */
function frozenSnapshot(snapshot: Data) {
  return {
    ...fields(snapshot, 'title currency total_minor policyVersion approver onBehalfOf exceptions policyReview receiptSignals expenseApprovals workflow approvalChain split released reopened'),
    items: snapshot.items.map((item: Data) => ({
      ...fields(item, 'id position kind spent_on merchant description amount_minor distance_hundredths days rate_thousandths explanation sales_tax_minor sales_tax_account sales_tax_code attendees fields request_id allowance_id claimed_minor billable customer project original_minor original_currency fx_rate fx_date fx_source original_sales_tax_minor per_diem card_charge_id coding codingVersion'),
      codingSnapshot: item.codingSnapshot?.map((choice: Data) => fields(choice, 'dimension dimensionName kind id name parent')) ?? [],
      allocations: item.allocations.map((part: Data) => fields(part, 'position category_id category_name cost_centre amount_minor description original_minor account_code tax_code ledger_account_id')),
      receipt: item.receipt ? fields(item.receipt, 'id name sha256 size media_type') : null,
    })),
  };
}

/** Frozen comparisons may outlive another claim's submission; never disclose a newly private reference. */
async function visibleReferences(db: D1Database, actor: Actor, snapshot: Data, claimId: string) {
  const references = new Set<string>();
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['claim', 'heldClaim'].includes(key) && typeof child === 'string' && child !== claimId) references.add(child);
      else visit(child);
    }
  }
  visit(snapshot.receiptSignals);
  visit(snapshot.split);
  for (const id of references) requireThat(canSee(actor, await loadClaim(db, id)), 'Frozen evidence references a claim outside your access', 403);
}

/** Read-only evidence for PURSE INTAKE-006. Current approval is required even when a revision is pinned. */
export async function finalReport(db: D1Database, actor: Actor, id: string, revision?: string) {
  const claim = await loadClaim(db, id);
  visible(actor, claim);
  requireThat(['approved', 'batched', 'reimbursed'].includes(claim.status), 'A currently approved claim is required', 409);
  requireThat(revision === undefined || revision === String(claim.revision), 'The approved revision changed', 409);
  const [revisions, decisions, batches, current] = await db.batch([
    db.prepare('SELECT revision,submitted_by,submitted_at,total_minor,snapshot FROM c_revisions WHERE claim_id=? AND revision=?').bind(id, claim.revision),
    db.prepare(`SELECT d.id,d.revision,d.decision_step,d.decision,d.reason,d.actor_email,d.on_behalf_of,d.at,
      CASE WHEN d.actor_email GLOB 'rule v[0-9]*' THEN 'rule' WHEN d.actor_email GLOB 'policy agent v[0-9]*' THEN 'policy-agent'
      ELSE COALESCE((SELECT t.role FROM c_workflow_tasks t WHERE t.kind='claim' AND t.record_id=d.claim_id AND t.revision=COALESCE(json_extract(r.snapshot,'$.split.fromRevision'),d.revision)
        AND (json_extract(r.snapshot,'$.split.fromRevision') IS NOT NULL OR t.slot=d.decision_step) ORDER BY t.slot DESC LIMIT 1), 'manager') END AS role,
      CASE WHEN ${finalApproval('d')} THEN 1 ELSE 0 END AS final_approval
      FROM c_decisions d JOIN c_revisions r ON r.claim_id=d.claim_id AND r.revision=d.revision
      WHERE d.claim_id=? AND d.revision<=? ORDER BY d.revision,d.at,d.rowid`).bind(id, claim.revision),
    db.prepare(`SELECT b.id,b.number,b.status,b.currency,bc.revision,bc.amount_minor,b.created_by,b.created_at,b.reviewed_by,b.reviewed_at,b.released_by,b.released_at,b.paid_reference,b.paid_on,b.paid_by
      FROM c_batch_claims bc JOIN c_batches b ON b.id=bc.batch_id WHERE bc.claim_id=? AND bc.revision=? AND b.id=?`).bind(id, claim.revision, claim.batch_id),
    db.prepare('SELECT version FROM c_claims WHERE id=?').bind(id),
  ]);
  requireThat(current.results[0]?.version === claim.version, 'The claim changed; reload its approved report', 409);
  const row = revisions.results[0] as Data | undefined;
  requireThat(row, 'Submitted revision missing', 409);
  requireThat(decisions.results.some((d: Data) => d.revision === claim.revision && d.final_approval === 1), 'Final approval evidence missing', 409);
  const snapshot = JSON.parse(row.snapshot);
  await visibleReferences(db, actor, snapshot, id);
  const batch = batches.results[0] as Data | undefined;
  return {
    claim: { id: claim.id, number: claim.number, employee_email: claim.employee_email, status: claim.status },
    revision: row.revision, submitted_by: row.submitted_by, submitted_at: row.submitted_at,
    snapshot_sha256: await sha256Hex(row.snapshot), snapshot: frozenSnapshot(snapshot),
    decisions: decisions.results,
    batch: batch ? fields(batch, 'id number status currency revision amount_minor created_by created_at reviewed_by reviewed_at released_by released_at') : null,
    payment: batch?.paid_reference ? { source: 'external-recording', reference: batch.paid_reference, paid_on: batch.paid_on, recorded_by: batch.paid_by } : null,
  };
}
