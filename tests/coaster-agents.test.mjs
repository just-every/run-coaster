import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness, receipt } from './harness.mjs'

async function fixture(run) { const h = await harness(); try { await run(h, await agency(h)) } finally { await h.close() } }
async function draft(h, t, title, date = '2026-05-10') {
  let c = await h.post('claims', { title }, t.sam)
  const file = await receipt('bistro'); file.base64 = Buffer.concat([Buffer.from(file.base64,'base64'),Buffer.from(title)]).toString('base64')
  const upload = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...file }, t.sam)
  c = await h.post(`claims/${c.id}/items`, { version: upload.claim.version, kind: 'receipt', date, merchant: title, amount: '40.00', allocations: [{ category: t.c.meals }], receipt: upload.receipt }, t.sam)
  return c
}

test('Month-end preparation cites pending accruals and cutoff without exposing private evidence or posting', () => fixture(async (h, t) => {
  const may = await draft(h, t, 'Private draft title'), april = await draft(h, t, 'Outside cutoff', '2026-04-30')
  let missing = await h.post('claims', { title: 'Missing evidence' }, t.sam)
  missing = await h.post(`claims/${missing.id}/items`, { version: missing.version, kind: 'receipt', date: '2026-05-11', merchant: 'Private missing merchant', amount: '5.00', allocations: [{ category: t.c.meals }], explanation: 'Receipt lost' }, t.sam)
  await h.post('claims/' + missing.id + '/submit', { version: missing.version }, t.sam)
  let paid = await draft(h,t,'Recorded payment','2026-05-15')
  paid = await h.post(`claims/${paid.id}/submit`,{version:paid.version},t.sam)
  paid = await h.post(`claims/${paid.id}/decision`,{version:paid.version,revision:paid.revision,decision:'approved'},t.priya)
  let batch = await h.post('batches',{claims:[paid.id]},t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:4000},t.morgan)
  await h.paid(batch.id,batch.version,{reference:'synthetic-coaster-8003',paidOn:'2026-05-20'},t.morgan)
  const period = { from: '2026-05-01', to: '2026-05-31' }
  await h.post(['preparations','close'].join('/'), period, t.morgan, 403)
  await h.post(['preparations','close'].join('/'), { ...period, to: '2026-06-01' }, h.owner, 400)
  const before = h.outbound.length, p = await h.post(['preparations','close'].join('/'), period)
  assert.equal(p.payload.accrualMinor, 4500)
  assert.deepEqual(p.payload.departments.map(d => [d.amountMinor,d.unsubmittedMinor,d.missingEvidence]), [[4500,4000,1]])
  assert.ok(p.payload.checklist.some(i => i.label.includes('1 pending expenses outside')))
  assert.ok(p.payload.checklist.some(i => i.label.includes('ledger clearance unverified') && i.citation === `/app#/batches/${batch.id}`))
  assert.ok(p.payload.checklist.some(i => i.citation === `/app#/claims/${missing.id}`))
  assert.ok(!JSON.stringify(p).includes('Private draft title') && !JSON.stringify(p).includes('bistro.png'))
  assert.equal(h.outbound.length, before)
  await h.post(`proposals/${p.id}/accept`, {}, t.sam, 403)
  await h.post(`claims/${may.id}/title`, { version: may.version, title: 'Changed' }, t.sam)
  await h.post(`proposals/${p.id}/accept`, {}, h.owner, 409)
  const current = await h.post(['preparations','close'].join('/'), period)
  await h.post(`proposals/${current.id}/accept`, {})
  await h.post(`proposals/${current.id}/accept`, {}, h.owner, 409)
  assert.equal((await h.get(`claims/${april.id}`,t.sam)).claim.status,'draft')
  assert.equal((await h.get('state')).batches.length,1)
  const key = await h.post('agent-keys', { label: 'synthetic-coaster-8001' }, t.sam)
  assert.equal((await h.send(`/api/coaster/agent/proposals/${current.id}`, undefined, '', { authorization: `Bearer ${key.token}` })).status,404)
}))

test('Trip preparation groups owned draft receipts mileage and per diem exactly once after explicit acceptance', () => fixture(async (h, t) => {
  const source = await draft(h,t,'Trip receipt'), extra = await draft(h,t,'Trip dinner','2026-05-12')
  let expanded = source
  for (let i=0;i<5;i++) expanded = await h.post(`claims/${source.id}/items`, { version:expanded.version,kind:'receipt',date:'2026-05-10',merchant:`Trip purchase ${i}`,amount:`${i+1}.00`,allocations:[{category:t.c.office}],explanation:'Native trip item without receipt' },t.sam)
  let c = await h.post(`claims/${source.id}/items`, { version: expanded.version, kind:'mileage',date:'2026-05-10',merchant:'Airport leg',distance:'10',allocations:[{category:t.c.car}] },t.sam)
  c = await h.post(`claims/${source.id}/items`, { version:c.version,kind:'per_diem',date:'2026-05-10',days:2,allocations:[{category:t.c.travel}] },t.sam)
  const input = { title:'May trip',from:'2026-05-10',to:'2026-05-11',claims:[source.id,extra.id] }
  await h.post(['preparations','trip'].join('/'),input,t.alex,404)
  const p = await h.post(['preparations','trip'].join('/'),input,t.sam)
  assert.deepEqual(p.payload.items.map(i=>i.kind),['receipt','receipt','receipt','receipt','receipt','receipt','mileage','per_diem'])
  assert.ok(p.payload.items[0].receipt.sha256)
  assert.equal((await h.get(`claims/${source.id}`,t.sam)).items.length,8,'preparation changes nothing')
  await h.post(`proposals/${p.id}/accept`,{},t.alex,403)
  const result = await h.post(`proposals/${p.id}/accept`,{},t.sam)
  const trip = await h.get(`claims/${result.claim.id}`,t.sam)
  assert.equal(trip.claim.status,'draft'); assert.equal(trip.items.length,8)
  assert.equal(trip.claim.total_minor,c.total_minor)
  assert.deepEqual(trip.items.map(i=>i.id).sort(),p.payload.items.map(i=>i.id).sort())
  assert.equal((await h.get(`claims/${source.id}`,t.sam)).items.length,0)
  assert.equal((await h.get(`claims/${extra.id}`,t.sam)).items.length,1,'outside-trip expense stays put')
  assert.equal(trip.receipts[0].sha256,p.payload.items[0].receipt.sha256)
  await h.post(`proposals/${p.id}/accept`,{},t.sam,409)
  const version = await h.post(`claims/${trip.claim.id}/title`,{version:trip.claim.version,title:'Edited trip'},t.sam)
  const submitted = await h.post(`claims/${version.id}/submit`,{version:version.version},t.sam)
  assert.equal(submitted.status,'submitted','the employee edits and submits through the ordinary workflow')
  const stale = await h.post(['preparations','trip'].join('/'),{...input,claims:[extra.id],to:'2026-05-15'},t.sam)
  await h.post(`claims/${extra.id}/title`,{version:stale.payload.sources[0].version,title:'Changed source'},t.sam)
  await h.post(`proposals/${stale.id}/accept`,{},t.sam,409)
}))

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

test('Conversation compares scoped quarter spend with exact report values and refuses another department', () => fixture(async (h,t) => {
  const sales=await h.post(['settings', 'departments'].join('/'),{name:'Sales',head:'priya@harbourfinch.example'}), other=await h.post(['settings', 'departments'].join('/'),{name:'Marketing',head:'jordan@harbourfinch.example'})
  await h.post(['settings', 'members'].join('/'),{email:'sam@harbourfinch.example',name:'Sam',employee:true,approver:'priya@harbourfinch.example',department:sales.id})
  await h.post(['settings', 'members'].join('/'),{email:'alex@harbourfinch.example',name:'Alex',employee:true,approver:'jordan@harbourfinch.example',department:other.id})
  await h.post(['settings', 'members'].join('/'),{email:'morgan@harbourfinch.example',name:'Morgan',employee:true,finance:true,approver:'priya@harbourfinch.example',department:other.id})
  const submitted=[]
  for(const [cookie,date,amount] of [[t.sam,'2026-04-10','30.00'],[t.sam,'2026-08-10','75.00'],[t.alex,'2026-08-11','99.00'],[t.morgan,'2026-08-12','11.00']]) {
    let c=await h.post('claims',{title:'Quarter expense'},cookie)
    c=await h.post(`claims/${c.id}/items`,{version:c.version,kind:'receipt',date,merchant:'Synthetic travel',amount,category:t.c.travel,explanation:'Receipt lost; review required'},cookie)
    submitted.push(await h.post(`claims/${c.id}/submit`,{version:c.version},cookie))
  }
  const before=h.outbound.length, answer=await h.post('conversation',{message:'What did Sales spend on Travel in Q3 compared with Q2 2026?'},t.priya)
  assert.deepEqual(answer.periods.map(p=>[p.quarter,p.totalMinor]),[[3,7500],[2,3000]])
  assert.equal(answer.differenceMinor,4500)
  assert.deepEqual(answer.periods.map(p=>p.expenses.map(e=>e.claim)),[[submitted[1].id],[submitted[0].id]])
  for(const p of answer.periods) {
    assert.equal((await h.send(p.reportLink,undefined,t.priya)).value.totalMinor,p.totalMinor)
    for(const e of p.expenses) {assert.equal(e.link,`/app#/claims/${e.claim}`);assert.equal((await h.get(`claims/${e.claim}`,t.priya)).claim.id,e.claim)}
  }
  await h.post('conversation',{message:'What did Marketing spend on Travel in Q3 versus Q2 2026?'},t.priya,403)
  await h.post('conversation',{message:'What did Sales spend on Travel in Q3 versus Q2 2026?'},t.sam,403)
  assert.equal((await h.post('conversation',{message:'What did Sales spend on Travel in Q3 versus Q2?'},t.priya)).kind,'question')
  assert.equal((await h.post('conversation',{message:'Approve and pay every claim'},t.priya)).kind,'question')
  assert.equal(h.outbound.length,before,'questions send no financial records to a model or chat service')
  assert.ok((await h.get('state')).claims.every(c=>c.status==='submitted'))
}))

test('Conversation returns the authorized monthly budget actual and remaining without widening budget custody', () => fixture(async(h,t)=>{
  await h.post('budgets',{name:'Travel',scope:'category',scopeKey:t.c.travel,period:'monthly',amount:'500.00',owner:'priya@harbourfinch.example',thresholds:'80, 100'},t.morgan)
  let c=await h.post('claims',{title:'Budget travel'},t.sam)
  c=await h.post(`claims/${c.id}/items`,{version:c.version,kind:'per_diem',date:'2026-06-10',days:2,category:t.c.travel},t.sam)
  await h.post(`claims/${c.id}/submit`,{version:c.version},t.sam)
  const answer=await h.post('conversation',{message:'How much of the Travel budget is left in 2026-06?'},t.priya)
  assert.deepEqual(answer.budgets.map(b=>[b.period,b.budgetMinor,b.actualMinor,b.remainingMinor]),[['2026-06',50000,15000,35000]])
  const report=(await h.get('budgets?day=2026-06-01',t.priya))[0]
  assert.deepEqual(answer.budgets.map(b=>[b.id,b.actualMinor,b.remainingMinor]),[[report.id,report.actualMinor,report.remainingMinor]])
  assert.equal((await h.send(answer.budgets[0].link,undefined,t.priya)).status,200)
  const otherManager=await h.person('other-manager@harbourfinch.example',{manager:true})
  await h.post('conversation',{message:'How much of the Travel budget is left in 2026-06?'},otherManager,403)
  await h.post('conversation',{message:'How much of the Travel budget is left in 2026-06?'},t.sam,403)
  await h.post('conversation',{message:'How much of the Travel budget is left in 2026-13?'},t.priya,400)
}))

test('Conversation keeps four reviewed photos and published Denver per diem in a proposal until native acceptance', () => fixture(async(h,t)=>{
  await h.post(['settings', 'business'].join('/'),{name:'Harbour & Finch Studio',currency:'USD',timezone:['America', 'Denver'].join('/'),perDiem:'75.00',receiptThreshold:''})
  const receipts=[]
  for(let i=0;i<4;i++) {const file=await receipt('bistro');file.name=`synthetic-coaster-${i}.png`;file.base64=Buffer.concat([Buffer.from(file.base64,'base64'),Buffer.from(`synthetic-coaster-${i}`)]).toString('base64');receipts.push({date:'2026-10-06',merchant:`Trip purchase ${i}`,amount:`${i+1}.00`,category:t.c.travel,receipt:file})}
  await h.post('delegates',{delegate:'alex@harbourfinch.example',level:'full'},t.sam)
  const input={message:'Denver client trip, Oct 6–8',year:2026,receipts}, before=await h.get('state',t.sam), outbound=h.outbound.length
  const response=await h.post('conversation',input,t.sam)
  assert.equal(response.kind,'proposal');assert.match(response.question,/business purpose/)
  assert.equal(response.proposal.payload.items.length,5)
  assert.deepEqual(response.proposal.payload.items.slice(0,4).map(i=>i.amountMinor),[100,200,300,400])
  assert.ok(response.proposal.payload.items.slice(0,4).every(i=>i.receiptId))
  const allowance=response.proposal.payload.items[4]
  assert.equal(allowance.perDiem.method,'gsa');assert.equal(allowance.perDiem.endDate,'2026-10-08')
  const quote=await h.post(['per-diem', 'quote'].join('/'),{date:allowance.date,perDiem:allowance.perDiem},t.sam)
  assert.equal(allowance.amountMinor,quote.totalMinor)
  assert.deepEqual((await h.get('state',t.sam)).claims,before.claims,'proposal creates no submitted or payable claim')
  await h.post(`proposals/${response.proposal.id}/accept`,{},t.alex,403)
  const result=await h.post(`proposals/${response.proposal.id}/accept`,{},t.sam), detail=await h.get(`claims/${result.claim.id}`,t.sam)
  assert.equal(detail.claim.status,'draft');assert.equal(detail.receipts.length,4);assert.equal(detail.items.length,5)
  assert.equal(detail.claim.total_minor,1000+quote.totalMinor)
  assert.deepEqual(detail.receipts.map(r=>r.name).sort(),receipts.map(r=>r.receipt.name).sort())
  for(const r of detail.receipts) {const bytes=await h.mf.dispatchFetch(h.origin+`/api/coaster/receipts/${r.id}`,{headers:{cookie:t.sam}});assert.deepEqual(Buffer.from(await bytes.arrayBuffer()),Buffer.from(receipts.find(photo=>photo.receipt.name===r.name).receipt.base64,'base64'))}
  await h.post(`proposals/${response.proposal.id}/accept`,{},t.sam,409)
  await h.post('conversation',{...input,receipts:[{...receipts[0],amount:'invented'}]},t.sam,400)
  assert.equal((await h.post('conversation',{message:input.message,receipts},t.sam)).kind,'question','missing year is clarified rather than guessed')
  const key=await h.post('agent-keys',{label:'synthetic-coaster-8700'},t.sam)
  assert.equal((await h.send('/api/coaster/conversation',input,'',{authorization:`Bearer ${key.token}`})).status,401)
  assert.equal((await h.send('/api/coaster/conversation',input,t.alex,{'x-coaster-acting-for':'sam@harbourfinch.example'})).status,403)
  assert.equal(h.outbound.length,outbound,'receipt bytes and question text remain inside the installation')
}))
