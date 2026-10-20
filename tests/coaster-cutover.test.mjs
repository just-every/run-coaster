import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness } from './harness.mjs'

const input = async () => ({ csv: await readFile('tests/fixtures/expensify-cutover.csv','utf8'), filename:'september.csv', mapping:{date:'YYYY-MM-DD',statuses:{Open:'open',Submitted:'submitted',Approved:'approved',Reimbursed:'reimbursed'}} })

test('MOVE-005 cutover inventory accounts for every Expensify source record, identifies three open reports honestly, and reconciles undo and reimport without writes',async()=>{
 const h=await harness();try{
 const t=await agency(h),b=await input()
 assert.deepEqual((await h.get('import/cutover')).imports,[])
 const preview=await h.post('import/preview',b)
 assert.deepEqual((await h.get('import/cutover')).imports,[],'preview is not a moved source record')
 const moved=await h.post('import/commit',{...b,fingerprint:preview.fingerprint})
 const before=await h.get('state'),history=await h.get('history')
 const report=await h.get('import/cutover'),job=report.imports[0]
 assert.equal(report.feedReconciled,false);assert.equal(report.openItemsCarried,false)
 assert.deepEqual(job.counts,{source:9,historyOnly:3,openHistory:6,leftBehind:0,erased:0})
 assert.equal(job.openReports,3);assert.equal(job.expenseTotalMinor,36700)
 assert.deepEqual(job.records.filter(r=>r.kind==='expense').map(r=>r.sourceId).sort(),['CUT-T1','CUT-T2','CUT-T3','CUT-T4','CUT-T5'])
 assert.deepEqual(job.records.filter(r=>r.kind==='report').map(r=>r.sourceId).sort(),['CUT-1','CUT-2','CUT-3','CUT-4'])
 assert.equal(job.records.filter(r=>r.kind==='expense').reduce((n,r)=>n+r.amountMinor,0),job.expenseTotalMinor,'report headers never double-count expense money')
 assert.ok(job.records.every(r=>r.artifact==='september.csv'&&r.row>=2&&r.row<=6))
 assert.ok(job.records.filter(r=>r.disposition==='open-history').every(r=>r.reason.includes('not carried')))
 assert.deepEqual(await h.get('state'),before);assert.deepEqual(await h.get('history'),history,'reading never creates a claim, decision or audit write')
 for(const cookie of [t.sam,t.priya,t.morgan])await h.get('import/cutover',cookie,403)
 const replay=await h.post('import/commit',{...b,fingerprint:preview.fingerprint});assert.equal(replay.job.id,moved.job.id)
 assert.equal((await h.get('import/cutover')).imports.length,1)
 await h.post('import/undo',{id:moved.job.id,mappingVersion:moved.mappingVersion})
 const undone=(await h.get('import/cutover')).imports[0]
 assert.deepEqual(undone.counts,{source:9,historyOnly:0,openHistory:0,leftBehind:9,erased:0})
 assert.ok(undone.records.every(r=>r.reason==='Import undone'))
 const again=await h.post('import/commit',{...b,fingerprint:preview.fingerprint})
 const after=await h.get('import/cutover')
 assert.equal(after.imports.length,2);assert.equal(after.imports.find(j=>j.id===again.job.id).openReports,3)
 assert.equal(after.imports.find(j=>j.id===moved.job.id).counts.leftBehind,9,'a later reimport never changes the undone job disposition')
 assert.equal((await h.get('state')).claims.length,0,'open history never claims approval or reimbursement')
 }finally{await h.close()}
})


test('MOVE-005 three open reports carry into normal approval and reimbursement once, preserving reservations through undo and reimport',async()=>{
 const h=await harness();try{
 const t=await agency(h),b=await input(),preview=await h.post('import/preview',b)
 const moved=await h.post('import/commit',{...b,fingerprint:preview.fingerprint})
 const carry=(report,categories,cookie,status)=>h.post('import/carry',{report,categories},cookie,status)
 const claims=[]
 await carry('CUT-1',{'CUT-T1':t.c.office},t.alex,404)
 await carry('CUT-4',{'CUT-T4':t.c.travel},t.alex,409)
 await carry('CUT-1',{'CUT-T1':'missing'},t.sam,400)
 assert.equal((await h.get('state',t.sam)).claims.length,0,'failed mapping writes no draft or reservation')
 const results=await Promise.all([carry('CUT-1',{'CUT-T1':t.c.office},t.sam).then(c=>({c})).catch(e=>({error:e})),carry('CUT-1',{'CUT-T1':t.c.office},t.sam).then(c=>({c})).catch(e=>({error:e}))])
 assert.equal(results.filter(r=>r.c).length,1,'concurrent carry reserves a report once')
 assert.match(results.find(r=>r.error).error.message,/409/,'losing concurrent carry is a conflict, never a server error')
 claims.push([results.find(r=>r.c).c,t.sam])
 claims.push([await carry('CUT-2',{'CUT-T2':t.c.meals},t.sam),t.sam])
 claims.push([await carry('CUT-3',{'CUT-T3':t.c.travel},t.alex),t.alex])
 assert.equal((await h.get('import/cutover')).imports[0].carriedReports,3)
 assert.equal((await h.get('import/cutover')).openItemsCarried,true)
 for(let [c,cookie] of claims){
  assert.equal(c.status,'draft','source approval is never native payment authority')
  await h.post('batches',{claims:[c.id]},t.morgan,409)
  const d=await h.get(`claims/${c.id}`,cookie),i=d.items[0]
  c=await h.post(`claims/${c.id}/items`,{version:c.version,item:i.id,kind:'receipt',date:i.spent_on,merchant:i.merchant,amount:(i.amount_minor/100).toFixed(2),category:i.allocations[0].category_id,explanation:'Carried from source; original report retained for review'},cookie)
  c=await h.post(`claims/${c.id}/submit`,{version:c.version},cookie)
  c=await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved',acknowledge:true},t.priya)
  const batch=await h.post('batches',{claims:[c.id]},t.morgan)
  const reviewed=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:c.total_minor},t.morgan)
  await h.paid(batch.id,reviewed.version,{reference:'outside-bank-test',paidOn:'2026-10-20'},t.morgan)
  assert.equal((await h.get(`claims/${c.id}`,cookie)).claim.status,'reimbursed')
  await h.post('batches',{claims:[c.id]},t.morgan,409)
 }
 await carry('CUT-1',{'CUT-T1':t.c.office},t.sam,409)
 await h.post('import/undo',{id:moved.job.id,mappingVersion:moved.mappingVersion})
 await carry('CUT-1',{'CUT-T1':t.c.office},t.sam,404)
 const reimport=await h.post('import/commit',{...b,fingerprint:preview.fingerprint})
 await carry('CUT-1',{'CUT-T1':t.c.office},t.sam,409)
 const inventory=await h.get('import/cutover')
 assert.equal(inventory.imports.find(j=>j.id===reimport.job.id).carriedReports,3)
 assert.ok(inventory.imports.find(j=>j.id===reimport.job.id).records.filter(r=>r.carriedClaim).every(r=>r.reason.includes('never cancels')))
 assert.equal((await h.get('state')).claims.length,3)
 assert.equal((await h.get('history')).lines.filter(e=>e.action==='open-report-carried').length,3)
 }finally{await h.close()}
})


test('MOVE-005 carry excludes non-reimbursable card spend and refuses mileage without partial writes',async()=>{
 const h=await harness();try{
 const t=await agency(h),b=await input()
 const line=b.csv.trim().split('\n')[1].replace('CUT-T1','CUT-CARD').replace('Harbour stationery','Company card stationery').replace(',true',',false')
 b.csv+=line+'\n'
 let preview=await h.post('import/preview',b)
 await h.post('import/commit',{...b,fingerprint:preview.fingerprint})
 const c=await h.post('import/carry',{report:'CUT-1',categories:{'CUT-T1':t.c.office}},t.sam)
 assert.equal(c.total_minor,2400,'non-reimbursable card row is not part of the draft')
 const job=(await h.get('import/cutover')).imports[0]
 assert.equal(job.records.find(r=>r.sourceId==='CUT-CARD').carriedClaim,undefined)
 assert.equal(job.carriedReports,1)
 b.csv=(await input()).csv.trim().split('\n').map((line,i)=>line+(i===0?',isDistance':i===1?',true':',false')).join('\n').replaceAll('CUT-','MILE-')
 preview=await h.post('import/preview',b)
 await h.post('import/commit',{...b,fingerprint:preview.fingerprint})
 await h.post('import/carry',{report:'MILE-1',categories:{'MILE-T1':t.c.office}},t.sam,409)
 assert.equal((await h.get('state',t.sam)).claims.length,1,'unsupported mileage carries no partial draft')
 }finally{await h.close()}
})
