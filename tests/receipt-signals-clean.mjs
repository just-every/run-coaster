import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { harness, agency } from './harness.mjs'
import { makeReceipt } from './fixtures/receipt-metadata.mjs'
import { photographedCopy } from './fixtures/receipt-image-variants.mjs'

/** Full public submission/finance queue population; no detector is switched off. */
export async function cleanSignalMeasurement() {
 const corpus=JSON.parse(await readFile('tests/fixtures/receipt-metadata-clean.json','utf8'))
 const h=await harness();try {
  const t=await agency(h), employees=[...new Set(corpus.map(r=>r.employee))]
  assert.ok(corpus.length>=300);assert.ok(employees.length>=20)
  let signalled=0,checked=0,noMetadata=0;const raised=[]
  for(const employee of employees) {
   const who=await h.person(employee,{employee:true},'priya@harbourfinch.example')
   let c=await h.post('claims',{title:'Legitimate expenses '+employee},who)
   const records=corpus.filter(r=>r.employee===employee)
   for(const record of records) {
    const png=makeReceipt(record),bytes=record.media==='image/jpeg'?photographedCopy(png,{crop:0,tilt:0,noise:0,quality:92}):png, r=await h.post(`claims/${c.id}/receipts`,{version:c.version,name:record.id+(record.media==='image/jpeg'?'.jpg':'.png'),base64:bytes.toString('base64')},who)
    const count=Number(record.scenario.match(/(\d+) attendees/)?.[1]??0)
    const attendees=Array.from({length:count},(_,n)=>({kind:'guest',name:'Team attendee '+(n+1)}))
    c=await h.post(`claims/${c.id}/items`,{version:r.claim.version,kind:'receipt',date:record.date,merchant:record.merchant,amount:String(record.amount),receipt:r.receipt,allocations:[{category:t.c.office}],attendees},who)
   }
   c=await h.post(`claims/${c.id}/submit`,{version:c.version},who)
   const detail=await h.get(`claims/${c.id}`,t.morgan), evidence=detail.revisions[0].snapshot.receiptSignals
   assert.equal(evidence.length,records.length)
   for(const result of evidence) {
    checked++;if(result.status==='no metadata to check')noMetadata++
    assert.equal(result.image.status,'checked','clean image participates in the content detector')
    const duplicates=detail.exceptions.filter(e=>e.item===result.item&&['duplicate-receipt','possible-duplicate'].includes(e.code))
    if(result.signals.length||duplicates.length) {signalled++;raised.push({item:result.item,signals:result.signals,duplicates})}
    for(const signal of result.signals) {assert.ok(signal.reason);assert.equal(signal.label,'possible, needs review')}
   }
  }
  const queue=await h.get('exceptions',t.morgan)
  const result={expenses:checked,employees:employees.length,signalled,percent:Number((signalled/checked*100).toFixed(2)),strippedReceipts:noMetadata,raised,queueSignals:queue.open.filter(x=>x.signal).length,formats:corpus.reduce((totals,r)=>(totals[r.media]=(totals[r.media]??0)+1,totals),{})}
  console.log('POLICY-002 combined clean-set measurement '+JSON.stringify({...result,raised:raised.slice(0,6)}))
  assert.ok(signalled/checked<=0.02,JSON.stringify({...result,raised:raised.slice(0,6)}))
  assert.ok(noMetadata>0)
  assert.equal(result.queueSignals,raised.reduce((n,r)=>n+r.signals.length,0),'all raised signals reach finance')
  return result
 } finally {await h.close()}
}
