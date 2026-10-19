import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { harness, agency } from './harness.mjs'
const key=()=>crypto.randomUUID()
const payload=()=>{const employee=key(),manager=key(),category=key(),chain=key();return {members:[{key:employee,email:'imported@harbourfinch.example',name:'Emburse Employee',employee:true},{key:manager,email:'lead@harbourfinch.example',name:'Emburse Lead',employee:true,manager:true}],categories:[{key:category,name:'Imported supplies',accountCode:'6520',taxCode:'GST'}],chains:[{key:chain,employee,steps:[manager]}]}}
const preview=async(h,configuration,source='certify',crosswalk={})=>{const b={source,configuration,mapping:{crosswalk}},p=await h.post('import/preview',b);return {...b,mapping:{crosswalk:p.summary.crosswalk},fingerprint:p.fingerprint,review:p}}
const commit=async(h,b)=>h.post('import/commit',b)
const undo=async(h,r,source='certify')=>h.post('import/undo',{source,id:r.job.id,mappingVersion:r.mappingVersion})

test('MOVE-003 configuration previews without writes, binds opaque identity crosswalk and original bytes, imports inactive people and categories, and undoes untouched configuration',async()=>{
 const h=await harness();try{const team=await agency(h),data=payload(),raw=JSON.stringify(data,null,2)+'\n';
 const before=(await h.get('state')).members.length,messages=h.messages.length;
 await h.post('import/preview',{source:'certify',configuration:{...data,chains:[{...data.chains[0],steps:[data.members[0].key]}]}},undefined,400)
 await h.post('import/preview',{source:'certify',configuration:{...data,chains:[{...data.chains[0],steps:[data.members[1].key,data.members[1].key]}]}},undefined,400)
 const b=await preview(h,raw);
 assert.equal((await h.get('state')).members.length,before)
 assert.equal((await h.get('import')).jobs.length,0)
 assert.equal(b.review.summary.members,2);assert.equal(b.review.summary.chains,1)
 assert.ok(Object.values(b.mapping.crosswalk).every(id=>/^[a-f0-9-]{36}$/.test(id)&&!Object.values(data.members).some(m=>id.includes(m.email))))
 await h.post('import/commit',{...b,configuration:JSON.stringify({...data,categories:[]})},undefined,409)
 await h.post('import/commit',b,team.jordan,403)
 const r=await commit(h,b);assert.equal(r.job.state,'completed')
 const state=await h.get('state'),person=state.members.find(m=>m.email===data.members[0].email),category=state.categories.find(c=>c.name===data.categories[0].name)
 assert.equal(person.active,0);assert.equal(person.member_id,b.mapping.crosswalk[data.members[0].key]);assert.equal(category.account_code,'6520');assert.equal(category.tax_code,'GST');assert.equal(h.messages.length,messages)
 await h.post('settings/members/invite',{email:person.email},undefined,404)
 const original=await h.post('import/status',{source:'certify',id:r.job.id,mappingVersion:r.mappingVersion})
 assert.equal(Buffer.from(original.originals.find(o=>o.name==='emburse-configuration.json').original.base64,'base64').toString(),raw)
 await undo(h,r)
 assert.equal((await h.get('state')).members.length,before);assert.ok(!(await h.get('state')).categories.some(c=>c.id===category.id))
 assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_import_chains').first()).n,0)
 const chrome=await preview(h,data,'chromeriver'),chromeriver=await commit(h,chrome);assert.equal(chromeriver.job.state,'completed');assert.equal((await h.get('state')).members.find(m=>m.email===data.members[0].email).active,0);await undo(h,chromeriver,'chromeriver')

 }finally{await h.close()}
})

test('MOVE-003 explicit crosswalk reuses native identities without changing access; undo keeps activated people and categories referenced by live claims',async()=>{
 const h=await harness();try{const team=await agency(h),data=payload(),state=await h.get('state'),sam=state.members.find(m=>m.email==='sam@harbourfinch.example');
 const existing={...data,members:[{...data.members[0],email:sam.email,name:'Never overwrite native name'},data.members[1]]};
 const conflict=await preview(h,existing);assert.ok(conflict.review.summary.errors.some(e=>e.includes('already exists')))
 const b=await preview(h,existing,'abacus',{[existing.members[0].key]:sam.member_id}),r=await commit(h,b)
 assert.equal((await h.get('state')).members.find(m=>m.email===sam.email).active,1)
 assert.equal((await h.get('state')).members.find(m=>m.email===sam.email).name,sam.name)
 const bytes=await readFile('tests/fixtures/receipts/bistro.png'),historyInput={source:'abacus',csv:'Expense ID,Report ID,Date,User Email,Approver Email,Merchant,Amount,Currency,Description,Category,GL Code,Receipt File\nAB-1,AB-report,2026-09-01,sam@harbourfinch.example,priya@harbourfinch.example,Union Station Grill,12.00,AUD,Client lunch,Meals,6300,abacus.png\n',filename:'abacus.csv',mapping:{date:'YYYY-MM-DD'},receipts:[{name:'abacus.png',base64:bytes.toString('base64')}]};const hp=await h.post('import/preview',historyInput);const hr=await h.post('import/commit',{...historyInput,fingerprint:hp.fingerprint});assert.equal(hr.job.state,'completed');const imported=(await h.get('import')).history.find(r=>r.source==='abacus'&&r.transactionId==='AB-1');assert.equal(imported.amountMinor,1200);assert.equal(imported.report,'AB-report');assert.equal(imported.receipt.size,bytes.length);await undo(h,hr,'abacus')

 await h.post('settings/members',{email:'lead@harbourfinch.example',name:'Activated Lead',employee:true,manager:true})
 const category=(await h.get('state')).categories.find(c=>c.name==='Imported supplies')
 let claim=await h.post('claims',{title:'Supplies after move'},team.sam)
 await h.post(`claims/${claim.id}/items`,{version:claim.version,kind:'receipt',date:'2026-10-01',merchant:'Stationery partner',amount:'12.00',explanation:'Receipt to follow',allocations:[{category:category.id}]},team.sam)
 await undo(h,r,'abacus')
 const after=await h.get('state');assert.ok(after.members.some(m=>m.email==='lead@harbourfinch.example'&&m.active===1));assert.ok(after.categories.some(c=>c.id===category.id));assert.ok(after.members.some(m=>m.member_id===sam.member_id))
 }finally{await h.close()}
})

test('MOVE-003 ERASURE-001 removes imported names and addresses from custody; later status, undo and reimport cannot resurrect them',async()=>{
 const h=await harness();try{await agency(h);const data=payload(),b=await preview(h,data),r=await commit(h,b);
 const invitation=await h.send('/auth/invite',{email:data.members[0].email,displayName:data.members[0].name,role:'member',returnTo:'/app'},h.owner);assert.equal(invitation.status,202);const inactive=await h.confirmMail(data.members[0].email);await h.get('state',inactive,403);await h.post('claims',{title:'Must refuse before activation'},inactive,403)
 const erased=await h.post('settings/members/erase',{email:data.members[0].email});assert.ok(erased.id)
 const tables=(await h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results;
 for(const {name} of tables){const rows=(await h.db.prepare(`SELECT * FROM "${name}"`).all()).results;for(const row of rows)for(const value of Object.values(row)){const text=typeof value==='object'&&value!==null?Buffer.from(value instanceof ArrayBuffer?value:value.buffer??[]).toString():String(value);assert.ok(!text.includes(data.members[0].email)&&!text.includes(data.members[0].name),`${name} must not retain erased identity`)}}
 const status=await h.post('import/status',{source:'certify',id:r.job.id,mappingVersion:r.mappingVersion});assert.ok(status.originals.every(o=>o.original.status!=='retained'))
 await undo(h,r)
 assert.ok(!(await h.get('state')).members.some(m=>m.email===data.members[0].email))
 await h.post('import/commit',b,undefined,409)

 }finally{await h.close()}
})
