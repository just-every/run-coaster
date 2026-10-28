import { entityBusiness, entityMember, requireEntityMember } from './entities';
import { noCardDuplicates } from './card-duplicates';
import { reimbursableMinor, REIMBURSABLE_SUM } from './card-expenses';
import { receiptSignals } from './receipt-signals';
import { evidencedPolicyReview } from './policy-review-evidence';
import { policyConfiguration, policyStill } from './policy-configuration';
import { all, authority, commit, type Sql } from './session';
import { event } from './events';
import { claimNumber, claimItems, claimState, insertClaim, loadClaim, type Claim } from './claims';
import { categories } from './items';
import { findExceptions, missingFields } from './exceptions';
import { requireBusiness } from './settings';
import { preApprovalOverride } from './requests';
import { auditSample } from './audit-queue';
import { now, optionalText, requireThat, uid, type Actor, type Data } from './types';
import { type Task, insertTasks, resolveStage } from './workflow-routing';
import { chainState, claimChain, freezeChain } from './approval-chain';
import { checkedCoding } from './coding/validation';

/** Moves expenses to another claim. They keep their ids, splits and attendees; each receipt's evidence and storage
 * reference are copied onto the new claim, and the original stays on the old claim and its earlier revisions. */
export function moveItems(db: D1Database, items: Data[], from: string, to: string) {
  return items.flatMap(item => [
    db.prepare('UPDATE c_items SET claim_id=? WHERE id=? AND claim_id=?').bind(to, item.id, from),
    ...(item.receipt_id ? (copy => [
      db.prepare('INSERT INTO c_receipts(id,claim_id,owner_email,name,media_type,size,sha256,bytes,source,uploaded_by,uploaded_at,capture_receipt_id,card_match_basis) SELECT ?,?,owner_email,name,media_type,size,sha256,bytes,source,uploaded_by,uploaded_at,capture_receipt_id,card_match_basis FROM c_receipts WHERE id=?').bind(copy, to, item.receipt_id),
      db.prepare('UPDATE c_items SET receipt_id=? WHERE id=?').bind(copy, item.id),
    ])(uid()) : []),
  ]);
}

/** Approve part of the exact submitted revision and hold the rest. The approved expenses continue on this claim as the
 * next revision, approved at once; the held ones move to a new claim that stays with the employee, carrying the reason,
 * the approver and a link back. `guard` is the decision's own COA-006 condition (approver, revision, version). */
export async function approveWithHold(db: D1Database, actor: Actor, claim: Claim, b: Data, snapshot: Data, guard: Sql, task?: Task) {
  const chain = await claimChain(db, claim.id, claim.revision);
  requireThat(!chain || chain.position === chain.steps.length - 1, 'Partial approval is available only at the final step of this approval chain; approve this step or return the claim', 409);
  const hold: string[] = b.hold;
  requireThat(hold.every(id => typeof id === 'string') && new Set(hold).size === hold.length, 'Choose the expenses to hold');
  const items: Data[] = snapshot.items;
  requireThat(hold.every(id => items.some(i => i.id === id)), 'Hold only expenses on the revision you are deciding', 409);
  requireThat(hold.length < items.length, 'Hold some expenses and approve the rest; to send everything back, return the claim');
  const reason = optionalText(b.reason, 'Reason', 1000);
  requireThat(reason, 'Say what the employee must do about the held expenses');
  const kept = items.filter(i => !hold.includes(i.id)), exceptions = (snapshot.exceptions as Data[]).filter(e => !hold.includes(e.item));
  requireThat(!exceptions.length || b.acknowledge === true, 'Review and acknowledge the policy exceptions before approving', 409);
  const override = preApprovalOverride(exceptions, b);
  const heldId = uid(), at = now(), revision = claim.revision + 1, total = reimbursableMinor(kept);
  const submitted = await db.prepare('SELECT submitted_by FROM c_revisions WHERE claim_id=? AND revision=?').bind(claim.id, claim.revision).first<{ submitted_by: string }>();
  requireThat(submitted, 'Submitted revision missing', 409);
  const onBehalfOf = actor.delegate ? actor.email : claim.on_behalf_of, by = actor.delegate?.email ?? actor.email;
  const split = { fromRevision: claim.revision, held: hold, heldClaim: heldId, reason };
  const writes: D1PreparedStatement[] = [
    insertClaim(db, heldId, claim.employee_email, `${claim.title} (held)`, claim.currency, null,claim.entity_id),
    db.prepare("UPDATE c_claims SET status='returned',approver_email=?,on_behalf_of=?,held_from=?,held_by=?,held_at=?,hold_reason=? WHERE id=?").bind(claim.approver_email, onBehalfOf, claim.id, by, at, reason, heldId),
  ];
  writes.push(
    ...moveItems(db, items.filter(i => hold.includes(i.id)), claim.id, heldId),
    db.prepare(`UPDATE c_claims SET total_minor=(SELECT ${REIMBURSABLE_SUM} FROM c_items WHERE claim_id=?),version=version+1,updated_at=? WHERE id=?`).bind(heldId, at, heldId),
    db.prepare('INSERT INTO c_revisions(claim_id,revision,submitted_by,submitted_at,total_minor,snapshot) VALUES(?,?,?,?,?,?)').bind(claim.id, revision, submitted.submitted_by, at, total, JSON.stringify({ ...snapshot, ...(snapshot.expenseApprovals?{expenseApprovals:snapshot.expenseApprovals.filter((a:Data)=>!hold.includes(a.item))}:{}), ...(snapshot.receiptSignals ? { receiptSignals: snapshot.receiptSignals.filter((r: Data) => !hold.includes(r.item)) } : {}), ...(snapshot.policyReview ? { policyReview: { ...snapshot.policyReview, recommendations: snapshot.policyReview.recommendations.filter((r: Data) => !hold.includes(r.item)) } } : {}), total_minor: total, exceptions, items: kept, split })),
    ...(task ? [db.prepare("INSERT INTO c_decisions(id,claim_id,revision,decision,reason,actor_email,at,exceptions,on_behalf_of,decision_step,workflow_final) VALUES(?,?,?,'approved',?,?,?,?,?,?,0)").bind(uid(),claim.id,claim.revision,override??reason,by,at,JSON.stringify(exceptions),onBehalfOf,task.slot),db.prepare("UPDATE c_workflow_tasks SET status='approved' WHERE kind='claim' AND record_id=? AND revision=? AND slot=?").bind(claim.id,claim.revision,task.slot)] : []),
    ...(chain ? [freezeChain(db, claim.id, revision, chain.chain_id, chain.steps, chain.position)] : []),
    db.prepare("INSERT INTO c_decisions(id,claim_id,revision,decision,reason,actor_email,at,exceptions,on_behalf_of,decision_step) VALUES(?,?,?,'approved',?,?,?,?,?,?)").bind(uid(), claim.id, revision, override ?? '', by, at, JSON.stringify(exceptions), onBehalfOf, chain?.position ?? 0),
    db.prepare("UPDATE c_claims SET status='approved',revision=?,total_minor=?,version=version+1,updated_at=? WHERE id=?").bind(revision, total, at, claim.id),
    auditSample(db, claim.id, revision),
    event(db, actor, 'claim-split', { claim: claim.id }, { revision: claim.revision, held: hold.length, heldClaim: heldId, reason, onBehalfOf }),
    event(db, actor, 'claim-approved', { claim: claim.id }, { revision, reason: override ?? '', preApprovalOverride: override, exceptionsAcknowledged: exceptions.length, onBehalfOf }),
    event(db, actor, 'claim-held', { claim: heldId }, { from: claim.id, fromNumber: claimNumber(claim.number), fromRevision: claim.revision, items: hold, reason, onBehalfOf }),
  );
  await commit(db, all(entityMember(claim.entity_id,actor.email),authority(actor, task?.role ?? 'manager'), claimState(claim.id, claim.version, ['submitted']), guard, chainState(chain, claim.id, claim.revision)), writes);
  return loadClaim(db, claim.id);
}

/** The approver who held expenses releases the hold before the employee resubmits: the held claim as it stands is frozen
 * as its first revision and approved, still submitted by whoever submitted the original. */
export async function releaseHold(db: D1Database, actor: Actor, id: string, b: Data, bucket?: R2Bucket) {
  requireThat(actor.kind === 'person' && actor.roles.manager, 'Only the approver who held these expenses releases them', 403);
  const claim = await loadClaim(db, id);
  requireThat(claim.held_from, 'This claim holds no expenses on hold', 409);
  requireThat(!await db.prepare("SELECT 1 FROM c_workflow_tasks WHERE kind='claim' AND record_id=? LIMIT 1").bind(claim.held_from).first(), 'Expenses held from a workflow must be resubmitted through the full workflow',409);
  requireThat(!await db.prepare('SELECT 1 FROM c_claim_chains WHERE claim_id=? LIMIT 1').bind(claim.held_from).first(), 'Expenses held from an approval chain must be resubmitted through the full chain before approval', 409);
  requireThat(claim.approver_email === actor.email, 'Only the approver who held these expenses releases them', 403);
  requireThat(claim.employee_email !== actor.email && claim.employee_email !== actor.delegate?.email, 'Nobody approves their own claim', 403);
  requireThat(claim.status === 'returned' && claim.revision === 0, 'The employee has already resubmitted these expenses; decide them as a claim', 409);
  requireThat(b.version === claim.version, 'The claim changed since you opened it; reload and try again', 409);
  const checked = await checkedCoding(db, await claimItems(db, claim.id)), items = checked.items, business = await requireBusiness(db);
  const cardGuards = await noCardDuplicates(db, claim.employee_email, items);
  const active = await policyConfiguration(db, business, await categories(db,claim.entity_id));
  const missing = missingFields(items, active.categories);
  requireThat(!missing.length, `Fill in the required fields: ${missing.join('; ')} (policy v${active.version})`, 409);
  const exceptions = await findExceptions(db, claim, items, business, active.categories, active);
  requireThat(!exceptions.some(e => e.hard), `This claim breaks a hard policy rule and cannot be submitted: ${exceptions.filter(e => e.hard).map(e => e.message).join('; ')}`, 409);
  requireThat(!exceptions.some(e => !items.find(i => i.id === e.item)?.explanation), 'Explain each policy exception before releasing the hold', 409);
  requireThat(!exceptions.length || b.acknowledge === true, 'Review and acknowledge the policy exceptions before approving', 409);
  const override = preApprovalOverride(exceptions, b);
  const original = await db.prepare('SELECT submitted_by FROM c_revisions WHERE claim_id=? ORDER BY revision DESC LIMIT 1').bind(claim.held_from).first<{ submitted_by: string }>();
  requireThat(original, 'Original claim missing', 409);
  const at = now(), total = reimbursableMinor(items), onBehalfOf = actor.delegate ? actor.email : claim.on_behalf_of, by = actor.delegate?.email ?? actor.email;
  const reason = override ?? optionalText(b.reason, 'Reason', 1000);
  const evidenced=await evidencedPolicyReview(db,items,exceptions,active,claim.employee_email,claim.currency);
  const snapshot = { receiptSignals: await receiptSignals(db, claim.id, bucket), policyReview: evidenced.review, policyVersion: active.version, title: claim.title, approver: claim.approver_email, onBehalfOf, currency: claim.currency, total_minor: total, exceptions, released: { by, reason }, items: items.map(({ receipt_sha256, receipt_name, receipt_media, receipt_size, ...item }) => ({ ...item, receipt: item.receipt_id ? { id: item.receipt_id, name: receipt_name, sha256: receipt_sha256, size: receipt_size, media_type: receipt_media } : null })) };
  await commit(db, all(authority(actor, 'manager'), checked.guard, evidenced.guard, ...cardGuards, policyStill(active.version, business.timezone,claim.entity_id), claimState(claim.id, claim.version, ['returned'])), [
    db.prepare('INSERT INTO c_revisions(claim_id,revision,submitted_by,submitted_at,total_minor,snapshot) VALUES(?,1,?,?,?,?)').bind(claim.id, original.submitted_by, at, total, JSON.stringify(snapshot)),
    db.prepare("INSERT INTO c_decisions(id,claim_id,revision,decision,reason,actor_email,at,exceptions,on_behalf_of) VALUES(?,?,1,'approved',?,?,?,?,?)").bind(uid(), claim.id, reason, by, at, JSON.stringify(exceptions), onBehalfOf),
    db.prepare("UPDATE c_claims SET status='approved',revision=1,total_minor=?,version=version+1,updated_at=? WHERE id=?").bind(total, at, claim.id),
    auditSample(db, claim.id, 1),
    event(db, actor, 'hold-released', { claim: claim.id }, { revision: 1, reason, preApprovalOverride: override, totalMinor: total, exceptionsAcknowledged: exceptions.length, onBehalfOf }),
  ]);
  return loadClaim(db, id);
}
