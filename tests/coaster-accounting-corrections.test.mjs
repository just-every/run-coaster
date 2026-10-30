// Public native correction, batch and export doors. Provider-close fixtures qualify eligibility only.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {harness,agency,receipt} from './harness.mjs'
import {desktopEdge} from './fixtures/desktop.mjs'

let next=0
const counts=async h=>{
 const tables=['c_claims','c_items','c_allocations','c_revisions','c_decisions','c_coding_corrections','c_batch_coding','c_events','c_batch_claims','c_reimbursement_keys','c_qbd_requests','c_batches','c_members','c_accounting_periods','c_card_ledger']
 return Promise.all(tables.map(async t=>[t,(await h.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results]))
}
async function submitted(h,t,extra={}){
 let c=await h.post('claims',{title:`synthetic-coaster-${++next}`},t.sam)
 const proof=await receipt('officeworks');proof.base64=Buffer.concat([Buffer.from(proof.base64,'base64'),Buffer.from(c.id)]).toString('base64')
 const up=await h.post(`claims/${c.id}/receipts`,{version:c.version,...proof},t.sam)
 c=await h.post(`claims/${c.id}/items`,{version:up.claim.version,kind:'receipt',date:'2026-06-10',merchant:`synthetic-coaster-${next}`,amount:'42.00',receipt:up.receipt,category:t.c.office,explanation:'Client work',...extra},t.sam)
 return h.post(`claims/${c.id}/submit`,{version:c.version},t.sam)
}
const approved=async(h,t,extra)=>{const c=await submitted(h,t,extra);return h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved',acknowledge:true},t.priya)}
async function body(h,c,extra={}){
 const d=await h.get(`claims/${c.id}`),item=d.revisions.at(-1).snapshot.items[0],own=d.codingCorrections.filter(x=>x.item_id===item.id&&x.allocation===0&&x.revision===c.revision)
 return {version:d.claim.version,revision:c.revision,item:item.id,allocation:0,sequence:own.at(-1)?.sequence??0,accountCode:'6990',reason:'Correct the export account',...extra}
}
const correct=async(h,c,cookie,extra={},status=200)=>h.post(`claims/${c.id}/coding-corrections`,await body(h,c,extra),cookie,status)
const stable=async(h,id)=>{
 const tables=['c_items','c_allocations','c_receipts','c_revisions','c_decisions','c_claim_chains','c_reimbursement_keys','c_qbd_requests']
 return Promise.all(tables.map(async table=>[table,(await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results]))
}
const review=(h,b)=>h.post(`batches/${b.id}/approve`,{version:b.version,expectedTotal:b.total_minor})
async function posting(h,c,status='succeeded',date='2026-06-10',expenses,batchId){
 const d=await h.get(`claims/${c.id}`),id=`synthetic-coaster-${++next}`
 await h.db.prepare('INSERT INTO c_qbd_requests(id,source,kind,payload,status,created_at,completed_at,txn_id) VALUES(?,?,?,?,?,?,?,?)').bind(id,'bill:'+id,'BillAdd',JSON.stringify({date,employee:c.employee_email,batch:batchId??id,expenses:expenses??d.items.map(i=>({claim:c.id,item:i.id,revision:c.revision})),lines:[],total:c.total_minor}),status,'2026-06-10T12:00:00.000Z',status==='succeeded'?'2026-06-10T12:01:00.000Z':null,status==='succeeded'?id:null).run()
 return id
}

test('ACCT-008 native correction preserves submitted evidence across every expense kind, permissions, removed batches and frozen accounting files',async()=>{
 const h=await harness()
 try{
  const t=await agency(h),state=await h.get('state'),member=name=>state.members.find(m=>m.name===name).email
  const domain=member('sam').slice(member('sam').indexOf(String.fromCharCode(64)))
  const role=async(name,flags)=>h.person(`synthetic-coaster-${name}${domain}`,flags,member('priya'))
  const finance=await role('finance',{finance:true}),bookkeeper=await role('books',{bookkeeper:true}),manager=await role('manager',{manager:true}),admin=await role('admin',{admin:true}),card=await role('card',{cardAdmin:true}),auditor=await role('audit',{auditor:true})
  await h.post('settings/members',{email:member('priya'),name:'priya',manager:true})
  const cap=(await h.post('allowances',{name:'synthetic-coaster-cap',type:'cap',period:'yearly',amount:'30.00',startsOn:'2026-01-01'})).all.find(a=>a.name==='synthetic-coaster-cap')
  let capped=await submitted(h,t,{allowance:cap.id,amount:'42.00'}),detail=await h.get(`claims/${capped.id}`)
  assert.equal(detail.items[0].amount_minor,3000);assert.equal(detail.items[0].claimed_minor,4200)
  for(const cookie of [h.owner,finance,bookkeeper,t.priya]){
   const before=await stable(h,capped.id),original=(await h.db.prepare('SELECT snapshot FROM c_revisions WHERE claim_id=?').bind(capped.id).first()).snapshot
   capped=await correct(h,capped,cookie,{accountCode:`69${++next}`})
   assert.deepEqual(await stable(h,capped.id),before)
   assert.equal((await h.db.prepare('SELECT snapshot FROM c_revisions WHERE claim_id=?').bind(capped.id).first()).snapshot,original)
  }
  const oldBody=await body(h,capped,{accountCode:'6980'}),beforeReason=await counts(h)
  await h.post(`claims/${capped.id}/coding-corrections`,{...oldBody,reason:'  '},finance,400)
  assert.deepEqual(await counts(h),beforeReason)
  capped=await h.post(`claims/${capped.id}/coding-corrections`,oldBody,finance)
  const once=await counts(h)
  await h.post(`claims/${capped.id}/coding-corrections`,oldBody,finance,409)
  await h.post(`claims/${capped.id}/coding-corrections`,{...await body(h,capped),revision:0},finance,409)
  await h.post(`claims/${capped.id}/coding-corrections`,{...await body(h,capped),sequence:0},finance,409)
  assert.deepEqual(await counts(h),once)
  capped=await h.post(`claims/${capped.id}/decision`,{version:capped.version,revision:capped.revision,decision:'approved',acknowledge:true},t.priya)
  for(const cookie of [t.priya,manager,admin,card,t.sam,t.alex,auditor]){
   const before=await counts(h);await correct(h,capped,cookie,{},403);assert.deepEqual(await counts(h),before)
  }
  for(const cookie of [h.owner,finance,bookkeeper])capped=await correct(h,capped,cookie,{accountCode:`68${++next}`})
  const key=await h.post('agent-keys',{label:'synthetic-coaster-1'},t.morgan),beforeKey=await counts(h)
  assert.equal((await h.send(`/api/coaster/claims/${capped.id}/coding-corrections`,await body(h,capped),'',{authorization:`Bearer ${key.token}`})).status,401)
  assert.deepEqual(await counts(h),beforeKey)
  // Full delegates keep the grantor's coding row and actual-person attribution; Submit-only grants do not.
  const financeEmail=(await h.get('state',finance)).actor.email,alex=member('alex')
  let grant=await h.post('delegates',{grantor:financeEmail,delegate:alex,level:'submit'})
  const delegatedBody=await body(h,capped,{accountCode:'6977'})
  let beforeDelegate=await counts(h)
  assert.equal((await h.send(`/api/coaster/claims/${capped.id}/coding-corrections`,delegatedBody,t.alex,{'x-coaster-acting-for':financeEmail})).status,403)
  assert.deepEqual(await counts(h),beforeDelegate)
  await h.post(`delegates/${grant.id}/revoke`,{})
  grant=await h.post('delegates',{grantor:financeEmail,delegate:alex,level:'full'})
  const delegateResult=await h.send(`/api/coaster/claims/${capped.id}/coding-corrections`,delegatedBody,t.alex,{'x-coaster-acting-for':financeEmail});assert.equal(delegateResult.status,200,delegateResult.text);capped=delegateResult.value
  detail=await h.get(`claims/${capped.id}`)
  assert.deepEqual([detail.codingCorrections.at(-1).actor_email,detail.codingCorrections.at(-1).on_behalf_of],[alex,financeEmail])
  await h.post(`delegates/${grant.id}/revoke`,{});beforeDelegate=await counts(h)
  assert.equal((await h.send(`/api/coaster/claims/${capped.id}/coding-corrections`,await body(h,capped),t.alex,{'x-coaster-acting-for':financeEmail})).status,403)
  assert.deepEqual(await counts(h),beforeDelegate)
  // Native mileage, flat per diem, generated stipend, and imported card charge share the same door.
  const kinds=[]
  for(const item of [{kind:'mileage',distance:'10',category:t.c.car},{kind:'per_diem',days:'2',category:t.c.travel}])kinds.push(await submitted(h,t,item))
  await h.post('allowances',{name:'synthetic-coaster-stipend',type:'stipend',category:t.c.office,period:'monthly',amount:'12.00',tax:'accountable',startsOn:'2026-06-01'})
  await (await h.mf.getWorker()).scheduled({scheduledTime:Date.parse('2026-06-20T12:00:00Z'),cron:'17 * * * *'})
  kinds.push((await h.get('state',t.sam)).claims.find(c=>c.title.startsWith('synthetic-coaster-stipend')))
  await h.post('statements/cards',{issuer:'Synthetic Card',last4:'2222',employee:member('sam')})
  const file={format:'qfx',name:'synthetic-coaster.qfx',issuer:'Synthetic Card',category:t.c.office,content:await readFile('tests/fixtures/statements/reconcile-earlier.qfx','utf8')}
  const imported=await h.post('statements/commit',{...file,fingerprint:(await h.post('statements/preview',file)).fingerprint})
  const cardClaim=await h.get(`claims/${imported.claims[0]}`,t.sam)
  const attached=await h.post(`claims/${cardClaim.claim.id}/receipts`,{version:cardClaim.claim.version,item:cardClaim.items[0].id,...await receipt('hotel')},t.sam)
  kinds.push(await h.post(`claims/${cardClaim.claim.id}/submit`,{version:attached.claim.version},t.sam))
  for(let c of kinds){
   assert.ok(c&&c.status==='submitted')
   for(const cookie of [h.owner,finance,bookkeeper,t.priya]){const before=await stable(h,c.id);c=await correct(h,c,cookie,{accountCode:`67${++next}`});assert.deepEqual(await stable(h,c.id),before)}
   c=await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved',acknowledge:true},t.priya)
   for(const cookie of [h.owner,finance,bookkeeper])c=await correct(h,c,cookie,{accountCode:`66${++next}`})
  }
  // A correction to one real split preserves dimensions, tax and the other allocation.
  await h.post('settings/business',{name:'Harbour & Finch Studio',currency:'AUD',timezone:'Australia/Sydney',perDiem:'75.00',receiptThreshold:'',salesTaxAccount:'2100',salesTaxCode:'GST'})
  const dimension=(await h.post('coding/dimensions',{version:(await h.get('coding')).version,name:'synthetic-coaster-project',kind:'tag'})).saved
  const value=(await h.post('coding/values',{version:(await h.get('coding')).version,dimension,name:'synthetic-coaster-project-1'})).saved
  let split=await approved(h,t,{salesTax:'2.00',allocations:[{category:t.c.office,amount:'25.00',costCentre:'Delivery'},{category:t.c.travel,amount:'15.00',costCentre:'Studio'}],coding:{[dimension]:value},billable:true,customer:'synthetic-coaster-1',project:'synthetic-coaster-2'})
  const splitBefore=await stable(h,split.id)
  split=await correct(h,split,finance,{allocation:1,sequence:0,accountCode:'6955'})
  assert.deepEqual(await stable(h,split.id),splitBefore)
  let splitBatch=await h.post('batches',{claims:[split.id]});splitBatch=await review(h,splitBatch)
  const splitLines=(await h.get(`batches/${splitBatch.id}`)).lines
  assert.deepEqual(splitLines.map(l=>[l.account,l.amountMinor,l.tax,l.costCentre]),[['6500',2500,'GST','Delivery'],['6955',1500,'GST','Studio'],['2100',200,'GST','']])
  assert.equal(splitLines.reduce((n,l)=>n+l.amountMinor,0),4200)
  // Removal from each supported batch state keeps original review and selections, reconciles totals and needs renewed review.
  for(const reviewed of [false,true]){
   let a=await approved(h,t),b=await approved(h,t),batch=await h.post('batches',{claims:[a.id,b.id]})
   if(reviewed)batch=await review(h,batch)
   const originalBatch=await h.get(`batches/${batch.id}`),beforeRemoval=await counts(h)
   await correct(h,a,finance,{},409);assert.deepEqual(await counts(h),beforeRemoval)
   batch=await h.post(`batches/${batch.id}/remove`,{version:batch.version,claim:a.id})
   assert.equal(batch.status,'draft');assert.equal(batch.total_minor,b.total_minor);assert.equal(batch.reviewed_at,originalBatch.batch.reviewed_at)
   assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_batch_coding WHERE batch_id=?').bind(batch.id).first()).n,2)
   assert.equal((await h.get(`batches/${batch.id}`)).events.filter(e=>e.action==='batch-approved').length,reviewed?1:0)
   await h.post(`batches/${batch.id}/release`,{version:batch.version},h.owner,409)
   assert.equal((await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`,undefined,h.owner)).status,409)
   a=await correct(h,a,finance,{accountCode:'6969'})
   batch=await review(h,batch)
   // A different bill in the former batch is not this expense's posting, even with retained coding selections.
   await h.db.prepare("INSERT OR IGNORE INTO c_accounting_periods VALUES('desktop','2026-03-01','2026-03-31','2026-04-01T00:00:00.000Z')").run()
   await posting(h,b,'succeeded','2026-03-10',undefined,batch.id)
   await posting(h,a,'pending','2026-04-10')
   a=await correct(h,a,bookkeeper,{accountCode:'6970'})
   const frozen=await h.post('batches',{claims:[a.id]});let finalBatch=await review(h,frozen)
   const lines=(await h.get(`batches/${finalBatch.id}`)).lines
   assert.equal(lines[0].account,'6970');assert.equal(lines.reduce((n,l)=>n+l.amountMinor,0),a.total_minor)
   const csv=await h.send(`/api/coaster/batches/${finalBatch.id}/accounting.csv`,undefined,h.owner);assert.equal(csv.status,200);assert.match(csv.text,/"6970"/);assert.match(csv.text,/"42.00"/)
   const response=await h.mf.dispatchFetch(h.origin+`/api/coaster/batches/${finalBatch.id}/accounting.xlsx`,{headers:{cookie:h.owner}})
   assert.equal(response.status,200);const workbook=Buffer.from(await response.arrayBuffer()).toString();assert.match(workbook,/6970/);assert.match(workbook,/<v>42<\/v>/)
   const beforeFrozen=await counts(h);await correct(h,a,finance,{accountCode:'6991'},409);assert.deepEqual(await counts(h),beforeFrozen)
   assert.equal((await h.get(`batches/${finalBatch.id}`)).lines[0].account,'6970')
  }
  // No posting and own open-period posting accept. Only the expense's own closed entry refuses 409 without writes.
  let noPosting=await approved(h,t);noPosting=await correct(h,noPosting,finance)
  let open=await approved(h,t);await posting(h,open);const source=await stable(h,open.id);open=await correct(h,open,finance);assert.deepEqual(await stable(h,open.id),source)
  await h.db.prepare("INSERT INTO c_accounting_periods VALUES('desktop','2026-06-01','2026-06-30','2026-07-01T00:00:00.000Z')").run()
  const closedBefore=await counts(h);await correct(h,open,finance,{accountCode:'6999'},409);assert.deepEqual(await counts(h),closedBefore)
  let unrelated=await approved(h,t);await posting(h,unrelated,'pending','2026-06-10');unrelated=await correct(h,unrelated,finance)
  // An actual native card close also fences only its own purchase.
  const reconciliation=await h.post(`statements/${imported.file}/reconcile`,{last4:'2222',openingBalance:'0.00',statementBalance:'64.00'})
  const cardCode=(await h.get(`claims/${cardClaim.claim.id}`)).codingCorrections.at(-1).after_code
  const nativeClose=await h.post(`statements/reconciliations/${reconciliation.id}/close`,{})
  assert.equal(nativeClose.ledger.entries.find(l=>l.kind==='purchase').debit_account,`Expense · ${cardCode} Office supplies`)
  const closedCard=await h.get(`claims/${cardClaim.claim.id}`),cardBefore=await counts(h)
  await correct(h,closedCard.claim,finance,{accountCode:'6998'},409);assert.deepEqual(await counts(h),cardBefore)
  await assert.rejects(h.db.prepare("UPDATE c_coding_corrections SET after_code='1'").run(),/permanent/)
  await assert.rejects(h.db.prepare('DELETE FROM c_coding_corrections').run(),/permanent/)
  await assert.rejects(h.db.prepare("UPDATE c_batch_coding SET account_code='1'").run(),/permanent/)
  const history=(await h.get('history?q=account-code-corrected')).lines
  assert.ok(history.length>20);assert.ok(history.every(e=>e.seq>0&&e.actor_email&&e.at))
  // Erasing a correction actor removes their identity from rows and embedded reasons without reviving authority.
  let erasureClaim=await approved(h,t)
  erasureClaim=await correct(h,erasureClaim,finance,{reason:`Reviewed by synthetic-coaster-finance ${financeEmail}`})
  await h.post('settings/members',{email:financeEmail,name:'synthetic-coaster-finance',finance:true,active:false})
  await h.post('settings/members/erase',{email:financeEmail})
  const erased=await h.get(`claims/${erasureClaim.id}`)
  assert.equal(JSON.stringify(erased.codingCorrections).includes(financeEmail),false)
  assert.equal(JSON.stringify(erased.events.filter(e=>e.action==='account-code-corrected')).includes(financeEmail),false)
  assert.equal((await h.send(`/api/coaster/claims/${erasureClaim.id}/coding-corrections`,await body(h,erasureClaim),finance)).status,401)
  console.log('PROBE ACCT-008 1: native correction -> receipt with cap, mileage, per diem, stipend and card accepted for every allowed role; immutable submitted evidence')
  console.log('PROBE ACCT-008 2: draft and reviewed removal -> totals reconciled, original review retained, renewed review required, corrections accepted')
  console.log('PROBE ACCT-008 3: retained former-batch selections and unrelated posting -> correction accepted')
  console.log('PROBE ACCT-008 4: no posting and own open posting -> accepted; own closed entry -> 409 with no writes; reversal omitted')
  console.log('PROBE ACCT-008 5: disallowed roles -> 403 with no writes; keys and revoked delegates refused')
 }finally{await h.close()}
})

test('ACCT-008 correction guards fence stale authority, concurrent batching and posting changes before and after writes',async()=>{
 let paused,release,armed=false,door='/before-coding-correction'
 const gate=()=>{paused=new Promise(r=>gate.arrived=r);return new Promise(r=>release=r)}
 const h=await harness({d1Barrier:async request=>{if(armed&&new URL(request.url).pathname===door){armed=false;gate.arrived();await gate.wait}return new Response('ok')}})
 try{
  const t=await agency(h)
  for(const change of ['batch','authority','posting','revision','sequence']){
   let c=await approved(h,t),b=await body(h,c),beforeCorrection=(await h.get(`claims/${c.id}`)).codingCorrections
   gate.wait=gate();armed=true
   const pending=h.send(`/api/coaster/claims/${c.id}/coding-corrections`,b,t.morgan);await paused
   if(change==='batch')await h.post('batches',{claims:[c.id]})
   if(change==='authority')await h.db.prepare('UPDATE c_members SET is_finance=0 WHERE email=?').bind((await h.get('state',t.morgan)).actor.email).run()
   if(change==='posting')await posting(h,c,'pending')
   if(change==='revision')await h.db.prepare('UPDATE c_claims SET revision=revision+1 WHERE id=?').bind(c.id).run()
   if(change==='sequence')await correct(h,c,h.owner,{accountCode:'6981'})
   const changed=await counts(h);release();const result=await pending;assert.equal(result.status,409,result.text);assert.deepEqual(await counts(h),changed)
   if(change==='authority')await h.db.prepare('UPDATE c_members SET is_finance=1 WHERE email=?').bind((await h.get('state',t.morgan)).actor.email).run()
  }
  // A frozen finance task cannot borrow a remaining manager role after finance is withdrawn.
  const reviewer=(await h.get('state',t.morgan)).actor.email
  await h.post(['settings','members'].join('/'),{email:reviewer,name:'synthetic-coaster-reviewer',manager:true,finance:true})
  await h.post(['settings','approval-workflow'].join('/'),{version:0,rules:[{label:'synthetic-coaster-review',condition:{kind:'always',value:''},stages:[[{kind:'finance',email:reviewer}]]}]})
  for(const phase of ['before','opening','closing']){
   let waiting=await submitted(h,t)
   waiting=await h.post(`claims/${waiting.id}/decision`,{version:waiting.version,revision:waiting.revision,decision:'approved',acknowledge:true},t.priya)
   const request=await body(h,waiting)
   if(phase==='before'){
    await h.post(['settings','members'].join('/'),{email:reviewer,name:'synthetic-coaster-reviewer',manager:true})
    const before=await counts(h)
    await h.post(`claims/${waiting.id}/decision`,{version:waiting.version,revision:waiting.revision,decision:'approved',acknowledge:true},t.morgan,403)
    const result=await h.send(`/api/coaster/claims/${waiting.id}/coding-corrections`,request,t.morgan)
    console.log(`PROBE gate-authority: finance removed, manager retained -> decision 403, correction ${result.status}`)
    assert.equal(result.status,403,result.text);assert.deepEqual(await counts(h),before)
   }else if(phase==='opening'){
    gate.wait=gate();armed=true
    const pending=h.send(`/api/coaster/claims/${waiting.id}/coding-corrections`,request,t.morgan);await paused
    await h.post(['settings','members'].join('/'),{email:reviewer,name:'synthetic-coaster-reviewer',manager:true})
    const before=await counts(h);release();const result=await pending
    assert.equal(result.status,409,result.text);assert.deepEqual(await counts(h),before)
   }else{
    await h.db.prepare(`CREATE TRIGGER synthetic_coaster_reviewer AFTER INSERT ON c_coding_corrections BEGIN UPDATE c_members SET is_finance=0 WHERE email='${reviewer}'; END`).run()
    const before=await counts(h);await h.post(`claims/${waiting.id}/coding-corrections`,request,t.morgan,409);assert.deepEqual(await counts(h),before)
    await h.db.prepare('DROP TRIGGER synthetic_coaster_reviewer').run()
   }
   await h.post(['settings','members'].join('/'),{email:reviewer,name:'synthetic-coaster-reviewer',manager:true,finance:true})
   waiting=await h.post(`claims/${waiting.id}/coding-corrections`,request,t.morgan)
   assert.equal((await h.get(`claims/${waiting.id}`)).codingCorrections.at(-1).after_code,request.accountCode)
  }
  await h.post(['settings','approval-workflow'].join('/'),{version:1,rules:[]})
  // A trigger changes authority after the opening guard. Closing guard must roll the whole transaction back.
  const c=await approved(h,t),financeEmail=(await h.get('state',t.morgan)).actor.email
  await h.db.prepare(`CREATE TRIGGER synthetic_coaster_guard AFTER INSERT ON c_coding_corrections BEGIN UPDATE c_members SET is_finance=0 WHERE email='${financeEmail}'; END`).run()
  const before=await counts(h);await correct(h,c,t.morgan,{},409);assert.deepEqual(await counts(h),before)
  assert.equal((await h.db.prepare('SELECT is_finance FROM c_members WHERE email=?').bind(financeEmail).first()).is_finance,1)
  await h.db.prepare('DROP TRIGGER synthetic_coaster_guard').run()
  await correct(h,c,t.morgan)
  // Hold a prepared sync at its transaction boundary while finance removes the reviewed claim.
  const root=['accounting','desktop'].join('/'),edge=await desktopEdge(h)
  const connected=await h.post(root+'/connect',{consent:true,company:'synthetic-coaster-1.QBW'})
  await edge.open(connected.configuration,connected.password);await edge.drain()
  const map=(name,listId,kind='Account')=>h.post(root+'/mappings',{name,listId,kind})
  await map('account:6500','synthetic-coaster-1');await map('payable','synthetic-coaster-2')
  const employee=(await h.get('state',t.sam)).actor.email
  await map('vendor:'+employee,'synthetic-coaster-6','Vendor')
  const purchase=await approved(h,t)
  let batch=await h.post('batches',{claims:[purchase.id]})
  batch=await review(h,batch)
  door='/before-desktop-queue';gate.wait=gate();armed=true
  const sync=h.send('/api/coaster/'+root+'/sync',{},h.owner);await paused
  const removed=await h.post(`batches/${batch.id}/remove`,{version:batch.version,claim:purchase.id})
  assert.equal(removed.status,'draft')
  release();const syncResult=await sync;assert.equal(syncResult.status,200,syncResult.text)
  const oldBills=(await h.db.prepare("SELECT * FROM c_qbd_requests WHERE kind='BillAdd' AND json_extract(payload,'$.batch')=?").bind(batch.id).all()).results
  console.log(`PROBE gate-money: removal while Desktop queue paused -> removal 200, old batch bills ${oldBills.length}`)
  assert.equal(oldBills.length,0,'a bill prepared before removal must not queue afterward')
  let replacement=await h.post('batches',{claims:[purchase.id]});replacement=await review(h,replacement)
  // The opposite order is safe too: a queued bill prevents removal and preserves every row.
  await h.post(root+'/sync',{})
  const beforeQueued=await counts(h)
  await h.post(`batches/${replacement.id}/remove`,{version:replacement.version,claim:purchase.id},h.owner,409)
  assert.deepEqual(await counts(h),beforeQueued)
  await edge.open(connected.configuration,connected.password);await edge.drain()
  const bills=edge.sent.filter(r=>r.kind==='BillAdd'&&r.request.includes(replacement.id))
  assert.equal(bills.length,1,'the rebatched purchase posts exactly once')
  await edge.open(connected.configuration,connected.password);await edge.drain()
  assert.equal(edge.sent.filter(r=>r.kind==='BillAdd'&&r.request.includes(replacement.id)).length,1)
  console.log('PROBE gate-money: paused sync then reviewed removal -> no former bill queued; rebatching posts once; queued posting refuses removal with no writes')
  console.log('PROBE ACCT-008 guards: paused correction plus batching, revoked authority, changed posting, revision or sequence -> 409 and no correction writes; closing authority guard rolls back')
 }finally{release?.();await h.close()}
})
