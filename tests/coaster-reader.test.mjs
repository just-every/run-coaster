import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {agency,harness} from './harness.mjs'
const folder='tests/fixtures/receipts/reader/',region=[{page:1,x:.1,y:.1,width:.5,height:.1}]
const load=async n=>JSON.parse(await readFile(folder+`synthetic-coaster-${n}.json`,'utf8'))
const raw=label=>Object.fromEntries(Object.entries(label.values).map(([name,value])=>[name,{value:name==='lineItems'?value.map(x=>({...x,confidence:.99,regions:region})):value,confidence:.99,regions:region}]))
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
 }finally{release?.();await h.close()}
})
