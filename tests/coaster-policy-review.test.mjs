// AGENT-005 advisory slice: real native sessions, Worker and D1 public doors.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { agency, harness, receipt } from './harness.mjs'

test('AGENT-005 submission freezes cited per-expense recommendations without granting approval authority or widening claim visibility', async () => {
  const h = await harness()
  try {
    const t = await agency(h)
    await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'USD', timezone: 'America/New_York', receiptThreshold: '75.00' })
    const policyVersion = (await h.get('policy', t.morgan)).versions[0].version
    const stranger = await h.person('unrelated-manager@harbourfinch.example', { employee: true, manager: true })
    const auditor = await h.person('audit@harbourfinch.example', { auditor: true })
    let c = await h.post('claims', { title: 'Lunch and dinner policy review' }, t.sam)
    const expected = []
    for (const [merchant, amount, fixture] of [['Lunch', '60.00', 'officeworks'], ['Dinner', '180.00', 'bistro']]) {
      const file = await receipt(fixture)
      const upload = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...file }, t.sam)
      c = await h.post(`claims/${c.id}/items`, {
        version: upload.claim.version, kind: 'receipt', date: '2026-06-16', merchant, amount,
        receipt: upload.receipt, allocations: [{ category: t.c.meals }], explanation: 'Client meeting meal',
      }, t.sam)
      expected.push({ receipt: { id: upload.receipt, sha256: createHash('sha256').update(Buffer.from(file.base64, 'base64')).digest('hex') }, amountMinor: Number(amount) * 100 })
    }
    const networkBefore = h.outbound.length
    c = await h.post(`claims/${c.id}/submit`, { version: c.version }, t.sam)
    assert.equal(c.status, 'submitted', 'recommendations grant no automatic approval')
    let detail = await h.get(`claims/${c.id}`, t.priya)
    const original = detail.revisions[0].snapshot.policyReview
    assert.equal(original.method, 'deterministic-policy-review')
    assert.equal(original.policyVersion, policyVersion)
    assert.equal(original.recommendations.length, 2)
    assert.deepEqual(original.recommendations.map(r => r.recommendation), ['no-policy-exception', 'review'])
    const [lunch, dinner] = original.recommendations
    assert.ok(lunch.reasons.some(r => r.code === 'no-policy-exception' && r.policy === policyVersion && /advice grants no approval/i.test(r.message)))
    assert.deepEqual(dinner.reasons, detail.exceptions.filter(e => e.item === dinner.item).map(({ code, message, policy }) => ({ code, message, ...(policy === undefined ? {} : { policy }) })))
    assert.ok(dinner.reasons.some(r => r.code === 'over-limit' && r.policy === policyVersion))
    for (const [index, review] of original.recommendations.entries()) {
      assert.equal(review.item, detail.items[index].id)
      assert.deepEqual(review.evidence.receipt, expected[index].receipt)
      assert.equal(review.evidence.amountMinor, expected[index].amountMinor)
      assert.equal(review.evidence.date, '2026-06-16')
      assert.deepEqual(review.evidence.allocations, [{ category: t.c.meals, amountMinor: expected[index].amountMinor }])
      assert.equal(review.evidence.requestId, null)
      assert.deepEqual(review.evidence.checksUnavailable, ['receipt-content', 'card-match', 'coding-confidence'])
    }
    assert.equal(detail.decisions.length, 0)
    for (const cookie of [t.sam, t.morgan, auditor, h.owner]) {
      assert.deepEqual((await h.get(`claims/${c.id}`, cookie)).revisions[0].snapshot.policyReview, original)
    }
    await h.get(`claims/${c.id}`, t.alex, 403)
    await h.get(`claims/${c.id}`, stranger, 403)
    const key = await h.post('agent-keys', { label: 'Personal drafting agent' }, t.sam)
    const headers = { authorization: `Bearer ${key.token}` }
    assert.equal((await h.send(`/api/coaster/claims/${c.id}`, undefined, '', headers)).status, 401)
    assert.equal((await h.send(`/api/coaster/claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved' }, '', headers)).status, 401)
    await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved' }, t.priya, 409)
    c = await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'returned', reason: 'Please check the dinner details' }, t.priya)
    await h.post('settings/categories', { id: t.c.meals, name: 'Meals', accountCode: '6300', taxCode: 'GST', limit: '250.00' })
    c = await h.post(`claims/${c.id}/submit`, { version: c.version }, t.sam)
    detail = await h.get(`claims/${c.id}`, t.priya)
    assert.deepEqual(detail.revisions[0].snapshot.policyReview, original, 'return and resubmission never rewrite old evidence')
    const latest = detail.revisions.at(-1).snapshot.policyReview
    assert.ok(latest.policyVersion > policyVersion)
    assert.deepEqual(latest.recommendations.map(r => r.recommendation), ['no-policy-exception', 'no-policy-exception'])
    assert.equal(detail.claim.status, 'submitted')
    const approved = await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved', hold: [dinner.item], reason: 'Confirm dinner evidence' }, t.priya)
    const kept = await h.get(`claims/${c.id}`, t.priya)
    assert.deepEqual(kept.revisions.at(-1).snapshot.policyReview.recommendations.map(r => r.item), [lunch.item], 'partial approval carries only retained-expense advice')
    assert.deepEqual(kept.revisions[0].snapshot.policyReview, original)
    const held = await h.get(`claims/${kept.events.find(e => e.action === 'claim-split').detail.heldClaim}`, t.sam)
    const released = await h.post(`claims/${held.claim.id}/release`, { version: held.claim.version }, t.priya)
    const releasedReview = (await h.get(`claims/${released.id}`, t.priya)).revisions[0].snapshot.policyReview
    assert.deepEqual(releasedReview.recommendations.map(r => r.item), [dinner.item], 'hold release records current-policy advice for the held expense')
    assert.equal(approved.status, 'approved'); assert.equal(released.status, 'approved')
    assert.equal(h.outbound.length, networkBefore, 'review and decisions make no external requests')
  } finally { await h.close() }
})

async function cardReviewSetup(h){
 const t=await agency(h);await h.post('settings/business',{name:'Synthetic Coaster',currency:'USD',timezone:'America/New_York',receiptThreshold:''});
 await h.post('statements/cards',{issuer:'Synthetic Coaster',last4:'1111',employee:'sam@harbourfinch.example'});
 const rule=await h.get('coding/automatic/rules',t.morgan);
 await h.post('coding/automatic/rules',{version:rule.version,scope:'finance',merchant:'Lunch',coding:{category:t.c.meals},active:true},t.morgan);
 return t;
}
async function cardFile(h,t,rows,name='synthetic-coaster-6100.csv'){
 let b={format:'csv',name,issuer:'Synthetic Coaster',category:t.c.meals,content:'Date,Merchant,Amount,Id\n'+rows.map(([merchant,amount,id,date='2026-10-02'])=>`${date},${merchant},${amount},${id}`).join('\n'),mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',transactionId:'Id',wholeFileLast4:'1111'}};
 let p=await h.post('statements/preview',b,t.morgan);
 if(p.possibleDuplicates.length){b={...b,includeRows:p.possibleDuplicates.map(r=>r.id)};p=await h.post('statements/preview',b,t.morgan);}
 return h.post('statements/commit',{...b,fingerprint:p.fingerprint},t.morgan);
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

test('AGENT-005 owner envelope approves the compliant $60 lunch with receipt/card/coding citations, routes $180 dinner, measures explicit agreement and revokes future authority',async()=>{
 let readingDate='2026-10-02';
 const h=await harness({bindings:{AI_ENABLED:'true',AI_API_KEY:'synthetic-coaster-6102'},aiEdge:async()=>lunchReading(readingDate)});
 try{
 const t=await cardReviewSetup(h),auditor=await h.person('synthetic-coaster-6103@example.test',{auditor:true}),admin=await h.person('synthetic-coaster-6104@example.test',{admin:true});
 const grant={version:0,enabled:true,limit:'100.00',consent:true};
 for(const cookie of [t.sam,t.morgan,t.priya,auditor,admin])await h.post('settings/approval-envelope',grant,cookie,403);
 await h.post('settings/approval-envelope',{...grant,consent:false},undefined,400);
 await h.post('settings/members',{email:'owner@harbourfinch.example',name:'Synthetic Coaster owner',employee:true,approver:'priya@harbourfinch.example'});
 const full=await h.post('delegates',{delegate:'morgan@harbourfinch.example',level:'full'});
 assert.equal((await h.send('/api/coaster/settings/approval-envelope',grant,t.morgan,{'x-coaster-acting-for':'owner@harbourfinch.example'})).status,403,'Full delegation never grants the owner’s agent approval authority');
 await h.post(`delegates/${full.id}/revoke`,{});
 assert.equal((await h.send('/api/coaster/settings/approval-envelope',grant,h.owner,{origin:'https://unrelated.example'})).status,403);
 assert.equal((await h.get('state')).approvalEnvelope,null,'refused consent and authority leave no envelope');
 const envelope=await h.post('settings/approval-envelope',grant);assert.equal(envelope.version,1);
 await h.post('settings/approval-envelope',grant,undefined,409);
 await h.post('settings/receipt-reading',{version:0,enabled:true,threshold:.95,model:'synthetic-coaster-6101',consent:true});
 const a=await cardOriginal(h,t,'synthetic-coaster-6105','Lunch','60.00',true),b=await cardOriginal(h,t,'synthetic-coaster-6106','Dinner','180.00');
 const job=await cardFile(h,t,[['Lunch','60.00','synthetic-coaster-6107'],['Dinner','180.00','synthetic-coaster-6108']]);
 await (await h.mf.getWorker()).scheduled({scheduledTime:Date.now(),cron:'17 * * * *'});
 let d=await h.get(`claims/${job.claims[0]}`,t.sam);assert.equal(d.claim.status,'draft');assert.deepEqual(d.decisions,[]);assert.deepEqual(d.revisions,[]);
 const dinner=d.items.find(i=>i.merchant==='Dinner');
 await h.post(`claims/${d.claim.id}/items`,{version:d.claim.version,item:dinner.id,kind:'receipt',date:dinner.spent_on,merchant:dinner.merchant,amount:'180.00',receipt:dinner.receipt_id,category:t.c.meals,explanation:'Client dinner over the policy limit'},t.sam);
 d=await h.get(`claims/${job.claims[0]}`,t.sam);
 const sent=h.outbound.length,c=await h.post(`claims/${d.claim.id}/submit`,{version:d.claim.version},t.sam);
 assert.equal(c.status,'submitted');d=await h.get(`claims/${c.id}`,t.priya);
 const frozen=d.revisions.at(-1).snapshot,approvals=frozen.expenseApprovals;
 assert.equal(approvals.length,1);assert.equal(approvals[0].item,d.items.find(i=>i.merchant==='Lunch').id);assert.equal(approvals[0].source,'agent');assert.equal(approvals[0].version,1);assert.equal(approvals[0].onBehalfOf,'owner@harbourfinch.example');
 const advice=frozen.policyReview.recommendations.find(r=>r.item===approvals[0].item);assert.equal(advice.evidence.agentEligible,true);assert.equal(advice.evidence.receiptAssessment.method,'retained-reading-agrees');assert.equal(advice.evidence.cardAssessment.matched,true);assert.equal(advice.evidence.codingAssessment.method,'finance-merchant-rule');assert.ok(advice.evidence.codingAssessment.rule);assert.deepEqual(advice.evidence.checksUnavailable,[]);
 assert.ok(frozen.policyReview.recommendations.find(r=>r.item===dinner.id).reasons.some(r=>r.code==='over-limit'));
 assert.equal(h.outbound.length,sent,'policy review makes no new provider call');
 assert.deepEqual((await h.get('state',t.priya)).reviewerAgreement,{method:'explicit-reviewer-feedback',agreed:0,total:0,percent:null},'automatic decisions and unanswered recommendations never count as agreement');
 assert.ok(!JSON.stringify(frozen).includes('fields_json')&&!JSON.stringify(frozen).includes(a.id)&&!JSON.stringify(frozen).includes(b.id),'submitted assessments expose no private original or reading history');
 for(const cookie of [h.owner,t.sam,t.morgan,auditor])await h.post(`claims/${c.id}/policy-review-feedback`,{version:c.version,revision:c.revision,item:approvals[0].item,agree:true},cookie,403);
 await h.post(`claims/${c.id}/policy-review-feedback`,{version:c.version,revision:c.revision,item:approvals[0].item,agree:true},t.priya);
 await h.post(`claims/${c.id}/policy-review-feedback`,{version:c.version,revision:c.revision,item:dinner.id,agree:false},t.priya);
 await h.post(`claims/${c.id}/policy-review-feedback`,{version:c.version,revision:c.revision,item:approvals[0].item,agree:true},t.priya,409);
 assert.deepEqual((await h.get('state',t.priya)).reviewerAgreement,{method:'explicit-reviewer-feedback',agreed:1,total:2,percent:50});assert.equal((await h.get('state',t.morgan)).reviewerAgreement.total,0);
 await h.post('settings/approval-envelope',{version:1,enabled:false,consent:false});
 readingDate='2026-10-03';await cardOriginal(h,t,'synthetic-coaster-6109','Lunch','60.00',true,readingDate);
 const next=await cardFile(h,t,[['Lunch','60.00','synthetic-coaster-6110',readingDate]],'synthetic-coaster-6111.csv');await (await h.mf.getWorker()).scheduled({scheduledTime:Date.now()+3600000,cron:'17 * * * *'});
 let pending=await h.get(`claims/${next.claims[0]}`,t.sam);pending.claim=await h.post(`claims/${pending.claim.id}/submit`,{version:pending.claim.version},t.sam);
 assert.equal(pending.claim.status,'submitted');pending=await h.get(`claims/${pending.claim.id}`,t.priya);assert.equal(pending.revisions.at(-1).snapshot.expenseApprovals,undefined);assert.equal(pending.revisions.at(-1).snapshot.policyReview.recommendations[0].evidence.agentEligible,true,'revocation, not noncompliance, stops the next approval');
 assert.deepEqual((await h.get(`claims/${c.id}`,t.priya)).revisions[0].snapshot,frozen,'revocation never rewrites prior advice or approval');
 const key=await h.post('agent-keys',{label:'synthetic-coaster-6112'},t.sam);assert.equal((await h.send('/api/coaster/settings/approval-envelope',grant,'',{authorization:'Bearer '+key.token})).status,401);
 }finally{await h.close()}
})

test('AGENT-005 low-confidence receipt coding is marked for review and cannot be approved by an active envelope',async()=>{
 let t;
 const h=await harness({bindings:{AI_ENABLED:'true',AI_API_KEY:'synthetic-coaster-6200'},aiEdge:async request=>{
  const body=await request.json();if(body.text.format.name==='receipt_reading')return lunchReading();
  return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({category:{id:t.c.meals,confidence:.2,reason:'Uncertain restaurant context'},dimensions:[],memo:{text:null,confidence:0,reason:'No memo'}})}]}]});
 }});
 try{
 t=await cardReviewSetup(h);
 const rules=await h.get('coding/automatic/rules',t.morgan),rule=rules.rules[0];await h.post('coding/automatic/rules',{version:rules.version,id:rule.id,scope:'finance',merchant:rule.merchant,coding:rule.fields,active:false},t.morgan);
 await h.post('settings/approval-envelope',{version:0,enabled:true,limit:'100.00',consent:true});
 await h.post('settings/receipt-reading',{version:0,enabled:true,threshold:.95,model:'synthetic-coaster-6201',consent:true});
 const r=await cardOriginal(h,t,'synthetic-coaster-6202','Lunch','60.00',true),read=await h.get(`receipt-inbox/${r.id}/reading`,t.sam),context=await h.get(`coding/automatic/suggestions?receipt=${r.id}`,t.sam);
 const source=await h.post(`receipt-inbox/${r.id}/reading/coding`,{expectedSequence:read.lifecycleSequence,expectedReadingSequence:read.sequence,contextVersion:context.contextVersion,consent:true},t.sam);
 assert.equal(source.status,'review');assert.ok(source.reviewFields.includes('category'));assert.equal(source.values.category,undefined,'a low-confidence source never silently settles category');
 const file=await cardFile(h,t,[['Lunch','60.00','synthetic-coaster-6203']]);await (await h.mf.getWorker()).scheduled({scheduledTime:Date.now(),cron:'17 * * * *'});
 let d=await h.get(`claims/${file.claims[0]}`,t.sam);const submitted=await h.post(`claims/${d.claim.id}/submit`,{version:d.claim.version},t.sam);assert.equal(submitted.status,'submitted');
 d=await h.get(`claims/${d.claim.id}`,t.priya);const snapshot=d.revisions[0].snapshot;
 assert.equal(snapshot.expenseApprovals,undefined);assert.equal(snapshot.policyReview.recommendations[0].evidence.codingAssessment.reviewRequired,true);assert.equal(snapshot.policyReview.recommendations[0].evidence.agentEligible,false);assert.deepEqual(d.decisions,[]);
 }finally{await h.close()}
})

test('AGENT-005 a fully evidenced reimbursable lunch completes once on the owner behalf and its accounting line retains the agent and envelope version',async()=>{
 const h=await harness({bindings:{AI_ENABLED:'true',AI_API_KEY:'synthetic-coaster-6300'},aiEdge:async()=>lunchReading()});
 try{
 const t=await cardReviewSetup(h);
 await h.post('settings/approval-envelope',{version:0,enabled:true,limit:'100.00',consent:true});await h.post('settings/audit-sample',{percent:'100'},t.morgan);
 await h.post('settings/receipt-reading',{version:0,enabled:true,threshold:.95,model:'synthetic-coaster-6301',consent:true});
 const r=await cardOriginal(h,t,'synthetic-coaster-6302','Lunch','60.00',true);
 let c=await h.post('claims',{title:'Synthetic compliant out-of-pocket lunch'},t.sam);
 c=await h.post(`claims/${c.id}/items`,{version:c.version,kind:'receipt',date:'2026-10-02',merchant:'Lunch',amount:'60.00',category:t.c.meals},t.sam);
 let d=await h.get(`claims/${c.id}`,t.sam);const inbox=(await h.get('receipt-inbox',t.sam)).receipts.find(o=>o.id===r.id);
 c=(await h.post(`receipt-inbox/${r.id}/attach`,{expectedSequence:inbox.lifecycleSequence,claimId:c.id,itemId:d.items[0].id,version:c.version},t.sam)).claim;
 c=await h.post(`claims/${c.id}/submit`,{version:c.version},t.sam);assert.equal(c.status,'approved');assert.equal(c.total_minor,6000);
 await h.post(`claims/${c.id}/submit`,{version:c.version},t.sam,409);
 d=await h.get(`claims/${c.id}`,t.morgan);assert.equal(d.decisions.length,1);assert.equal(d.decisions[0].actor_email,'policy agent v1');assert.equal(d.decisions[0].on_behalf_of,'owner@harbourfinch.example');assert.equal((await h.get('exceptions',t.morgan)).samples.length,1);
 const lines=(await h.get('history?q=policy-agent-expense-approved',t.morgan)).lines;assert.equal(lines.length,1);assert.equal(lines[0].channel,'agent');
 const batch=await h.post('batches',{claims:[c.id]},t.morgan),exported=await h.get(`batches/${batch.id}`,t.morgan);assert.equal(batch.total_minor,6000);assert.equal(exported.lines[0].approver,'policy agent v1');assert.equal(exported.lines[0].amountMinor,6000);
 const frozen=d.revisions[0].snapshot;await h.post(`claims/${c.id}/unapprove`,{version:(await h.get(`claims/${c.id}`,t.morgan)).claim.version,to:'approver',reason:'Human check requested'},t.morgan);
 const reopened=await h.get(`claims/${c.id}`,t.priya);assert.deepEqual(reopened.revisions[0].snapshot,frozen);assert.deepEqual(reopened.revisions.at(-1).snapshot.expenseApprovals,[],'unapproval removes authority from the reopened revision without changing the earlier evidence');
 }finally{await h.close()}
})

test('AGENT-005 eligible expenses cannot approve the owner or bypass human workflow and payment gates',async()=>{
 const h=await harness({bindings:{AI_ENABLED:'true',AI_API_KEY:'synthetic-coaster-6500'},aiEdge:async()=>lunchReading()});
 try{
  const t=await cardReviewSetup(h);
  await h.post('settings/members',{email:'owner@harbourfinch.example',name:'Synthetic Coaster owner',employee:true,approver:'priya@harbourfinch.example'});
  await h.post('settings/receipt-reading',{version:0,enabled:true,threshold:.95,model:'synthetic-coaster-6501',consent:true});
  await h.post('settings/approval-envelope',{version:0,enabled:true,limit:'100.00',consent:true});
  async function lunch(cookie,id){
   const r=await cardOriginal(h,{...t,sam:cookie},id,'Lunch','60.00',true);
   let c=await h.post('claims',{title:id},cookie);
   c=await h.post(`claims/${c.id}/items`,{version:c.version,kind:'receipt',date:'2026-10-02',merchant:'Lunch',amount:'60.00',category:t.c.meals},cookie);
   const item=(await h.get(`claims/${c.id}`,cookie)).items[0],inbox=(await h.get('receipt-inbox',cookie)).receipts.find(o=>o.id===r.id);
   c=(await h.post(`receipt-inbox/${r.id}/attach`,{expectedSequence:inbox.lifecycleSequence,claimId:c.id,itemId:item.id,version:c.version},cookie)).claim;
   c=await h.post(`claims/${c.id}/submit`,{version:c.version},cookie);
   return h.get(`claims/${c.id}`,t.priya);
  }
  const own=await lunch(h.owner,'synthetic-coaster-6502');
  assert.equal(own.revisions[0].snapshot.policyReview.recommendations[0].evidence.agentEligible,true);
  assert.equal(own.claim.status,'submitted');assert.equal(own.revisions[0].snapshot.expenseApprovals,undefined);assert.deepEqual(own.decisions,[]);
  await h.post('settings/approval-workflow',{version:0,rules:[{label:'Human finance stage',condition:{kind:'always',value:''},stages:[[{kind:'finance',email:'morgan@harbourfinch.example'}]]}]});
  const routed=await lunch(t.sam,'synthetic-coaster-6503');
  assert.equal(routed.revisions[0].snapshot.expenseApprovals[0].source,'agent');
  assert.equal(routed.claim.status,'submitted');assert.deepEqual(routed.decisions,[]);
  await h.post('batches',{claims:[routed.claim.id]},t.morgan,409);
  let c=await h.post(`claims/${routed.claim.id}/decision`,{version:routed.claim.version,revision:routed.claim.revision,decision:'approved'},t.priya);
  assert.equal(c.status,'submitted');assert.equal(c.approver_email,'morgan@harbourfinch.example');
  await h.post('batches',{claims:[c.id]},t.morgan,409);
  c=await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved'},t.morgan);
  assert.equal(c.status,'approved');
  const batch=await h.post('batches',{claims:[c.id]},t.morgan);
  await h.post(`batches/${batch.id}/release`,{version:batch.version},h.owner,409);
  assert.equal((await h.get(`batches/${batch.id}`,t.morgan)).batch.released_at,null,'agent approvals do not release an unreviewed batch');
 }finally{await h.close()}
})
