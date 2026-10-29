// Preserved native HTTP assertion phases; callers own test registration.
import assert from 'node:assert/strict'
import { agency, harness, receipt } from '../harness.mjs'

const SAM = 'sam@harbourfinch.example', PRIYA = 'priya@harbourfinch.example'
const HEAD = 'jordan@harbourfinch.example', FINANCE = 'morgan@harbourfinch.example'
const conditionalRules = () => [
  { label: 'Department head for large purchases', condition: { kind: 'amount', value: '1000.00' }, stages: [[{ kind: 'named', email: HEAD }]] },
  { label: 'Finance reviews exceptions', condition: { kind: 'exception', value: '' }, stages: [[{ kind: 'finance', email: FINANCE }]] },
]

async function withAgency(run) {
  const h = await harness()
  try { await run(h, await agency(h)) } finally { await h.close() }
}

async function draft(h, t, { title, amount, fixture, category = t.c.travel, project = '', request, explanation = '', cookie = t.sam }) {
  let c = await h.post('claims', { title }, cookie)
  const uploaded = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...(await receipt(fixture)) }, cookie)
  c = await h.post(`claims/${c.id}/items`, {
    version: uploaded.claim.version, kind: 'receipt', date: '2026-06-17', merchant: title,
    amount, receipt: uploaded.receipt, allocations: [{ category }], project, request, explanation,
  }, cookie)
  return c
}
const submit = (h, c, cookie) => h.post(`claims/${c.id}/submit`, { version: c.version }, cookie)
const decision = (c, extra = {}) => ({ version: c.version, revision: c.revision, decision: 'approved', ...extra })
const approve = (h, c, cookie, extra = {}) => h.post(`claims/${c.id}/decision`, decision(c, extra), cookie)
const requestDecision = (h, r, cookie, status = 200) => h.post(`requests/${r.id}/decision`, { version: r.version, decision: 'approved' }, cookie, status)


// Original assertion phase: APPROVE-001 category and project route through parallel manager and finance reviews with current roles; the department head cannot approve their own claim
export const parallelWorkflow = () => withAgency(async (h, t) => {
  await h.post('settings/approval-workflow', { version: 0, rules: [
    { label: 'Joint travel review', condition: { kind: 'category', value: t.c.travel }, stages: [[{ kind: 'manager' }, { kind: 'finance', email: FINANCE }]] },
    { label: 'Launch project sign-off', condition: { kind: 'project', value: 'Launch' }, stages: [[{ kind: 'named', email: HEAD }]] },
  ] })
  let c = await submit(h, await draft(h, t, { title: 'Production travel', amount: '200.00', fixture: 'officeworks', project: 'Launch' }), t.sam)
  assert.deepEqual((await h.get(`claims/${c.id}`, t.sam)).revisions[0].snapshot.workflow.matched, ['Joint travel review', 'Launch project sign-off'])
  await h.post(`claims/${c.id}/decision`, decision(c), t.morgan, 403)
  await h.post('settings/members',{email:SAM,name:'sam',employee:true,approver:HEAD})
  c = await approve(h, c, t.priya)
  assert.deepEqual(c.assigned_emails, [PRIYA, FINANCE])
  assert.ok((await h.get('state', t.morgan)).claims.some(row => row.id === c.id && row.assigned_emails.includes(FINANCE)))
  const before = await h.get(`claims/${c.id}`, t.sam)
  await h.post('settings/members', { email: FINANCE, name: 'morgan', employee: true, approver: PRIYA })
  await h.post(`claims/${c.id}/decision`, decision(c), t.morgan, 403)
  await h.post(`claims/${c.id}/decision`, decision(c), t.jordan, 403)
  assert.deepEqual((await h.get(`claims/${c.id}`, t.sam)).decisions, before.decisions, 'refused decisions leave no partial audit write')
  await h.post('settings/members', { email: FINANCE, name: 'morgan', employee: true, finance: true, approver: PRIYA })
  const parallelVersion = c.version
  c = await approve(h, c, t.morgan)
  assert.deepEqual([c.status, c.assigned_emails], ['submitted', [PRIYA]], 'finance may finish first without consuming the manager task')
  await h.post('batches', { claims: [c.id] }, t.morgan, 409)
  await h.post(`claims/${c.id}/decision`, decision(c, { version: parallelVersion }), t.priya, 409)
  c = await approve(h, c, t.priya)
  assert.deepEqual([c.status, c.assigned_emails], ['submitted', [HEAD]])
  await h.post('batches', { claims: [c.id] }, t.morgan, 409)
  c = await approve(h, c, t.jordan)
  assert.equal(c.status, 'approved')
  const done = await h.get(`claims/${c.id}`, t.sam)
  assert.equal(done.decisions.length, 4)
  assert.equal(done.decisions.at(-1).actor_email,HEAD,'decision history ends with the completing reviewer')
  assert.deepEqual(done.claim.workflow_tasks.map(task => [task.email, task.status]), [[PRIYA, 'approved'], [PRIYA, 'approved'], [FINANCE, 'approved'], [HEAD, 'approved']])
  assert.equal(done.events.filter(e => e.action === 'claim-approved').length, 1)
  const batch = await h.post('batches', { claims: [c.id] }, t.morgan)
  const batched = await h.get(`batches/${batch.id}`, t.morgan)
  assert.deepEqual([batch.total_minor, batched.lines.length, batched.lines[0].approver], [20000, 1, HEAD])

  const workflow = (await h.get('state')).approvalWorkflow
  await h.post('settings/approval-workflow', { version: workflow.version, rules: conditionalRules() })
  await h.post('settings/members', { email: HEAD, name: 'jordan', employee: true, manager: true, finance: true, approver: PRIYA })
  const own = await draft(h, t, { title: 'Department head travel', amount: '1400.00', fixture: 'hotel', cookie: t.jordan })
  await h.post(`claims/${own.id}/decision`, decision(own), t.jordan, 403)
  await h.post(`claims/${own.id}/submit`, { version: own.version }, t.jordan, 409)
  const blocked = await h.get(`claims/${own.id}`, t.jordan)
  assert.deepEqual([blocked.claim.status, blocked.claim.version, blocked.decisions.length], ['draft', own.version, 0], 'a future self-review stage refuses submission without a partial write')
})

// Original assertion phase: APPROVE-001 spend requests retain their conditional route and an hourly stipend uses the newly configured finance stage
export const requestAndStipendWorkflow = () => withAgency(async (h, t) => {
  const workflow = await h.post('settings/approval-workflow', { version: 0, rules: [...conditionalRules(),
    { label: 'Finance reviews planned spend', condition: { kind: 'spend-request', value: '' }, stages: [[{ kind: 'finance', email: FINANCE }]] },
  ] })
  let small = await h.post('requests', { title: 'Local conference', estimate: '200.00', purpose: 'Meet clients' }, t.sam)
  let trip = await h.post('requests', { title: 'Interstate conference', estimate: '1400.00', purpose: 'Present the studio portfolio' }, t.sam)
  const frozen = trip.workflow
  await requestDecision(h, trip, t.sam, 403)
  await requestDecision(h, trip, t.jordan, 403)
  small = await requestDecision(h, small, t.priya)
  assert.deepEqual([small.status, small.assigned_emails], ['submitted', [FINANCE]], 'a spend-request condition adds finance even below the amount threshold')
  small = await requestDecision(h, small, t.morgan)
  assert.equal(small.status, 'approved')
  let linked=await submit(h,await draft(h,t,{title:'Approved conference supplies',amount:'50.00',fixture:'bistro',request:small.id}),t.sam)
  assert.deepEqual((await h.get(`claims/${linked.id}`,t.sam)).revisions[0].snapshot.workflow.matched,['Finance reviews planned spend'],'an expense linked to an approved request takes the spend-request condition')
  linked=await approve(h,linked,t.priya)
  assert.deepEqual(linked.assigned_emails,[FINANCE])
  assert.equal((await approve(h,linked,t.morgan)).status,'approved')
  const original = trip
  trip = await requestDecision(h, trip, t.priya)
  assert.deepEqual([trip.status, trip.assigned_emails], ['submitted', [HEAD]])
  await requestDecision(h, { ...trip, version: original.version }, t.jordan, 409)
  await requestDecision(h, trip, t.morgan, 403)

  const updated = await h.post('settings/approval-workflow', { version: workflow.version, rules: [
    { label: 'Finance reviews every reimbursement', condition: { kind: 'always', value: '' }, stages: [[{ kind: 'finance', email: FINANCE }]] },
  ] })
  trip = await requestDecision(h, trip, t.jordan)
  assert.deepEqual([trip.status, trip.assigned_emails, trip.workflow], ['submitted', [FINANCE], frozen])
  trip = await requestDecision(h, trip, t.morgan)
  assert.deepEqual([trip.status, trip.decided_by, trip.workflow], ['approved', FINANCE, frozen])
  assert.equal((await h.get('state', t.sam)).requests.find(r => r.id === trip.id).workflow, frozen)

  await h.post('settings/approval-rule', { enabled: true, limit: '100.00' })
  await h.post('allowances', { name: 'Phone stipend', type: 'stipend', category: t.c.office, period: 'monthly', amount: '75.00', tax: 'taxable', startsOn: '2026-06-01', member: SAM }, t.morgan)
  const worker = await h.mf.getWorker()
  const tick = () => worker.scheduled({ scheduledTime: new Date('2026-06-01T00:17:00Z'), cron: '17 * * * *' })
  await tick()
  await tick()
  const stipends = (await h.get('state', t.sam)).claims.filter(c => c.title.startsWith('Phone stipend · '))
  assert.equal(stipends.length, 1, 'the hourly trigger does not duplicate a stipend period')
  let stipend = stipends[0]
  const detail = await h.get(`claims/${stipend.id}`, t.sam)
  assert.deepEqual([stipend.status, stipend.assigned_emails, detail.items[0].kind, detail.items[0].receipt_id], ['submitted', [PRIYA], 'stipend', null])
  assert.equal(detail.revisions[0].submitted_by, 'allowance')
  assert.equal(detail.revisions[0].snapshot.workflow.version, updated.version)
  assert.deepEqual(detail.exceptions, [])
  stipend = await approve(h, stipend, t.priya)
  assert.deepEqual([stipend.status, stipend.assigned_emails], ['submitted', [FINANCE]])
  await h.post('batches', { claims: [stipend.id] }, t.morgan, 409)
  stipend = await approve(h, stipend, t.morgan)
  const completed = await h.get(`claims/${stipend.id}`, t.sam)
  assert.deepEqual([stipend.status, completed.decisions.map(d => d.actor_email)], ['approved', [PRIYA, FINANCE]])
  assert.deepEqual(completed.revisions, detail.revisions)
  const batch = await h.post('batches', { claims: [stipend.id] }, t.morgan)
  const payment = await h.get(`batches/${batch.id}`, t.morgan)
  assert.deepEqual([batch.total_minor, payment.lines.length, payment.lines[0].approver, payment.people[0].amountMinor], [7500, 1, FINANCE, 7500])
})

export async function preserveWorkflow() {
  await parallelWorkflow()
  await requestAndStipendWorkflow()
}
