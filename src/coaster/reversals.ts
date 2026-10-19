import { all, authority, commit, type Sql } from './session';
import { event } from './events';
import { claimState, loadClaim } from './claims';
import { loadBatch } from './batches';
import { now, optionalText, requireThat, type Actor, type Data } from './types';
import { chainRoute, chainState, claimChain, freezeChain } from './approval-chain';
import { localDay } from './delegation';
import { requireBusiness } from './settings';

/** The employee (or their delegate) takes a submitted claim back before anyone decides it: it returns to draft, leaves the
 * approver's queue, and the next submission is the next revision. The retraction is a history line on that revision. */
export async function retractClaim(db: D1Database, actor: Actor, id: string, b: Data) {
  requireThat(actor.kind === 'person', 'Agents prepare proposals; the employee retracts the claim', 403);
  const claim = await loadClaim(db, id);
  requireThat(claim.employee_email === actor.email, 'Only the employee who owns a claim can retract it', 403);
  requireThat(!['approved', 'batched', 'reimbursed'].includes(claim.status), 'This claim has been approved; ask the approver to unapprove it', 409);
  requireThat(claim.status === 'submitted', 'Only a claim waiting for a decision can be retracted', 409);
  requireThat(b.version === claim.version, 'This claim changed; reload before trying again', 409);
  requireThat(!await db.prepare('SELECT 1 FROM c_decisions WHERE claim_id=? AND revision=? LIMIT 1').bind(claim.id, claim.revision).first(), 'An approver has already decided a step; ask the current approver to return the claim', 409);
  const reason = optionalText(b.reason, 'Reason', 1000);
  await commit(db, all(authority(actor, 'employee'), claimState(claim.id, claim.version, ['submitted'])), [
    db.prepare("UPDATE c_claims SET status='draft',approver_email=NULL,on_behalf_of=NULL,version=version+1,updated_at=? WHERE id=?").bind(now(), claim.id),
    event(db, actor, 'claim-retracted', { claim: claim.id }, { revision: claim.revision, reason, approver: claim.approver_email }),
  ]);
  return loadClaim(db, id);
}

/** The approver who approved (or the approver it was approved on behalf of), finance or the owner sends an approved claim
 * back until its batch is reviewed: to the approver as a new revision of the same expenses, or to the employee to correct.
 * An unreviewed draft batch lets the claim go; the approval stays in history beside the unapproval. */
export async function unapproveClaim(db: D1Database, actor: Actor, id: string, b: Data) {
  requireThat(actor.kind === 'person', 'Only a person unapproves a claim', 403);
  const claim = await loadClaim(db, id);
  const batch = claim.batch_id ? await loadBatch(db, claim.batch_id) : null;
  requireThat(claim.status !== 'reimbursed' && (!batch || batch.status === 'draft'), 'This claim is in a reviewed batch; it can no longer be unapproved', 409);
  requireThat(['approved', 'batched'].includes(claim.status), 'Only an approved claim can be unapproved', 409);
  const approval = await db.prepare("SELECT actor_email,on_behalf_of FROM c_decisions WHERE claim_id=? AND revision=? AND decision='approved' ORDER BY decision_step DESC LIMIT 1").bind(claim.id, claim.revision).first<{ actor_email: string; on_behalf_of: string | null }>();
  requireThat(approval, 'Approval missing', 409);
  const own = actor.roles.manager && (approval.actor_email === actor.email || approval.on_behalf_of === actor.email);
  requireThat(actor.roles.finance || actor.roles.owner || own, 'Only the approver who approved, finance or the owner can unapprove a claim', 403);
  requireThat(b.version === claim.version, 'The claim changed since you opened it; reload and try again', 409);
  requireThat(b.to === 'approver' || b.to === 'employee', 'Choose who the claim goes back to: the approver or the employee');
  const reason = optionalText(b.reason, 'Reason', 1000);
  requireThat(reason, 'Say why you are unapproving');
  const at = now(), role = actor.roles.finance ? 'finance' : 'manager';
  const state: Sql[] = [claimState(claim.id, claim.version, [claim.status])];
  const chain = await claimChain(db, claim.id, claim.revision);
  state.push(chainState(chain, claim.id, claim.revision));
  const writes: D1PreparedStatement[] = [];
  if (batch) {
    state.push({ sql: "EXISTS(SELECT 1 FROM c_batches WHERE id=? AND status='draft')", params: [batch.id] });
    writes.push(
      db.prepare('DELETE FROM c_reimbursement_keys WHERE batch_id=? AND claim_id=?').bind(batch.id, claim.id),
      db.prepare('DELETE FROM c_batch_claims WHERE batch_id=? AND claim_id=?').bind(batch.id, claim.id),
      db.prepare('UPDATE c_batches SET total_minor=(SELECT COALESCE(SUM(amount_minor),0) FROM c_batch_claims WHERE batch_id=?),version=version+1 WHERE id=?').bind(batch.id, batch.id),
      event(db, actor, 'claim-unbatched', { claim: claim.id, batch: batch.id }, { unapproved: true }),
    );
  }
  if (b.to === 'approver') {
    // The approver decides again on a new revision: the same frozen expenses, marked as reopened from the approved one.
    const previous = await db.prepare('SELECT submitted_by,total_minor,snapshot FROM c_revisions WHERE claim_id=? AND revision=?').bind(claim.id, claim.revision).first<{ submitted_by: string; total_minor: number; snapshot: string }>();
    requireThat(previous, 'Approved revision missing', 409);
    const route = chain ? await chainRoute(db, chain.steps, 0, claim.employee_email, localDay((await requireBusiness(db)).timezone)) : null;
    state.push(route?.guard ?? { sql: 'EXISTS(SELECT 1 FROM c_members WHERE email=? AND is_manager=1 AND active=1)', params: [claim.approver_email] });
    const approver = route?.approver ?? claim.approver_email, onBehalfOf = route ? route.onBehalfOf : claim.on_behalf_of;
    const snapshot = { ...JSON.parse(previous.snapshot), approver, onBehalfOf, reopened: { fromRevision: claim.revision, by: actor.delegate?.email ?? actor.email, reason } };
    writes.push(
      db.prepare('INSERT INTO c_revisions(claim_id,revision,submitted_by,submitted_at,total_minor,snapshot) VALUES(?,?,?,?,?,?)').bind(claim.id, claim.revision + 1, previous.submitted_by, at, previous.total_minor, JSON.stringify(snapshot)),
      ...(chain ? [freezeChain(db, claim.id, claim.revision + 1, chain.chain_id, chain.steps)] : []),
      db.prepare("UPDATE c_claims SET status='submitted',revision=?,approver_email=?,on_behalf_of=?,batch_id=NULL,version=version+1,updated_at=? WHERE id=?").bind(claim.revision + 1, approver, onBehalfOf, at, claim.id),
    );
  } else {
    writes.push(db.prepare("UPDATE c_claims SET status='returned',batch_id=NULL,version=version+1,updated_at=? WHERE id=?").bind(at, claim.id));
  }
  writes.push(event(db, actor, 'claim-unapproved', { claim: claim.id, batch: batch?.id }, { revision: claim.revision, reason, to: b.to, approvedBy: approval.actor_email, onBehalfOf: approval.on_behalf_of }));
  await commit(db, all(authority(actor, role), ...state), writes);
  return loadClaim(db, id);
}
