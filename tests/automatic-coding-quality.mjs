import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { harness } from './harness.mjs'
import { issuerServer } from './fixtures/feed/server.mjs'

export const n = number => `synthetic-coaster-${number}`
export const path = 'coding/automatic'
export const fixture = JSON.parse(await readFile('tests/fixtures/coding/labels.json','utf8'))
export async function setup(h) {
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
export async function manual(h,t,row,claim){
  const coding=t.fields(row.category,row.class,row.project)
  return h.post(`claims/${claim.id}/items`,{version:claim.version,kind:'receipt',date:row.date,merchant:row.merchant,amount:row.amount,category:coding.category,coding:coding.dimensions},t[row.employee])
}
export const simplified=(fields,t)=>({category:fields.category?t.cats.findIndex(c=>c.id===fields.category):null,class:fields.dimensions?.[t.dimensions.class]?t.values.class.indexOf(fields.dimensions[t.dimensions.class]):null,project:fields.dimensions?.[t.dimensions.project]?t.values.project.indexOf(fields.dimensions[t.dimensions.project]):null})

/** Real scheduled SSH/SFTP pick-up from a synthetic issuer network edge. No file-upload/preview/commit substitute. */
export async function ingestProgramCorpus(h,t,corpus=fixture) {
  const issuer=await issuerServer()
  let connected
  try {
    const sequence=n(9901),filename=`${n(9902)}.csv`
    issuer.files.set(filename,'Date,Merchant,Amount,Card,Transaction,MCC,Sequence\n'+corpus.cases.map(row=>[row.date,row.merchant,row.amount,'1111',row.id,row.mcc??'',sequence].join(',')).join('\n'))
    connected=await h.post('feeds/program',{...issuer.credentials,issuer:n(300),category:t.cats[0].id,intervalMinutes:60,consent:true,mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',card:'Card',transactionId:'Transaction',mcc:'MCC',sequence:'Sequence'}},t.finance)
    assert.equal(issuer.requests.length,0,'connecting a feed only records configuration; the scheduler picks up the file')
    const worker=await h.mf.getWorker()
    await worker.scheduled({scheduledTime:new Date(),cron:'17 * * * *'})
    const state=await h.get('feeds/program',t.finance),feed=state.feeds.find(f=>f.id===connected.id)
    assert.ok(feed?.lastSuccessAt,feed?.error??'The scheduled program feed did not complete')
    assert.equal(feed.error,null)
    const deliveries=state.deliveries.filter(d=>d.feed_id===connected.id)
    assert.equal(deliveries.length,1,'the corpus is one issuer delivery')
    const delivery=deliveries[0]
    assert.equal(delivery.charges,corpus.cases.length)
    assert.equal(delivery.issuer_sequence,sequence)
    const ledger=await h.get('statements',t.finance),received=ledger.charges.filter(c=>c.file_id===delivery.file_id)
    assert.equal(received.length,corpus.cases.length,'read back only the charges created from this scheduled delivery')
    const itemIds=new Set(received.map(c=>c.item_id)),charges=[]
    for(const claim of new Set(received.map(c=>c.claim_id)))charges.push(...(await h.get(`claims/${claim}`,t.sam)).items.filter(i=>itemIds.has(i.id)&&i.card_charge_id))
    assert.equal(charges.length,corpus.cases.length,'native employee expenses retain every program charge')
    assert.ok(issuer.requests.some(r=>r.operation==='authenticate')&&issuer.requests.some(r=>r.operation==='read'),'the scheduler used actual public-key SSH/SFTP')
    return {charges,delivery:{id:delivery.id,fileId:delivery.file_id,issuerSequence:delivery.issuer_sequence,charges:delivery.charges},transport:'scheduled-sftp-mapped-csv'}
  }finally{
    try {if(connected)await h.post(`feeds/program/${connected.id}/disconnect`,{version:connected.version,consent:true},t.finance)}
    finally {await issuer.close()}
  }
}

/** Held-key journey, outside push Verify. AI traffic is real; SFTP's issuer is a synthetic actual SSH server.
 * The secret is introduced at the paid edge, so Worker captures and artifacts contain a synthetic application key. */
export async function runLiveCodingQuality({key,model,output}={}) {
  assert.ok(typeof key==='string'&&key.length,'COASTER_AI_KEY is required for this real provider journey')
  assert.ok(typeof model==='string'&&model.length,'COASTER_AI_MODEL must name the actual model to measure')
  let providerRequests=0
  const gitSHA=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
  const h=await harness({bindings:origin=>({AI_ENABLED:'true',AI_MODEL:model,AI_API_KEY:n(9900),RER_DEV_ORIGIN:origin}),aiEdge:async request=>{
    assert.equal(new URL(request.url).origin,'https://api.openai.com')
    const headers={authorization:`Bearer ${key}`,'content-type':request.headers.get('content-type')??'application/json',accept:request.headers.get('accept')??'application/json'}
    providerRequests++
    return fetch(request.url,{method:request.method,headers,body:await request.arrayBuffer(),redirect:'manual'})
  }})
  try {
    const t=await setup(h),claims={}
    for(const employee of ['sam','alex','bea'])claims[employee]=await h.post('claims',{title:n(7000+['sam','alex','bea'].indexOf(employee))},t[employee])
    for(const row of fixture.history)claims[row.employee]=await manual(h,t,row,claims[row.employee])
    for(const employee of ['sam','alex','bea'])await h.post(`claims/${claims[employee].id}/submit`,{version:claims[employee].version},t[employee])
    await t.rule(n(1001),t.fields(1));await t.rule(n(1002),t.fields(2),'personal',t.sam)
    for(const [mcc,cat]of [['5812',2],['5943',0]])await h.post(`${path}/mcc`,{version:(await h.get(`${path}/rules`,t.finance)).version,mcc,category:t.cats[cat].id,active:true},t.finance)
    let catalog=await h.get('coding');catalog=await h.post('coding/values',{version:catalog.version,id:t.values.account,active:false});await h.post('coding/values',{version:catalog.version,id:t.values.class[3],active:false})
    const settings=await h.get('settings/receipt-reading')
    await h.post('settings/receipt-reading',{version:settings.version,enabled:true,threshold:0.95,model,consent:true})
    const {charges,delivery}=await ingestProgramCorpus(h,t,fixture)
    const records=fixture.cases.map(row=>{
      const item=charges.find(i=>i.merchant===row.merchant&&i.amount_minor===Math.round(Number(row.amount)*100))
      assert.ok(item)
      const fields=item.codingSuggestions.reduce((a,s)=>({...a,...s.fields,dimensions:{...a.dimensions,...s.fields.dimensions}}),{})
      return {id:row.id,door:'scheduled-sftp-program-feed',actual:simplified(fields,t),sources:[...new Set(item.codingSuggestions.flatMap(s=>s.evidence.map(e=>e.source)))]}
    })
    const fieldSummary=fields=>Object.fromEntries(Object.entries(fields??{}).map(([name,field])=>[name,{value:Array.isArray(field.value)?field.value.map(({description,amount,quantity})=>({description,amount,quantity})):field.value,confidence:field.confidence,review:field.review,reasons:field.reasons,source:field.source}]))
    let next=0
    await Promise.all(Array.from({length:4},async()=>{
      for(;;){
        const index=next++;if(index>=fixture.cases.length)return
        const row=fixture.cases[index],receipt=await t.upload(row,'') // Deliberately no typed merchant: only actual image reading may supply it.
        const id=receipt.receipt.id,base=`/api/coaster/receipt-inbox/${id}/reading`
        const read=await h.send(base,{expectedSequence:0,expectedReadingSequence:0,consent:true},t.sam)
        let coding={status:0,value:{status:'review',values:{},codingSuggestions:[]}}
        if(read.status===200&&typeof read.value.prefill?.merchant==='string')coding=await h.send(base+'/coding',{expectedSequence:read.value.lifecycleSequence,expectedReadingSequence:read.value.sequence,contextVersion:0,consent:true},t.sam)
        const suggestions=coding.value?.codingSuggestions??[]
        records.push({id:row.id,door:'actual-unlinked-image-reading',actual:simplified(coding.value?.values??{},t),sources:[...new Set(suggestions.flatMap(s=>s.evidence.map(e=>e.source)))],reading:{http:read.status,state:read.value?.state??'unavailable',merchant:read.value?.prefill?.merchant??null,merchantVerified:typeof read.value?.prefill?.merchant==='string',fields:fieldSummary(read.value?.fields)},understanding:{http:coding.status,status:coding.value?.status??'review',reason:coding.value?.reason??coding.value?.error??null,model:coding.value?.model??null,reviewFields:coding.value?.reviewFields??[]}})
      }
    }))
    const measure=rows=>{
      const result={records:rows.length,financeRule:{matched:0,total:0},fullRepeatCategory:{matched:0,total:0},eligibleRepeatCategory:{matched:0,total:0},category:{matched:0,total:0},class:{matched:0,total:0},project:{matched:0,total:0},categoryAbstentions:0,suggestedAgreement:Object.fromEntries(['category','class','project'].map(field=>[field,{matched:0,total:0}])),sources:{}}
      for(const record of rows){
        const label=fixture.cases.find(r=>r.id===record.id);assert.ok(label)
        for(const field of ['category','class','project']){
          if(label[field]!==null){result[field].total++;if(record.actual[field]===label[field])result[field].matched++}
          if(record.actual[field]!==null){result.suggestedAgreement[field].total++;if(label[field]!==null&&record.actual[field]===label[field])result.suggestedAgreement[field].matched++}
        }
        if(label.repeat){result.fullRepeatCategory.total++;if(label.category!==null&&record.actual.category===label.category)result.fullRepeatCategory.matched++}
        if(label.repeat&&label.category!==null){result.eligibleRepeatCategory.total++;if(record.actual.category===label.category)result.eligibleRepeatCategory.matched++}
        if(label.kind==='finance'){result.financeRule.total++;if(['category','class','project'].every(f=>record.actual[f]===label[f]))result.financeRule.matched++}
        if(record.actual.category===null)result.categoryAbstentions++
        for(const source of record.sources)result.sources[source]=(result.sources[source]??0)+1
      }
      for(const field of ['financeRule','fullRepeatCategory','eligibleRepeatCategory','category','class','project'])result[field].percent=result[field].total?100*result[field].matched/result[field].total:null
      for(const field of ['category','class','project']){const score=result.suggestedAgreement[field];score.percent=score.total?100*score.matched/score.total:null}
      return result
    }
    const result={gitSHA,measuredAt:new Date().toISOString(),model,providerRequests,delivery,fixture:{charges:fixture.cases.length,receiptOriginals:fixture.cases.length,priorNativeExpenses:fixture.history.length,historyMonths:new Set(fixture.history.map(r=>r.date.slice(0,7))).size},method:'Native scheduled SFTP public-key pick-up of the complete issuer mapped-CSV corpus plus actual uploaded PNGs, real BaseAI image reading and separate explicit real BaseAI coding consent. No manual charge-file upload, typed merchant, human correction, charge attachment, label-to-app channel, response replay or AI provider substitute. Concurrency four. Unknown/retired and failed/abstaining cases remain in the full repeat denominator.',charges:measure(records.filter(r=>r.door==='scheduled-sftp-program-feed')),unlinkedReceipts:measure(records.filter(r=>r.door==='actual-unlinked-image-reading')),combined:measure(records),records:records.sort((a,b)=>a.id.localeCompare(b.id)||a.door.localeCompare(b.door)),limitations:['The issuer network edge is a synthetic real SSH/SFTP server, not an issuer account or vendor onboarding proof.','Only explicitly mapped CSV is exercised; GL, VCF and PGP forms are not exercised.','The original catalog and receipt fixture text contain opaque synthetic names; missing business intent is not invented.','Scores are observations, never a claim that a held-key run met an unmet bar.']}
    if(output)await writeFile(output,JSON.stringify(result,null,2)+'\n')
    return result
  }finally{await h.close()}
}

/** AGENT-005: run the entire frozen old + semantic coding populations through
 * posted expenses and private originals. Source facts/merchant rules are input;
 * coding labels are read only after submission to score the agent decisions. */
export async function runPolicyAgentCodingQuality({output}={}){
 const semantic=JSON.parse(await readFile('tests/fixtures/coding/semantic/labels.json','utf8'));
 const rules=JSON.parse(await readFile('tests/fixtures/coding/semantic/rules.json','utf8'));
 const history=JSON.parse(await readFile('tests/fixtures/coding/semantic/history.json','utf8')).rows;
 const gitSHA=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),h=await harness();
 try{
  const t=await setup(h),claims={},counts={},historyClaims=new Map();
  for(const person of ['sam','alex','bea']){claims[person]=await h.post('claims',{title:n(64000+historyClaims.size)},t[person]);counts[person]=0;historyClaims.set(claims[person].id,{claim:claims[person],person});}
  for(const row of [...fixture.history,...history]){
   if(counts[row.employee]===100){claims[row.employee]=await h.post('claims',{title:n(64000+historyClaims.size)},t[row.employee]);counts[row.employee]=0;}
   claims[row.employee]=await manual(h,t,row,claims[row.employee]);counts[row.employee]++;historyClaims.set(claims[row.employee].id,{claim:claims[row.employee],person:row.employee});
  }
  for(const {claim,person}of historyClaims.values())await h.post(`claims/${claim.id}/submit`,{version:claim.version},t[person]);
  await t.rule(n(1001),t.fields(1));await t.rule(n(1002),t.fields(2),'personal',t.sam);
  for(const row of rules.finance)await t.rule(row.merchant,t.fields(row.coding.category,row.coding.class,row.coding.project));
  for(const row of rules.personal)await t.rule(row.merchant,t.fields(row.coding.category,row.coding.class,row.coding.project),'personal',t[row.employee]);
  for(const row of rules.mcc)await h.post(`${path}/mcc`,{version:(await h.get(`${path}/rules`,t.finance)).version,mcc:row.mcc,category:t.cats[row.category].id,active:true},t.finance);
  let catalog=await h.get('coding');catalog=await h.post('coding/values',{version:catalog.version,id:t.values.account,active:false});await h.post('coding/values',{version:catalog.version,id:t.values.class[3],active:false});
  await h.post('settings/approval-envelope',{version:0,enabled:true,limit:'1000.00',consent:true});
  const matching=await h.get('settings/card-matching');await h.post('settings/card-matching',{version:matching.version,enabled:true,windowDays:7,tipPercent:0,fxPercent:0});
  const sources=[{corpus:fixture,folder:''},{corpus:semantic,folder:'semantic/'}],originals=[],reportIds=new Set();
  for(const {corpus,folder}of sources){
   const imported=await t.statement(corpus.cases);for(const id of imported.claims)reportIds.add(id);
   for(const row of corpus.cases){
    const original=await t.upload({...row,receipt:folder+row.receipt});
    originals.push({row,id:original.receipt.id});
    await h.post(`receipt-inbox/${original.receipt.id}/card-match`,{expectedSequence:0,enabled:true,merchant:row.merchant,date:row.date,total:row.amount,currency:'USD',notice:original.receipt.matchChoice.notice},t.sam);
   }
  }
  const worker=await h.mf.getWorker();for(let hour=0;hour<3;hour++)await worker.scheduled({scheduledTime:Date.now()+hour*3600000,cron:'17 * * * *'});
  const allItems=[];for(const id of reportIds)allItems.push(...(await h.get(`claims/${id}`,t.sam)).items);
  assert.equal(allItems.length,240);assert.equal(originals.length,240);
  const originalById=new Map((await h.get('receipt-inbox',t.sam)).receipts.map(r=>[r.id,r]));
  // A person explicitly resolves every remaining question. No charge amount,
  // coding or expected label is changed to force an automatic approval.
  for(const {row,id}of originals){
   const original=originalById.get(id);if(original.attachment)continue;
   const item=allItems.find(i=>i.card_transaction_key.endsWith('id:'+row.id));assert.ok(item);
   const claim=(await h.get(`claims/${item.claim_id}`,t.sam)).claim;
   await h.post(`receipt-inbox/${id}/attach`,{expectedSequence:original.lifecycleSequence,claimId:claim.id,itemId:item.id,version:claim.version},t.sam);
  }
  console.log('All 240 charges and originals retained; evaluating submitted recommendations');
  const records=[];let approved=0,routed=0,codingReview=0;
  for(const id of reportIds){
   const before=await h.get(`claims/${id}`,t.sam),submitted=await h.post(`claims/${id}/submit`,{version:before.claim.version},t.sam);
   const detail=await h.get(`claims/${id}`,t.manager),snapshot=detail.revisions.at(-1).snapshot;
   for(const item of snapshot.items){
    const label=[...fixture.cases,...semantic.cases].find(r=>item.card_transaction_key.endsWith('id:'+r.id));assert.ok(label);
    const approval=snapshot.expenseApprovals?.find(a=>a.item===item.id),review=snapshot.policyReview.recommendations.find(r=>r.item===item.id),actual=simplified({category:item.allocations.length===1?item.allocations[0].category_id:undefined,dimensions:item.coding},t);
    if(approval){assert.equal(approval.source,'agent');assert.deepEqual(actual,{category:label.category,class:label.class,project:label.project},label.id+' approved coding must equal its label');assert.equal(review.evidence.codingAssessment.reviewRequired,false);approved++;}
    else routed++;
    if(review.evidence.codingAssessment.reviewRequired){codingReview++;assert.equal(approval,undefined);assert.equal(submitted.status,'submitted');}
    records.push({id:label.id,item:item.id,approved:!!approval,actual,label:{category:label.category,class:label.class,project:label.project},codingReview:review.evidence.codingAssessment.reviewRequired,method:review.evidence.codingAssessment.method,receipt:review.evidence.receiptAssessment,eligible:review.evidence.agentEligible,exceptions:snapshot.exceptions.filter(e=>e.item===item.id)});
   }
  }
  const result={gitSHA,journey:'AGENT-005 full CODE-002 coding population',charges:240,originals:240,approved,routed,codingReview,approvedCodingAgreement:100,method:'Existing frozen old and semantic corpora, current native source rules and historical observations, all 240 posted charges and 240 uploaded originals, explicit typed matching and human answers to remaining questions. No provider call, relabel, expense correction or omitted case.',records};
  if(output)await writeFile(output,JSON.stringify(result,null,2)+'\n');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),gitSHA,'candidate SHA must stay fixed during the journey');
  assert.equal(records.length,240);assert.ok(approved>0);assert.ok(codingReview>0);assert.equal(approved+routed,240);return result;
 }finally{await h.close()}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const outputIndex=process.argv.indexOf('--output')
  try {const result=process.argv.includes('--policy-agent')?await runPolicyAgentCodingQuality({output:outputIndex<0?undefined:process.argv[outputIndex+1]}):await runLiveCodingQuality({key:process.env.COASTER_AI_KEY,model:process.env.COASTER_AI_MODEL,output:outputIndex<0?undefined:process.argv[outputIndex+1]});const {records,...summary}=result;console.log(JSON.stringify(summary,null,2))}
  catch(error){console.error(error instanceof Error?error.message:'Automatic coding quality journey failed');process.exitCode=1}
}
