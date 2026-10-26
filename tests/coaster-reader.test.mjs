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

test('Receipt reading requires both consents, keeps exact private evidence and returns only verified prefill',async()=>{
 const label=await load(1001),requests=[];let low=false;let activeLabel=label
 const h=await harness({bindings:aiBindings,aiEdge:async request=>{const b=await request.json();requests.push(b);assert.equal(new URL(request.url).pathname,'/v1/responses');assert.equal(b.store,false);assert.ok(b.input[1].content.some(c=>activeLabel.file.endsWith('.pdf')?c.type==='input_file'&&c.file_data.startsWith('data:application/pdf;base64,'):c.type==='input_image'&&c.image_url.startsWith('data:image/png;base64,')));const value=raw(activeLabel);if(low)value.total.confidence=.5;return response(value)}})
 try {
  const t=await agency(h),receipt=await upload(h,t.sam)
  assert.equal(requests.length,0,'upload does not send anything for reading')
  await h.post(`receipt-inbox/${receipt.id}/reading`,{expectedSequence:0,expectedReadingSequence:0,consent:true},t.sam,409)
  assert.equal(requests.length,0)
  await h.post('settings/receipt-reading',{version:0,enabled:true,consent:true},t.morgan,403)
  await h.post('settings/receipt-reading',{version:0,enabled:true},h.owner,400)
  await enable(h)
  await h.post(`receipt-inbox/${receipt.id}/reading`,{expectedSequence:0,expectedReadingSequence:0,consent:false},t.sam,400)
  const d=await read(h,receipt.id,t.sam)
  assert.equal(d.state,'read');assert.equal(d.prefill.amount,label.values.total);assert.equal(d.prefill.merchant,label.values.merchant)
  for(const [name,field]of Object.entries(d.fields)){assert.equal(field.review,false);assert.deepEqual(name==='lineItems'?field.value.map(({description,amount,quantity})=>({description,amount,quantity})):field.value,label.values[name],name)}
  assert.equal(d.history[0].kind,'started');assert.equal(d.history[1].kind,'read')
  assert.equal(d.history[1].actorEmail,'sam@harbourfinch.example');assert.equal(d.matchDefault.enabled,false)
  const inbox=(await h.get('receipt-inbox',t.sam)).receipts.find(r=>r.id===receipt.id);assert.equal(inbox.matchChoice.enabled,false,'reading never opts a receipt into card matching')
  const history=await h.get('history');assert.ok(!JSON.stringify(history).includes(label.values.merchant),'private reading text never enters global history')
  await h.get(`receipt-inbox/${receipt.id}/reading`,h.owner,404);await h.get(`receipt-inbox/${receipt.id}/reading`,t.alex,404)
  assert.equal(requests.length,1)
  const stale=await h.send(`/api/coaster/receipt-inbox/${receipt.id}/reading`,{expectedSequence:0,expectedReadingSequence:0,consent:true},t.sam);assert.equal(stale.status,409);assert.equal(requests.length,1)
  activeLabel=await load(2041);const heic=await upload(h,t.sam,2041),heicReading=await read(h,heic.id,t.sam)
  assert.equal(heicReading.prefill.amount,activeLabel.values.total,'HEIC is decoded to actual PNG pixels before the Base AI call');assert.equal(requests.length,2)
  activeLabel=await load(2031);const pdf=await upload(h,t.sam,2031),pdfReading=await read(h,pdf.id,t.sam)
  assert.equal(pdfReading.prefill.amount,activeLabel.values.total,'The complete multipage original is passed to Base AI');assert.equal(pdfReading.history.at(-1).usage.pages,2)
  const pdfContext=JSON.parse(requests.at(-1).input[1].content.find(c=>c.type==='input_text'&&c.text.startsWith('Untrusted text and source rectangles')).text.split('instructions: ')[1]);assert.ok(pdfContext.filter(c=>c.region.page===1).map(c=>c.text).join(' ').includes(activeLabel.values.merchant));assert.ok(pdfContext.filter(c=>c.region.page===2).map(c=>c.text).join(' ').includes(activeLabel.values.total));assert.ok(pdfContext.every(c=>c.region.x>=0&&c.region.y>=0&&c.region.width>0&&c.region.height>0&&c.region.x+c.region.width<=1&&c.region.y+c.region.height<=1),'PDF evidence is located on its actual source page')
  const bytes=await h.mf.dispatchFetch(h.origin+`/api/coaster/receipt-inbox/${receipt.id}`,{headers:{cookie:t.sam}});assert.deepEqual(Buffer.from(await bytes.arrayBuffer()),await readFile(folder+label.file))
  activeLabel=label
  const notice=inbox.matchChoice.notice
  await h.post('settings/receipt-reading/matching',{version:0,enabled:true,consent:true},t.sam,400)
  await h.post('settings/receipt-reading/matching',{version:0,enabled:true,consent:true,notice,employee:'sam@harbourfinch.example'},h.owner,400)
  await h.post('settings/receipt-reading/matching',{version:0,enabled:true,consent:true,notice},t.sam)
  const chosen=await upload(h,t.sam,1002);let chosenRead=await read(h,chosen.id,t.sam)
  let chosenInbox=(await h.get('receipt-inbox',t.sam)).receipts.find(r=>r.id===chosen.id);assert.equal(chosenInbox.matchChoice.enabled,true,'self-granted standing choice applies only safe fields')
  await h.post(`receipt-inbox/${chosen.id}/card-match`,{expectedSequence:chosenInbox.lifecycleSequence,enabled:false},t.sam)
  chosenInbox=(await h.get('receipt-inbox',t.sam)).receipts.find(r=>r.id===chosen.id)
  await read(h,chosen.id,t.sam,chosenRead.sequence,chosenInbox.lifecycleSequence)
  assert.equal((await h.get('receipt-inbox',t.sam)).receipts.find(r=>r.id===chosen.id).matchChoice.enabled,false,'later reading never resurrects a withdrawn original')
  low=true;const uncertain=await upload(h,t.sam,1003);await read(h,uncertain.id,t.sam)
  assert.equal((await h.get('receipt-inbox',t.sam)).receipts.find(r=>r.id===uncertain.id).matchChoice.enabled,false,'low-confidence totals never opt an original in')
  low=false
  await h.post('delegates',{delegate:'alex@harbourfinch.example',level:'submit'},t.sam)
  const delegated=await upload(h,t.sam,1004),headers={'x-coaster-acting-for':'sam@harbourfinch.example'}
  assert.equal((await h.send('/api/coaster/settings/receipt-reading/matching',{version:1,enabled:true,consent:true,notice},t.alex,headers)).status,403,'a delegate cannot grant a standing choice')
  const delegatedRead=await h.send(`/api/coaster/receipt-inbox/${delegated.id}/reading`,{expectedSequence:0,expectedReadingSequence:0,consent:true},t.alex,headers)
  assert.equal(delegatedRead.status,200)
  const delegatedInbox=(await h.get('receipt-inbox',t.sam)).receipts.find(r=>r.id===delegated.id)
  assert.equal(delegatedInbox.matchChoice.enabled,true,'the employee standing choice applies to their own safe original read by a live delegate')
  assert.equal(delegatedInbox.lifecycle.at(-1).actorEmail,'alex@harbourfinch.example');assert.equal(delegatedInbox.lifecycle.at(-1).onBehalfOf,'sam@harbourfinch.example')
  await h.post('settings/receipt-reading/matching',{version:1,enabled:false,consent:false},t.sam)
 }finally{await h.close()}
})

test('Receipt confidence is lowered by arithmetic and native conflicts; human correction keeps both readings and failure has explicit retry',async()=>{
 const label=await load(1007);let mode='wrong',calls=0
 const h=await harness({bindings:aiBindings,aiEdge:async()=>{calls++;if(mode==='failure')return Response.json({error:{message:'provider detail is never disclosed'}},{status:503});const value=raw(label);if(mode==='wrong')value.total={...value.total,value:'99.00',confidence:.6};return response(value)}})
 try {
  const t=await agency(h);await enable(h);const original=await upload(h,t.sam,1007)
  let d=await read(h,original.id,t.sam);assert.equal(d.state,'needs-attention');assert.equal(d.fields.total.value,'99.00');assert.equal(d.fields.total.review,true);assert.ok(!('amount'in d.prefill));assert.ok(!('total'in d.prefill))
  const before=d.history[1].fields
  d=await h.post(`receipt-inbox/${original.id}/reading/corrections`,{expectedSequence:0,expectedReadingSequence:d.sequence,values:{total:label.values.total}},t.sam)
  assert.equal(d.prefill.amount,label.values.total);assert.equal(d.fields.total.source,'person');assert.deepEqual(d.history[1].fields,before);assert.equal(d.history.at(-1).fields.total.value,label.values.total)
  mode='failure';d=await read(h,original.id,t.sam,d.sequence)
  assert.equal(d.state,'needs-attention');assert.equal(d.retryable,true);assert.equal(d.history.at(-1).kind,'failed');assert.ok(!JSON.stringify(d).includes('provider detail'))
  const failedCalls=calls;await h.get(`receipt-inbox/${original.id}/reading`,t.sam);assert.equal(calls,failedCalls,'GET and failure never retry a paid request')
  mode='valid';d=await read(h,original.id,t.sam,d.sequence);assert.equal(d.prefill.amount,label.values.total)
  const notice=(await h.get('receipt-inbox',t.sam)).receipts.find(r=>r.id===original.id).matchChoice.notice
  await h.post(`receipt-inbox/${original.id}/card-match`,{expectedSequence:0,enabled:true,merchant:label.values.merchant,date:label.values.date,total:'11.00',currency:label.values.currency,last4:label.values.last4,notice},t.sam)
  d=await read(h,original.id,t.sam,d.sequence,1);assert.equal(d.fields.total.review,true);assert.ok(d.fields.total.reasons.some(r=>r.includes('person-confirmed')));assert.ok(!('amount'in d.prefill))
 }finally{await h.close()}
})

test('Receipt reader authority survives neither delegate revocation nor terminal disposition and readers cannot widen their identity',async()=>{
 const label=await load(1001);let entered,release;const paused=new Promise(resolve=>entered=resolve)
 const h=await harness({bindings:aiBindings,aiEdge:async()=>{entered();await new Promise(resolve=>release=resolve);const value=raw(label);if(low)value.total.confidence=.5;return response(value)}})
 try {
  const t=await agency(h);await enable(h);const original=await upload(h,t.sam)
  const grant=await h.post('delegates',{delegate:'alex@harbourfinch.example',level:'submit'},t.sam),headers={'x-coaster-acting-for':'sam@harbourfinch.example'}
  const pending=h.send(`/api/coaster/receipt-inbox/${original.id}/reading`,{expectedSequence:0,expectedReadingSequence:0,consent:true},t.alex,headers)
  await paused;await h.post(`delegates/${grant.id}/revoke`,{},t.sam);release()
  assert.equal((await pending).status,409,'no reading completion commits after the delegate loses access')
  const detail=await h.get(`receipt-inbox/${original.id}/reading`,t.sam);assert.equal(detail.history.length,1);assert.equal(detail.history[0].kind,'started')
  assert.equal((await h.send(`/api/coaster/receipt-inbox/${original.id}/reading`,{expectedSequence:0,expectedReadingSequence:1,consent:true},t.alex,headers)).status,403)
  const agent=await h.post('agent-keys',{label:'synthetic-coaster-5001'},t.sam)
  assert.equal((await h.send(`/api/coaster/receipt-inbox/${original.id}/reading`,{expectedSequence:0,expectedReadingSequence:1,consent:true},'',{authorization:'Bearer '+agent.token})).status,401)
  const disposed=await upload(h,t.sam,1007);await h.post(`receipt-inbox/${disposed.id}/discard`,{expectedSequence:0,reason:'synthetic-coaster-5002'},t.sam)
  await h.post(`receipt-inbox/${disposed.id}/reading`,{expectedSequence:1,expectedReadingSequence:0,consent:true},t.sam,409)
  const originalBytes=await h.mf.dispatchFetch(h.origin+`/api/coaster/receipt-inbox/${disposed.id}`,{headers:{cookie:t.sam}});assert.equal(originalBytes.status,200)
  const notice=(await h.get('receipt-inbox',t.sam)).receipts.find(r=>r.id===disposed.id).matchChoice.notice
  await h.post('settings/receipt-reading/matching',{version:0,enabled:true,consent:true,notice},t.sam)
  await h.post('settings/members',{email:'sam@harbourfinch.example',name:'Sam',employee:true,active:false})
  const erased=await h.post('settings/members/erase',{email:'sam@harbourfinch.example'})
  const rows=(await h.db.prepare('SELECT actor_email,on_behalf_of FROM c_receipt_readings WHERE receipt_id=?').bind(original.id).all()).results
  assert.equal(rows[0].on_behalf_of,erased.retained.subject,'private reading provenance follows the original opaque owner')
  assert.ok(!JSON.stringify(rows).includes('sam@harbourfinch.example'))
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_receipt_reading_match_defaults WHERE employee_email=?').bind('sam@harbourfinch.example').first()).n,0,'erasure removes personal standing matching authority')
 }finally{release?.();await h.close()}
})

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

test('Merchant email body and attachment readings share one confirmed-only question and retain both exact sources',async()=>{
 const attachment=await load(2031),body={...attachment,values:{...attachment.values,merchant:'synthetic-coaster-8501',date:'2026-08-04',total:'70.50',salesTax:'5.36',tip:'7.00',currency:'CAD',last4:'4141'}};
 let selected=attachment;const calls=[];
 const h=await harness({bindings:aiBindings,aiEdge:async request=>{const input=await request.json();calls.push(input);return response(raw(selected));}});
 try{
  const t=await agency(h);await enable(h);
  const {receiptAddress,receiptMail,deliverMail}=await import('./fixtures/receipt-email.mjs');
  await h.post('settings/receipt-email',{address:receiptAddress,consent:true});
  const pdf=await readFile(folder+attachment.file),html=`<h1>${body.values.merchant}</h1><p>${body.values.date}</p><p>Subtotal 58.14; tax 5.36; tip 7.00; total CAD 70.50; card ending 4141</p>`;
  const message=Buffer.from(receiptMail({subject:'synthetic-coaster-8502',file:{name:attachment.file,bytes:pdf}}).toString().replace('Content-Type: text/plain\r\n\r\nYour receipt is attached.','Content-Type: text/html; charset=UTF-8\r\n\r\n'+html));
  await deliverMail(h,message);
  const originals=(await h.get('receipt-inbox',t.sam)).receipts;
  assert.equal(originals.length,2);assert.equal(calls.length,0,'intake never authorizes external processing');
  const attachedOriginal=originals.find(r=>r.name===attachment.file),bodyOriginal=originals.find(r=>r.id!==attachedOriginal.id);
  assert.ok(attachedOriginal&&bodyOriginal);
  const download=async(id,suffix='')=>{const r=await h.mf.dispatchFetch(h.origin+`/api/coaster/receipt-inbox/${id}${suffix}`,{headers:{cookie:t.sam}});assert.equal(r.status,200);return Buffer.from(await r.arrayBuffer());};
  assert.deepEqual(await download(attachedOriginal.id),pdf);
  const bodyPdf=await download(bodyOriginal.id);assert.ok(bodyPdf.length>0);
  for(const original of originals)assert.deepEqual(await download(original.id,'/source'),message);
  const attachmentRead=await read(h,attachedOriginal.id,t.sam);assert.equal(attachmentRead.prefill.amount,attachment.values.total);
  assert.equal(calls.length,1);assert.equal((await h.get(`receipt-inbox/${bodyOriginal.id}/reading`,t.sam)).sequence,0,'reading one original never reads its sibling');
  selected=body;const bodyRead=await read(h,bodyOriginal.id,t.sam);assert.equal(calls.length,2);
  assert.ok(!('total' in bodyRead.prefill));assert.ok(!('merchant' in bodyRead.prefill));
  let detail=await h.get(`receipt-inbox/${attachedOriginal.id}/reading`,t.sam);
  assert.equal(detail.state,'needs-attention');assert.equal(detail.fields.total.review,true);assert.ok(!('total' in detail.prefill));assert.ok(!('amount' in detail.prefill));assert.ok(!('merchant' in detail.prefill),'a later sibling reading invalidates earlier prefill');
  assert.deepEqual(detail.history[1].fields,attachmentRead.history[1].fields,'dynamic comparison does not overwrite the first reading');
  await h.get(`receipt-inbox/${bodyOriginal.id}/reading`,t.alex,404);
  await h.get(`receipt-inbox/${attachedOriginal.id}/reading`,h.owner,404);
  const issuer='synthetic-coaster-8503';await h.post('statements/cards',{issuer,last4:attachment.values.last4,employee:'sam@harbourfinch.example'});
  const file={format:'csv',name:'synthetic-coaster-8504.csv',issuer,category:t.c.office,content:`Date,Merchant,Amount,Id\n${attachment.values.date},${attachment.values.merchant},72.50,synthetic-coaster-8504`,mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',transactionId:'Id',wholeFileLast4:attachment.values.last4}};
  const preview=await h.post('statements/preview',file),job=await h.post('statements/commit',{...file,fingerprint:preview.fingerprint});
  const claim=await h.get('claims/'+job.claims[0],t.sam),item=claim.items[0];
  await h.post(`receipt-inbox/${attachedOriginal.id}/attach`,{expectedSequence:0,claimId:claim.claim.id,itemId:item.id,version:claim.claim.version},t.sam);
  detail=await h.get(`receipt-inbox/${attachedOriginal.id}/reading`,t.sam);const q=detail.question;
  assert.ok(q);assert.equal(new Set(q.conflicts.map(c=>c.field)).size,q.conflicts.length,'each field appears once in the one question');
  assert.deepEqual(q.conflicts.map(c=>c.field).sort(),['merchant','date','total','salesTax','tip','currency','last4'].sort());
  for(const conflict of q.conflicts){
   assert.deepEqual(conflict.regions,region);assert.equal(conflict.read,attachment.values[conflict.field]);
   assert.equal(conflict.sources.length,1);assert.equal(conflict.sources[0].receiptId,bodyOriginal.id);assert.equal(conflict.sources[0].value,body.values[conflict.field]);assert.deepEqual(conflict.sources[0].regions,region);
  }
  assert.equal(q.conflicts.find(c=>c.field==='total').card,'72.50');
  const before=await h.get('claims/'+claim.claim.id,t.sam);
  const postedBefore=(await h.get('statements')).charges.find(charge=>charge.id===q.chargeId);assert.ok(postedBefore);
  assert.deepEqual((await h.get(`receipt-inbox/${attachedOriginal.id}/question`,t.sam)).question,q);
  assert.deepEqual(await h.get('claims/'+claim.claim.id,t.sam),before,'an ignored comparison changes no expense');assert.equal(calls.length,2);
  const values={...Object.fromEntries(q.conflicts.map(c=>[c.field,body.values[c.field]])),total:body.values.total,currency:body.values.currency};
  const answer={questionId:q.id,expectedSequence:1,expectedReadingSequence:detail.sequence,version:q.version,values,consent:true};
  await h.post(`receipt-inbox/${attachedOriginal.id}/question`,{...answer,consent:false},t.sam,400);
  await h.post(`receipt-inbox/${bodyOriginal.id}/reading/corrections`,{expectedSequence:0,expectedReadingSequence:bodyRead.sequence,values:{total:'71.50',tip:'8.00'}},t.sam);
  await h.post(`receipt-inbox/${attachedOriginal.id}/question`,answer,t.sam,409);
  assert.deepEqual(await h.get('claims/'+claim.claim.id,t.sam),before,'a stale sibling question cannot commit an expense correction');
  const fresh=(await h.get(`receipt-inbox/${attachedOriginal.id}/reading`,t.sam)).question;
  await h.post(`receipt-inbox/${attachedOriginal.id}/question`,{...answer,questionId:fresh.id,values:{...values,total:'71.50',tip:'8.00'}},t.sam);
  const after=await h.get(`receipt-inbox/${attachedOriginal.id}/reading`,t.sam);assert.equal(after.question,null);assert.equal(after.fields.total.value,'71.50');assert.equal(after.fields.total.source,'person');assert.deepEqual(after.history[1].fields,attachmentRead.history[1].fields);
  const resolved=(await h.get('claims/'+claim.claim.id,t.sam)).items.find(i=>i.id===item.id);assert.equal(resolved.amount_minor,7250);assert.deepEqual((await h.get('statements')).charges.find(charge=>charge.id===q.chargeId),postedBefore);assert.equal(JSON.parse(resolved.receipt_resolution).receiptTotal,'71.50');assert.equal(JSON.parse(resolved.receipt_resolution).receiptCurrency,'CAD');
  assert.deepEqual(await download(attachedOriginal.id),pdf);assert.deepEqual(await download(bodyOriginal.id),bodyPdf);for(const original of originals)assert.deepEqual(await download(original.id,'/source'),message);
  assert.equal(calls.length,2,'comparison, correction and evidence views never start another paid reading');
  // A terminal sibling stops contributing values, while its unchanged evidence stays private.
  await h.post(`receipt-inbox/${bodyOriginal.id}/discard`,{expectedSequence:0,reason:'synthetic-coaster-8505'},t.sam);
  const current=await h.get(`receipt-inbox/${attachedOriginal.id}/reading`,t.sam);assert.ok(current.fields.total.reasons.every(reason=>!reason.includes('merchant email')));
  assert.deepEqual(await download(bodyOriginal.id),bodyPdf);
 }finally{await h.close();}
});
