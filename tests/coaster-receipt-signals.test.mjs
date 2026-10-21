import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {harness,agency} from './harness.mjs'
import {imageSignalCases,patternSignalCases,cardSignalCases,addSignalExpense} from './receipt-signal-scenarios.mjs'
import {cleanSignalMeasurement} from './receipt-signals-clean.mjs'
import {withExif} from './fixtures/receipt-exif.mjs'
import {makeReceipt,addTextMetadata} from './fixtures/receipt-metadata.mjs'

const corpus=JSON.parse(await readFile('tests/fixtures/receipt-metadata-clean.json','utf8'))
const splitCategory=results=>results.flatMap(r=>r.signals).find(s=>s.code==='split-charge').evidence.category
const upload=async(h,who,claim,record,bytes=makeReceipt(record))=>{
 const r=await h.post(`claims/${claim.id}/receipts`,{version:claim.version,name:record.id+'.'+(record.ext??'png'),base64:bytes.toString('base64')},who)
 return h.post(`claims/${claim.id}/items`,{version:r.claim.version,kind:'receipt',date:record.date,merchant:record.merchant,amount:String(record.amount),receipt:r.receipt,allocations:[{category:record.category}]},who)
}

test('POLICY-002 metadata signals name computable software/date evidence, never gate reimbursement, and finance records a human reason without changing the frozen evidence',async()=>{
 const h=await harness();try{
 const t=await agency(h),record={...corpus[0],id:'EDITED-POSSIBLE',category:t.c.office,merchant:'Harbour stationery',amount:40,software:'Adobe Photoshop 2026',imageDate:'2026-06-19',date:'2026-06-16'}
 const bytes=makeReceipt(record)
 let c=await h.post('claims',{title:'Possible metadata edit'},t.sam)
 c=await upload(h,t.sam,c,record,bytes)
 await h.post('settings/approval-rule',{enabled:true,limit:'100'})
 c=await h.post(`claims/${c.id}/submit`,{version:c.version},t.sam)
 assert.equal(c.status,'approved','a metadata flag does not prevent the existing owner rule from approving')
 const detail=await h.get(`claims/${c.id}`,t.morgan),evidence=detail.revisions[0].snapshot.receiptSignals[0]
 assert.deepEqual(detail.exceptions,[],'metadata signals never become submission-blocking policy exceptions')
 assert.deepEqual(evidence.signals.map(s=>s.code),['editing-software','image-date-mismatch'])
 assert.ok(evidence.signals.every(s=>s.label==='possible, needs review'))
 assert.match(evidence.signals[0].reason,/Adobe Photoshop/)
 assert.match(evidence.signals[1].reason,/2026-06-19.*2026-06-16/)
 assert.match(evidence.signals[1].reason,/Later photographs can be legitimate/)
 assert.equal(evidence.sha256,createHash('sha256').update(bytes).digest('hex'))
 assert.equal(evidence.fields.software,record.software)
 assert.equal(evidence.image.status,'checked',JSON.stringify(evidence.image))
 const body={revision:1,item:evidence.item,code:'editing-software',note:'Legitimate supplier preparation; finance reviewed the original.'}
 const review=()=>h.post(`claims/${c.id}/receipt-signals/review`,body,t.morgan)
 for(const cookie of [t.sam,t.priya])await h.post(`claims/${c.id}/receipt-signals/review`,body,cookie,403)
 await h.get(`claims/${c.id}`,t.alex,403)
 let batch=await h.post('batches',{claims:[c.id]},t.morgan)
 batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:4000},t.morgan)
 await h.paid(batch.id,batch.version,{reference:'EXTERNAL-PAID',paidOn:'2026-06-20'},t.morgan)
 assert.equal((await h.get(`claims/${c.id}`,t.sam)).claim.status,'reimbursed','unresolved metadata signals never delay a person-released payment')
 await review();await h.post(`claims/${c.id}/receipt-signals/review`,body,t.morgan,409)
 const after=await h.get(`claims/${c.id}`,t.morgan)
 assert.deepEqual(after.revisions[0].snapshot.receiptSignals[0],evidence)
 assert.equal(after.claim.status,'reimbursed')
 const resolved=after.events.find(e=>e.action==='receipt-signal-reviewed')
 assert.equal(resolved.actor_email,'morgan@harbourfinch.example');assert.equal(resolved.detail.note,body.note)
 assert.equal(resolved.detail.reason,evidence.signals[0].reason)
 // Real little- and big-endian TIFF IFDs in a JPEG identify only their actual metadata.
 const jpeg=await readFile('tests/fixtures/receipts/report-bistro.jpg')
 for(const little of [true,false]){
  let image=await h.post('claims',{title:'Exif '+little},t.alex)
  image=await upload(h,t.alex,image,{...record,id:'EXIF-'+little,ext:'jpg',merchant:'JPEG supplier '+little},withExif(jpeg,{little}))
  image=await h.post(`claims/${image.id}/submit`,{version:image.version},t.alex)
  const result=(await h.get(`claims/${image.id}`,t.morgan)).revisions[0].snapshot.receiptSignals[0]
  assert.equal(result.fields.software,'GIMP 3.0');assert.equal(result.fields.dateTimeOriginal,'2026:06:19 12:00:00')
  assert.deepEqual(result.signals.filter(s=>['editing-software','image-date-mismatch'].includes(s.code)).map(s=>s.code),['editing-software','image-date-mismatch'])
 }
 // Stripped metadata, arbitrary trailing text and a damaged metadata chunk never invent a flag.
 const stripped=makeReceipt({...record,software:undefined,imageDate:undefined}),damaged=addTextMetadata(stripped,'Software','Adobe Photoshop');damaged[damaged.indexOf(Buffer.from('tEXt'))+8]^=1
 for(const [index,clean] of [stripped,Buffer.concat([stripped,Buffer.from('Software Adobe Photoshop')]),damaged].entries()){
  let plain=await h.post('claims',{title:'No metadata '+index},t.alex)
  plain=await upload(h,t.alex,plain,{...record,id:'NO-META-'+index,merchant:'Unflagged merchant '+index},clean)
  plain=await h.post(`claims/${plain.id}/submit`,{version:plain.version},t.alex)
  const observed=(await h.get(`claims/${plain.id}`,t.morgan)).revisions[0].snapshot.receiptSignals[0]
  assert.equal(observed.status,'no metadata to check');assert.deepEqual(observed.signals.filter(s=>['editing-software','image-date-mismatch'].includes(s.code)),[])
  if(index===1)assert.ok(observed.signals.some(s=>s.code==='near-duplicate-image'),'the same pixels with different metadata still raise the image comparison')
 }
 }finally{await h.close()}
})

test('POLICY-002 combined detectors stay within the 300 legitimate expense false-positive bound across 20 employees',cleanSignalMeasurement)

test('POLICY-002 exact, cropped, photographed and visibly changed receipts name comparative evidence across employees',async()=>{
 const h=await harness();try {
  const t=await agency(h)
  await imageSignalCases(h,t)
 }finally{await h.close()}
})

test('POLICY-002 split and round/weekend patterns enter the finance queue and reviewed reasons never gate reimbursement',async()=>{
 const h=await harness();try {
  const t=await agency(h),{claim:c,results}=await patternSignalCases(h,t)
  const queue=await h.get('exceptions',t.morgan),signals=queue.open.filter(x=>x.signal&&x.claim===c.id)
  assert.ok(signals.length>=4)
  assert.ok(signals.every(s=>s.message&&s.evidence))
  const target=signals.find(s=>s.code==='split-charge'),frozen=JSON.stringify(results)
  const review={claim:c.id,revision:c.revision,item:target.item,code:target.code,note:'Legitimate separate equipment purchases; original supplier records checked.'}
  await h.post('exceptions/review',review,t.sam,403)
  await h.post('exceptions/review',{...review,note:''},t.morgan,400)
  const reviewed=await h.post('exceptions/review',review,t.morgan)
  assert.ok(!reviewed.open.some(s=>s.claim===c.id&&s.item===target.item&&s.code===target.code))
  await h.post('exceptions/review',review,t.morgan,409)
  let approved=await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved',acknowledge:true},t.priya)
  let batch=await h.post('batches',{claims:[c.id]},t.morgan)
  batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:approved.total_minor},t.morgan)
  await h.paid(batch.id,batch.version,{reference:'synthetic-coaster-401',paidOn:'2026-06-20'},t.morgan)
  const after=await h.get(`claims/${c.id}`,t.morgan)
  assert.equal(after.claim.status,'reimbursed');assert.equal(JSON.stringify(after.revisions.at(-1).snapshot.receiptSignals),frozen)
  assert.equal(after.events.find(e=>e.action==='receipt-signal-reviewed').detail.note,review.note)
  assert.ok((await h.get('exceptions',t.morgan)).open.some(s=>s.signal&&s.claim===c.id),'other unresolved signals survive payment')
  const category=splitCategory(results)
  let later=await h.post('claims',{title:'Purchase reported separately'},t.sam)
  const record={...corpus[0],id:'SYNTHETIC-COASTER-403',merchant:'Equipment House',amount:480,date:'2026-06-16',category,explanation:'A separate purchase, submitted on its own report'}
  later=await addSignalExpense(h,t.sam,later,record,makeReceipt(record))
  later=await h.post(`claims/${later.id}/submit`,{version:later.version},t.sam)
  const extra=(await h.get(`claims/${later.id}`,t.morgan)).revisions[0].snapshot.receiptSignals[0].signals.find(s=>s.code==='split-charge')
  assert.equal(extra.evidence.purchases.length,3,'the detector crosses submitted claims while earlier observations stay frozen')
 }finally{await h.close()}
})

test('POLICY-002 matched receipt and posted card differences show entered totals, tip and FX context without blocking approval',async()=>{
 const h=await harness();try {
  const t=await agency(h)
  const {claim}=await cardSignalCases(h,t,{
   async upload(bytes,name,who) {
    const form=new FormData();form.append('file',new Blob([bytes]),name)
    const request=new Request(h.origin+'/api/coaster/receipt-inbox',{method:'POST',headers:{origin:h.origin,cookie:who},body:form})
    const response=await h.mf.dispatchFetch(request.url,{method:'POST',headers:Object.fromEntries(request.headers),body:await request.arrayBuffer()})
    assert.equal(response.status,200);return (await response.json()).receipt
   },
   tick:async()=> (await h.mf.getWorker()).scheduled({scheduledTime:Date.now(),cron:'17 * * * *'})
  })
  let c=claim
  c=await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved'},t.priya)
  assert.equal(c.status,'approved');assert.equal(c.total_minor,0,'company-card charge remains non-reimbursable')
 }finally{await h.close()}
})
