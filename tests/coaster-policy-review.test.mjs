// AGENT-005 advisory slice: real native sessions, Worker and D1 public doors.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness, receipt } from './harness.mjs'

async function cardReviewSetup(h){
 const t=await agency(h);await h.post('settings/business',{name:'Synthetic Coaster',currency:'USD',timezone:'America/New_York',receiptThreshold:''});
 await h.post('statements/cards',{issuer:'Synthetic Coaster',last4:'1111',employee:'sam@harbourfinch.example'});
 const rule=await h.get('coding/automatic/rules',t.morgan);
 await h.post('coding/automatic/rules',{version:rule.version,scope:'finance',merchant:'Lunch',coding:{category:t.c.meals},active:true},t.morgan);
 return t;
}
async function cardOriginal(h,t,id,merchant,total,read=false,date='2026-10-02'){
 const form=new FormData(),body=Buffer.concat([await readFile(`tests/fixtures/policy-review/synthetic-coaster-${merchant==='Lunch'?(date==='2026-10-02'?6001:6003):6002}.png`),Buffer.from('\n'+id)]);
 form.append('file',new Blob([body]),id+'.png');form.append('source','upload');
 const req=new Request(h.origin+'/api/coaster/receipt-inbox',{method:'POST',headers:{origin:h.origin,cookie:t.sam},body:form});
 const r=await h.mf.dispatchFetch(req.url,{method:'POST',headers:Object.fromEntries(req.headers),body:await req.arrayBuffer()});assert.equal(r.status,200);const original=(await r.json()).receipt;
 if(read)await h.post(`receipt-inbox/${original.id}/reading`,{expectedSequence:0,expectedReadingSequence:0,consent:true},t.sam);
 const current=(await h.get('receipt-inbox',t.sam)).receipts.find(r=>r.id===original.id);
 await h.post(`receipt-inbox/${original.id}/card-match`,{expectedSequence:current.lifecycleSequence,enabled:true,merchant,date,total,currency:'USD',notice:current.matchChoice.notice},t.sam);
 return original;
}
const lunchReading=(date='2026-10-02')=>{
 const region=[{page:1,x:.1,y:.1,width:.5,height:.1}],values={merchant:'Lunch',date,total:'60.00',subtotal:'60.00',salesTax:'0.00',tip:'0.00',currency:'USD',last4:'1111',lineItems:[{description:'Meal',quantity:1,amount:'60.00',confidence:.99,regions:region}]};
 const fields=Object.fromEntries(Object.entries(values).map(([k,value])=>[k,{value,confidence:.99,regions:region}]));
 return Response.json({status:'completed',model:'synthetic-coaster-6101',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(fields)}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}});
};

test('AGENT-005 a fully evidenced reimbursable lunch completes once on the owner behalf and its accounting line retains the agent and envelope version',async()=>{
 const h=await harness({bindings:{AI_ENABLED:'true',AI_API_KEY:'synthetic-coaster-6300'},aiEdge:async()=>lunchReading()});
 try{
 const t=await cardReviewSetup(h);
 const granted=await h.post('settings/approval-envelope',{version:0,enabled:true,limit:'100.00',consent:true});await h.post('settings/audit-sample',{percent:'100'},t.morgan);
 await h.post('settings/receipt-reading',{version:0,enabled:true,threshold:.95,model:'synthetic-coaster-6301',consent:true});
 const r=await cardOriginal(h,t,'synthetic-coaster-6302','Lunch','60.00',true);
 let c=await h.post('claims',{title:'Synthetic compliant out-of-pocket lunch'},t.sam);
 c=await h.post(`claims/${c.id}/items`,{version:c.version,kind:'receipt',date:'2026-10-02',merchant:'Lunch',amount:'60.00',category:t.c.meals},t.sam);
 let d=await h.get(`claims/${c.id}`,t.sam);const inbox=(await h.get('receipt-inbox',t.sam)).receipts.find(o=>o.id===r.id);
 c=(await h.post(`receipt-inbox/${r.id}/attach`,{expectedSequence:inbox.lifecycleSequence,claimId:c.id,itemId:d.items[0].id,version:c.version},t.sam)).claim;
 c=await h.post(`claims/${c.id}/submit`,{version:c.version},t.sam);assert.equal(c.status,'approved');assert.equal(c.total_minor,6000);
 await h.post(`claims/${c.id}/submit`,{version:c.version},t.sam,409);
 d=await h.get(`claims/${c.id}`,t.morgan);assert.equal(d.decisions.length,1);assert.equal(d.decisions[0].actor_email,`policy agent v${granted.version}`);assert.equal(d.decisions[0].on_behalf_of,'owner@harbourfinch.example');assert.equal((await h.get('exceptions',t.morgan)).samples.length,1);
 const lines=(await h.get('history?q=policy-agent-expense-approved',t.morgan)).lines;assert.equal(lines.length,1);assert.equal(lines[0].channel,'agent');
 const batch=await h.post('batches',{claims:[c.id]},t.morgan),exported=await h.get(`batches/${batch.id}`,t.morgan);assert.equal(batch.total_minor,6000);assert.equal(exported.lines[0].approver,`policy agent v${granted.version}`);assert.equal(exported.lines[0].amountMinor,6000);
 const frozen=d.revisions[0].snapshot;await h.post(`claims/${c.id}/unapprove`,{version:(await h.get(`claims/${c.id}`,t.morgan)).claim.version,to:'approver',reason:'Human check requested'},t.morgan);
 const reopened=await h.get(`claims/${c.id}`,t.priya);assert.deepEqual(reopened.revisions[0].snapshot,frozen);assert.deepEqual(reopened.revisions.at(-1).snapshot.expenseApprovals,[],'unapproval removes authority from the reopened revision without changing the earlier evidence');
 const recommendation=reopened.revisions.at(-1).snapshot.policyReview.recommendations[0];
 await h.post(`claims/${c.id}/policy-review-feedback`,{version:reopened.claim.version,revision:reopened.claim.revision,item:recommendation.item,agree:true},t.priya);
 assert.equal((await h.get('state',t.priya)).reviewerAgreement.agreed,1);
 // The reopened revision needs a human; payment is still reviewed and released.
 const human=await h.post(`claims/${c.id}/decision`,{version:reopened.claim.version,revision:reopened.claim.revision,decision:'approved'},t.priya);
 let paidBatch=await h.post('batches',{claims:[human.id]},t.morgan);
 await h.post(`batches/${paidBatch.id}/paid`,{version:paidBatch.version,reference:'Early',paidOn:'2026-10-03'},t.morgan,409);
 paidBatch=await h.post(`batches/${paidBatch.id}/approve`,{version:paidBatch.version,expectedTotal:6000},t.morgan);
 await h.paid(paidBatch.id,paidBatch.version,{reference:'Human release',paidOn:'2026-10-03'},t.morgan);
 assert.equal((await h.get(`claims/${c.id}`,t.sam)).claim.status,'reimbursed');
 const envelope=(await h.get('state')).approvalEnvelope;
 await h.post('settings/approval-envelope',{version:envelope.version,enabled:false});
 const next=await h.post('claims',{title:'After revocation'},t.sam);
 const expense=await h.post(`claims/${next.id}/items`,{version:next.version,kind:'receipt',date:'2026-10-03',merchant:'Lunch',amount:'60.00',category:t.c.meals,explanation:'Manual review'},t.sam);
 assert.equal((await h.post(`claims/${expense.id}/submit`,{version:expense.version},t.sam)).status,'submitted');
 }finally{await h.close()}
})
