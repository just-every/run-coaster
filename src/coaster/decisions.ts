import { all, authority, commit, need } from './session';
import { event } from './events';
import { claimState, loadClaim } from './claims';
import { approveWithHold } from './holds';
import { preApprovalOverride } from './requests';
import { auditSample } from './audit-queue';
import { email, now, optionalText, requireThat, uid, type Actor, type Data } from './types';

/** The assigned manager approves, returns or rejects the exact submitted revision. */
export async function decide(db: D1Database, actor: Actor, id: string, b: Data) {
  need(actor, 'manager');
  requireThat(actor.kind === 'person', 'Only a person decides a claim', 403);
  const claim = await loadClaim(db, id);
  requireThat(claim.employee_email !== actor.email && claim.employee_email !== actor.delegate?.email, 'Nobody approves their own claim', 403);
  requireThat(claim.approver_email === actor.email, 'This claim is waiting for another approver', 403);
  requireThat(claim.status === 'submitted', 'This claim is not waiting for a decision', 409);
  requireThat(b.revision === claim.revision && b.version === claim.version, 'The claim changed since you opened it; reload and review it again', 409);
  requireThat(['approved', 'returned', 'rejected'].includes(b.decision), 'Choose approve, return or reject');
  const reason = optionalText(b.reason, 'Reason', 1000);
  requireThat(b.decision === 'approved' || reason, b.decision === 'returned' ? 'Say what needs correcting' : 'Give the reason for rejecting');
  const revision = await db.prepare('SELECT snapshot FROM c_revisions WHERE claim_id=? AND revision=?').bind(claim.id, claim.revision).first<{ snapshot: string }>();
  requireThat(revision, 'Submitted revision missing', 409);
  const snapshot = JSON.parse(revision.snapshot), exceptions = snapshot.exceptions ?? [];
  const decided = { sql: 'EXISTS(SELECT 1 FROM c_claims WHERE id=? AND approver_email=? AND revision=?)', params: [claim.id, actor.email, claim.revision] };
  // Holding some expenses approves the rest of the same revision in one decision (APPROVE-005).
  if (b.decision === 'approved' && Array.isArray(b.hold) && b.hold.length) return approveWithHold(db, actor, claim, b, snapshot, decided);
  requireThat(b.decision !== 'approved' || !exceptions.length || b.acknowledge === true, 'Review and acknowledge the policy exceptions before approving', 409);
  const override = b.decision === 'approved' ? preApprovalOverride(exceptions, b) : null, recorded = override ?? reason;
  // A Full delegate decides as the approver and is recorded as acting on their behalf, like an approval delegate.
  const at = now(), onBehalfOf = actor.delegate ? actor.email : claim.on_behalf_of;
  await commit(db, all(authority(actor, 'manager'), claimState(claim.id, claim.version, ['submitted']), decided), [
    db.prepare('INSERT INTO c_decisions(id,claim_id,revision,decision,reason,actor_email,at,exceptions,on_behalf_of) VALUES(?,?,?,?,?,?,?,?,?)').bind(uid(), claim.id, claim.revision, b.decision, recorded, actor.delegate?.email ?? actor.email, at, JSON.stringify(exceptions), onBehalfOf),
    db.prepare('UPDATE c_claims SET status=?,version=version+1,updated_at=? WHERE id=?').bind(b.decision, at, claim.id),
    ...(b.decision === 'approved' ? [auditSample(db, claim.id, claim.revision)] : []),
    event(db, actor, `claim-${b.decision}`, { claim: claim.id }, { revision: claim.revision, reason: recorded, preApprovalOverride: override, exceptionsAcknowledged: b.decision === 'approved' ? exceptions.length : 0, onBehalfOf }),
  ]);
  return loadClaim(db, id);
}

/** The owner moves a stuck claim to another active manager; the move is a history line and COA-006 still holds for the new approver. */
export async function reassign(db: D1Database, actor: Actor, id: string, b: Data) {
  need(actor, 'owner');
  const claim = await loadClaim(db, id);
  requireThat(claim.status === 'submitted', 'Only a claim waiting for a decision can be reassigned', 409);
  requireThat(b.version === claim.version, 'The claim changed since you opened it; reload and try again', 409);
  const to = email(b.approver, 'New approver');
  requireThat(to !== claim.employee_email, 'Nobody approves their own claim');
  requireThat(to !== claim.approver_email, 'The claim is already waiting for that person');
  requireThat(await db.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_manager=1').bind(to).first(), 'The new approver must be an active member with the manager role');
  const reason = optionalText(b.reason, 'Reason', 500);
  await commit(db, all(authority(actor, 'owner'), claimState(claim.id, claim.version, ['submitted'])), [
    db.prepare('UPDATE c_claims SET approver_email=?,on_behalf_of=NULL,version=version+1,updated_at=? WHERE id=?').bind(to, now(), claim.id),
    event(db, actor, 'claim-reassigned', { claim: claim.id }, { from: claim.approver_email, to, reason }),
  ]);
  return loadClaim(db, id);
}
