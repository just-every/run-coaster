// Assertion phases used by the surviving public-door journey.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { harness, agency } from '../harness.mjs'

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

export async function preserveConcurCustody1() {
  // MOVE-002 refuses bank/PAN originals and unsupported rules before persistence, binds reviewed mappings and preserves later native policy edits on undo
  await (async()=>{
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
})()
  // MOVE-002 erasure withdraws upstream-id-only extract/archive originals by employee provenance and status, undo and reimport cannot restore identity
  await (async()=>{
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
})()
}
