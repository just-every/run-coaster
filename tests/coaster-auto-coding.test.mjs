import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { harness } from './harness.mjs'

const n = number => `synthetic-coaster-${number}`
const path = 'coding/automatic'
const fixture = JSON.parse(await readFile('tests/fixtures/coding/labels.json','utf8'))
async function setup(h) {
  await h.post('settings/business',{name:n(90),currency:'USD',timezone:'UTC',receiptThreshold:'10000'})
  const managerEmail=`${n(100)}@example.test`,financeEmail=`${n(101)}@example.test`
  const manager=await h.person(managerEmail,{employee:true,manager:true})
  const finance=await h.person(financeEmail,{employee:true,finance:true},managerEmail)
  const people={manager,finance,managerEmail,financeEmail}
  for(const [i,key] of ['sam','alex','bea'].entries()){people[`${key}Email`]=`${n(102+i)}@example.test`;people[key]=await h.person(people[`${key}Email`],{employee:true},managerEmail)}
  const sales=await h.post('settings/departments',{name:n(500)}),marketing=await h.post('settings/departments',{name:n(501)})
  for(const key of ['sam','alex','bea'])await h.post('settings/members',{email:people[`${key}Email`],name:people[`${key}Email`].split('@')[0],employee:true,approver:managerEmail,department:key==='bea'?marketing.id:sales.id})
  const cats=[]
  for(let i=0;i<4;i++)cats.push(await h.post('settings/categories',{name:n(2000+i),accountCode:n(2100+i),taxCode:n(2200)}))
  let catalog=await h.get('coding'),dimensions={},values={class:[],project:[]}
  for(const [i,kind]of ['class','project','account'].entries()){
    catalog=await h.post('coding/dimensions',{version:catalog.version,name:n(2300+i),kind});dimensions[kind]=catalog.saved
    for(let j=0;j<(kind==='account'?1:4);j++){
      catalog=await h.post('coding/values',{version:catalog.version,dimension:dimensions[kind],name:n((kind==='class'?2400:kind==='project'?2500:2600)+j)})
      if(kind==='account')values.account=catalog.saved;else values[kind].push(catalog.saved)
    }
  }
  await h.post('settings/categories',{id:cats[3].id,name:cats[3].name,accountCode:cats[3].account_code,taxCode:cats[3].tax_code,ledgerAccountId:values.account})
  const fields=(cat=0,cl=cat,project=cat)=>({category:cats[cat].id,dimensions:{...(cl===null?{}:{[dimensions.class]:values.class[cl]}),...(project===null?{}:{[dimensions.project]:values.project[project]})}})
  const rule=async(merchant,coding,scope='finance',cookie=finance,extra={})=>h.post(`${path}/rules`,{version:(await h.get(`${path}/rules`,cookie)).version,merchant,coding,scope,active:true,...extra},cookie)
  const upload=async(row,merchant=row.merchant,cookie=people[row.employee??'sam'])=>{
    const form=new FormData();form.append('file',new Blob([await readFile(`tests/fixtures/coding/${row.receipt??fixture.cases[0].receipt}`)]),`${row.id??n(6000)}.png`);form.append('source','upload');if(merchant)form.append('merchant',merchant)
    const request=new Request(h.origin+'/api/coaster/receipt-inbox',{method:'POST',headers:{origin:h.origin,cookie},body:form})
    const r=await h.mf.dispatchFetch(request.url,{method:'POST',headers:Object.fromEntries(request.headers),body:await request.arrayBuffer()});assert.equal(r.status,200,await r.clone().text());return r.json()
  }
  const statement=async(rows,last4='1111',cookie=finance)=>{
    const body={format:'csv',name:`${rows[0].id}.csv`,issuer:n(300),category:cats[0].id,content:'Date,Merchant,Amount,Id,MCC\n'+rows.map(r=>[r.date??'2026-10-15',r.merchant,r.amount??'2.31',r.id,r.mcc??''].join(',')).join('\n'),mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',transactionId:'Id',mcc:'MCC',wholeFileLast4:last4}}
    const p=await h.post('statements/preview',body,cookie);return h.post('statements/commit',{...body,fingerprint:p.fingerprint},cookie)
  }
  await h.post('statements/cards',{issuer:n(300),last4:'1111',employee:people.samEmail})
  await h.post('statements/cards',{issuer:n(300),last4:'2222',employee:people.alexEmail})
  return {...people,cats,dimensions,values,fields,rule,upload,statement}
}
async function withSetup(run){const h=await harness();try{await run(h,await setup(h))}finally{await h.close()}}
async function manual(h,t,row,claim){
  const coding=t.fields(row.category,row.class,row.project)
  return h.post(`claims/${claim.id}/items`,{version:claim.version,kind:'receipt',date:row.date,merchant:row.merchant,amount:row.amount,category:coding.category,coding:coding.dimensions},t[row.employee])
}
const simplified=(fields,t)=>({category:fields.category?t.cats.findIndex(c=>c.id===fields.category):null,class:fields.dimensions?.[t.dimensions.class]?t.values.class.indexOf(fields.dimensions[t.dimensions.class]):null,project:fields.dimensions?.[t.dimensions.project]?t.values.project.indexOf(fields.dimensions[t.dimensions.project]):null})

test('CODE-002 labeled 120-charge and 120-receipt corpus measures finance-rule exact coding and twelve-month repeat learning through native public doors',()=>withSetup(async(h,t)=>{
  const claims={}
  for(const key of ['sam','alex','bea'])claims[key]=await h.post('claims',{title:n(7000+['sam','alex','bea'].indexOf(key))},t[key])
  for(const row of fixture.history)claims[row.employee]=await manual(h,t,row,claims[row.employee])
  for(const key of ['sam','alex','bea'])await h.post(`claims/${claims[key].id}/submit`,{version:claims[key].version},t[key])
  const historyMonths=new Set(fixture.history.map(r=>r.date.slice(0,7)));assert.equal(historyMonths.size,12)
  await t.rule(n(1001),t.fields(1))
  await t.rule(n(1002),t.fields(2),'personal',t.sam)
  for(const [mcc,cat]of [['5812',2],['5943',0]])await h.post(`${path}/mcc`,{version:(await h.get(`${path}/rules`,t.finance)).version,mcc,category:t.cats[cat].id,active:true},t.finance)
  let catalog=await h.get('coding');catalog=await h.post('coding/values',{version:catalog.version,id:t.values.account,active:false});await h.post('coding/values',{version:catalog.version,id:t.values.class[3],active:false})
  const imported=await t.statement(fixture.cases)
  const charges=[];for(const claim of imported.claims)charges.push(...(await h.get(`claims/${claim}`,t.sam)).items)
  assert.equal(charges.length,120)
  const scores={charges:120,receipts:120,financeRule:{matched:0,total:0},eligibleRepeatCategory:{matched:0,total:0},fullRepeatCategory:{matched:0,total:0},category:{matched:0,total:0},class:{matched:0,total:0},project:{matched:0,total:0},abstentions:0,sources:{}}
  const originals=[]
  for(const row of fixture.cases){
    const item=charges.find(i=>i.merchant===row.merchant&&i.amount_minor===Math.round(Number(row.amount)*100));assert.ok(item)
    const sources=item.codingSuggestions.flatMap(s=>s.evidence)
    const proposed=item.codingSuggestions.reduce((a,s)=>({category:s.fields.category??a.category,dimensions:{...a.dimensions,...s.fields.dimensions}}),{dimensions:{}})
    const actual=simplified(proposed,t),label={category:row.category,class:row.class,project:row.project}
    assert.deepEqual(actual,label,`${row.id} charge ${row.kind}`)
    const receipt=await t.upload(row);originals.push({row,id:receipt.receipt.id,notice:receipt.receipt.matchChoice.notice});const suggestions=receipt.codingSuggestions??[]
    const receiptFields=suggestions.reduce((a,s)=>({category:s.fields.category??a.category,dimensions:{...a.dimensions,...s.fields.dimensions}}),{dimensions:{}})
    const receiptActual=simplified(receiptFields,t)
    for(const field of ['category','class','project'])if(receiptActual[field]!==null)assert.equal(receiptActual[field],label[field],`${row.id} receipt ${field} suggestion must match its business label`)
    // Receipts have no charge MCC and no invented reader. Missing source data is an abstention, included in category recall.
    for(const measured of [actual,simplified(receiptFields,t)]){
      for(const field of ['category','class','project'])if(row[field]!==null){scores[field].total++;if(measured[field]===row[field])scores[field].matched++}
      if(row.repeat&&row.category!==null){scores.eligibleRepeatCategory.total++;if(measured.category===row.category)scores.eligibleRepeatCategory.matched++}
      if(row.repeat){scores.fullRepeatCategory.total++;if(row.category!==null&&measured.category===row.category)scores.fullRepeatCategory.matched++}
      if(row.kind==='finance'){scores.financeRule.total++;if(JSON.stringify(measured)===JSON.stringify(label))scores.financeRule.matched++}
      if(measured.category===null)scores.abstentions++
    }
    for(const source of new Set(sources.map(e=>e.source)))scores.sources[source]=(scores.sources[source]??0)+1
    assert.ok(!Object.values(proposed.dimensions).includes(t.values.class[3]))
    assert.notEqual(proposed.category,t.cats[3].id)
  }
  for(const field of ['financeRule','eligibleRepeatCategory','fullRepeatCategory','category','class','project'])scores[field].percent=100*scores[field].matched/scores[field].total
  assert.equal(scores.financeRule.percent,100);assert.ok(scores.eligibleRepeatCategory.percent>=90)
  console.log('CODE002_INGESTION_MEASUREMENT '+JSON.stringify(scores))
  // The employee opts each original into real charge matching. The actual linked charge can supply its MCC.
  for(const {row,id,notice}of originals)await h.post(`receipt-inbox/${id}/card-match`,{expectedSequence:0,enabled:true,merchant:row.merchant,date:row.date,total:row.amount,currency:'USD',notice},t.sam)
  const worker=await h.mf.getWorker();for(let i=0;i<2;i++)await worker.scheduled({scheduledTime:Date.now()+i*3600000,cron:'17 * * * *'})
  // Tip-tolerant matching correctly asks when multiple charges are candidates. The employee confirms the exact-total purchase through the normal attachment door.
  const inbox=await h.get('receipt-inbox',t.sam),versions=new Map();
  for(const {row,id}of originals){
    const original=inbox.receipts.find(r=>r.id===id);if(original.attachment)continue;
    const question=await h.get(`receipt-inbox/${id}/card-match-question`,t.sam),exact=question.candidates.filter(c=>c.amountMinor===Math.round(Number(row.amount)*100));assert.equal(exact.length,1)
    const chosen=exact[0];if(!versions.has(chosen.claimId))versions.set(chosen.claimId,(await h.get(`claims/${chosen.claimId}`,t.sam)).claim.version)
    const attached=await h.post(`receipt-inbox/${id}/attach`,{expectedSequence:original.lifecycleSequence,claimId:chosen.claimId,itemId:chosen.itemId,version:versions.get(chosen.claimId)},t.sam);versions.set(chosen.claimId,attached.claim.version)
  }
  const linked={fullRepeatCategory:{matched:scores.fullRepeatCategory.matched,total:scores.fullRepeatCategory.total},eligibleRepeatCategory:{matched:scores.eligibleRepeatCategory.matched,total:scores.eligibleRepeatCategory.total},category:{matched:scores.category.matched,total:scores.category.total},class:scores.class,project:scores.project,financeRule:scores.financeRule,abstentions:24}
  for(const {row,id}of originals){
    const read=await h.get(`${path}/suggestions?receipt=${id}`,t.sam),fields=read.suggestions.reduce((a,s)=>({category:s.fields.category??a.category,dimensions:{...a.dimensions,...s.fields.dimensions}}),{dimensions:{}}),actual=simplified(fields,t)
    assert.deepEqual(actual,{category:row.category,class:row.class,project:row.project},`${row.id} actual linked charge supplies its MCC without OCR`)
    if(['ambiguous','new-mcc','retired-class'].includes(row.kind)){linked.category.matched++;if(row.repeat){linked.fullRepeatCategory.matched++;linked.eligibleRepeatCategory.matched++}assert.ok(read.suggestions.some(s=>s.evidence.some(e=>e.source==='merchant-category'&&e.reason.includes(row.mcc))))}
  }
  for(const k of ['fullRepeatCategory','eligibleRepeatCategory','category'])linked[k].percent=100*linked[k].matched/linked[k].total
  assert.ok(linked.fullRepeatCategory.percent>=90,'all repeat charges and originals count, including required archived-account abstentions')
  console.log('CODE002_LINKED_MEASUREMENT '+JSON.stringify(linked))
}))

test('CODE-002 native rules, personal corrections, source rates and untouched statement undo use exact guarded public flows',()=>withSetup(async(h,t)=>{
  const merchant=n(8000),first=t.fields(0),corrected=t.fields(2)
  await h.post(`${path}/rules`,{version:0,scope:'finance',merchant,coding:first},t.sam,403)
  const financeRule=await t.rule(merchant,{...first,memo:n(8001)})
  await t.rule(merchant,corrected,'personal',t.sam)
  let preview=await h.post(`${path}/preview`,{merchant:`  ${merchant.toUpperCase()}  `,values:{}},t.sam)
  assert.deepEqual(simplified(preview.fields,t),{category:0,class:0,project:0});assert.ok(preview.evidence.every(e=>e.source==='merchant-rule'&&e.reason))
  await h.get(`${path}/rates`,t.sam,403)
  const pending=await t.statement([{id:n(8002),merchant,amount:'4.12'}]);let detail=await h.get(`claims/${pending.claims[0]}`,t.sam),item=detail.items[0]
  const undone=await h.post(`statements/${pending.file}/undo`,{},t.finance);assert.equal(undone.removed,1,'untouched category/memo suggestions are system coding, so statement undo removes them')
  const decision=(d,values,action='override')=>h.post(`${path}/suggestions/${d.items.at(-1).codingSuggestions.find(s=>s.status==='pending').id}/decision`,{claimVersion:d.claim.version,action,values},t.sam)
  const second=await t.statement([{id:n(8003),merchant,amount:'4.13'}]);detail=await h.get(`claims/${second.claims[0]}`,t.sam)
  await decision(detail,corrected)
  assert.equal((await h.post(`statements/${second.file}/undo`,{},t.finance)).removed,0,'a human override stays when the original statement is undone')
  const third=await t.statement([{id:n(8004),merchant,amount:'4.14'}]);detail=await h.get(`claims/${third.claims[0]}`,t.sam);await decision(detail,corrected)
  const accepted=await t.statement([{id:n(8007),merchant,amount:'4.18'}]);detail=await h.get(`claims/${accepted.claims[0]}`,t.sam);await decision(detail,undefined,'accept')
  assert.equal((await h.post(`statements/${accepted.file}/undo`,{},t.finance)).removed,0,'explicitly accepted automatic coding is human-confirmed and stays')
  await t.rule(n(8008),{category:t.cats[0].id})
  const sameDefault=await t.statement([{id:n(8009),merchant:n(8008),amount:'4.19'}]);detail=await h.get(`claims/${sameDefault.claims[0]}`,t.sam);await decision(detail,undefined,'accept')
  assert.equal((await h.post(`statements/${sameDefault.file}/undo`,{},t.finance)).removed,0,'confirmation stays even when the proposed category equals the import default')
  // Finance rules continue to win even after personal corrections; disabling the rule exposes personal behavior.
  await h.post(`${path}/rules`,{version:(await h.get(`${path}/rules`,t.finance)).version,id:financeRule.saved,scope:'finance',merchant,coding:first,active:false},t.finance)
  const personal=(await h.get(`${path}/rules`,t.sam)).rules[0]
  await h.post(`${path}/rules`,{version:(await h.get(`${path}/rules`,t.sam)).version,id:personal.id,scope:'personal',merchant,coding:corrected,active:false},t.sam)
  const fourth=await t.statement([{id:n(8005),merchant,amount:'4.15'}]);detail=await h.get(`claims/${fourth.claims[0]}`,t.sam)
  assert.deepEqual(simplified(detail.items.at(-1).codingSuggestions.at(-1).fields,t),{category:2,class:2,project:2},'two overrides teach this person the corrected coding')
  assert.ok(detail.items.at(-1).codingSuggestions.at(-1).evidence.every(e=>e.source==='learned-person'))
  const others=await t.statement([{id:n(8006),merchant,amount:'4.16'}],'2222');const other=await h.get(`claims/${others.claims[0]}`,t.alex)
  assert.equal(other.items[0].codingSuggestions.length,0,'another employee never learns from someone else’s private draft corrections')
  const rates=await h.get(`${path}/rates`,t.finance),ruleRate=rates.rules.find(r=>r.id===financeRule.saved)
  assert.equal(ruleRate.overridden,2);assert.equal(ruleRate.accepted,1);assert.equal(ruleRate.rate,33.33)
  assert.ok(rates.sources.some(r=>r.source==='merchant-rule'&&r.overridden===2))
  const activeRule=await t.rule(n(8010),{...first,memo:n(8011)})
  const human=await h.post(`${path}/preview`,{merchant:n(8010),values:{...corrected,memo:n(8012)}},t.sam)
  assert.deepEqual(human.appliedFields,[],'no source overwrites human-filled category, dimensions or memo')
  let catalog=await h.get('coding');await h.post('coding/values',{version:catalog.version,id:t.values.class[0],active:false})
  preview=await h.post(`${path}/preview`,{merchant:n(8010),values:{}},t.sam)
  assert.deepEqual(preview.appliedFields,[]);assert.match(preview.flags[0].reason,/archived/)
  assert.ok((await h.get(`${path}/rules`,t.finance)).flags.some(f=>f.rule_id===activeRule.saved))
  const blocked=await t.statement([{id:n(8013),merchant:n(8010),amount:'4.17'}]);detail=await h.get(`claims/${blocked.claims[0]}`,t.sam)
  assert.equal(detail.items.at(-1).codingSuggestions.length,0)
}))

test('CODE-002 two personal corrections change the third charge while shared history and another employee remain unchanged',()=>withSetup(async(h,t)=>{
  const merchant=n(8200),initial=t.fields(0),corrected=t.fields(2)
  let history=await h.post('claims',{title:n(8201)},t.alex)
  for(let i=0;i<2;i++)history=await manual(h,t,{employee:'alex',merchant,date:`2026-0${i+1}-15`,amount:'1.00',category:0,class:0,project:0},history)
  await h.post(`claims/${history.id}/submit`,{version:history.version},t.alex)
  for(let i=0;i<2;i++){
    const imported=await t.statement([{id:n(8202+i),merchant,amount:`3.0${i}`}]);const detail=await h.get(`claims/${imported.claims[0]}`,t.sam),item=detail.items.at(-1)
    assert.deepEqual(simplified(item.codingSuggestions.at(-1).fields,t),{category:0,class:0,project:0})
    await h.post(`${path}/suggestions/${item.codingSuggestions.at(-1).id}/decision`,{claimVersion:detail.claim.version,action:'override',values:corrected},t.sam)
  }
  const third=await t.statement([{id:n(8204),merchant,amount:'3.02'}]),detail=await h.get(`claims/${third.claims[0]}`,t.sam),item=detail.items.at(-1)
  assert.deepEqual(simplified(item.codingSuggestions.at(-1).fields,t),{category:2,class:2,project:2})
  assert.ok(item.codingSuggestions.at(-1).evidence.every(e=>e.source==='learned-person'))
  const other=await t.statement([{id:n(8205),merchant,amount:'3.03'}],'2222'),another=await h.get(`claims/${other.claims[0]}`,t.alex)
  assert.deepEqual(simplified(another.items.at(-1).codingSuggestions.at(-1).fields,t),{category:0,class:0,project:0})
}))

test('CODE-002 receipt coding stays private, carries human choices through charge arrival and attachment, and approver feedback preserves frozen revisions',()=>withSetup(async(h,t)=>{
  const merchant=fixture.cases[0].merchant,rule=await t.rule(merchant,{...t.fields(0),memo:n(8301)})
  const uploaded=await t.upload({id:n(8302),merchant}),id=uploaded.receipt.id
  await h.get(`${path}/suggestions?receipt=${id}`,t.finance,404)
  const current=await h.get(`${path}/suggestions?receipt=${id}`,t.sam)
  await h.post(`${path}/receipts/${id}`,{version:current.context.version,merchant,values:{...t.fields(2),memo:n(8303)}},t.sam)
  const original=await h.get(`${path}/suggestions?receipt=${id}`,t.sam)
  assert.equal(original.suggestions[0].status,'override')
  const imported=await t.statement([{id:n(8304),merchant,amount:fixture.cases[0].amount}]);let detail=await h.get(`claims/${imported.claims[0]}`,t.sam),item=detail.items.at(-1)
  await h.post(`receipt-inbox/${id}/attach`,{expectedSequence:0,claimId:detail.claim.id,itemId:item.id,version:detail.claim.version},t.sam)
  detail=await h.get(`claims/${detail.claim.id}`,t.sam);item=detail.items.at(-1)
  assert.equal(item.allocations[0].category_id,t.cats[2].id);assert.deepEqual(item.coding,t.fields(2).dimensions);assert.equal(item.description,n(8303))
  assert.deepEqual((await h.get(`${path}/suggestions?receipt=${id}`,t.sam)).context.values,original.context.values,'a later charge never changes coding entered on the original')

  const another=await t.upload({id:n(8305),merchant,receipt:fixture.cases[1].receipt}),posted=await t.statement([{id:n(8306),merchant,amount:fixture.cases[1].amount}]);detail=await h.get(`claims/${posted.claims[0]}`,t.sam);item=detail.items.at(-1)
  const corrected=await h.post(`claims/${detail.claim.id}/items`,{version:detail.claim.version,item:item.id,kind:'receipt',date:item.spent_on,merchant:item.merchant,amount:fixture.cases[1].amount,category:t.cats[1].id,coding:t.fields(1).dimensions,description:n(8307)},t.sam)
  await h.post(`receipt-inbox/${another.receipt.id}/attach`,{expectedSequence:0,claimId:corrected.id,itemId:item.id,version:corrected.version},t.sam)
  detail=await h.get(`claims/${corrected.id}`,t.sam);item=detail.items.at(-1)
  assert.equal(item.allocations[0].category_id,t.cats[1].id);assert.deepEqual(item.coding,t.fields(1).dimensions);assert.equal(item.description,n(8307),'receipt suggestions never overwrite employee coding already entered on the expense')

  const fresh=await t.statement([{id:n(8310),merchant:n(8311),amount:'2.33'}])
  // A new finance rule is introduced before a separate charge so a routed approver can review its frozen advice.
  await t.rule(n(8312),t.fields(0))
  const review=await t.statement([{id:n(8313),merchant:n(8312),amount:'2.34'}]);const before=await h.get(`claims/${review.claims[0]}`,t.sam),suggestion=before.items.at(-1).codingSuggestions.at(-1)
  const submitted=await h.post(`claims/${before.claim.id}/submit`,{version:before.claim.version},t.sam)
  const frozen=(await h.get(`claims/${submitted.id}`,t.manager)).revisions.at(-1).snapshot
  await h.post(`${path}/suggestions/${suggestion.id}/decision`,{claimVersion:submitted.version,action:'accept'},t.finance,403)
  const feedback=await h.post(`${path}/suggestions/${suggestion.id}/decision`,{claimVersion:submitted.version,action:'override',values:t.fields(1)},t.manager)
  assert.equal(feedback.applied,false);assert.equal(feedback.requiresReturn,true)
  assert.deepEqual((await h.get(`claims/${submitted.id}`,t.manager)).revisions.at(-1).snapshot,frozen)
  const records=await h.get(`${path}/rates`,t.finance);assert.ok(records.rules.some(r=>r.id===rule.saved&&r.overridden>0))
}))
