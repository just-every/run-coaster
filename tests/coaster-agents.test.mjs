import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness, receipt } from './harness.mjs'

async function fixture(run, options = {}) { const h = await harness(options); try { await run(h, await agency(h)) } finally { await h.close() } }
async function draft(h, t, title, date = '2026-05-10') {
  let c = await h.post('claims', { title }, t.sam)
  const file = await receipt('bistro'); file.base64 = Buffer.concat([Buffer.from(file.base64,'base64'),Buffer.from(title)]).toString('base64')
  const upload = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...file }, t.sam)
  c = await h.post(`claims/${c.id}/items`, { version: upload.claim.version, kind: 'receipt', date, merchant: title, amount: '40.00', allocations: [{ category: t.c.meals }], receipt: upload.receipt }, t.sam)
  return c
}

test('Expense preparation cites coding receipt and submission issues while keeping every financial decision human', () => fixture(async(h,t)=>{
  const c=await draft(h,t,'Close native expense'), messagesBefore=h.messages.length
  await h.post(`${['preparations','expenses'].join('/')}/${c.id}`,{},t.alex,404)
  await h.post(['coding','automatic','rules'].join('/'),{version:(await h.get(['coding','automatic','rules'].join('/'),t.morgan)).version,scope:'finance',merchant:'Close native expense',coding:{category:t.c.office}},t.morgan)
  const p=await h.post(`${['preparations','expenses'].join('/')}/${c.id}`,{},t.sam)
  assert.equal(p.payload.checklist[0].coding[0].category_name,'Meals')
  assert.equal(p.payload.checklist[0].proposedCoding.fields.category,t.c.office)
  assert.equal(p.payload.checklist[0].proposedCoding.evidence[0].source,'merchant-rule')
  assert.ok(p.payload.checklist[0].receipt.sha256)
  assert.equal(p.payload.checklist[0].citation,`/app#/claims/${c.id}`)
  const key=await h.post('agent-keys',{label:'synthetic-coaster-8002'},t.sam)
  assert.equal((await h.send(`/api/coaster/preparations/expenses/${c.id}`,{},'',{authorization:`Bearer ${key.token}`})).status,401)
  assert.equal((await h.send(`/api/coaster/agent/proposals/${p.id}`,undefined,'',{authorization:`Bearer ${key.token}`})).status,404)
  const accepted=await h.post(`proposals/${p.id}/accept`,{},t.sam)
  assert.equal(accepted.claim.status,'draft')
  assert.equal((await h.get(`claims/${c.id}`,t.sam)).claim.version,c.version)
  assert.equal(h.messages.length,messagesBefore,'no outbound chase is sent')
  let disputed=await h.post('claims',{title:'Disputed coding'},t.sam)
  disputed=await h.post(`claims/${disputed.id}/items`,{version:disputed.version,kind:'receipt',date:'2026-05-12',merchant:'Close native expense',amount:'12.00',explanation:'Missing receipt to review'},t.sam)
  const advice=(await h.get(`claims/${disputed.id}`,t.sam)).items[0].codingSuggestions[0]
  assert.ok(advice)
  await h.post(`${['coding','automatic','suggestions'].join('/')}/${advice.id}/decision`,{claimVersion:disputed.version,action:'override',values:{category:t.c.meals}},t.sam)
  const stopped=await h.post(`${['preparations','expenses'].join('/')}/${disputed.id}`,{},t.sam)
  assert.equal(stopped.payload.stopped,true)
  await h.post(`proposals/${stopped.id}/accept`,{},t.sam,409)
  const rules=await h.get(['coding','automatic','rules'].join('/'),t.morgan), rule=rules.rules.find(r=>r.merchant==='Close native expense')
  await h.post(['coding','automatic','rules'].join('/'),{version:rules.version,id:rule.id,scope:'finance',merchant:rule.merchant,coding:{category:t.c.meals}},t.morgan)
  const resolved=await h.post(`${['preparations','expenses'].join('/')}/${disputed.id}`,{},t.sam)
  assert.equal(resolved.payload.stopped,false)
  await h.post(`proposals/${resolved.id}/accept`,{},t.sam)
  const old=await h.post(`${['preparations','expenses'].join('/')}/${c.id}`,{},t.sam)
  await h.post(`claims/${c.id}/title`,{version:c.version,title:'Changed coding review context'},t.sam)
  await h.post(`proposals/${old.id}/accept`,{},t.sam,409)
  assert.equal((await h.get(`claims/${c.id}`,t.sam)).claim.status,'draft')
}))
