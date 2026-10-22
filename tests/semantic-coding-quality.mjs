import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import {harness} from './harness.mjs'
import {ingestProgramCorpus,runLiveCodingQuality} from './automatic-coding-quality.mjs'

const sourcePath='coding/automatic'
const n=value=>`synthetic-coaster-${value}`
const fieldNames=['category','class','project']
const scoreNames=['financeRule','fullRepeatCategory','eligibleRepeatCategory',...fieldNames]
const ratio=(matched=0,total=0)=>({matched,total,percent:total?100*matched/total:null})

/** Labels enter only this measurement function, after the native API has produced each record. */
export function measureSemanticCoding(records,labels){
  const expected=new Map(labels.map(label=>[label.id,label]))
  const result={records:records.length,...Object.fromEntries(scoreNames.map(name=>[name,ratio()])),categoryAbstentions:0,customer:ratio(),suggestedCustomerAgreement:ratio(),suggestedAgreement:Object.fromEntries(fieldNames.map(name=>[name,ratio()])),sources:{}}
  for(const record of records){
    const label=expected.get(record.id);assert.ok(label,'Every measured record has a fixed pre-existing business label')
    for(const field of fieldNames){
      if(label[field]!==null){result[field].total++;if(record.actual[field]===label[field])result[field].matched++}
      if(record.actual[field]!==null){result.suggestedAgreement[field].total++;if(label[field]!==null&&record.actual[field]===label[field])result.suggestedAgreement[field].matched++}
    }
    if(label.expectedCustomer!==null&&label.expectedCustomer!==undefined){result.customer.total++;if(record.actual.customer===label.expectedCustomer)result.customer.matched++}
    if(record.actual.customer!==null&&record.actual.customer!==undefined){result.suggestedCustomerAgreement.total++;if(label.expectedCustomer!==null&&record.actual.customer===label.expectedCustomer)result.suggestedCustomerAgreement.matched++}
    if(label.repeat){result.fullRepeatCategory.total++;if(label.category!==null&&record.actual.category===label.category)result.fullRepeatCategory.matched++}
    if(label.repeat&&label.category!==null){result.eligibleRepeatCategory.total++;if(record.actual.category===label.category)result.eligibleRepeatCategory.matched++}
    if(label.kind==='finance'){result.financeRule.total++;if(fieldNames.every(field=>record.actual[field]===label[field]))result.financeRule.matched++}
    if(record.actual.category===null)result.categoryAbstentions++
    for(const source of record.sources)result.sources[source]=(result.sources[source]??0)+1
  }
  result.customer=ratio(result.customer.matched,result.customer.total);result.suggestedCustomerAgreement=ratio(result.suggestedCustomerAgreement.matched,result.suggestedCustomerAgreement.total)
  for(const name of scoreNames)result[name]=ratio(result[name].matched,result[name].total)
  for(const name of fieldNames){const score=result.suggestedAgreement[name];result.suggestedAgreement[name]=ratio(score.matched,score.total)}
  return result
}

function addScores(a,b){
  const result={records:a.records+b.records,categoryAbstentions:a.categoryAbstentions+b.categoryAbstentions,suggestedAgreement:{},sources:{}}
  for(const name of scoreNames)result[name]=ratio(a[name].matched+b[name].matched,a[name].total+b[name].total)
  for(const name of fieldNames)result.suggestedAgreement[name]=ratio(a.suggestedAgreement[name].matched+b.suggestedAgreement[name].matched,a.suggestedAgreement[name].total+b.suggestedAgreement[name].total)
  for(const source of new Set([...Object.keys(a.sources),...Object.keys(b.sources)]))result.sources[source]=(a.sources[source]??0)+(b.sources[source]??0)
  return result
}

/** Combining results never drops a case or averages percentages. Preserve the original corpora as separate artifacts. */
export function combineCodingQuality(old,semantic){
  assert.equal(old.gitSHA,semantic.gitSHA,'Old and semantic quality measurements must use the same exact candidate')
  assert.equal(old.model,semantic.model,'Old and semantic quality measurements must use the same actual model')
  return {gitSHA:semantic.gitSHA,model:semantic.model,old,semantic,combined:{charges:addScores(old.charges,semantic.charges),unlinkedReceipts:addScores(old.unlinkedReceipts,semantic.unlinkedReceipts),all:addScores(old.combined,semantic.combined)}}
}

const readingSummary=fields=>Object.fromEntries(Object.entries(fields??{}).map(([name,field])=>[name,{value:Array.isArray(field.value)?field.value.map(({description,amount,quantity})=>({description,amount,quantity})):field.value,confidence:field.confidence,review:field.review,reasons:field.reasons,source:field.source}]))

export async function loadSemanticFixture(){
  const folder=new URL('./fixtures/coding/semantic/',import.meta.url)
  const [catalog,rules,labels,charges,history]=await Promise.all(['catalog.json','rules.json','labels.json','charges.json','history.json'].map(async name=>JSON.parse(await readFile(new URL(name,folder),'utf8'))))
  return {folder,catalog,rules,labels,charges,history}
}

/** Native owner configuration is declared separately from the held-out cases' expected coding. */
export async function setupSemanticCoding(h,config){
  await h.post('settings/business',{...config.business,receiptThreshold:'10000'})
  const managerEmail=`${n(81000)}@example.test`,financeEmail=`${n(81001)}@example.test`
  const manager=await h.person(managerEmail,{employee:true,manager:true}),finance=await h.person(financeEmail,{employee:true,finance:true},managerEmail)
  const people={manager,finance,managerEmail,financeEmail},departments={}
  for(const department of config.departments)departments[department.key]=(await h.post('settings/departments',{name:department.name})).id
  for(const person of config.people){
    people[person.key]=await h.person(person.email,{employee:true},managerEmail);people[`${person.key}Email`]=person.email
    await h.post('settings/members',{email:person.email,name:person.name,employee:true,approver:managerEmail,department:departments[person.department]})
  }
  const cats=[]
  for(const category of config.categories)cats.push(await h.post('settings/categories',{name:category.name,accountCode:category.accountCode,taxCode:category.taxCode}))
  let catalog=await h.get('coding');const dimensions={},values={},valueKeys={},valueNames={}
  for(const [key,dimension]of Object.entries(config.dimensions)){
    catalog=await h.post('coding/dimensions',{version:catalog.version,name:dimension.name,kind:dimension.kind});dimensions[key]=catalog.saved;values[key]=[];valueKeys[key]={};valueNames[key]={}
    for(const value of dimension.values){
      catalog=await h.post('coding/values',{version:catalog.version,dimension:dimensions[key],name:value.name})
      values[key].push(catalog.saved);valueKeys[key][value.key]=catalog.saved;valueNames[key][catalog.saved]=value.name
    }
  }
  for(const [index,category]of config.categories.entries())if(category.ledgerAccount){
    assert.ok(valueKeys.account[category.ledgerAccount],'The declared category account exists in owner configuration')
    await h.post('settings/categories',{id:cats[index].id,name:category.name,accountCode:category.accountCode,taxCode:category.taxCode,ledgerAccountId:valueKeys.account[category.ledgerAccount]})
  }
  const fields=coding=>({...(coding.category===null?{}:{category:cats[coding.category].id}),dimensions:Object.fromEntries(['class','project'].filter(key=>coding[key]!==null).map(key=>[dimensions[key],values[key][coding[key]]]))})
  await h.post('statements/cards',{issuer:n(300),last4:'1111',employee:people.samEmail})
  return {...people,cats,dimensions,values,valueKeys,valueNames,fields}
}

export async function prepareSemanticHistory(h,t,fixture){
  const claims={}
  for(const employee of new Set(fixture.history.rows.map(row=>row.employee)))claims[employee]=await h.post('claims',{title:n(81010+Object.keys(claims).length)},t[employee])
  for(const row of fixture.history.rows){
    const coding=t.fields(row)
    claims[row.employee]=await h.post(`claims/${claims[row.employee].id}/items`,{version:claims[row.employee].version,kind:'receipt',date:row.date,merchant:row.merchant,amount:row.amount,category:coding.category,coding:coding.dimensions},t[row.employee])
  }
  for(const [employee,claim]of Object.entries(claims))await h.post(`claims/${claim.id}/submit`,{version:claim.version},t[employee])
  for(const value of fixture.catalog.retireAfterHistory){
    const catalog=await h.get('coding'),id=t.valueKeys[value.dimension][value.key];assert.ok(id)
    await h.post('coding/values',{version:catalog.version,id,active:false})
  }
  for(const rule of fixture.rules.finance)await h.post(`${sourcePath}/rules`,{version:(await h.get(`${sourcePath}/rules`,t.finance)).version,scope:'finance',merchant:rule.merchant,coding:t.fields(rule.coding),active:rule.active},t.finance)
  for(const rule of fixture.rules.personal)await h.post(`${sourcePath}/rules`,{version:(await h.get(`${sourcePath}/rules`,t[rule.employee])).version,scope:'personal',merchant:rule.merchant,coding:t.fields(rule.coding),active:true},t[rule.employee])
  for(const rule of fixture.rules.mcc)await h.post(`${sourcePath}/mcc`,{version:(await h.get(`${sourcePath}/rules`,t.finance)).version,mcc:rule.mcc,category:t.cats[rule.category].id,active:true},t.finance)
}

const actualFields=(fields,t)=>({...Object.fromEntries(fieldNames.map(key=>[key,key==='category'?(fields.category?t.cats.findIndex(c=>c.id===fields.category):null):(fields.dimensions?.[t.dimensions[key]]?t.values[key].indexOf(fields.dimensions[t.dimensions[key]]):null)])),customer:fields.customer||t.valueNames.customer[fields.dimensions?.[t.dimensions.customer]]||null})
export async function uploadSemantic(h,t,folder,receipt){
  const bytes=await readFile(new URL(receipt.receipt,folder)),form=new FormData()
  form.append('file',new File([bytes],receipt.receipt.split('/').at(-1),{type:'image/png'}));form.append('source','upload')
  const request=new Request(h.origin+'/api/coaster/receipt-inbox',{method:'POST',headers:{origin:h.origin,cookie:t[receipt.employee]},body:form})
  const response=await h.mf.dispatchFetch(request.url,{method:'POST',headers:Object.fromEntries(request.headers),body:await request.arrayBuffer()})
  assert.equal(response.status,200,'Actual semantic receipt original uploads through the private native door')
  return response.json()
}

/** Real held-key evaluation. The only provider credential enters at the paid network edge; the Worker sees a synthetic key. */
export async function runSemanticCodingQuality({key,model,output,oldResult,includeOld=false}={}){
  assert.ok(typeof key==='string'&&key.length,'COASTER_AI_KEY is required for the real provider journey')
  assert.ok(typeof model==='string'&&model.length,'COASTER_AI_MODEL must name the actual model to measure')
  assert.ok(!(oldResult&&includeOld),'Choose a prior exact-candidate result or a fresh old-corpus run')
  const fixture=await loadSemanticFixture(),gitSHA=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
  let providerRequests=0
  const h=await harness({bindings:origin=>({AI_ENABLED:'true',AI_MODEL:model,AI_API_KEY:n(81999),RER_DEV_ORIGIN:origin}),aiEdge:async request=>{
    assert.equal(new URL(request.url).origin,'https://api.openai.com')
    const headers={authorization:`Bearer ${key}`,'content-type':request.headers.get('content-type')??'application/json',accept:request.headers.get('accept')??'application/json'}
    providerRequests++
    return fetch(request.url,{method:request.method,headers,body:await request.arrayBuffer(),redirect:'manual'})
  }})
  let semantic
  try {
    const t=await setupSemanticCoding(h,fixture.catalog)
    await prepareSemanticHistory(h,t,fixture)
    const settings=await h.get('settings/receipt-reading')
    await h.post('settings/receipt-reading',{version:settings.version,enabled:true,threshold:.95,model,consent:true})
    const {charges,delivery}=await ingestProgramCorpus(h,t,{cases:fixture.charges.rows})
    const records=fixture.charges.rows.map(row=>{
      const item=charges.find(item=>item.merchant===row.merchant&&item.amount_minor===Math.round(Number(row.amount)*100));assert.ok(item)
      const fields=item.codingSuggestions.reduce((all,suggestion)=>({...all,...suggestion.fields,dimensions:{...all.dimensions,...suggestion.fields.dimensions}}),{})
      return {id:row.id,door:'scheduled-sftp-program-feed',actual:actualFields(fields,t),sources:[...new Set(item.codingSuggestions.flatMap(suggestion=>suggestion.evidence.map(evidence=>evidence.source)))]}
    })
    let next=0
    await Promise.all(Array.from({length:4},async()=>{
      for(;;){
        const index=next++;if(index>=fixture.labels.cases.length)return
        const label=fixture.labels.cases[index],upload=await uploadSemantic(h,t,fixture.folder,label),id=upload.receipt.id,base=`/api/coaster/receipt-inbox/${id}/reading`
        const reading=await h.send(base,{expectedSequence:0,expectedReadingSequence:0,consent:true},t[label.employee])
        let coding={status:0,value:{status:'review',values:{},codingSuggestions:[]}}
        if(reading.status===200&&typeof reading.value.prefill?.merchant==='string')coding=await h.send(base+'/coding',{expectedSequence:reading.value.lifecycleSequence,expectedReadingSequence:reading.value.sequence,contextVersion:0,consent:true},t[label.employee])
        const suggestions=coding.value?.codingSuggestions??[]
        records.push({id:label.id,door:'actual-unlinked-image-reading',actual:actualFields(coding.value?.values??{},t),sources:[...new Set(suggestions.flatMap(suggestion=>suggestion.evidence.map(evidence=>evidence.source)))],reading:{http:reading.status,state:reading.value?.state??'unavailable',merchant:reading.value?.prefill?.merchant??null,merchantVerified:typeof reading.value?.prefill?.merchant==='string',fields:readingSummary(reading.value?.fields)},understanding:{http:coding.status,status:coding.value?.status??'review',reason:coding.value?.reason??coding.value?.error??null,model:coding.value?.model??null,reviewFields:coding.value?.reviewFields??[]}})
      }
    }))
    semantic={gitSHA,measuredAt:new Date().toISOString(),model,providerRequests,corpus:'semantic',fixture:{charges:fixture.charges.rows.length,receiptOriginals:fixture.labels.cases.length,priorNativeExpenses:fixture.history.rows.length,historyMonths:new Set(fixture.history.rows.map(row=>row.date.slice(0,7))).size},delivery,method:'Separate declared native owner catalog/rules and twelve-month human input history; real scheduled SFTP mapped-CSV pick-up; actual uploaded PNGs with no typed merchant; real BaseAI image reading and separately consented coding. Expected labels are read only by measurement after application results. Four concurrent originals, no human correction, charge attachment, model response replay or provider substitute. All unknown, retired and failed/abstaining cases remain in full denominators.',charges:measureSemanticCoding(records.filter(record=>record.door==='scheduled-sftp-program-feed'),fixture.labels.cases),unlinkedReceipts:measureSemanticCoding(records.filter(record=>record.door==='actual-unlinked-image-reading'),fixture.labels.cases),combined:measureSemanticCoding(records,fixture.labels.cases),records:records.sort((a,b)=>a.id.localeCompare(b.id)||a.door.localeCompare(b.door)),limitations:['The issuer edge is an actual synthetic SSH/SFTP server, not an issuer account or vendor onboarding receipt.','Only declared mapped CSV is exercised; GL, VCF and PGP are not exercised.','This sibling corpus does not replace or narrow the original corpus; both sets keep their own measurements.','Scores are observed outcomes; confidence and missing intent never manufacture a coding label.']}
  }finally{await h.close()}
  const old=includeOld?await runLiveCodingQuality({key,model}):oldResult
  const result=old?combineCodingQuality(old,semantic):semantic
  if(output)await writeFile(output,JSON.stringify(result,null,2)+'\n')
  return result
}

const summary=result=>{const {records,...rest}=result;return rest}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const outputIndex=process.argv.indexOf('--output'),oldIndex=process.argv.indexOf('--old-result')
  try {
    const oldResult=oldIndex<0?undefined:JSON.parse(await readFile(process.argv[oldIndex+1],'utf8'))
    const result=await runSemanticCodingQuality({key:process.env.COASTER_AI_KEY,model:process.env.COASTER_AI_MODEL,output:outputIndex<0?undefined:process.argv[outputIndex+1],oldResult,includeOld:process.argv.includes('--include-old')})
    console.log(JSON.stringify(result.semantic?{...result,old:summary(result.old),semantic:summary(result.semantic)}:summary(result),null,2))
  }catch(error){console.error(error instanceof Error?error.message:'Semantic coding quality journey failed');process.exitCode=1}
}
