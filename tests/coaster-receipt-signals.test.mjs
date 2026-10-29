import { preserveReceiptSignals1 } from './journeys/receipt-signals-1.mjs'
import { cleanSignalMeasurement } from './journeys/receipt-signal-population.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {harness,agency} from './harness.mjs'
import { imageSignalCases, patternSignalCases } from './receipt-signal-scenarios.mjs'
import { makeReceipt } from './fixtures/receipt-metadata.mjs'

const corpus=JSON.parse(await readFile('tests/fixtures/receipt-metadata-clean.json','utf8'))
const splitCategory=results=>results.flatMap(r=>r.signals).find(s=>s.code==='split-charge').evidence.category
const upload=async(h,who,claim,record,bytes=makeReceipt(record))=>{
 const r=await h.post(`claims/${claim.id}/receipts`,{version:claim.version,name:record.id+'.'+(record.ext??'png'),base64:bytes.toString('base64')},who)
 return h.post(`claims/${claim.id}/items`,{version:r.claim.version,kind:'receipt',date:record.date,merchant:record.merchant,amount:String(record.amount),receipt:r.receipt,allocations:[{category:record.category}]},who)
}

test('Finance investigates related split and edited receipts across employees without contacting them or changing payment, and records a human outcome', async () => {
  await preserveReceiptSignals1()
  await cleanSignalMeasurement()
  await (async()=>{
 const h=await harness();try{
  const t=await agency(h)
  await imageSignalCases(h,t)
  const patterns=await patternSignalCases(h,t),category=splitCategory(patterns.results)
  let edited=await h.post('claims',{title:'Related supplier evidence'},t.alex)
  const record={...corpus[0],id:'synthetic-coaster-690',merchant:'Equipment House',category,amount:480,date:'2026-06-16',software:'Adobe Photoshop 2026',imageDate:'2026-06-19'}
  edited=await upload(h,t.alex,edited,record,makeReceipt(record));edited=await h.post(`claims/${edited.id}/submit`,{version:edited.version},t.alex)
  let privateClaim=await h.post('claims',{title:'synthetic-coaster-691 private'},t.sam)
  privateClaim=await upload(h,t.sam,privateClaim,{...record,id:'synthetic-coaster-691',merchant:'Equipment House'},makeReceipt({...record,id:'synthetic-coaster-691'}))
  const before=await h.get(`claims/${edited.id}`,t.morgan),messages=h.messages.length,outbound=h.outbound.length
  const packs=await h.get('investigations',t.morgan),pack=packs.packs.find(p=>p.records.some(r=>r.claim===edited.id))
  assert.ok(pack);assert.equal(pack.employees.length,2);assert.equal(pack.records.length,3)
  assert.ok(pack.records.some(r=>r.signals.some(s=>s.code==='split-charge')))
  assert.ok(pack.records.some(r=>r.signals.some(s=>s.code==='editing-software')))
  assert.ok(pack.records.some(r=>r.receipt?.sha256));assert.ok(!JSON.stringify(packs).includes(privateClaim.id))
  assert.deepEqual(await h.get('investigations',t.morgan),packs,'repeated reads assemble one stable pack per connected pattern')
  for(const who of [t.sam,t.alex,t.priya])await h.get('investigations',who,403)
  const key=await h.post('agent-keys',{label:'synthetic-coaster-692'},t.morgan)
  assert.equal((await h.send('/api/coaster/investigations',undefined,'',{authorization:'Bearer '+key.token})).status,401)
  const file=await h.send(`/api/coaster/investigations/${pack.id}/download`,undefined,t.morgan)
  assert.equal(file.status,200);assert.match(file.headers.get('content-type'),/zip/)
  const rawDownload=await h.mf.dispatchFetch(h.origin+`/api/coaster/investigations/${pack.id}/download`,{headers:{cookie:t.morgan}}),archive=Buffer.from(await rawDownload.arrayBuffer())
  assert.ok(archive.includes(Buffer.from('evidence.json')));assert.ok(archive.includes(makeReceipt(record)),'the public ZIP contains the exact original image bytes')
  assert.equal(h.messages.length,messages);assert.equal(h.outbound.length,outbound)
  assert.deepEqual(await h.get(`claims/${edited.id}`,t.morgan),before)
  const outcome={outcome:'explained',note:'Supplier originals checked; separate purchases confirmed.'}
  await h.post(`investigations/${pack.id}/outcome`,outcome,t.sam,403)
  await h.post(`investigations/${pack.id}/outcome`,{...outcome,note:''},t.morgan,400)
  const reviewed=(await h.post(`investigations/${pack.id}/outcome`,outcome,t.morgan)).packs.find(p=>p.id===pack.id)
  assert.equal(reviewed.outcome.by,'morgan@harbourfinch.example');assert.equal(reviewed.outcome.note,outcome.note)
  await h.post(`investigations/${pack.id}/outcome`,outcome,t.morgan,409)
  assert.equal(h.messages.length,messages);assert.deepEqual(await h.get(`claims/${edited.id}`,t.morgan),before)
  const approved=await h.post(`claims/${edited.id}/decision`,{version:edited.version,revision:edited.revision,decision:'approved',acknowledge:true},t.priya)
  let batch=await h.post('batches',{claims:[edited.id]},t.morgan)
  batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:approved.total_minor},t.morgan)
  await h.paid(batch.id,batch.version,{reference:'synthetic-coaster-693',paidOn:'2026-06-20'},t.morgan)
  assert.equal((await h.get(`claims/${edited.id}`,t.morgan)).claim.status,'reimbursed')
 }finally{await h.close()}
})()
})