import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness } from './harness.mjs'
import { qboFixture } from './fixtures/qbo.mjs'

const name = n => `synthetic-coaster-${n}`
const SAM = 'sam@harbourfinch.example', HEAD = 'jordan@harbourfinch.example', MANAGER = 'priya@harbourfinch.example'
async function team(run,options) { const h = await harness(options); try { await run(h, await agency(h)) } finally { await h.close() } }
async function catalog(h) {
  const csv = 'dimension,parentDimension,kind,required,value,parentValue,owner\n' + [
    [name(1),'','department','false',name(2),'',''], // sales department
    [name(1),'','department','false',name(3),'',''], // marketing department
    [name(4),name(1),'project','false',name(5),name(2),HEAD],
    [name(4),name(1),'project','false',name(6),name(3),MANAGER],
    [name(7),name(4),'tag','false',name(8),name(5),''],
  ].map(r => r.join(',')).join('\n')
  const c = await h.post('coding/import',{ version: (await h.get('coding')).version,csv })
  const d = n => c.dimensions.find(d => d.name === name(n)).id, v = n => c.values.find(v => v.name === name(n)).id
  return { c, d, v, valid: { [d(1)]:v(2),[d(4)]:v(5),[d(7)]:v(8) }, csv }
}
async function draft(h,t,n,options={}) {
  const cookie = options.cookie ?? t.sam
  let c = await h.post('claims',{ title:name(n) },cookie)
  c = await h.post(`claims/${c.id}/items`,{ version:c.version,kind:'receipt',date:'2026-06-17',merchant:name(n),amount:'12.34',category:t.c.travel,explanation:name(n),...options },cookie)
  return c
}
const submit = (h,c,cookie,status=200) => h.post(`claims/${c.id}/submit`,{ version:c.version },cookie,status)
const approve = (h,c,cookie) => h.post(`claims/${c.id}/decision`,{ version:c.version,revision:c.revision,decision:'approved',acknowledge:true },cookie)

test('CODE-001 native hierarchy import, category requirements and every submission retain real coding and reject invalid parents atomically', () => team(async(h,t) => {
  const admin = await h.person('synthetic-coaster-9@example.test',{ admin:true },MANAGER)
  for(const who of [t.sam,t.morgan,t.priya]) await h.post('coding/dimensions',{ version:0,name:name(10),kind:'tag' },who,403)
  let configured = await h.post('coding/dimensions',{ version:0,name:name(10),kind:'cost-centre',required:false },admin)
  const center = configured.saved
  configured = await h.post('coding/values',{ version:configured.version,dimension:center,name:name(11) },admin)
  const centerValue = configured.saved
  await h.post('coding/values',{ version:0,dimension:center,name:name(12) },admin,409)
  const { c,d,v,valid,csv } = await catalog(h)
  assert.ok(c.dimensions.every(d => d.source === 'native' && !d.source_company))
  const originalCategory = (await h.get('state')).categories.find(c => c.id === t.c.travel)
  const categoryInput = { id:originalCategory.id,name:originalCategory.name,accountCode:originalCategory.account_code,taxCode:originalCategory.tax_code }
  configured = await h.post('coding/dimensions',{ version:c.version,name:name(70),kind:'account' })
  const accountDimension = configured.saved
  configured = await h.post('coding/values',{ version:configured.version,dimension:accountDimension,name:name(71) })
  const accountId = configured.saved
  await h.post('settings/categories',{ ...categoryInput,ledgerAccountId:accountId },t.morgan,403)
  const mapped = await h.post('settings/categories',{ ...categoryInput,ledgerAccountId:accountId },admin)
  assert.equal(mapped.account_code,originalCategory.account_code,'selecting a chart account never relabels the manual accounting code')
  assert.equal(mapped.ledger_account.id,accountId);assert.equal(mapped.ledger_account.source,'native');assert.equal(mapped.ledger_account_available,true)
  for(const ledgerAccountId of [centerValue,name(72)]) await h.post('settings/categories',{ ...categoryInput,ledgerAccountId },admin,400)
  assert.deepEqual((await h.get('state')).categories.find(c => c.id === t.c.travel),mapped,'invalid mappings do not change category settings')
  const before = await h.get('coding')
  await h.post('coding/import',{ version:before.version,csv:csv.replace(name(5)+','+name(2),name(5)+','+name(99)) },h.owner,400)
  assert.deepEqual(await h.get('coding'),before,'a bad parent imports no dimensions or choices')
  assert.deepEqual((await h.get(`coding/options?dimension=${d(4)}&parent=${v(2)}`,t.sam)).map(v => v.id),[v(5)],'Sales offers only Sales projects')
  assert.deepEqual(await h.get(`coding/options?dimension=${d(4)}`,t.sam),[])

  // Free text remains a native supported path until this category is explicitly bound.
  const legacy = await draft(h,t,20,{ project:name(21),customer:name(22),billable:true })
  assert.equal((await h.get(`claims/${legacy.id}`,t.sam)).items[0].project,name(21))
  const automatic = await h.post('expenses',{ kind:'receipt',date:'2026-06-17',merchant:name(23),amount:'3.21',category:t.c.travel,explanation:name(23) },t.sam)
  await h.post('coding/requirements',{ version:before.version,category:t.c.travel,dimensions:[{ dimension:d(4),required:true }] })
  const failed = await submit(h,legacy,t.sam,400)
  assert.match(failed.error,new RegExp(name(4)))
  assert.equal((await h.get(`claims/${legacy.id}`,t.sam)).revisions.length,0)
  const empty = await h.post('claims',{ title:name(24) },t.sam)
  for(const coding of [{}, { [d(1)]:v(2),[d(4)]:v(6) }, { [d(4)]:v(5) }, { ...valid,[d(7)]:v(6) }]) {
    await h.post(`claims/${empty.id}/items`,{ version:empty.version,kind:'receipt',date:'2026-06-17',merchant:name(24),amount:'1.23',category:t.c.travel,coding },t.sam,400)
    assert.equal((await h.get(`claims/${empty.id}`,t.sam)).items.length,0)
  }
  await h.post('expenses',{ kind:'receipt',date:'2026-06-17',merchant:name(25),amount:'2.34',category:t.c.travel },t.sam,400)
  // Optional project/task levels may be omitted on an unbound category; selected parents are still enforced.
  await draft(h,t,26,{ category:t.c.office,coding:{ [d(1)]:v(2) } })
  // Agent proposals and their acceptance re-check the live catalog through the same public doors.
  const key = await h.post('agent-keys',{ label:name(31) },t.sam)
  const sendAgent = items => h.send('/api/coaster/agent/claims',{ title:name(32),items },'',{ authorization:`Bearer ${key.token}` })
  const agentItem = { kind:'receipt',date:'2026-06-17',merchant:name(32),amount:'4.56',category:t.c.travel,explanation:name(32),coding:valid }
  assert.equal((await sendAgent([{ ...agentItem,coding:{ [d(1)]:v(2),[d(4)]:v(6) } }])).status,400)
  const proposed = await sendAgent([agentItem]); assert.equal(proposed.status,200)
  let changed = await h.get('coding')
  await h.post('coding/values',{ version:changed.version,id:v(8),active:false })
  await h.post(`proposals/${proposed.value.id}/accept`,{},t.sam,400)
  changed = await h.get('coding')
  await h.post('coding/values',{ version:changed.version,id:v(8),active:true })
  const accepted = await h.post(`proposals/${proposed.value.id}/accept`,{},t.sam)
  const acceptedSubmission = await submit(h,accepted.claim,t.sam)
  assert.equal((await h.get(`claims/${acceptedSubmission.id}`,t.sam)).revisions[0].snapshot.items[0].project,name(5))
  const coded = await draft(h,t,27,{ coding:{ ...valid,[center]:centerValue } })
  const submitted = await submit(h,coded,t.sam)
  const frozen = (await h.get(`claims/${submitted.id}`,t.sam)).revisions[0].snapshot.items[0]
  assert.equal(frozen.project,name(5)); assert.deepEqual(frozen.coding,{ ...valid,[center]:centerValue })
  assert.equal(frozen.allocations[0].cost_centre,name(11))
  assert.equal(frozen.allocations[0].ledger_account.id,accountId);assert.equal(frozen.allocations[0].ledger_account.source,'native')
  assert.equal(frozen.allocations[0].account_code,originalCategory.account_code)
  assert.equal(frozen.codingSnapshot.find(v => v.kind === 'project').owner,HEAD)

  // Scheduled automatic and stipend paths use the same missing-coding gate.
  await h.post('settings/auto-submit',{ schedule:'daily' })
  await h.post('allowances',{ name:name(28),type:'stipend',member:SAM,category:t.c.travel,period:'monthly',amount:'7.00',tax:'accountable',startsOn:'2026-06-01' },t.morgan)
  await h.mf.getWorker().then(w => w.scheduled({ scheduledTime:Date.parse('2026-06-18T02:00:00Z'),cron:'0 * * * *' }))
  assert.equal((await h.get(`claims/${automatic.id}`,t.sam)).claim.status,'draft')
  const claims = (await h.get('state',t.sam)).claims
  const stipend = claims.find(c => c.title.includes(name(28)))
  assert.ok(stipend && stipend.status === 'draft','scheduled stipend cannot bypass required catalog coding')

  // Requiring a level globally applies to new expenses even on otherwise unbound categories.
  let current = await h.get('coding')
  await h.post('coding/dimensions',{ version:current.version,id:d(1),required:true })
  await draft(h,t,29,{ category:t.c.office,coding:{ [d(1)]:v(2) } })
  await h.post(`claims/${empty.id}/items`,{ version:empty.version,kind:'receipt',date:'2026-06-17',merchant:name(30),amount:'1.23',category:t.c.office },t.sam,400)
  current = await h.get('coding')
  await h.post('coding/values',{ version:current.version,id:v(2),active:false })
  assert.deepEqual(await h.get(`coding/options?dimension=${d(4)}&parent=${v(2)}`,t.sam),[],'archiving a parent removes dependent project choices')
  assert.deepEqual((await h.get(`claims/${submitted.id}`,t.sam)).revisions[0].snapshot.items[0],frozen,'catalog edits cannot rewrite a submitted revision')
  current = await h.get('coding')
  current = await h.post('coding/values',{ version:current.version,id:accountId,name:name(73) })
  assert.equal((await h.get('state')).categories.find(c => c.id === t.c.travel).ledger_account.name,name(71),'provider/native renames retain the saved mapping provenance')
  await h.post('coding/values',{ version:current.version,id:accountId,active:false })
  assert.deepEqual(await h.get(`coding/options?dimension=${accountDimension}`),[],'archived accounts stop being offered')
  const unavailable = (await h.get('state')).categories.find(c => c.id === t.c.travel)
  assert.equal(unavailable.ledger_account_available,false);assert.equal(unavailable.ledger_account.name,name(71))
  await h.post('settings/categories',{ ...categoryInput,ledgerAccountId:accountId },admin,400)
  const preserved = await h.post('settings/categories',categoryInput,admin)
  assert.equal(preserved.ledger_account_id,accountId,'omission preserves an unavailable mapping for explicit review')
  const cleared = await h.post('settings/categories',{ ...categoryInput,ledgerAccountId:'' },admin)
  assert.equal(cleared.ledger_account,null);assert.equal(cleared.account_code,originalCategory.account_code)
  await h.post('settings/categories',{ ...categoryInput,accountCode:name(75) },admin)
  assert.deepEqual((await h.get(`claims/${submitted.id}`,t.sam)).revisions[0].snapshot.items[0],frozen,'later mapping edits retain the exact submitted account identity and manual code')
}))

test('CODE-001 projects group exact split and tax spend, with project and tag budget actuals on frozen coding', async () => { const edge = qboFixture(); await team(async(h,t) => {
  const { d,v,valid } = await catalog(h)
  await h.post('settings/business',{ name:name(40),currency:'AUD',timezone:'Australia/Sydney',receiptThreshold:'',salesTaxAccount:name(41),salesTaxCode:name(42) })
  for(const scope of ['project','tag']) await h.post('budgets',{ name:name(scope==='project'?43:44),scope,scopeKey:scope==='project'?v(5):v(8),period:'monthly',amount:'20.00',owner:HEAD,thresholds:'80,100',policyRule:true },t.morgan)
  const item = { amount:'12.34',salesTax:'0.34',allocations:[{ category:t.c.travel,amount:'5.01' },{ category:t.c.office,amount:'6.99' }],coding:valid }
  let approved = await submit(h,await draft(h,t,45,item),t.sam)
  approved = await approve(h,approved,t.priya)
  const pending = await submit(h,await draft(h,t,46,{ ...item,amount:'7.89',salesTax:'0.89',allocations:[{ category:t.c.travel,amount:'2.01' },{ category:t.c.office,amount:'4.99' }] }),t.sam)
  const policyExceptions = (await h.get(`claims/${pending.id}`,t.sam)).revisions[0].snapshot.exceptions
  assert.equal(policyExceptions.filter(e => e.code === 'over-budget').length,2,'both project and tag policy budgets count the full tax-inclusive expense')
  const uncoded = await submit(h,await draft(h,t,47,{ category:t.c.office,amount:'1.23',project:name(48) }),t.sam)
  const query = 'from=2026-06-01&to=2026-06-30'
  const byProject = await h.get(`spend?by=project&${query}`,t.morgan)
  assert.equal(byProject.totalMinor,2146)
  assert.deepEqual(byProject.groups.map(g => [g.key,g.totalMinor,g.approvedMinor,g.pendingMinor]).sort(),[[v(5),2023,1234,789],[name(48),123,0,123]].sort())
  for(const by of ['employee','category','merchant','cost-centre','department','month','card']) assert.equal((await h.get(`spend?by=${by}&${query}`,t.morgan)).totalMinor,2146,`${by} total remains exact`)
  const drill = await h.get(`spend?by=project&key=${v(5)}&${query}`,t.morgan)
  assert.equal(drill.lines.length,6); assert.equal(drill.totalMinor,2023)
  assert.equal(drill.lines.reduce((n,l)=>n+l.amountMinor,0),2023)
  const budgets = await h.get('budgets?day=2026-06-20',t.morgan)
  assert.ok(budgets.every(b => b.actualMinor===2023 && b.approvedMinor===1234 && b.pendingMinor===789))
  // Renaming the live project never changes frozen spend/budget membership.
  const current = await h.get('coding')
  await h.post('coding/values',{ version:current.version,id:v(5),name:name(49) })
  assert.deepEqual((await h.get(`spend?by=project&${query}`,t.morgan)).groups,byProject.groups)
  assert.ok((await h.get('budgets?day=2026-06-20',t.morgan)).every(b => b.actualMinor===2023))
  const saved = await h.post('spend-views',{ name:name(50),by:'project',from:'2026-06-01',to:'2026-06-30' },t.morgan)
  assert.equal((await h.get(`spend?view=${saved[0].id}`,t.morgan)).totalMinor,2146)
  // A real connected provider account is selected by stable catalog identity, with explicit source provenance.
  const connection = await h.post('accounting/qbo/connect',{ consent:true })
  assert.equal((await h.send(edge.callback(connection.authorizationUrl),undefined,h.owner)).status,303)
  await h.post('accounting/qbo/refresh',{})
  const provider = await h.get('coding'),accountDimension = provider.dimensions.find(d => d.source==='quickbooks' && d.kind==='account')
  const account = provider.values.find(v => v.dimension_id===accountDimension.id)
  const original = (await h.get('state')).categories.find(c => c.id===t.c.office)
  const mapping = await h.post('settings/categories',{ id:original.id,name:original.name,accountCode:original.account_code,taxCode:original.tax_code,ledgerAccountId:account.id })
  assert.equal(mapping.ledger_account.source,'quickbooks');assert.equal(mapping.ledger_account.sourceCompany,`sandbox:${edge.realm}`)
  assert.equal(mapping.ledger_account.sourceId,account.source_id);assert.equal(mapping.account_code,original.account_code)
  const providerClaim = await submit(h,await draft(h,t,74,{ category:t.c.office,amount:'1.11' }),t.sam)
  const providerFrozen = (await h.get(`claims/${providerClaim.id}`,t.sam)).revisions[0].snapshot.items[0].allocations[0].ledger_account
  assert.deepEqual(providerFrozen,mapping.ledger_account)
  await h.post('accounting/qbo/disconnect',{ consent:true,version:(await h.get('accounting/qbo')).version })
  assert.equal((await h.get('state')).categories.find(c=>c.id===t.c.office).ledger_account_available,false)
  assert.deepEqual((await h.get(`claims/${providerClaim.id}`,t.sam)).revisions[0].snapshot.items[0].allocations[0].ledger_account,providerFrozen)
  assert.equal(approved.status,'approved');assert.equal(pending.status,'submitted');assert.equal(uncoded.status,'submitted')
}, { qboEdge:edge.fetch,bindings:edge.bindings }) })

test('CODE-001 project-owner workflows resolve persisted owners, freeze reviewers and refuse self approval', () => team(async(h,t) => {
  const { c,d,v,valid } = await catalog(h)
  await h.post('settings/approval-workflow',{ version:0,rules:[{ label:name(60),condition:{ kind:'project',value:name(5) },stages:[[{ kind:'projectOwner' }]] }] })
  let claim = await submit(h,await draft(h,t,61,{ coding:valid }),t.sam)
  const frozen = (await h.get(`claims/${claim.id}`,t.sam)).revisions[0].snapshot.workflow
  assert.deepEqual(frozen.stages[1],[{ kind:'named',email:HEAD }])
  let current = await h.get('coding')
  await h.post('coding/values',{ version:current.version,id:v(5),owner:MANAGER })
  claim = await approve(h,claim,t.priya)
  assert.equal(claim.status,'submitted'); assert.equal(claim.approver_email,HEAD)
  await h.post(`claims/${claim.id}/decision`,{ version:claim.version,revision:claim.revision,decision:'approved',acknowledge:true },t.priya,403)
  claim = await approve(h,claim,t.jordan)
  assert.equal(claim.status,'approved')
  assert.deepEqual((await h.get(`claims/${claim.id}`,t.sam)).revisions[0].snapshot.workflow,frozen)
  // The project owner cannot submit their own project into their own required review.
  await h.post('settings/members',{ email:HEAD,name:name(62),employee:true,manager:true,finance:true,approver:MANAGER })
  current = await h.get('coding')
  await h.post('coding/values',{ version:current.version,id:v(5),owner:HEAD })
  // Distinct projects add all of their actual owners as parallel reviewers.
  let multiple = await draft(h,t,67,{ coding:valid })
  multiple = await h.post(`claims/${multiple.id}/items`,{ version:multiple.version,kind:'receipt',date:'2026-06-17',merchant:name(68),amount:'1.23',category:t.c.travel,explanation:name(68),coding:{ [d(1)]:v(3),[d(4)]:v(6) } },t.sam)
  multiple = await submit(h,multiple,t.sam)
  const parallel = (await h.get(`claims/${multiple.id}`,t.sam)).revisions[0].snapshot.workflow.stages[1]
  assert.deepEqual(parallel.map(r => r.email).sort(),[HEAD,MANAGER].sort())
  multiple = await approve(h,multiple,t.priya)
  multiple = await approve(h,multiple,t.jordan)
  assert.equal(multiple.status,'submitted','every project owner must approve the parallel stage')
  multiple = await approve(h,multiple,t.priya)
  assert.equal(multiple.status,'approved')
  const self = await draft(h,t,63,{ cookie:t.jordan,coding:valid })
  const refused = await submit(h,self,t.jordan,409)
  assert.match(refused.error,/own claim/)
  assert.equal((await h.get(`claims/${self.id}`,t.jordan)).revisions.length,0)
  // A free text project name without persisted ownership cannot invent a reviewer.
  const bad = await draft(h,t,64,{ project:name(65) })
  await h.post('settings/approval-workflow',{ version:1,rules:[{ label:name(66),condition:{ kind:'always' },stages:[[{ kind:'projectOwner' }]] }] })
  await submit(h,bad,t.sam,409)
}))
