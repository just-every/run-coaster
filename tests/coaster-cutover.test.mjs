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
