import assert from 'node:assert/strict'
import { makeReceipt } from './fixtures/receipt-metadata.mjs'
import { photographedCopy,croppedCopy,compressionGridCopy } from './fixtures/receipt-image-variants.mjs'

export const baseReceipt={id:'SYNTHETIC-COASTER-301',employee:'sam@harbourfinch.example',merchant:'Harbour stationery',date:'2026-06-16',amount:40}
export async function addSignalExpense(h,who,c,record,bytes) {
 if(bytes) {
  const r=await h.post(`claims/${c.id}/receipts`,{version:c.version,name:record.id+(bytes[0]===255?'.jpg':'.png'),base64:bytes.toString('base64')},who)
  c=r.claim;record={...record,receipt:r.receipt}
 }
 return h.post(`claims/${c.id}/items`,{version:c.version,kind:'receipt',date:record.date,merchant:record.merchant,amount:String(record.amount),receipt:record.receipt,allocations:[{category:record.category}],explanation:record.explanation??'',attendees:record.attendees??[]},who)
}
export async function imageSignalCases(h,t,suffix='') {
 const record={...baseReceipt,category:t.c.office,explanation:'Finance will review the original supplier invoice'},original=makeReceipt(record)
 let source=await h.post('claims',{title:'Original supplier invoice'+suffix},t.sam)
 source=await addSignalExpense(h,t.sam,source,record,original)
 source=await h.post(`claims/${source.id}/submit`,{version:source.version},t.sam)
 let c=await h.post('claims',{title:'Copies needing a human review'+suffix},t.alex)
 const variants=[['Exact original',original,40],['Photographed copy',photographedCopy(original),40],['Cropped copy',croppedCopy(original),40],['Changed visible total',makeReceipt({...record,amount:480}),480],['Visible compression grid',compressionGridCopy(original),40],['Recompressed original',photographedCopy(original,{crop:0,tilt:0,noise:0,quality:45}),40]]
 for(const [merchant,bytes,amount] of variants)c=await addSignalExpense(h,t.alex,c,{...record,merchant,amount,explanation:'Finance will review whether these are separate allocations'},bytes)
 c=await h.post(`claims/${c.id}/submit`,{version:c.version},t.alex)
 const detail=await h.get(`claims/${c.id}`,t.morgan),results=detail.revisions.at(-1).snapshot.receiptSignals
 for(const [index,code] of ['same-receipt','near-duplicate-image','near-duplicate-image','image-content-change','compression-grid','near-duplicate-image'].entries()) {
  assert.ok(results[index].signals.some(s=>s.code===code),`${variants[index][0]}: ${JSON.stringify(results[index].signals)}`)
  const signal=results[index].signals.find(s=>s.code===code)
  assert.equal(signal.label,'possible, needs review');assert.ok(signal.reason);assert.ok(signal.evidence)
 }
 return {claim:c,source,results}
}
export async function patternSignalCases(h,t,suffix='') {
 const category=await h.post('settings/categories',{name:'Equipment review'+suffix,accountCode:'6501',taxCode:'GST',limit:'500'})
 let c=await h.post('claims',{title:'Split and repeated spend observations'+suffix},t.sam)
 const cases=[
  {id:'SYNTHETIC-COASTER-401',merchant:'Equipment House',amount:480,date:'2026-06-16',category:category.id},
  {id:'SYNTHETIC-COASTER-402',merchant:'Equipment House',amount:480,date:'2026-06-16',category:category.id},
  ...['2026-06-06','2026-06-07','2026-06-13'].map((date,i)=>({id:'SYNTHETIC-COASTER-'+(410+i),merchant:'Weekend workshops',amount:100,date,category:t.c.office})),
 ]
 for(const [index,record] of cases.map(r=>({...r,id:r.id+suffix.trim(),merchant:r.merchant+suffix})).entries())c=await addSignalExpense(h,t.sam,c,{...record,employee:baseReceipt.employee,explanation:'Distinct project purchase, finance to review grouping'},index===1?undefined:makeReceipt({...record,employee:baseReceipt.employee}))
 c=await h.post(`claims/${c.id}/submit`,{version:c.version},t.sam)
 const detail=await h.get(`claims/${c.id}`,t.morgan),results=detail.revisions.at(-1).snapshot.receiptSignals
 for(const code of ['split-charge','round-amount-pattern','weekend-pattern'])assert.ok(results.some(r=>r.signals.some(s=>s.code===code)),code)
 const split=results[0].signals.find(s=>s.code==='split-charge')
 assert.deepEqual([split.evidence.limitMinor,split.evidence.totalMinor],[50000,96000])
 assert.equal(split.evidence.purchases.length,2)
 assert.equal(results[1].receipt,null,'receipt-less purchases participate in the same spend detector')
 assert.ok(results[1].signals.some(s=>s.code==='split-charge'))
 return {claim:c,results}
}

export async function cardSignalCases(h,t,{upload,tick,suffix=''}) {
 const issuer='Synthetic Coaster card'
 await h.post('statements/cards',{issuer,last4:'1111',employee:(await h.get('state',t.sam)).actor.email})
 const record={...baseReceipt,id:'SYNTHETIC-COASTER-501'+suffix,merchant:'Harbour Bistro'+suffix},bytes=makeReceipt(record)
 const original=await upload(bytes,'synthetic-coaster-501.png',t.sam)
 const notice="When this receipt matches one of your card charges, Coaster attaches it automatically. Approvers and finance can see the receipt, its file name and the total, currency and date you entered once that expense is submitted — by you, your delegate or the owner's scheduled submission."
 await h.post(`receipt-inbox/${original.id}/card-match`,{expectedSequence:original.lifecycleSequence,enabled:true,merchant:record.merchant,date:record.date,total:'40',currency:'AUD',last4:'1111',notice},t.sam)
 const statement={format:'csv',name:'synthetic-coaster-501'+suffix+'.csv',issuer,category:t.c.office,content:'Posted,Transaction,Merchant,Amount,Id\n2026-06-17,2026-06-16,'+record.merchant+',48.00,synthetic-coaster-501'+suffix,mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Posted',transactionDate:'Transaction',description:'Merchant',amount:'Amount',transactionId:'Id',wholeFileLast4:'1111'}}
 const preview=await h.post('statements/preview',statement,t.morgan),job=await h.post('statements/commit',{...statement,fingerprint:preview.fingerprint},t.morgan)
 await tick()
 let detail=await h.get(`claims/${job.claims[0]}`,t.sam)
 assert.ok(detail.items[0].receipt_id)
 const claim=await h.post(`claims/${detail.claim.id}/submit`,{version:detail.claim.version},t.sam)
 detail=await h.get(`claims/${claim.id}`,t.morgan)
 const signal=detail.revisions.at(-1).snapshot.receiptSignals[0].signals.find(s=>s.code==='card-disagreement')
 assert.deepEqual([signal.evidence.enteredTotalMinor,signal.evidence.postedMinor,signal.evidence.differenceMinor,signal.evidence.basis],[4000,4800,800,'tip'])
 assert.match(signal.reason,/tips and exchange differences can be legitimate/)
 assert.ok((await h.get('exceptions',t.morgan)).open.some(s=>s.code==='card-disagreement'&&s.claim===claim.id))
 return {claim,signal}
}
