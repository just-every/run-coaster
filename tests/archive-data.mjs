// Populate portable finance and receipt records through the same native HTTP
// doors before the shared CLI recovery journey. External providers are fixtures.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { api } from './browser-journey.mjs'

export async function prepareArchiveData(owner,employee,origin,providers){
  const bank=providers.bank
  await api(owner.context,origin,'bank/providers/connect',{provider:'plaid',clientId:bank.clientId,secret:bank.secret,consent:true})
  await api(employee.context,origin,'bank/start',{provider:'plaid'})
  const saved=await api(employee.context,origin,'bank/complete',{provider:'plaid',...bank.link('2468')})
  assert.equal(saved.account.last4,'2468')
  const model='synthetic-archive-reader'
  await api(owner.context,origin,'settings/provider-costs',{version:0,model,inputPerMillion:'2',outputPerMillion:'8',reservePerPage:'0.01',monthlyCap:'20'})
  await api(owner.context,origin,'settings/receipt-reading',{version:0,enabled:true,consent:true,threshold:.95,model})
  const label=providers.label,bytes=await readFile('tests/fixtures/receipts/reader/'+label.file)
  const uploaded=await employee.context.request.post(origin+'/api/coaster/receipt-inbox',{headers:{origin},multipart:{file:{name:'archive-reading.png',mimeType:'image/png',buffer:bytes}}})
  assert.equal(uploaded.status(),200)
  const original=(await uploaded.json()).receipt
  const reading=await api(employee.context,origin,`receipt-inbox/${original.id}/reading`,{expectedSequence:0,expectedReadingSequence:0,consent:true})
  assert.equal(reading.prefill.amount,label.values.total)
  assert.ok((await api(owner.context,origin,'settings/provider-costs')).usedUsdMicros>0)
}
