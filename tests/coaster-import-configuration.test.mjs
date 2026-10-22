import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm, readdir, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('MOVE-001 Expensify configuration previews exact people, chains, categories, tags, rules and last-four assignments and undoes unused rows',async()=>{
 const h=await harness();try{await agency(h);const data=payload();
 data.members[0].name='Expensify Employee';data.members[1].name='Expensify Lead';
 data.tags=[{key:key(),name:'Client: synthetic-coaster-1'}];data.cards=[{key:key(),issuer:'Synthetic Coaster',last4:'1101',employee:data.members[0].key}];
 data.policies=[{key:key(),name:'Synthetic Coaster policy',rules:[{kind:'per-expense-limit',category:data.categories[0].key,limit:'70.00'}]}];data.unmappedSourceSetting=true;
 const beforeCustody=(await h.db.prepare('SELECT COUNT(*) n FROM ik_jobs').first()).n;
 for(const field of ['number','cardNumber','bankAccountNumber'])await h.post('import/preview',{source:'expensify',configuration:{...data,cards:data.cards.map(c=>({...c,[field]:'9'.repeat(12)+'1201'}))}},undefined,400);
 assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM ik_jobs').first()).n,beforeCustody,'full-account fields never reach a persisted original or plan');
 const before=(await h.get('state')).members.length, prior=(await h.get('policy')).versions[0].version;
 const b=await preview(h,JSON.stringify(data,null,2)+'\n','expensify');
 assert.deepEqual([b.review.summary.members,b.review.summary.categories,b.review.summary.chains,b.review.summary.tags,b.review.summary.cards,b.review.summary.policyRules],[2,1,1,1,1,1]);
 assert.ok(b.review.summary.warnings.some(w=>w.includes('unmappedSourceSetting')));assert.equal((await h.get('state')).members.length,before);assert.equal((await h.get('import')).jobs.length,0);
 const r=await commit(h,b);assert.equal(r.job.state,'completed');
 const state=await h.get('state');assert.equal(state.members.find(m=>m.email===data.members[0].email).active,0);
 assert.equal((await h.db.prepare('SELECT employee_email FROM c_cards WHERE last4=?').bind('1101').first()).employee_email,data.members[0].email);
 assert.equal((await h.get('coding')).values.find(v=>v.name===data.tags[0].name).dimension_id,'expensify:tags');
 assert.ok((await h.get('policy')).versions[0].rules.some(r=>r.kind==='per-expense-limit'&&r.limit_minor===7000));
 const status=await h.post('import/status',{source:'expensify',id:r.job.id,mappingVersion:r.mappingVersion});assert.equal(Buffer.from(status.originals.find(o=>o.name==='expensify-configuration.json').original.base64,'base64').toString(),b.configuration);
 await undo(h,r,'expensify');assert.equal((await h.get('state')).members.length,before);assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_cards').first()).n,0);assert.equal((await h.get('coding')).values.length,0);
 const after=(await h.get('policy')).versions;assert.ok(after[0].version>prior);assert.ok(!after[0].rules.some(r=>r.limit_minor===7000));
 }finally{await h.close()}
})

test('MOVE-001 report receipts retain exact image bytes on their expenses, bind preview changes and undo without creating payable claims',async()=>{
 const h=await harness();try{await agency(h);const bytes=await readFile('tests/fixtures/receipts/bistro.png');
 const csv='reportID,reportName,accountEmail,status,transactionID,created,merchant,amount,currency,receiptFilename,unused\nsynthetic-coaster-1,Open report,sam@harbourfinch.example,Open,synthetic-coaster-2,2026-10-01,Bistro,60.00,AUD,meal.png,kept\nsynthetic-coaster-3,Closed report,sam@harbourfinch.example,Closed,synthetic-coaster-4,2026-10-02,Hotel,70.00,AUD,meal.png,kept\n';
 const b={source:'expensify',csv,filename:'synthetic-coaster.csv',mapping:{date:'YYYY-MM-DD',statuses:{Open:'open',Closed:'closed'}},receipts:[{name:'meal.png',base64:bytes.toString('base64')}]};
 const p=await h.post('import/preview',b);assert.equal(p.summary.reports,2);assert.equal(p.summary.receipts,1);assert.deepEqual(p.summary.errors,[]);assert.ok(p.summary.warnings.some(w=>w.includes('unused')));assert.equal((await h.get('import')).history.length,0);
 await h.post('import/commit',{...b,receipts:[],fingerprint:p.fingerprint},undefined,409);
 const r=await h.post('import/commit',{...b,fingerprint:p.fingerprint});assert.equal(r.job.state,'completed');
 const history=(await h.get('import')).history;assert.equal(history.filter(r=>r.kind==='expense'&&r.receipt.name==='meal.png'&&r.receipt.size===bytes.length).length,2);assert.equal((await h.get('state')).claims.length,0);
 const status=await h.post('import/status',{source:'expensify',id:r.job.id,mappingVersion:r.mappingVersion});assert.deepEqual(Buffer.from(status.originals.find(o=>o.name==='meal.png').original.base64,'base64'),bytes);
 await undo(h,r,'expensify');assert.deepEqual((await h.get('import')).history,[]);
 }finally{await h.close()}
})


test('MOVE-001 Integration Server command requires explicit consent, selects read-only jobs and keeps credentials out of retained exports',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'coaster-expensify-'));
 try{
 const template=join(dir,'template.ftl'),edge=join(dir,'edge.mjs'),trace=join(dir,'trace.json'),output=join(dir,'export');
 await writeFile(template,'synthetic-coaster-1');
 await writeFile(edge,`import {writeFile} from 'node:fs/promises';
const calls=[];
globalThis.fetch=async(url,options)=>{
 if(url!=='https://integrations.expensify.com/Integration-Server/ExpensifyIntegrations'||options.redirect!=='error')throw Error('unexpected destination');
 const body=new URLSearchParams(options.body),job=JSON.parse(body.get('requestJobDescription'));calls.push(job);
 await writeFile(${JSON.stringify(trace)},JSON.stringify(calls));
 if(process.env.SYNTHETIC_COASTER_REFUSE)return new Response('synthetic-coaster-2',{status:401});
 return job.type==='file'?new Response('synthetic-coaster-3.csv'):job.type==='download'?new Response('reportID,reportName,accountEmail,status,transactionID,created,merchant,amount,currency\\n'):Response.json({responseCode:200,policyInfo:[]});
};`);
 const command=['scripts/expensify/export.mjs','--reports','synthetic-coaster-4','--policies','synthetic-coaster-5','--template',template,'--output',output];
 const run=promisify(execFile),options={env:{...process.env,EXPENSIFY_PARTNER_USER_ID:'synthetic-coaster-6',EXPENSIFY_PARTNER_USER_SECRET:'synthetic-coaster-7'}};
 await assert.rejects(run(process.execPath,['--import',edge,...command],options),e=>/Repeat with --consent/.test(e.stderr));
 assert.deepEqual(await readdir(dir),['edge.mjs','template.ftl']);
 const result=await run(process.execPath,['--import',edge,...command,'--consent'],options);
 const calls=JSON.parse(await readFile(trace));assert.deepEqual(calls.map(c=>c.type),['file','download','get']);assert.equal(calls[0].onFinish,undefined);assert.equal(calls[0].inputSettings.filters.reportIDList,'synthetic-coaster-4');assert.deepEqual(calls[2].inputSettings.policyIDList,['synthetic-coaster-5']);
 for(const name of ['reports.csv','source-policy.json']){const content=await readFile(join(output,name),'utf8');assert.ok(!content.includes('synthetic-coaster-6')&&!content.includes('synthetic-coaster-7'));assert.equal((await stat(join(output,name))).mode&0o777,0o600);}
 assert.ok(!result.stdout.includes('synthetic-coaster-7'));assert.equal((await stat(output)).mode&0o777,0o700);
 await assert.rejects(run(process.execPath,['--import',edge,...command.map(v=>v===output?join(dir,'refused'):v),'--consent'],{...options,env:{...options.env,SYNTHETIC_COASTER_REFUSE:'1'}}),e=>/HTTP 401/.test(e.stderr)&&!e.stderr.includes('synthetic-coaster-7'));
 assert.ok(!(await readdir(dir)).includes('refused'));
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('MOVE-001 erasure withdraws the policy original, replaces imported cardholder identity and prevents undo/reimport resurrection',async()=>{
 const h=await harness();try{
 await agency(h);const data=payload();data.cards=[{key:key(),issuer:'Synthetic Coaster',last4:'1201',employee:data.members[0].key}];data.tags=[{key:key(),name:'Synthetic client'}];
 const b=await preview(h,JSON.stringify(data),'expensify'),r=await commit(h,b);
 const erased=await h.post('settings/members/erase',{email:data.members[0].email});assert.ok(erased.id);
 const card=await h.db.prepare('SELECT employee_email FROM c_cards WHERE last4=?').bind('1201').first();assert.equal(card.employee_email,erased.retained.subject);
 const tables=(await h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results;
 for(const {name}of tables){const rows=(await h.db.prepare(`SELECT * FROM "${name}"`).all()).results;for(const row of rows)for(const value of Object.values(row)){const text=typeof value==='object'&&value!==null?Buffer.from(value instanceof ArrayBuffer?value:value.buffer??[]).toString():String(value);assert.ok(!text.includes(data.members[0].email)&&!text.includes(data.members[0].name),`${name} must not resurrect the imported identity`);}}
 const status=await h.post('import/status',{source:'expensify',id:r.job.id,mappingVersion:r.mappingVersion});assert.ok(status.originals.every(o=>o.original.status!=='retained'));
 await undo(h,r,'expensify');await h.post('import/commit',b,undefined,409);
 }finally{await h.close()}
})
