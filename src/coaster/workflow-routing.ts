import { requireEntityMember } from './entities';
import { projectOwners } from './coding/project-owners';
import { configuredChain } from './approval-chain';
import { currentWorkflow, workflowState, type Reviewer } from './workflow-configuration';
import { localDay, routeFor } from './delegation';
import { type Sql } from './session';
import { amount, requireThat, type Data } from './types';

export type Task = {kind:'claim'|'request';record_id:string;revision:number;slot:number;stage:number;email:string;on_behalf_of:string|null;role:'manager'|'finance';status:'waiting'|'approved'};
export type Plan = {version:number; stages:Reviewer[][]; matched:string[]};
export async function workflowPlan(db:D1Database,employee:string,total:number,items:Data[],exceptions:Data[],request=false,entityId='primary') {
 const workflow=await currentWorkflow(db,entityId);
 if(!workflow?.rules.length) return null;
 const configured=await configuredChain(db,employee,entityId);
 const member=await db.prepare('SELECT m.approver_email,m.department_id,(SELECT a.approver_email FROM c_members a WHERE a.email=m.approver_email AND a.active=1) AS managers_manager,(SELECT d.head_email FROM c_departments d WHERE d.id=m.department_id AND d.active=1) AS department_head FROM c_members m WHERE m.email=? AND m.active=1').bind(employee).first<{approver_email:string;department_id:string|null;managers_manager:string|null;department_head:string|null}>();
 const stages:Reviewer[][]=configured.chain?configured.chain.steps.map(s=>[{kind:'named',email:s.email}]):[[{kind:'manager'}]];
 const matched:string[]=[];
 for(const rule of workflow.rules) {
  const c=rule.condition;
  const match=c.kind==='always'||c.kind==='amount'&&total>amount(c.value,'Amount')||c.kind==='exception'&&exceptions.length>0||c.kind==='category'&&items.some(i=>i.allocations?.some((a:Data)=>a.category_id===c.value))||c.kind==='project'&&items.some(i=>i.project===c.value||i.codingSnapshot?.some((v:Data)=>v.kind==='project'&&v.id===c.value))||c.kind==='spend-request'&&(request||items.some(i=>i.request_id))||c.kind==='department'&&!!member?.department_id&&member.department_id===c.value;
  if(match){stages.push(...rule.stages);matched.push(rule.label);}
 }
 const guards:Sql[]=[workflowState(workflow.version,entityId),...configured.guards];
 const frozen:Reviewer[][]=[];
 for(const stage of stages){
  const reviewers:Reviewer[]=[];
  const expanded:Reviewer[]=[];
  for(const reviewer of stage) {
   if(reviewer.kind==='projectOwner') {
    const resolved=await projectOwners(db,items); guards.push(resolved.guard);
    expanded.push(...resolved.owners.map(address=>({kind:'named' as const,email:address})));
   } else expanded.push(reviewer);
  }
  for(const r of expanded){
   const address=r.kind==='manager'?member?.approver_email:r.kind==='department-head'?member?.department_head:r.kind==='managers-manager'?member?.managers_manager:r.email;
   requireThat(address||!['department-head','managers-manager'].includes(r.kind),r.kind==='department-head'?'The employee\'s department has no active head; ask the owner to set one':'The employee\'s approving manager has no manager; ask the owner to correct the hierarchy',409);
   requireThat(address&&address!==employee,'Nobody approves their own claim or spend request; ask the owner to correct the workflow',409);
   if(r.kind==='department-head') guards.push({sql:'EXISTS(SELECT 1 FROM c_members m JOIN c_departments d ON d.id=m.department_id AND d.active=1 WHERE m.email=? AND d.head_email=?)',params:[employee,address]});
   if(r.kind==='managers-manager') guards.push({sql:'EXISTS(SELECT 1 FROM c_members m JOIN c_members a ON a.email=m.approver_email AND a.active=1 WHERE m.email=? AND a.approver_email=?)',params:[employee,address]});
   const role=r.kind==='finance'?'finance':'manager';
   const guard={sql:`EXISTS(SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_${role}=1)`,params:[address]};
   requireThat(await db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.params).first(),'Every workflow reviewer must be active with the matching role',409);
   guards.push(guard,await requireEntityMember(db,entityId,address));reviewers.push({kind:r.kind==='finance'?'finance':'named',email:address});
  }
  requireThat(new Set(reviewers.map(r=>r.email)).size===reviewers.length,'Parallel reviewers resolve to the same person; ask the owner to correct the workflow',409);
  frozen.push(reviewers);
 }
 guards.push({sql:'EXISTS(SELECT 1 FROM c_members WHERE email=? AND approver_email IS ? AND department_id IS ? AND active=1)',params:[employee,member?.approver_email??null,member?.department_id??null]});
 return {plan:{version:workflow.version,stages:frozen,matched},guards};
}
export async function resolveStage(db:D1Database,reviewers:Reviewer[],employee:string,timezone:string) {
 const tasks:Omit<Task,'kind'|'record_id'|'revision'|'slot'|'stage'>[]=[],guards:Sql[]=[];
 for(const reviewer of reviewers){
  const m=reviewer.kind==='manager'?await db.prepare('SELECT approver_email FROM c_members WHERE email=? AND active=1').bind(employee).first<{approver_email:string}>():null;
  const original=reviewer.email??m?.approver_email;
  requireThat(original&&original!==employee,'The workflow needs an active reviewer other than the employee; ask the owner to correct it',409);
  const role=reviewer.kind==='finance'?'finance':'manager';
  const route=await routeFor(db,original,employee,localDay(timezone),role);
  requireThat(!tasks.some(t=>t.email===route.approver),'Parallel reviewers resolve to the same person; ask the owner to correct the workflow',409);
  const guard={sql:`EXISTS(SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_${role}=1)`,params:[route.approver]};
  requireThat(await db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.params).first(),'A workflow reviewer is inactive or no longer has the required role; ask the owner to reassign',409);
  guards.push(guard);tasks.push({email:route.approver,on_behalf_of:route.onBehalfOf,role,status:'waiting'});
 }
 return {tasks,guards};
}
export function insertTasks(db:D1Database,kind:'claim'|'request',id:string,revision:number,stage:number,slot:number,tasks:Awaited<ReturnType<typeof resolveStage>>['tasks']) {
 return tasks.map((t,i)=>db.prepare('INSERT INTO c_workflow_tasks(kind,record_id,revision,slot,stage,email,on_behalf_of,role) VALUES(?,?,?,?,?,?,?,?)').bind(kind,id,revision,slot+i,stage,t.email,t.on_behalf_of,t.role));
}
export const tasksFor=async(db:D1Database,kind:string,id:string,revision:number)=>(await db.prepare('SELECT * FROM c_workflow_tasks WHERE kind=? AND record_id=? AND revision=? ORDER BY slot').bind(kind,id,revision).all<Task>()).results;
export const assigned=(tasks:Task[],email:string)=>tasks.some(t=>t.status==='waiting'&&t.email===email);
export async function workflowAccess(db:D1Database,kind:string,id:string,revision:number) {
 const tasks=await tasksFor(db,kind,id,revision);
 return {workflow_tasks:tasks,assigned_emails:tasks.filter(t=>t.status==='waiting').map(t=>t.email),workflow_readers:[...new Set(tasks.flatMap(t=>[t.email,...(t.on_behalf_of?[t.on_behalf_of]:[])]))]};
}
/** Frozen plan lives in the immutable revision; tasks capture each activated stage's actual delegation. */
export async function nextWorkflow(db:D1Database,kind:'claim'|'request',id:string,revision:number,plan:Plan,actor:string,employee:string,timezone:string, advance=true) {
 const tasks=await tasksFor(db,kind,id,revision),active=tasks.filter(t=>t.status==='waiting');
 const task=active.find(t=>t.email===actor);
 requireThat(task,'This record is waiting for another reviewer',403);
 const remaining=active.filter(t=>t!==task),stage=task.stage+1;
 const resolved=advance&&remaining.length===0&&stage<plan.stages.length?await resolveStage(db,plan.stages[stage],employee,timezone):null;
 const next=remaining[0]??resolved?.tasks[0]??null;
 if(kind==='claim'&&resolved){const claim=await db.prepare('SELECT entity_id FROM c_claims WHERE id=?').bind(id).first<{entity_id:string}>();for(const t of resolved.tasks)resolved.guards.push(await requireEntityMember(db,claim!.entity_id,t.email));}
 return {task,next,final:!next,guards:resolved?.guards??[],writes:[db.prepare("UPDATE c_workflow_tasks SET status='approved' WHERE kind=? AND record_id=? AND revision=? AND slot=?").bind(kind,id,revision,task.slot),...(resolved?insertTasks(db,kind,id,revision,stage,tasks.length,resolved.tasks):[])]};
}
