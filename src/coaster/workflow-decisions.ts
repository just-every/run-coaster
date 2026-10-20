import { all, authority, commit } from './session';
import { event } from './events';
import { claimState, loadClaim, type Claim } from './claims';
import { approveWithHold } from './holds';
import { preApprovalOverride } from './requests';
import { requireBusiness } from './settings';
import { auditSample } from './audit-queue';
import { nextWorkflow, tasksFor, type Plan } from './workflow-routing';
import { now, optionalText, requireThat, uid, type Actor, type Data } from './types';

/** Only a frozen, assigned task grants authority; finance role alone never grants a decision. */
export async function decideWorkflowClaim(db:D1Database,actor:Actor,claim:Claim,b:Data,plan:Plan,snapshot:Data) {
 requireThat(actor.kind==='person','Only a person decides a claim',403);
 requireThat(claim.employee_email!==actor.email&&claim.employee_email!==actor.delegate?.email,'Nobody approves their own claim',403);
 requireThat(claim.status==='submitted','This claim is not waiting for a decision',409);
 requireThat(b.version===claim.version&&b.revision===claim.revision,'The claim changed since you opened it; reload and review it again',409);
 requireThat(['approved','returned','rejected'].includes(b.decision),'Choose approve, return or reject');
 const route=await nextWorkflow(db,'claim',claim.id,claim.revision,plan,actor.email,claim.employee_email,(await requireBusiness(db)).timezone,b.decision==='approved');
 requireThat(actor.roles[route.task.role],'The reviewer role is no longer held',403);
 const reason=optionalText(b.reason,'Reason',1000);
 requireThat(b.decision==='approved'||reason,'Give a reason to return or reject');
 const exceptions=snapshot.exceptions??[],approved=b.decision==='approved';
 if(approved&&Array.isArray(b.hold)&&b.hold.length){
  requireThat(route.final,'Partial approval is available only after all other workflow reviews',409);
  return approveWithHold(db,actor,claim,b,snapshot,{sql:'EXISTS(SELECT 1 FROM c_workflow_tasks WHERE kind=\'claim\' AND record_id=? AND revision=? AND slot=? AND email=? AND status=\'waiting\')',params:[claim.id,claim.revision,route.task.slot,actor.email]},route.task);
 }
 requireThat(!approved||!exceptions.length||b.acknowledge===true,'Review and acknowledge the policy exceptions before approving',409);
 const override=approved?preApprovalOverride(exceptions,b):null,at=now(),onBehalfOf=actor.delegate?actor.email:route.task.on_behalf_of;
 await commit(db,all(authority(actor,route.task.role),claimState(claim.id,claim.version,['submitted']),...route.guards),[
  db.prepare('INSERT INTO c_decisions(id,claim_id,revision,decision,reason,actor_email,at,exceptions,on_behalf_of,decision_step,workflow_final) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(uid(),claim.id,claim.revision,b.decision,override??reason,actor.delegate?.email??actor.email,at,JSON.stringify(exceptions),onBehalfOf,route.task.slot,approved&&route.final?1:0),
  ...(approved?route.writes:[]),
  db.prepare('UPDATE c_claims SET status=?,approver_email=?,on_behalf_of=?,version=version+1,updated_at=? WHERE id=?').bind(approved&&!route.final?'submitted':b.decision,approved?route.next?.email??claim.approver_email:claim.approver_email,approved?route.next?.on_behalf_of??null:claim.on_behalf_of,at,claim.id),
  ...(approved&&route.final?[auditSample(db,claim.id,claim.revision)]:[]),
  event(db,actor,approved&&!route.final?'claim-step-approved':`claim-${b.decision}`,{claim:claim.id},{revision:claim.revision,slot:route.task.slot,stage:route.task.stage,stages:plan.stages.length,nextApprover:route.next?.email??null,onBehalfOf,reason:override??reason,workflowVersion:plan.version}),
 ]);
 return loadClaim(db,claim.id);
}
