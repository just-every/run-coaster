import { all, authority, commit, need } from './session';
import { event } from './events';
import { claimState, loadClaim } from './claims';
import { now, optionalText, requireThat, uid, type Actor, type Data } from './types';

/** The assigned manager approves, returns or rejects the exact submitted revision. */
export async function decide(db: D1Database, actor: Actor, id: string, b: Data) {
  need(actor, 'manager');
  requireThat(actor.kind === 'person', 'Only a person decides a claim', 403);
  const claim = await loadClaim(db, id);
  requireThat(claim.employee_email !== actor.email, 'Nobody approves their own claim', 403);
  requireThat(claim.approver_email === actor.email, 'This claim is waiting for another approver', 403);
  requireThat(claim.status === 'submitted', 'This claim is not waiting for a decision', 409);
  requireThat(b.revision === claim.revision && b.version === claim.version, 'The claim changed since you opened it; reload and review it again', 409);
  requireThat(['approved', 'returned', 'rejected'].includes(b.decision), 'Choose approve, return or reject');
  const reason = optionalText(b.reason, 'Reason', 1000);
  requireThat(b.decision === 'approved' || reason, b.decision === 'returned' ? 'Say what needs correcting' : 'Give the reason for rejecting');
  const revision = await db.prepare('SELECT snapshot FROM c_revisions WHERE claim_id=? AND revision=?').bind(claim.id, claim.revision).first<{ snapshot: string }>();
  requireThat(revision, 'Submitted revision missing', 409);
  const exceptions = JSON.parse(revision.snapshot).exceptions ?? [];
  requireThat(b.decision !== 'approved' || !exceptions.length || b.acknowledge === true, 'Review and acknowledge the policy exceptions before approving', 409);
  const at = now();
  await commit(db, all(authority(actor, 'manager'), claimState(claim.id, claim.version, ['submitted']), { sql: 'EXISTS(SELECT 1 FROM c_claims WHERE id=? AND approver_email=? AND revision=?)', params: [claim.id, actor.email, claim.revision] }), [
    db.prepare('INSERT INTO c_decisions(id,claim_id,revision,decision,reason,actor_email,at,exceptions) VALUES(?,?,?,?,?,?,?,?)').bind(uid(), claim.id, claim.revision, b.decision, reason, actor.email, at, JSON.stringify(exceptions)),
    db.prepare('UPDATE c_claims SET status=?,version=version+1,updated_at=? WHERE id=?').bind(b.decision, at, claim.id),
    event(db, actor, `claim-${b.decision}`, { claim: claim.id }, { revision: claim.revision, reason, exceptionsAcknowledged: b.decision === 'approved' ? exceptions.length : 0 }),
  ]);
  return loadClaim(db, id);
}
