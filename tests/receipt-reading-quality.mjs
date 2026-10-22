// Actual-provider quality journey. Run only through the approved credential helper; never prints transport headers or keys.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {agency,harness} from './harness.mjs'
const directory='tests/fixtures/receipts/reader/',manifest=JSON.parse(await readFile(directory+'manifest.json','utf8'))
const limit=Number(process.env.READING_QUALITY_LIMIT??manifest.receipts.length),model=process.env.READING_QUALITY_MODEL??'gpt-4.1-2025-04-14'
assert.ok(process.env.OPENAI_API_KEY,'A provider key must be injected by the authorized helper; values are never printed')
assert.ok(Number.isInteger(limit)&&limit>0&&limit<=manifest.receipts.length)
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),fieldNames=['merchant','date','total','subtotal','salesTax','tip','currency','last4','lineItems']
const comparable=(name,value)=>name==='lineItems'&&Array.isArray(value)?value.map(({description,quantity,amount})=>({description,quantity,amount})):value
const providerResponses=[]
const h=await harness({bindings:{AI_ENABLED:'true',AI_API_KEY:'synthetic-coaster-6002'},aiEdge:async request=>{
 const headers={'authorization':'Bearer '+process.env.OPENAI_API_KEY,'content-type':request.headers.get('content-type')??'application/json',accept:request.headers.get('accept')??'application/json'}
 providerResponses.push({stage:'sending',method:request.method,url:request.url})
 try {
  const response=await fetch(request.url,{method:request.method,headers,body:await request.arrayBuffer(),redirect:'manual'})
  const summary=await response.clone().json()
  providerResponses.push({status:response.status,state:summary.status??null,errorCode:summary.error?.code??null,errorType:summary.error?.type??null,param:summary.error?.param??null,outputTypes:summary.output?.map(row=>row.type)??[]})
  return response
 } catch(error) {providerResponses.push({stage:'transport-error',name:error.name,code:error.cause?.code??null,message:String(error.message).replaceAll(process.env.OPENAI_API_KEY,'[redacted]')});throw error}
}})
const result={model,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),at:new Date().toISOString(),providerResponses,corpusCount:manifest.receipts.length,evaluated:0,complete:false,confidentWrong:0,unflaggedDifferent:0,missingConfidentPrefill:0,rates:{},usage:{input_tokens:0,output_tokens:0,total_tokens:0},receipts:[]}
try {
 const team=await agency(h)
 await h.post('settings/receipt-reading',{version:0,enabled:true,consent:true,threshold:.95,model})
 for(const entry of manifest.receipts.slice(0,limit)) {
  const label=JSON.parse(await readFile(directory+entry.label,'utf8')),bytes=await readFile(directory+entry.file),form=new FormData()
  form.append('file',new File([bytes],entry.file,{type:entry.file.endsWith('.pdf')?'application/pdf':'image/png'}))
  const encoded=new Request(h.origin+'/api/coaster/receipt-inbox',{method:'POST',headers:{origin:h.origin,cookie:team.sam},body:form})
  const uploaded=await h.mf.dispatchFetch(encoded.url,{method:'POST',headers:Object.fromEntries(encoded.headers),body:await encoded.arrayBuffer()})
  assert.equal(uploaded.status,200);const id=(await uploaded.json()).receipt.id
  const response=await h.send(`/api/coaster/receipt-inbox/${id}/reading`,{expectedSequence:0,expectedReadingSequence:0,consent:true},team.sam)
  const reading=response.value,per={id:entry.id,sha256:sha(bytes),model:reading.history?.at(-1)?.model??model,state:reading.state??'refused',status:response.status,correctWithoutReview:[],mismatches:[],errorCode:reading.history?.at(-1)?.errorCode??null}
  for(const name of fieldNames) {
   const field=reading.fields?.[name],actual=comparable(name,field?.value??null),expected=label.values[name],equal=JSON.stringify(actual)===JSON.stringify(expected),confident=field?.review===false&&field?.value!==null
   if(confident&&equal)per.correctWithoutReview.push(name)
   if(!equal){per.mismatches.push({field:name,confident,expected,actual});if(confident)result.confidentWrong++;if(field&&field.review!==true)result.unflaggedDifferent++;}
  }
  if(reading.fields?.total?.review===false&&reading.prefill?.amount!==label.values.total)result.missingConfidentPrefill++
  const usage=reading.history?.at(-1)?.usage??{};for(const key of Object.keys(result.usage))result.usage[key]+=usage[key]??0
  result.receipts.push(per);result.evaluated++;console.log(`${entry.id}: ${per.state}; correct without review ${per.correctWithoutReview.length}/${fieldNames.length}`)
 }
 result.complete=result.evaluated===result.corpusCount
 for(const name of fieldNames){const correct=result.receipts.filter(r=>r.correctWithoutReview.includes(name)).length;result.rates[name]={correctWithoutReview:correct,denominator:result.evaluated,rate:correct/result.evaluated};}
 result.passed=result.complete&&result.confidentWrong===0&&result.unflaggedDifferent===0&&result.missingConfidentPrefill===0&&['merchant','date','total'].every(name=>result.rates[name].rate>=.9)
} finally {
 result.outboundPaths=h.outbound.map(row=>{const u=new URL(row.url);return u.origin+u.pathname})
 await h.close()
 await writeFile(process.env.READING_QUALITY_OUTPUT??directory+'measurement.json',JSON.stringify(result,null,2)+'\n')
}
console.log(JSON.stringify({model:result.model,complete:result.complete,confidentWrong:result.confidentWrong,missingConfidentPrefill:result.missingConfidentPrefill,rates:result.rates,passed:result.passed}))
assert.equal(result.passed,true,'Receipt-reading quality acceptance did not pass; keep the clause partial and inspect recorded evidence')
