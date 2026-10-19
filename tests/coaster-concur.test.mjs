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
async function importHistory(h,b){const p=await h.post('import/preview',b);assert.deepEqual(p.summary.errors,[]);return h.post('import/commit',{...b,fingerprint:p.fingerprint})}

test('MOVE-002 owner previews, maps and imports Concur configuration and allocated SAE history with indexed receipts; native policy and chain work and undo compensates without rewriting history',async()=>{
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
})

test('MOVE-002 refuses bank/PAN originals and unsupported rules before persistence, binds reviewed mappings and preserves later native policy edits on undo',async()=>{
 const h=await harness();try{
 const team=await setup(h),data=config(),b=await reviewed(h,data),count=async()=>(await h.get('import')).jobs.length
 for(const rule of [{kind:'unsupported-concur-rule'},{kind:'per-expense-limit',category:data.categories[0].key,limit:'70',scope:'Sales'}]){
  const invalid={...data,policies:[{...data.policies[0],rules:[rule]}]},bad=await reviewed(h,invalid)
  assert.ok(bad.preview.summary.errors.some(e=>/unsupported|supported/i.test(e)))
  await h.post('import/commit',bad,undefined,409);assert.equal(await count(),0)
 }
 await h.post('import/preview',{source:'concur',configuration:{...data,members:[{...data.members[0],bankAccountNumber:'synthetic-bank-field'},data.members[1]]}},undefined,400)
 assert.equal(await count(),0)
 const input=await historyInput(team.c.meals,'sam@harbourfinch.example')
 for(const position of [16,17,130,154,291,302]){
  const rows=input.csv.trimEnd().split('\n'),cells=rows[1].split('|');cells[position-1]='synthetic-sensitive-field';rows[1]=cells.join('|')
  const rejected=await h.post('import/preview',{...input,csv:rows.join('\n')+'\n'},undefined,400)
  assert.match(rejected.error,/Export without banking fields/);assert.ok(!JSON.stringify(rejected).includes('synthetic-sensitive-field'))
 }
 const header=await historyInput(team.c.meals,'sam@harbourfinch.example','headers')
 await h.post('import/preview',{...header,csv:header.csv.replace('Cost Center','ACH_Bank_Account_Number')},undefined,400);assert.equal(await count(),0)
 const changedMapping={...header,mapping:{...header.mapping,categories:{'Business Meals':team.c.travel}}},p=await h.post('import/preview',header)
 await h.post('import/commit',{...changedMapping,fingerprint:p.fingerprint},undefined,409)
 const adopted=await h.post('import/commit',b)
 await h.post('policy',{rules:[{kind:'blocked-merchant',merchant:'Personal purchases',hard:true}]})
 const later=(await h.get('policy')).versions[0];await undo(h,adopted)
 assert.deepEqual((await h.get('policy')).versions[0],later,'undo does not replace later native policy edits')
 const report=await status(h,adopted);assert.ok(report.undo.dispositions.some(d=>d.targetKind==='concur-policy'&&d.disposition==='retained'))
 const validHeader=await h.post('import/preview',header);assert.deepEqual(validHeader.summary.errors,[])
 const headerJob=await h.post('import/commit',{...header,fingerprint:validHeader.fingerprint})
 assert.equal((await h.get('import')).history.filter(r=>r.source==='concur'&&r.kind==='expense').reduce((n,r)=>n+r.amountMinor,0),8500,'documented header exports import through the same lifecycle')
 await undo(h,headerJob)
 }finally{await h.close()}
})

test('MOVE-002 erasure withdraws upstream-id-only extract/archive originals by employee provenance and status, undo and reimport cannot restore identity',async()=>{
 const h=await harness();try{
 await setup(h);const data=config(),b=await reviewed(h,data),configuration=await h.post('import/commit',b),category=(await h.get('state')).categories.find(c=>c.name==='Concur Meals')
 const input=await historyInput(category.id),imported=await importHistory(h,input)
 assert.ok(!input.csv.includes(data.members[0].email)&&!input.csv.includes(data.members[0].name))
 await h.post('settings/members/erase',{email:data.members[0].email})
 const retained=await status(h,imported)
 const withdrawnBytes=[Buffer.from(input.csv).toString('base64'),input.receipts.archive.base64]
 for(const bytes of withdrawnBytes) assert.ok(!retained.originals.some(o=>o.original.status==='retained'&&o.original.base64===bytes),'erasure withdraws exact extract/archive bytes even when custody anonymizes their names')
 assert.equal(retained.originals.filter(o=>o.original.status==='unavailable').length,3,'extract, ZIP and employee-index originals are withdrawn')
 await undo(h,imported);await undo(h,configuration)
 await h.post('import/commit',b,undefined,409)
 await h.post('import/preview',input,undefined,409)
 await h.post('import/commit',{...input,fingerprint:imported.fingerprint},undefined,409)
 const tables=(await h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results
 for(const {name} of tables)for(const row of (await h.db.prepare(`SELECT * FROM "${name}"`).all()).results)for(const value of Object.values(row)){
  const text=typeof value==='object'&&value!==null?Buffer.from(value instanceof ArrayBuffer?value:value.buffer??[]).toString():String(value)
  assert.ok(!text.includes(data.members[0].email)&&!text.includes(data.members[0].name),`${name} cannot restore erased identity`)
 }
 }finally{await h.close()}
})
