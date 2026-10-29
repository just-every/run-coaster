import { preserveConcurCustody1 } from './journeys/concur-custody-1.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { harness, agency } from './harness.mjs'

const fixture = name => readFile(`tests/fixtures/concur-${name}`)
const config = () => {
 const employee=crypto.randomUUID(),manager=crypto.randomUUID(),category=crypto.randomUUID()
 return {members:[{key:employee,email:'concur-employee@harbourfinch.example',name:'Concur Employee',employee:true},{key:manager,email:'concur-manager@harbourfinch.example',name:'Concur Manager',manager:true}],categories:[{key:category,name:'Concur Meals',accountCode:'6320',taxCode:'NONE'}],chains:[{key:crypto.randomUUID(),employee,steps:[manager]}],policies:[{key:crypto.randomUUID(),name:'US company policy',rules:[{kind:'per-expense-limit',category,limit:'70.00',hard:false}]}]}
}
async function setup(h){const team=await agency(h);await h.post('settings/business',{name:'Harbour & Finch Studio',currency:'USD',timezone:'America/Chicago',perDiem:'75.00',receiptThreshold:'75.00'});return team}
async function reviewed(h,data){const raw=JSON.stringify(data,null,2)+'\n',p=await h.post('import/preview',{source:'concur',configuration:raw,mapping:{crosswalk:{}}});return {source:'concur',configuration:raw,mapping:{crosswalk:p.summary.crosswalk},fingerprint:p.fingerprint,preview:p}}
const undo=(h,r)=>h.post('import/undo',{source:'concur',id:r.job.id,mappingVersion:r.mappingVersion})
const status=(h,r)=>h.post('import/status',{source:'concur',id:r.job.id,mappingVersion:r.mappingVersion})
async function historyInput(category,email='concur-employee@harbourfinch.example',layout='sae-v4'){
 return {source:'concur',csv:(await fixture(layout==='sae-v4'?'sae-v4.txt':'accounting.csv')).toString(),filename:layout==='sae-v4'?'concur-accounting.txt':'concur-accounting.csv',mapping:{layout,employees:{'EMP-17':email},categories:{'Business Meals':category}},receipts:{archive:{name:'concur-receipts.zip',base64:(await fixture('receipts.zip')).toString('base64')}}}
}

test('MOVE-002 owner previews, maps and imports Concur configuration and allocated SAE history with indexed receipts; native policy and chain work and undo compensates without rewriting history', async () => {
  await preserveConcurCustody1()
  await (async()=>{
 const h=await harness();try{
 const team=await setup(h)
 await h.post('policy',{rules:[{kind:'blocked-merchant',merchant:'Personal vendor',hard:true}]})
 const data=config(),before=(await h.get('state')).members.length,mail=h.messages.length,baseline=(await h.get('policy')).versions[0]
 const reviewedConfig=await reviewed(h,data)
 assert.equal((await h.get('import')).jobs.length,0);assert.equal((await h.get('state')).members.length,before)
 await h.post('import/commit',reviewedConfig,team.jordan,403)
 const adopted=await h.post('import/commit',reviewedConfig),state=await h.get('state'),person=state.members.find(m=>m.email===data.members[0].email),cat=state.categories.find(c=>c.name==='Concur Meals')
 assert.equal(person.active,0);assert.equal(h.messages.length,mail);assert.equal(cat.account_code,'6320')
 const active=(await h.get('policy')).versions[0]
 assert.equal(active.rules.find(r=>r.category===cat.id).limit_minor,7000)
 assert.ok(active.rules.some(r=>r.kind==='blocked-merchant'&&r.merchant==='Personal vendor'&&r.hard),'source policy adds to existing finance rules')
 assert.equal(active.configuration.receipt_threshold_minor,baseline.configuration.receipt_threshold_minor)
 for(const floor of baseline.configuration.categories)assert.deepEqual(active.configuration.categories.find(c=>c.id===floor.id),floor,'owner category floor is unchanged')
 const input=await historyInput(cat.id),p=await h.post('import/preview',input)
 assert.deepEqual([p.summary.reports,p.summary.expenses,p.summary.journals,p.summary.totalMinor,p.summary.receipts],[1,2,3,8500,2])
 assert.equal((await h.get('import')).history.filter(r=>r.source==='concur').length,0)
 await h.post('import/commit',{...input,csv:input.csv.replace('90.0000','91.0000'),fingerprint:p.fingerprint},undefined,409)
 const imported=await h.post('import/commit',{...input,fingerprint:p.fingerprint}),history=(await h.get('import')).history
 const lunch=history.find(r=>r.transactionId==='E-100'),refund=history.find(r=>r.transactionId==='E-101'),report=history.find(r=>r.source==='concur'&&r.kind==='report')
 assert.equal(lunch.amountMinor,9000);assert.deepEqual(lunch.allocations.map(a=>a.amountMinor),[5400,3600]);assert.equal(refund.amountMinor,-500)
 assert.equal(lunch.receipts[0].entry,'E-100');assert.equal(report.receipts[0].entry,null)
 const originals=await status(h,imported),kept=Object.fromEntries(originals.originals.map(o=>[o.name,o]))
 assert.equal(Buffer.from(kept['concur-accounting.txt'].original.base64,'base64').toString(),input.csv)
 assert.deepEqual(Buffer.from(kept['concur-receipts.zip'].original.base64,'base64'),await fixture('receipts.zip'))
 const configOriginal=await status(h,adopted);assert.equal(Buffer.from(configOriginal.originals.find(o=>o.name==='concur-configuration.json').original.base64,'base64').toString(),reviewedConfig.configuration)
 const manager=await h.person(data.members[1].email,{employee:true,manager:true}),employee=await h.person(data.members[0].email,{employee:true},data.members[1].email)
 let claim=await h.post('claims',{title:'Meal after Concur cutover'},employee)
 const upload=await h.post(`claims/${claim.id}/receipts`,{version:claim.version,name:'meal.png',base64:(await readFile('tests/fixtures/receipts/officeworks.png')).toString('base64')},employee)
 claim=await h.post(`claims/${claim.id}/items`,{version:upload.claim.version,kind:'receipt',date:'2026-10-01',merchant:'Team dinner',amount:'80.00',receipt:upload.receipt,explanation:'Client event exception',allocations:[{category:cat.id}]},employee)
 const view=await h.get(`claims/${claim.id}`,employee);assert.ok(view.exceptions.some(e=>e.code==='over-limit'||e.code==='over-per-expense-limit'))
 claim=await h.post(`claims/${claim.id}/submit`,{version:claim.version},employee)
 assert.equal(claim.approver_email,data.members[1].email)
 const frozen=await h.get(`claims/${claim.id}`,manager)
 let reclaim=await h.post('claims',{title:'Prior Concur lunch'},employee)
 reclaim=await h.post(`claims/${reclaim.id}/items`,{version:reclaim.version,kind:'receipt',date:'2026-09-01',merchant:'Union Station Grill',amount:'90',category:cat.id},employee)
 assert.ok((await h.get(`claims/${reclaim.id}`,employee)).exceptions.some(e=>e.code==='possible-duplicate'&&e.message.includes('SAP Concur expense E-100')),'imported expense history flags a later reclaim')
 await undo(h,imported);assert.equal((await h.get('import')).history.filter(r=>r.source==='concur').length,0)
 await undo(h,adopted)
 assert.deepEqual((await h.get('policy')).versions[0].rules,baseline.rules)
 assert.deepEqual((await h.get(`claims/${claim.id}`,manager)).revisions,frozen.revisions)
 assert.ok((await h.get('policy')).versions.some(v=>v.rules.some(r=>r.category===cat.id)), 'adopted policy history remains readable')
 assert.ok((await h.get('state')).members.some(m=>m.member_id===person.member_id&&m.active===1))
 assert.ok((await h.get('state')).categories.some(c=>c.id===cat.id),'used native category survives undo')
 }finally{await h.close()}
})()
})