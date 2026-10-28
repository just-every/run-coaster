import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {agency,harness} from './harness.mjs'
const folder='tests/fixtures/receipts/reader/',region=[{page:1,x:.1,y:.1,width:.5,height:.1}]
const load=async n=>JSON.parse(await readFile(folder+`synthetic-coaster-${n}.json`,'utf8'))
const raw=label=>Object.fromEntries(Object.entries(label.values).map(([name,value])=>[name,{value:name==='lineItems'?value.map(x=>({...x,description:`${x.description} × ${x.quantity}`,confidence:.99,regions:region})):value,confidence:.99,regions:region}]))
const response=fields=>Response.json({status:'completed',model:'gpt-4.1-2025-04-14',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(fields)}]}],usage:{input_tokens:100,output_tokens:100,total_tokens:200}})
const aiBindings={AI_ENABLED:'true',AI_API_KEY:'synthetic-coaster-5000'}
async function upload(h,cookie,n=1001,headers={}) {
 const label=await load(n),form=new FormData();form.append('file',new File([await readFile(folder+label.file)],label.file,{type:label.file.endsWith('.pdf')?'application/pdf':'image/png'}))
 const encoded=new Request(h.origin+'/api/coaster/receipt-inbox',{method:'POST',headers:{origin:h.origin,cookie,...headers},body:form});const r=await h.mf.dispatchFetch(encoded.url,{method:'POST',headers:Object.fromEntries(encoded.headers),body:await encoded.arrayBuffer()});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data.receipt
}
async function enable(h,cookie=h.owner) {return h.post('settings/receipt-reading',{version:0,enabled:true,consent:true,threshold:.95,model:'gpt-4.1-2025-04-14'},cookie)}
const read=(h,id,cookie,reading=0,life=0,extra={})=>h.post(`receipt-inbox/${id}/reading`,{expectedSequence:life,expectedReadingSequence:reading,consent:true,...extra},cookie)

test('Owner sees per-page USD corpus usage and an atomic monthly cap pauses reading and coding while manual expenses work',async()=>{
 let activeLabel=await load(1001),calls=0
 const h=await harness({bindings:aiBindings,aiEdge:async()=>{calls++;const body=await response(raw(activeLabel)).json();body.usage={input_tokens:100000,output_tokens:6250,total_tokens:106250};return Response.json(body)}})
 try{
  const t=await agency(h),model='gpt-4.1-2025-04-14',pricing={version:0,model,inputPerMillion:'2',outputPerMillion:'8',reservePerPage:'0.25',monthlyCap:'20'}
  assert.equal((await h.get('settings/provider-costs')).settings,null)
  for(const who of [t.sam,t.morgan,t.priya]){await h.get('settings/provider-costs',who,403);await h.post('settings/provider-costs',pricing,who,403)}
  await h.post('settings/provider-costs',pricing);await enable(h)
  const manifest=JSON.parse(await readFile(folder+'manifest.json','utf8')),attempts=[];let pages=0
  for(const entry of manifest.receipts){
   activeLabel=JSON.parse(await readFile(folder+entry.label,'utf8'))
   const original=await upload(h,t.sam,Number(entry.id.replace('synthetic-coaster-',''))),d=await read(h,original.id,t.sam),row=d.history.at(-1)
   assert.equal(row.kind,'read');assert.equal(row.usage.cost.currency,'USD');assert.equal(row.usage.cost.usdMicros,250000);assert.equal(row.usage.cost.pages,row.usage.pages);assert.equal(row.usage.cost.perPageUsdMicros,250000/row.usage.pages);attempts.push(row.attemptId);pages+=row.usage.pages
  }
  let costs=await h.get('settings/provider-costs');assert.equal(costs.attempts.length,manifest.receipts.length);assert.equal(costs.usedUsdMicros,manifest.receipts.length*250000)
  assert.deepEqual(costs.attempts.map(r=>r.attempt_id).sort(),attempts.sort(),'the owner usage ledger names every corpus reading attempt')
  assert.equal(costs.attempts.reduce((n,r)=>n+r.pages,0),pages)
  assert.ok(!JSON.stringify(costs).includes('sam@harbourfinch.example'));assert.ok(!JSON.stringify(costs).includes(activeLabel.values.merchant))
  // Keep the original $20 cap. Synthetic metered usage costs USD 0.25 per request.
  const cap=20;activeLabel=await load(1001);const fuel=await upload(h,t.sam);let fuelSequence=0
  const extra=(20000000-costs.usedUsdMicros)/250000-1;assert.ok(Number.isInteger(extra)&&extra>0)
  for(let i=0;i<extra;i++){const d=await read(h,fuel.id,t.sam,fuelSequence);assert.equal(d.history.at(-1).usage.cost.usdMicros,250000);fuelSequence=d.sequence}
  costs=await h.get('settings/provider-costs');assert.equal(costs.settings.monthlyCap,20);assert.equal(costs.usedUsdMicros,19750000)
  const a=await upload(h,t.sam),b=await upload(h,t.sam,1002),before=calls
  const answers=await Promise.all([read(h,a.id,t.sam),read(h,b.id,t.sam)])
  assert.equal(calls,before+1,'two concurrent attempts cannot both spend the last reservation')
  assert.equal(answers.filter(d=>d.history.at(-1).kind==='read').length,1)
  costs=await h.get('settings/provider-costs');assert.equal(costs.usedUsdMicros,cap*1e6);assert.equal(costs.paused,true)
  const c=await upload(h,t.sam,1003),paused=await read(h,c.id,t.sam)
  assert.equal(paused.history.at(-1).errorCode,'budget_exhausted');assert.match(paused.attentionReason,/budget is exhausted/);assert.equal(calls,before+1)
  let manual=await h.post('claims',{title:'Manual after optional AI cap'},t.sam)
  manual=await h.post(`claims/${manual.id}/items`,{version:manual.version,kind:'receipt',date:'2026-06-16',merchant:'synthetic-coaster-7000',amount:'12.34',allocations:[{category:t.c.office}]},t.sam)
  assert.equal((await h.get(`claims/${manual.id}`,t.sam)).items[0].amount_minor,1234)
  const readOriginal=answers.find(d=>d.fields)
  await h.post(`receipt-inbox/${readOriginal.receiptId}/reading/coding`,{expectedSequence:readOriginal.lifecycleSequence,expectedReadingSequence:readOriginal.sequence,contextVersion:0,consent:true},t.sam)
  assert.equal(calls,before+1,'coding has the same optional provider cap')
 }finally{await h.close()}
})

test('Receipt disagreements ask one private crop-backed question across the labeled corpus, apply only confirmed answers and remind after two business days',async()=>{
 let activeLabel=await load(1001),first=true
 const h=await harness({bindings:aiBindings,aiEdge:async()=>{const fields=raw(activeLabel);if(first){fields.total.value=(Number(activeLabel.values.total)-Number(activeLabel.values.tip)).toFixed(2);fields.total.confidence=.6;}return response(fields)}})
 try{
  const t=await agency(h);await h.post('settings/members',{email:'owner@harbourfinch.example',name:'Owner',employee:true,finance:true,approver:'priya@harbourfinch.example'});await h.post('settings/business',{name:'Harbour & Finch Studio',currency:'USD',timezone:'America/Chicago',perDiem:'75',receiptThreshold:''});await enable(h)
  const manifest=JSON.parse(await readFile(folder+'manifest.json','utf8')),seen=new Set();let firstQuestion,firstOriginal,firstReading,firstClaim
  for(const entry of manifest.receipts){
   activeLabel=JSON.parse(await readFile(folder+entry.label,'utf8'));const label=activeLabel.values;let original;
   if(first){
    const {receiptAddress,receiptMail,deliverMail}=await import('./fixtures/receipt-email.mjs');
    await h.post('settings/receipt-email',{address:receiptAddress,consent:true});
    await deliverMail(h,receiptMail({file:{name:activeLabel.file,bytes:await readFile(folder+activeLabel.file)},subject:'Merchant receipt with tip'}));
    original=(await h.get('receipt-inbox',t.sam)).receipts[0];assert.ok(original.emailSource);
   }else original=await upload(h,t.sam,Number(entry.id.replace('synthetic-coaster-','')));

   const readBefore=await read(h,original.id,t.sam),originalFields=readBefore.history[1].fields
   const issuer='synthetic-coaster-7100',last4=label.last4??'1111';await h.post('statements/cards',{issuer,last4,employee:'sam@harbourfinch.example'})
   const chargeTotal=(Number(label.total)+(first?0:.01)).toFixed(2),quote=s=>'"'+String(s).replaceAll('"','""')+'"'
   const file={format:'csv',name:entry.id+'.csv',issuer,category:t.c.office,content:'Date,Merchant,Amount,Id\n'+[label.date,label.merchant,chargeTotal,entry.id].map(quote).join(','),mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',transactionId:'Id',wholeFileLast4:last4}}
   let preview=await h.post('statements/preview',file);
   if(preview.possibleDuplicates.length){file.includeRows=preview.possibleDuplicates.map(r=>r.id);preview=await h.post('statements/preview',file)}
   const job=await h.post('statements/commit',{...file,fingerprint:preview.fingerprint})
   const detail=await h.get('claims/'+job.claims[0],t.sam),item=detail.items.find(i=>i.merchant===label.merchant&&i.amount_minor===Math.round(Number(chargeTotal)*100)&&!i.receipt_id)
   const attached=await h.post(`receipt-inbox/${original.id}/attach`,{expectedSequence:0,claimId:detail.claim.id,itemId:item.id,version:detail.claim.version},t.sam)
   let d=await h.get(`receipt-inbox/${original.id}/reading`,t.sam),q=d.question
   assert.ok(q,entry.id+' disagreement has one question');assert.ok(!seen.has(q.id));seen.add(q.id)
   assert.ok(q.conflicts.some(c=>c.field==='total'&&c.read===originalFields.total.value&&c.card===chargeTotal));assert.ok(q.conflicts.every(c=>c.regions.length))
   const ignored=await h.get('claims/'+detail.claim.id,t.sam)
   assert.deepEqual((await h.get(`receipt-inbox/${original.id}/question`,t.sam)).question,q)
   assert.deepEqual(await h.get('claims/'+detail.claim.id,t.sam),ignored,'ignoring or re-reading a question changes no value')
   if(first){
    firstQuestion=q;firstOriginal=original;firstReading=d;firstClaim=attached.claim
    await h.get(`receipt-inbox/${original.id}/question`,t.alex,404);await h.get(`receipt-inbox/${original.id}/question`,h.owner,404)
    const key=await h.post('agent-keys',{label:'synthetic-coaster-7101'},t.sam)
    assert.equal((await h.send(`/api/coaster/receipt-inbox/${original.id}/question`,undefined,'',{authorization:'Bearer '+key.token})).status,401)
    const worker=await h.mf.getWorker(),tick=day=>worker.scheduled({scheduledTime:new Date(day+'T15:00:00Z'),cron:'17 * * * *'})
    await tick('2026-11-02');const start=h.messages.length;await tick('2026-11-03');assert.equal(h.messages.slice(start).filter(m=>m.subject.includes('private receipt question')).length,0)
    await tick('2026-11-04');const reminders=h.messages.slice(start).filter(m=>m.subject.includes('private receipt question'));assert.equal(reminders.length,1);assert.deepEqual(reminders[0].to,['sam@harbourfinch.example']);assert.ok(!reminders[0].text.includes(original.id));assert.ok(!reminders[0].text.includes(label.total));assert.ok(!reminders[0].text.includes(label.merchant))
   }
   const values={...Object.fromEntries(q.conflicts.map(c=>[c.field,label[c.field]])),total:label.total,currency:label.currency};if(first)values.tip=label.tip
   const answer={questionId:q.id,expectedSequence:1,expectedReadingSequence:d.sequence,version:q.version,values,consent:true}
   await h.post(`receipt-inbox/${original.id}/question`,{...answer,consent:false},t.sam,400)
   if(first){const grant=await h.post('delegates',{delegate:'alex@harbourfinch.example',level:'submit'},t.sam);const result=await h.send(`/api/coaster/receipt-inbox/${original.id}/question`,answer,t.alex,{'x-coaster-acting-for':'sam@harbourfinch.example'});assert.equal(result.status,200);await h.post(`delegates/${grant.id}/revoke`,{},t.sam);assert.equal((await h.send(`/api/coaster/receipt-inbox/${original.id}/question`,undefined,t.alex,{'x-coaster-acting-for':'sam@harbourfinch.example'})).status,403)}else await h.post(`receipt-inbox/${original.id}/question`,answer,t.sam)
   d=await h.get(`receipt-inbox/${original.id}/reading`,t.sam);assert.equal(d.question,null);assert.equal(d.fields.total.value,label.total);assert.equal(d.fields.currency.value,label.currency);assert.deepEqual(d.history[1].fields,originalFields)
   for(const c of q.conflicts)assert.equal(d.fields[c.field].source,'person')
   const after=await h.get('claims/'+detail.claim.id,t.sam),updated=after.items.find(i=>i.id===item.id)
   assert.equal(updated.amount_minor,Math.round(Number(chargeTotal)*100));assert.equal(JSON.parse(updated.receipt_resolution).receiptTotal,label.total)
   await h.post(`receipt-inbox/${original.id}/question`,answer,t.sam,409)
   first=false
  }
  assert.equal(seen.size,manifest.receipts.length,'every differing labeled original has exactly one current question')
  const worker=await h.mf.getWorker(),mailBefore=h.messages.length;await worker.scheduled({scheduledTime:new Date('2026-11-09T15:00:00Z'),cron:'17 * * * *'})
  assert.equal(h.messages.slice(mailBefore).filter(m=>m.subject.includes('private receipt question')).length,0,'answered questions stop reminders')
  assert.ok(!JSON.stringify(await h.get('history')).includes(firstQuestion.id),'private question identifiers never enter global history')
  let current=(await h.get('claims/'+firstClaim.id,t.sam)).claim
  const extra=await h.post(`claims/${current.id}/receipts`,{version:current.version,name:'synthetic-coaster-7199.png',base64:(await readFile('tests/fixtures/receipts/bistro.png')).toString('base64')},t.sam);current=extra.claim
  current=await h.post(`claims/${current.id}/items`,{version:current.version,kind:'receipt',date:'2026-08-20',merchant:'synthetic-coaster-7199',amount:'10.00',receipt:extra.receipt,allocations:[{category:t.c.office}]},t.sam)
  let submitted=await h.post(`claims/${current.id}/submit`,{version:current.version},t.sam)
  const published=(await h.get('claims/'+current.id,t.morgan)).items.find(i=>i.id===firstQuestion.itemId).receipt_resolution
  await h.post(`claims/${current.id}/decision`,{version:submitted.version,revision:submitted.revision,decision:'returned',reason:'Confirm the receipt comparison once more'},t.priya)
  activeLabel=await load(1001);first=false;const matchingBefore=await h.get(`receipt-inbox/${firstOriginal.id}/reading`,t.sam),matchingRead=await read(h,firstOriginal.id,t.sam,matchingBefore.sequence,1);assert.equal(matchingRead.question,null,'a matching source reading raises no question');first=true;const latest=await h.get(`receipt-inbox/${firstOriginal.id}/reading`,t.sam),refresh=await read(h,firstOriginal.id,t.sam,latest.sequence,1),freshQuestion=refresh.question
  await h.post(`receipt-inbox/${firstOriginal.id}/question`,{questionId:freshQuestion.id,expectedSequence:1,expectedReadingSequence:refresh.sequence,version:freshQuestion.version,values:{total:activeLabel.values.total,currency:activeLabel.values.currency,tip:activeLabel.values.tip},consent:true},t.sam)
  assert.equal((await h.get('claims/'+current.id,t.morgan)).items.find(i=>i.id===firstQuestion.itemId).receipt_resolution,published,'a returned claim shares only its last submitted comparison with finance')
  assert.notEqual((await h.get('claims/'+current.id,t.sam)).items.find(i=>i.id===firstQuestion.itemId).receipt_resolution,published,'the employee sees the new private confirmation')
  const apiKey=await h.post('public-api/keys',{label:'synthetic-coaster-7188',scopes:['expenses:read']});const projection=await h.send('/api/coaster/public-api/v1/expenses?claimId='+current.id,undefined,'',{authorization:'Bearer '+apiKey.token});assert.equal(projection.status,200);assert.ok(projection.value.data.every(i=>!('receipt_resolution' in i)),'expense scope never exposes private receipt confirmation metadata')
  current=(await h.get('claims/'+current.id,t.sam)).claim;submitted=await h.post(`claims/${current.id}/submit`,{version:current.version},t.sam)
  const approved=await h.post(`claims/${current.id}/decision`,{version:submitted.version,revision:submitted.revision,decision:'approved',acknowledge:true},t.priya)
  let batch=await h.post('batches',{claims:[approved.id]},t.morgan);batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:1000},t.morgan);await h.paid(batch.id,batch.version,{reference:'synthetic-coaster-7199',paidOn:'2026-11-09'},t.morgan)
  const before=await h.get('claims/'+approved.id,t.sam);assert.equal(before.claim.status,'reimbursed')
  await h.post(`receipt-inbox/${firstOriginal.id}/question`,{questionId:freshQuestion.id,expectedSequence:1,expectedReadingSequence:(await h.get(`receipt-inbox/${firstOriginal.id}/reading`,t.sam)).sequence,version:before.claim.version,values:{total:'99.00',currency:'USD'},consent:true},t.sam,409)
  assert.deepEqual(await h.get('claims/'+approved.id,t.sam),before,'an answered or non-editable expense is never changed')
 }finally{await h.close()}
})
