import { all, commit, type Sql } from './session';
import { needRow, rowAuthority } from './permissions';
import { event } from './events';
import { amount, email, now, requireThat, text, type Actor, type Data } from './types';

/** `manager` is the employee's approving manager, `department-head` the head of the employee's department and
 * `managers-manager` the approving manager of that manager (ADMIN-001 hierarchy); all are resolved when the claim is submitted. */
export type Reviewer = { kind: 'manager' | 'named' | 'finance' | 'department-head' | 'managers-manager' | 'projectOwner'; email?: string };
const HIERARCHY = ['manager', 'department-head', 'managers-manager', 'projectOwner'];
export type WorkflowRule = { label: string; condition: { kind: 'always' | 'amount' | 'category' | 'project' | 'exception' | 'spend-request' | 'department'; value: string }; stages: Reviewer[][] };
export type Workflow = { version: number; rules: WorkflowRule[] };
export async function currentWorkflow(db: D1Database): Promise<Workflow | null> {
 const row = await db.prepare('SELECT version,rules FROM c_approval_workflows ORDER BY version DESC LIMIT 1').first<{version:number;rules:string}>();
 return row ? {version:row.version,rules:JSON.parse(row.rules)} : null;
}
export const workflowState = (version: number): Sql => ({sql:'COALESCE((SELECT MAX(version) FROM c_approval_workflows),0)=?',params:[version]});
export async function saveWorkflow(db: D1Database, actor: Actor, b: Data) {
 needRow(actor,'settings');
 requireThat(actor.kind==='person','Only a person configures approval workflows',403);
 const current=await currentWorkflow(db);
 requireThat(b.version===(current?.version??0),'Workflow changed; reload before saving',409);
 requireThat(Array.isArray(b.rules)&&b.rules.length<=20,'Use at most 20 workflow rules');
 const rules: WorkflowRule[]=[];
 for(const input of b.rules) {
  const label=text(input.label,'Rule name',100), c=input.condition;
  requireThat(c&&['always','amount','category','project','exception','spend-request','department'].includes(c.kind),'Choose a workflow condition');
  const value=['amount','category','project','department'].includes(c.kind)?text(c.value,'Condition value',200):'';
  if(c.kind==='amount') amount(value,'Amount');
  if(c.kind==='department') requireThat(await db.prepare('SELECT 1 FROM c_departments WHERE id=? AND active=1').bind(value).first(),'Choose an active department');
  if(c.kind==='category') requireThat(await db.prepare('SELECT 1 FROM c_categories WHERE id=? AND active=1').bind(value).first(),'Choose an active category');
  requireThat(Array.isArray(input.stages)&&input.stages.length>0&&input.stages.length<=10,'Use one to ten stages per rule');
  const stages: Reviewer[][]=[];
  for(const stage of input.stages) {
   requireThat(Array.isArray(stage)&&stage.length>0&&stage.length<=10,'Use one to ten reviewers per stage');
   const reviewers:Reviewer[]=[];
   for(const r of stage) {
    requireThat(['manager','named','finance','department-head','managers-manager','projectOwner'].includes(r.kind),'Choose manager, department head, manager\'s manager, project owner, named manager or finance reviewer');
    if(HIERARCHY.includes(r.kind)) reviewers.push({kind:r.kind});
    else {
     const address=email(r.email,'Reviewer');
     requireThat(await db.prepare(`SELECT 1 FROM c_members WHERE email=? AND active=1 AND ${r.kind==='finance'?'is_finance':'is_manager'}=1`).bind(address).first(),'Choose an active reviewer with the matching role');
     reviewers.push({kind:r.kind,email:address});
    }
   }
   requireThat(new Set(reviewers.map(r=>`${r.kind}:${r.email??''}`)).size===reviewers.length,'Each reviewer appears once per parallel stage');
   stages.push(reviewers);
  }
  rules.push({label,condition:{kind:c.kind,value},stages});
 }
 const version=(current?.version??0)+1;
 await commit(db,all(rowAuthority(actor,'settings'),workflowState(version-1)),[
  db.prepare('INSERT INTO c_approval_workflows(version,rules,created_by,created_at) VALUES(?,?,?,?)').bind(version,JSON.stringify(rules),actor.delegate?.email??actor.email,now()),
  event(db,actor,'approval-workflow-saved',{}, {version,rules}),
 ]);
 return {version,rules};
}
