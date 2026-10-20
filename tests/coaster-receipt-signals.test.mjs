import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {harness,agency} from './harness.mjs'
import {withExif} from './fixtures/receipt-exif.mjs'
import {makeReceipt,addTextMetadata} from './fixtures/receipt-metadata.mjs'

const corpus=JSON.parse(await readFile('tests/fixtures/receipt-metadata-clean.json','utf8'))
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
  assert.deepEqual(result.signals.map(s=>s.code),['editing-software','image-date-mismatch'])
 }
 // Stripped metadata, arbitrary trailing text and a damaged metadata chunk never invent a flag.
 const stripped=makeReceipt({...record,software:undefined,imageDate:undefined}),damaged=addTextMetadata(stripped,'Software','Adobe Photoshop');damaged[damaged.indexOf(Buffer.from('tEXt'))+8]^=1
 for(const [index,clean] of [stripped,Buffer.concat([stripped,Buffer.from('Software Adobe Photoshop')]),damaged].entries()){
  let plain=await h.post('claims',{title:'No metadata '+index},t.alex)
  plain=await upload(h,t.alex,plain,{...record,id:'NO-META-'+index,merchant:'Unflagged merchant '+index},clean)
  plain=await h.post(`claims/${plain.id}/submit`,{version:plain.version},t.alex)
  const observed=(await h.get(`claims/${plain.id}`,t.morgan)).revisions[0].snapshot.receiptSignals[0]
  assert.equal(observed.status,'no metadata to check');assert.deepEqual(observed.signals,[])
 }
 }finally{await h.close()}
})

test('POLICY-002 clean metadata fixture measurement covers 300 legitimate receipts across 20 employees with subscriptions, attendee-split meals and round amounts',async()=>{
 const h=await harness();try{
 const t=await agency(h),employees=[...new Set(corpus.map(r=>r.employee))]
 assert.ok(corpus.length>=300);assert.ok(employees.length>=20)
 let signalled=0,checked=0,noMetadata=0
 for(const employee of employees){
  const who=await h.person(employee,{employee:true},'priya@harbourfinch.example')
  let c=await h.post('claims',{title:'Metadata clean set '+employee},who)
  const records=corpus.filter(r=>r.employee===employee)
  for(const record of records)c=await upload(h,who,c,{...record,category:t.c.office})
  c=await h.post(`claims/${c.id}/submit`,{version:c.version},who)
  const evidence=(await h.get(`claims/${c.id}`,t.priya)).revisions[0].snapshot.receiptSignals
  assert.equal(evidence.length,records.length)
  for(const result of evidence){checked++;if(result.status==='no metadata to check')noMetadata++;if(result.signals.length)signalled++}
 }
 console.log(`POLICY-002 metadata clean-set false-positive rate: ${signalled}/${checked} (${(signalled/checked*100).toFixed(2)}%); ${noMetadata} stripped receipts`)
 assert.ok(signalled/checked<=0.02,'metadata detector stays within the declared clean-set false-positive bound')
 assert.ok(noMetadata>0)
 }finally{await h.close()}
})
