import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import {harness} from './harness.mjs'
import {fixture as oldFixture,setup,manual,n,path as codingPath,simplified,ingestProgramCorpus} from './automatic-coding-quality.mjs'
import {loadSemanticFixture,setupSemanticCoding,prepareSemanticHistory,uploadSemantic,measureSemanticCoding} from './semantic-coding-quality.mjs'

const head=()=>execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
const sources=suggestions=>[...new Set(suggestions.flatMap(s=>(s.evidence??[]).map(e=>e.source)))]
const merged=suggestions=>suggestions.reduce((fields,s)=>({...fields,...s.fields,dimensions:{...fields.dimensions,...s.fields.dimensions}}),{})
const actual=(fields,t)=>({...simplified(fields,t),customer:fields.customer||t.valueNames?.customer?.[fields.dimensions?.[t.dimensions.customer]]||null})
const fieldSummary=fields=>Object.fromEntries(Object.entries(fields??{}).map(([name,field])=>[name,{value:field.value,confidence:field.confidence,review:field.review,reasons:field.reasons,source:field.source}]))
const evidence=state=>({version:state.contextVersion??state.context?.version??0,mcc:state.context?.mcc??null,values:state.values??state.context?.values??{},suggestions:state.suggestions??state.codingSuggestions??[]})
const empty=()=>({actual:{category:null,class:null,project:null,customer:null},sources:[]})
const briefError=error=>({errorType:error instanceof Error?error.name:'Error',reason:'The native step did not complete; no retry, correction or forced attachment was made.'})
async function concurrent(rows,action){let next=0;await Promise.all(Array.from({length:4},async()=>{for(;;){const index=next++;if(index>=rows.length)return;await action(rows[index],index)}}))}

async function prepareOldHistory(h,t){
  const claims={}
  for(const [index,employee]of ['sam','alex','bea'].entries())claims[employee]=await h.post('claims',{title:n(7000+index)},t[employee])
  for(const row of oldFixture.history)claims[row.employee]=await manual(h,t,row,claims[row.employee])
  for(const employee of ['sam','alex','bea'])await h.post(`claims/${claims[employee].id}/submit`,{version:claims[employee].version},t[employee])
  await t.rule(n(1001),t.fields(1));await t.rule(n(1002),t.fields(2),'personal',t.sam)
  for(const [mcc,category]of [['5812',2],['5943',0]])await h.post(`${codingPath}/mcc`,{version:(await h.get(`${codingPath}/rules`,t.finance)).version,mcc,category:t.cats[category].id,active:true},t.finance)
  let catalog=await h.get('coding');catalog=await h.post('coding/values',{version:catalog.version,id:t.values.account,active:false});await h.post('coding/values',{version:catalog.version,id:t.values.class[3],active:false})
}
async function configure(h,model,exactMatching){
  const reading=await h.get('settings/receipt-reading')
  await h.post('settings/receipt-reading',{version:reading.version,enabled:true,threshold:.95,model,consent:true})
  const rule=await h.get('settings/card-matching')
  return h.post('settings/card-matching',{version:rule.version,enabled:true,windowDays:rule.window_days,tipPercent:exactMatching?0:rule.tip_percent,fxPercent:exactMatching?0:rule.fx_percent})
}
async function inboxes(h,t,employees){
  return (await Promise.all(employees.map(async employee=>(await h.get('receipt-inbox',t[employee])).receipts))).flat()
}
function snapshotOriginal(record,receipt,state,question){
  const current=evidence(state),pending=current.suggestions.filter(s=>s.status==='pending')
  // Earlier evidence remains visible, but only evidence whose value still survives describes current coding.
  const matching=pending.map(s=>({...s,evidence:(s.evidence??[]).filter(e=>{
    const value=key=>key.startsWith('dimension:')?current.values.dimensions?.[key.slice(10)]:current.values[key]
    const proposed=key=>key.startsWith('dimension:')?s.fields.dimensions?.[key.slice(10)]:s.fields[key]
    return value(e.field)!==undefined&&value(e.field)===proposed(e.field)
  })}))
  return {...empty(),...record,actual:actual(current.values,record.catalog),sources:sources(matching),context:current,receipt:receipt??null,question:question??null}
}
/** Read the final financial expense and its surviving advice through native public doors. Initial importer category
 * defaults remain visible as expense coding, but do not count as suggestions without matching source evidence. */
export async function snapshotNativeCharges(h,t,chargeRecords){
  let ledger
  try{ledger=await h.get('statements',t.finance)}catch(error){return chargeRecords.map(record=>({...record,...empty(),expenseActual:empty().actual,failure:briefError(error)}))}
  const current=record=>ledger.charges.find(charge=>charge.id===record.chargeId||charge.item_id===record.itemId),claims=new Map()
  await concurrent([...new Set(chargeRecords.map(record=>current(record)?.claim_id).filter(Boolean))],async claim=>{
    try{claims.set(claim,await h.get(`claims/${claim}`,t.sam))}catch(error){claims.set(claim,{failure:briefError(error)})}
  })
  return chargeRecords.map(record=>{
    const charge=current(record),detail=claims.get(charge?.claim_id),item=detail?.items?.find(item=>item.id===charge?.item_id)
    if(!item)return {...record,...empty(),expenseActual:empty().actual,failure:detail?.failure??{reason:'The current native charge expense was unavailable; it remains in the denominator.'}}
    const fields={category:item.allocations.length===1?item.allocations[0].category_id:undefined,dimensions:item.coding??{},project:item.project||undefined,customer:item.customer||undefined,memo:item.description||undefined},supported={dimensions:{}},currentEvidence=[]
    for(const suggestion of item.codingSuggestions??[])for(const entry of suggestion.evidence??[]){
      const dimension=entry.field.startsWith('dimension:')?entry.field.slice(10):null
      const value=dimension?fields.dimensions[dimension]:fields[entry.field],proposed=dimension?suggestion.fields.dimensions?.[dimension]:suggestion.fields[entry.field]
      if(value===undefined||value!==proposed)continue
      if(dimension)supported.dimensions[dimension]=value;else supported[entry.field]=value
      currentEvidence.push({...entry,suggestionId:suggestion.id,suggestionStatus:suggestion.status})
    }
    return {...record,door:'charge-after-native-hourly-attachment',claimId:charge.claim_id,itemId:item.id,chargeId:charge.id,actual:actual(supported,t),expenseActual:actual(fields,t),sources:[...new Set(currentEvidence.map(entry=>entry.source))],evidence:currentEvidence,suggestions:item.codingSuggestions??[],expense:{id:item.id,claimId:charge.claim_id,cardChargeId:item.card_charge_id,receiptId:item.receipt_id,merchant:item.merchant,amountMinor:item.amount_minor,allocations:item.allocations,coding:item.coding,project:item.project,customer:item.customer,description:item.description}}
  })
}
async function settle(h,t,employees,records,progress){
  const worker=await h.mf.getWorker(),ticks=[],minimum=Math.ceil(records.length/100)+1,maximum=minimum+8
  let previous='',stable=0,snapshot=[]
  for(let tick=0;tick<maximum;tick++){
    await worker.scheduled({scheduledTime:new Date(Date.now()+tick*3600000),cron:'17 * * * *'})
    snapshot=await inboxes(h,t,employees)
    const signature=JSON.stringify(snapshot.map(r=>[r.id,r.lifecycleSequence,r.disposition,r.attachment?.itemId??null]).sort((a,b)=>a[0].localeCompare(b[0])))
    stable=signature===previous?stable+1:0;previous=signature
    ticks.push({tick:tick+1,at:new Date().toISOString(),attached:snapshot.filter(r=>r.attachment).length,matchingChoices:snapshot.filter(r=>r.matchChoice.enabled).length,stablePasses:stable})
    progress('hourly',tick+1,maximum)
    if(tick+1>=minimum&&stable>=2)break
  }
  return {ticks,settled:stable>=2,snapshot}
}

async function runCorpus({name,key,model,gitSHA,exactMatching,matchingPolicy,progress,checkpoint}){
  assert.equal(head(),gitSHA,'Candidate changed before corpus; stop before paid calls')
  const semantic=name==='semantic'?await loadSemanticFixture():null
  const labels=semantic?.labels.cases??oldFixture.cases,chargesInput=semantic?.charges.rows??oldFixture.cases
  let providerRequests=0
  const h=await harness({bindings:origin=>({AI_ENABLED:'true',AI_MODEL:model,AI_API_KEY:n(82999),RER_DEV_ORIGIN:origin}),aiEdge:async request=>{
    assert.equal(head(),gitSHA,'Candidate changed before paid request')
    assert.equal(new URL(request.url).origin,'https://api.openai.com')
    // The Worker and its request log receive only a synthetic credential. Forward only the approved headers.
    const headers={authorization:`Bearer ${key}`,'content-type':request.headers.get('content-type')??'application/json',accept:request.headers.get('accept')??'application/json'}
    providerRequests++
    return fetch(request.url,{method:request.method,headers,body:await request.arrayBuffer(),redirect:'manual'})
  }})
  const heartbeat=setInterval(()=>progress('provider-requests',providerRequests,labels.length*2),30000)
  try{
    progress('setup',0,labels.length)
    const t=semantic?await setupSemanticCoding(h,semantic.catalog):await setup(h)
    if(semantic)await prepareSemanticHistory(h,t,semantic);else await prepareOldHistory(h,t)
    const matchingRule=await configure(h,model,exactMatching),{charges,delivery}=await ingestProgramCorpus(h,t,{cases:chargesInput})
    const ledger=await h.get('statements',t.finance)
    const chargeRecords=chargesInput.map(row=>{
      const item=charges.find(i=>i.merchant===row.merchant&&i.amount_minor===Math.round(Number(row.amount)*100));assert.ok(item,'Every issuer row has its native expense')
      const charge=ledger.charges.find(c=>c.item_id===item.id)
      return {id:row.id,door:'scheduled-sftp-program-feed',itemId:item.id,claimId:item.claim_id,chargeId:charge?.id??item.card_charge_id??null,actual:actual(merged(item.codingSuggestions),t),sources:sources(item.codingSuggestions),suggestions:item.codingSuggestions}
    })
    const records=labels.map(row=>({id:row.id,employee:row.employee??'sam',receiptPath:row.receipt,receiptId:null,phase:'not-uploaded',intake:empty()}))
    const employees=[...new Set(records.map(row=>row.employee))]
    let uploaded=0,read=0
    await concurrent(records,async(record,index)=>{
      try{const upload=semantic?await uploadSemantic(h,t,semantic.folder,labels[index]):await t.upload(labels[index],'',t[record.employee]);record.receiptId=upload.receipt.id;record.upload=upload.receipt;record.phase='uploaded'}
      catch(error){record.phase='upload-failed';record.failure=briefError(error)}
      if(++uploaded%10===0||uploaded===records.length)progress('uploads',uploaded,records.length)
    })
    const matchingConsents=[]
    for(const employee of employees){
      const first=records.find(r=>r.employee===employee&&r.receiptId);if(!first){matchingConsents.push({employee,status:'no-uploaded-original'});continue}
      const detail=await h.get(`receipt-inbox/${first.receiptId}/reading`,t[employee]),notice=first.upload.matchChoice.notice
      const consent=await h.post('settings/receipt-reading/matching',{version:detail.matchDefault.version,enabled:true,consent:true,notice},t[employee])
      matchingConsents.push({employee,email:t[`${employee}Email`],...consent,notice})
    }
    // All originals exist before any matching decision; the scheduler never sees a favorable partial corpus.
    await concurrent(records,async record=>{
      if(record.receiptId)try{
        record.phase='reading'
        const base=`/api/coaster/receipt-inbox/${record.receiptId}/reading`,reading=await h.send(base,{expectedSequence:record.upload.lifecycleSequence,expectedReadingSequence:0,consent:true},t[record.employee])
        record.reading={http:reading.status,state:reading.value?.state??'unavailable',sequence:reading.value?.sequence,history:reading.value?.history??[],fields:fieldSummary(reading.value?.fields),attentionReason:reading.value?.attentionReason??reading.value?.error??null}
        let coding={status:0,value:{status:'review',reason:'No verified merchant; separate coding was not requested.'}}
        if(reading.status===200&&typeof reading.value?.prefill?.merchant==='string'){
          const context=await h.get(`${codingPath}/suggestions?receipt=${record.receiptId}`,t[record.employee])
          record.phase='coding'
          coding=await h.send(base+'/coding',{expectedSequence:reading.value.lifecycleSequence,expectedReadingSequence:reading.value.sequence,contextVersion:context.contextVersion,consent:true},t[record.employee])
        }
        record.understanding={http:coding.status,status:coding.value?.status??'review',reason:coding.value?.reason??coding.value?.error??null,model:coding.value?.model??null,reviewFields:coding.value?.reviewFields??[]}
        const state=await h.get(`${codingPath}/suggestions?receipt=${record.receiptId}`,t[record.employee])
        const receipt=(await h.get('receipt-inbox',t[record.employee])).receipts.find(r=>r.id===record.receiptId)
        const {catalog,...intake}=snapshotOriginal({id:record.id,catalog:t},receipt,state)
        record.intake=intake;record.phase='intake-recorded'
      }catch(error){record.failure=briefError(error);record.phase+='-failed'}
      if(++read%10===0||read===records.length)progress('read-and-coding',read,records.length)
    })
    const intake={charges:measureSemanticCoding(chargeRecords,labels),unlinkedReceipts:measureSemanticCoding(records.map(r=>({id:r.id,...r.intake})),labels),combined:measureSemanticCoding([...chargeRecords,...records.map(r=>({id:r.id,...r.intake}))],labels)}
    await checkpoint({corpus:name,gitSHA,model,measuredAt:new Date().toISOString(),status:'intake-recorded-before-hourly',providerRequests,delivery,matchingPolicy,matchingRule,matchingConsents,intake,chargeRecords,records})
    const matching=await settle(h,t,employees,records,progress)
    await concurrent(records,async record=>{
      record.afterNativeAttachment=empty()
      if(!record.receiptId){record.matchReason='upload-failed';return}
      try{
        const receipt=matching.snapshot.find(r=>r.id===record.receiptId),state=await h.get(`${codingPath}/suggestions?receipt=${record.receiptId}`,t[record.employee])
        const question=receipt?.attachment?null:await h.get(`receipt-inbox/${record.receiptId}/card-match-question`,t[record.employee])
        const {catalog,...after}=snapshotOriginal({id:record.id,catalog:t},receipt,state,question)
        record.afterNativeAttachment=after
        record.attachment=receipt?.attachment??null
        record.matchReason=record.attachment?'native-hourly-attachment':!receipt?'native-original-unavailable':receipt.disposition!=='active'?'original-not-active':!receipt?.matchChoice?.enabled?'verified-reading-did-not-enable-matching':question?.ambiguous?'ambiguous-native-candidates':question?.candidates?.length?'native-candidate-not-attached':'no-native-match-candidate'
      }catch(error){record.afterFailure=briefError(error);record.matchReason='native-result-unavailable'}
    })
    const postChargeRecords=await snapshotNativeCharges(h,t,chargeRecords),postReceiptRecords=records.map(record=>({id:record.id,...record.afterNativeAttachment}))
    assert.equal(head(),gitSHA,'Candidate changed during corpus')
    return {corpus:name,gitSHA,model,measuredAt:new Date().toISOString(),providerRequests,fixture:{charges:chargesInput.length,receiptOriginals:labels.length,priorNativeExpenses:semantic?.history.rows.length??oldFixture.history.length},delivery,matchingPolicy,matchingRule,matchingConsents,intake,afterNativeAttachment:{receipts:measureSemanticCoding(postReceiptRecords,labels),charges:measureSemanticCoding(postChargeRecords,labels),combined:measureSemanticCoding([...postChargeRecords,...postReceiptRecords],labels),chargeExpenses:measureSemanticCoding(postChargeRecords.map(record=>({...record,actual:record.expenseActual})),labels),chargeMeasurement:'Suggestion scores require source evidence whose value survives in the current native expense. Raw allocation/catalog coding, including unadvised importer defaults, is reported separately as chargeExpenses.',counts:{total:records.length,uploaded:records.filter(r=>r.receiptId).length,attached:records.filter(r=>r.attachment).length,unmatched:records.filter(r=>!r.attachment).length,matchingChoices:records.filter(r=>r.afterNativeAttachment.receipt?.matchChoice?.enabled).length,receiptsWithNativeMcc:records.filter(r=>r.afterNativeAttachment.context?.mcc).length,chargeExpensesRead:postChargeRecords.filter(record=>record.expense).length,chargeReadFailures:postChargeRecords.filter(record=>record.failure).length,readingHttpFailures:records.filter(r=>r.reading?.http!==200).length,readingNeedsAttention:records.filter(r=>r.reading?.state==='needs-attention').length,codingHttpFailures:records.filter(r=>r.understanding?.http!==200).length,archived:records.filter(r=>['discarded','merged'].includes(r.afterNativeAttachment.receipt?.disposition)).length},settled:matching.settled,ticks:matching.ticks},chargeRecords,postChargeRecords,postReceiptRecords,records}
  }finally{clearInterval(heartbeat);await h.close()}
}

/** Actual provider journey; no fixture answers, merchant text, corrections or attachment choices enter application requests. */
export async function runAttachmentCodingQuality({key,model='gpt-6.1-sol',corpus='both',exactMatching=false,assertAfterAttachment=false,output,progress=(name,phase,done,total)=>console.error(`[${name}] ${phase} ${done}/${total}`)}={}){
  assert.ok(typeof key==='string'&&key.length,'COASTER_AI_KEY is required for the real provider journey')
  assert.ok(['old','semantic','both'].includes(corpus),'--corpus must be old, semantic or both')
  const matchingPolicy=exactMatching?'explicit-global-zero-tip-and-fx-tolerances':'installation-tip-and-fx-tolerances'
  const result={gitSHA:head(),model,matchingPolicy,startedAt:new Date().toISOString(),status:'running',method:'Frozen full corpora; native catalog and twelve-month history; actual scheduled SFTP; PNG upload without typed merchant; employee self-only standing matching consent with the native notice; one explicit read and one separately consented coding request when verified merchant exists; four concurrent originals. Intake is saved before native hourly matching. Final native charges and expense advice are read back through public ledger and claim routes after hourly matching. Every charge and original remains in its denominator; no correction, retries, forced attachment, extra model requests or direct database writes. '+(exactMatching?'Separate explicit scenario: finance settings globally choose zero tip and FX tolerances while preserving the installation date window.':'Default scenario: finance settings preserve the installation tip, FX and date-window tolerances.'),limitations:['Synthetic actual SSH/SFTP issuer transport is not issuer onboarding proof.','Matching preserves native tolerances and ambiguity decisions; unmatched originals stay in the full denominator.','Intake and post-attachment scores are distinct observations; neither replaces prior unlinked measurements.','Hourly stabilization is bounded and reported; no claim of attachment is made for remaining private originals.'],corpora:{}}
  try{
    for(const name of corpus==='both'?['old','semantic']:[corpus]){
      assert.equal(head(),result.gitSHA,'Candidate changed before corpus; stop before paid calls')
      const measured=await runCorpus({name,key,model,gitSHA:result.gitSHA,exactMatching,matchingPolicy,progress:(...args)=>progress(name,...args),checkpoint:async partial=>{if(output)await writeFile(`${output}.${name}.json`,JSON.stringify(partial,null,2)+'\n')}})
      result.corpora[name]=measured
      // A later failure must never erase a completed corpus's original records and measurements.
      if(output){await writeFile(`${output}.${name}.json`,JSON.stringify(measured,null,2)+'\n');await writeFile(output,JSON.stringify(result,null,2)+'\n')}
    }
    const labels=[],intakeRecords=[],finalRecords=[]
    for(const [name,measured]of Object.entries(result.corpora)){
      const corpusLabels=name==='old'?oldFixture.cases:(await loadSemanticFixture()).labels.cases
      const qualify=record=>({...record,id:`${name}:${record.id}`})
      labels.push(...corpusLabels.map(qualify))
      intakeRecords.push(...measured.chargeRecords.map(qualify),...measured.records.map(record=>qualify({id:record.id,...record.intake})))
      finalRecords.push(...measured.postChargeRecords.map(qualify),...measured.postReceiptRecords.map(qualify))
    }
    result.evaluatedStage='after-native-hourly-attachment'
    result.global={intake:measureSemanticCoding(intakeRecords,labels),final:measureSemanticCoding(finalRecords,labels)}
    const final=result.global.final
    result.acceptance={assertionRequested:assertAfterAttachment,evaluatedStage:result.evaluatedStage,financeRulePassed:final.financeRule.percent===100,fullRepeatCategoryPassed:typeof final.fullRepeatCategory.percent==='number'&&final.fullRepeatCategory.percent>=90}
    result.acceptance.thresholdsMet=result.acceptance.financeRulePassed&&result.acceptance.fullRepeatCategoryPassed
    if(assertAfterAttachment){
      assert.ok(result.acceptance.financeRulePassed,'Global final-stage finance-rule suggestions must match 100% of the full selected fixture set')
      assert.ok(result.acceptance.fullRepeatCategoryPassed,'Global final-stage repeat category suggestions must match at least 90% of the full selected fixture set')
    }
    result.status='complete';result.finishedAt=new Date().toISOString()
  }catch(error){result.status='failed';result.failure=briefError(error);if(output)await writeFile(output,JSON.stringify(result,null,2)+'\n');throw error}
  if(output)await writeFile(output,JSON.stringify(result,null,2)+'\n')
  return result
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const value=flag=>{const index=process.argv.indexOf(flag);return index<0?undefined:process.argv[index+1]}
  try{
    const result=await runAttachmentCodingQuality({key:process.env.COASTER_AI_KEY,model:process.env.COASTER_AI_MODEL??'gpt-6.1-sol',corpus:value('--corpus')??'both',exactMatching:process.argv.includes('--exact-matching'),assertAfterAttachment:process.argv.includes('--assert-after-attachment'),output:value('--output')})
    console.log(JSON.stringify({...result,corpora:Object.fromEntries(Object.entries(result.corpora).map(([name,{records,chargeRecords,postChargeRecords,postReceiptRecords,...summary}])=>[name,summary]))},null,2))
  }catch(error){console.error(error instanceof Error?error.message:'Attachment coding quality journey failed');process.exitCode=1}
}
