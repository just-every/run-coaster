// Preserved native HTTP assertion phases; callers own test registration.
import assert from 'node:assert/strict';
import { agency,harness } from '../harness.mjs';
const P='priya@harbourfinch.example',F='morgan@harbourfinch.example',J='jordan@harbourfinch.example';
const choice=(c,extra={})=>({version:c.version,revision:c.revision,decision:'approved',...extra});
// Original assertion phase: APPROVE-001 frozen workflow lifecycle: delegation, reminders, return/reject, owner reassignment, holds and complete restart after unapproval
export const frozenWorkflowLifecycle = async()=>{
 const h=await harness();
 try{
  const t=await agency(h);
  await h.post('settings/business',{name:'Harbour & Finch Studio',currency:'AUD',timezone:'Australia/Sydney',receiptThreshold:'1000.00'});
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  await h.post('settings/approval-workflow',{version:0,rules:[{label:'Joint review',condition:{kind:'always',value:''},stages:[[{kind:'named',email:J},{kind:'finance',email:F}]]}]});
  const create=async(title)=>{
   let c=await h.post('claims',{title},t.sam);
   for(const [merchant,amount]of [[title+' taxi','20.00'],[title+' supplies','30.00']]) c=await h.post(`claims/${c.id}/items`,{version:c.version,kind:'receipt',date:'2026-06-17',merchant,amount,allocations:[{category:t.c.travel}]},t.sam);
   return h.post(`claims/${c.id}/submit`,{version:c.version},t.sam);
  };
  const approve=(c,cookie,extra={})=>h.post(`claims/${c.id}/decision`,choice(c,extra),cookie);
  let c=await create('Delegated travel');
  await h.post('delegates',{delegate:'sam@harbourfinch.example',level:'full'},t.priya);
  assert.equal((await h.send(`/api/coaster/claims/${c.id}/decision`,choice(c),t.sam,{'x-coaster-acting-for':P})).status,403,'a full delegate never approves their own expense');
  await h.post('delegations',{approver:J,delegate:P,startsOn:today,endsOn:today});
  c=await approve(c,t.priya);
  assert.deepEqual(c.assigned_emails,[P,F]);
  assert.equal(c.workflow_tasks.find(x=>x.email===P&&x.stage===1).on_behalf_of,J);
  // Starting another delegation leaves active task assignments unchanged.
  await h.post('delegations',{approver:P,delegate:J,startsOn:today,endsOn:today});
  assert.deepEqual((await h.get(`claims/${c.id}`,t.sam)).claim.assigned_emails,[P,F]);
  const worker=await h.mf.getWorker();
  await worker.scheduled({scheduledTime:new Date('2026-06-22T00:17:00Z'),cron:'17 * * * *'});
  await worker.scheduled({scheduledTime:new Date('2026-06-25T00:17:00Z'),cron:'17 * * * *'});
  const reminders=h.messages.filter(m=>m.subject.startsWith('Reminder: Decide'));
  assert.ok(reminders.some(m=>m.to.includes(P))&&reminders.some(m=>m.to.includes(F)),'both waiting parallel reviewers are chased');
  await h.post(`claims/${c.id}/decision`,choice(c,{hold:[(await h.get(`claims/${c.id}`,t.sam)).items[1].id],reason:'Need receipt'}),t.priya,409);
  c=await approve(c,t.morgan);
  const item=(await h.get(`claims/${c.id}`,t.sam)).items[1];
  c=await approve(c,t.priya,{hold:[item.id],reason:'Need receipt'});
  assert.equal(c.status,'approved');assert.equal(c.total_minor,2000);
  const held=(await h.get('state',t.sam)).claims.find(x=>x.title.endsWith('(held)'));
  await h.post(`claims/${held.id}/release`,{version:held.version},t.priya,409);
  let resubmitted=await h.post(`claims/${held.id}/submit`,{version:held.version},t.sam);
  assert.equal(resubmitted.status,'submitted');
  // Unapproval reopens the frozen plan, even after the owner removes future rules.
  await h.post('settings/approval-workflow',{version:1,rules:[]});
  let reopened=await h.post(`claims/${c.id}/unapprove`,{version:c.version,to:'approver',reason:'Review travel again'},t.morgan);
  assert.equal(reopened.status,'submitted');
  assert.equal(reopened.assigned_emails.length,1);
  reopened=await approve(reopened,t.jordan); // first frozen manager, delegated on activation
  assert.deepEqual(reopened.assigned_emails,[P,F]);
  reopened=await approve(reopened,t.morgan);reopened=await approve(reopened,t.priya);
  assert.equal(reopened.status,'approved');
  const before=h.messages.length;
  await worker.scheduled({scheduledTime:new Date('2026-06-30T00:17:00Z'),cron:'17 * * * *'});
  assert.ok(!h.messages.slice(before).some(m=>m.subject.startsWith('Reminder: Decide')&&m.text.includes('Delegated travel”')),'completed workflow stops reminders');
  // Frozen held revision still has its full workflow after config changes.
  resubmitted=await approve(resubmitted,t.jordan);
  resubmitted=await h.post(`claims/${resubmitted.id}/decision`,choice(resubmitted,{decision:'returned',reason:'Please attach receipt'}),t.priya);
  assert.equal(resubmitted.status,'returned');
  await h.post(`claims/${resubmitted.id}/decision`,choice(resubmitted),t.morgan,409);
  // Owner reassigns only the chosen task, preserving later reviews and history.
  await h.post('settings/approval-workflow',{version:2,rules:[{label:'Finance review',condition:{kind:'always',value:''},stages:[[{kind:'finance',email:F}]]}]});
  let other=await create('Reassigned travel');
  other=await h.post(`claims/${other.id}/reassign`,{version:other.version,approver:P,reason:'Manager away'});
  other=await approve(other,t.priya);
  assert.deepEqual(other.assigned_emails,[F]);
  other=await h.post(`claims/${other.id}/reassign`,{version:other.version,approver:J,reason:'Finance away'});
  other=await h.post(`claims/${other.id}/decision`,choice(other,{decision:'rejected',reason:'Not business spend'}),t.jordan);
  assert.equal(other.status,'rejected');
  const events=(await h.get(`claims/${other.id}`,t.sam)).events;
  assert.equal(events.filter(e=>e.action==='claim-reassigned').length,2);
  let request=await h.post('requests',{title:'Conference booking',estimate:'200.00'},t.sam);
  request=await h.post(`requests/${request.id}/reassign`,{version:request.version,approver:P,reason:'Available reviewer'});
  request=await h.post(`requests/${request.id}/decision`,{version:request.version,decision:'approved'},t.priya);
  assert.deepEqual(request.assigned_emails,[F]);
  request=await h.post(`requests/${request.id}/reassign`,{version:request.version,approver:J,reason:'Finance cover'});
  request=await h.post(`requests/${request.id}/decision`,{version:request.version,decision:'rejected',reason:'Canceled trip'},t.jordan);
  assert.equal(request.status,'rejected');
  let moving=await create('Manager deactivated');
  await h.post('settings/members',{email:J,name:'Jordan',manager:true,finance:true,employee:true,approver:P});
  await h.post('settings/members',{email:J,name:'Jordan',manager:true,finance:true,employee:true,approver:P,active:false});
  moving=(await h.get(`claims/${moving.id}`,t.sam)).claim;
  assert.deepEqual(moving.assigned_emails,[P]);
  assert.ok(moving.version>1,'moving an active task invalidates stale views');
  await h.post(`claims/${moving.id}/decision`,choice(moving),t.jordan,403);

 }finally{await h.close();}
}

export async function preserveWorkflowLifecycle() {
  await frozenWorkflowLifecycle()
}
