import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness, receipt } from './harness.mjs'

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

async function draft(h, t, { title, amount, fixture, category = t.c.travel, project = '', explanation = '', cookie = t.sam }) {
  let c = await h.post('claims', { title }, cookie)
  const uploaded = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...(await receipt(fixture)) }, cookie)
  c = await h.post(`claims/${c.id}/items`, {
    version: uploaded.claim.version, kind: 'receipt', date: '2026-06-17', merchant: title,
    amount, receipt: uploaded.receipt, allocations: [{ category }], project, explanation,
  }, cookie)
  return c
}
const submit = (h, c, cookie) => h.post(`claims/${c.id}/submit`, { version: c.version }, cookie)
const decision = (c, extra = {}) => ({ version: c.version, revision: c.revision, decision: 'approved', ...extra })
const approve = (h, c, cookie, extra = {}) => h.post(`claims/${c.id}/decision`, decision(c, extra), cookie)
const requestDecision = (h, r, cookie, status = 200) => h.post(`requests/${r.id}/decision`, { version: r.version, decision: 'approved' }, cookie, status)
const csvRows = text => text.trim().split('\r\n').map(row => row.split('\",\"').map(cell => cell.replace(/^\"|\"$/g, '')))
const csvTotal = text => { const [header, ...rows] = csvRows(text); return Math.round(rows.reduce((total, row) => total + Number(row[header.indexOf('amount')]) * 100, 0)) }

test('APPROVE-001 owner configures three conditional paths; frozen reviews finish once and reimburse exactly the approved total', () => withAgency(async (h, t) => {
  const rules = conditionalRules()
  await h.post('settings/approval-workflow', { version: 0, rules }, t.morgan, 403)
  await h.post('settings/approval-workflow', { version: 0, rules: [{ ...rules[0], stages: [[{ kind: 'named', email: FINANCE }]] }] }, h.owner, 400)
  await h.post('settings/approval-workflow', { version: 0, rules: [{ ...rules[1], stages: [[{ kind: 'finance', email: PRIYA }]] }] }, h.owner, 400)
  const configured = await h.post('settings/approval-workflow', { version: 0, rules })
  assert.deepEqual((await h.get('state')).approvalWorkflow, configured)
  await h.post('settings/approval-workflow', { version: 0, rules: [] }, h.owner, 409)
  assert.deepEqual((await h.get('state')).approvalWorkflow, configured, 'a stale settings save changes nothing')
  await h.post('settings/audit-sample', { percent: '100' }, t.jordan)

  let baseline = await submit(h, await draft(h, t, { title: 'Airport transfer', amount: '200.00', fixture: 'uber' }), t.sam)
  let large = await submit(h, await draft(h, t, { title: 'Conference accommodation', amount: '1400.00', fixture: 'hotel' }), t.sam)
  let exception = await submit(h, await draft(h, t, { title: 'Client dinner', amount: '300.00', fixture: 'officeworks', category: t.c.meals, explanation: 'Dinner for the visiting client team' }), t.sam)
  const boundary=await submit(h,await draft(h,t,{title:'Exact routing threshold',amount:'1000.00',fixture:'bistro'}),t.sam)
  assert.deepEqual((await h.get(`claims/${boundary.id}`,t.sam)).revisions[0].snapshot.workflow.matched,[],'an amount equal to the threshold adds no amount review')
  const submitted = [baseline, large, exception]
  assert.ok(submitted.every(c => c.status === 'submitted' && c.approver_email === PRIYA))
  const frozen = await Promise.all(submitted.map(c => h.get(`claims/${c.id}`, t.sam)))
  assert.deepEqual(frozen.map(d => d.revisions[0].snapshot.workflow.matched), [[], [rules[0].label], [rules[1].label]])
  assert.deepEqual(frozen.map(d => d.exceptions.map(e => e.code)), [[], [], ['over-limit']])

  // Future settings cannot remove a review from a submitted revision.
  await h.post('settings/approval-workflow', { version: configured.version, rules: [] })
  await h.post(`claims/${large.id}/decision`, decision(large), t.jordan, 403)
  await h.post(`claims/${exception.id}/decision`, decision(exception, { acknowledge: true }), t.morgan, 403)
  await h.post(`claims/${large.id}/decision`, decision(large), t.sam, 403)
  await h.post(`claims/${baseline.id}/decision`, decision(baseline, { version: baseline.version + 1 }), t.priya, 409)
  baseline = await approve(h, baseline, t.priya)
  large = await approve(h, large, t.priya)
  await h.post(`claims/${exception.id}/decision`, decision(exception), t.priya, 409)
  exception = await approve(h, exception, t.priya, { acknowledge: true })
  assert.deepEqual([baseline.status, large.status, large.approver_email, exception.status, exception.approver_email], ['approved', 'submitted', HEAD, 'submitted', FINANCE])
  assert.equal((await h.get('exceptions', t.jordan)).samples.length, 1, 'intermediate reviews do not count as completed approvals')
  await h.post('batches', { claims: [large.id, exception.id] }, t.morgan, 409)
  await h.post(`claims/${large.id}/decision`, decision(large, { version: submitted[1].version }), t.jordan, 409)
  await h.post(`claims/${exception.id}/decision`, decision(exception, { acknowledge: true }), t.jordan, 403)
  await h.post(`claims/${exception.id}/decision`, decision(exception), t.morgan, 409)
  large = await approve(h, large, t.jordan)
  exception = await approve(h, exception, t.morgan, { acknowledge: true })

  const approved = [baseline, large, exception]
  for (const [i, c] of approved.entries()) {
    const detail = await h.get(`claims/${c.id}`, t.sam)
    assert.equal(c.status, 'approved')
    assert.deepEqual(detail.revisions, frozen[i].revisions, 'configuration edits and decisions preserve the submitted revision')
    assert.deepEqual(detail.decisions.map(d => d.actor_email), [[PRIYA], [PRIYA, HEAD], [PRIYA, FINANCE]][i])
    assert.equal(detail.events.filter(e => e.action === 'claim-approved').length, 1)
  }
  assert.equal((await h.get('exceptions', t.jordan)).samples.length, approved.length)
  let batch = await h.post('batches', { claims: approved.map(c => c.id) }, t.morgan)
  const total = approved.reduce((n, c) => n + c.total_minor, 0)
  const detail = await h.get(`batches/${batch.id}`, t.morgan)
  assert.deepEqual([total, batch.total_minor, detail.lines.length, detail.people[0].amountMinor], [190000, 190000, 3, 190000])
  assert.deepEqual(detail.lines.map(l => l.approver), [PRIYA, HEAD, FINANCE], 'only the completing decision supplies each accounting line')
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: total }, t.jordan)
  for (const format of ['accounting', 'reimbursements']) {
    const file = await h.send(`/api/coaster/batches/${batch.id}/${format}.csv`, undefined, t.morgan)
    assert.equal(file.status, 200)
    assert.equal(csvTotal(file.text), total)
    assert.equal(csvRows(file.text).length, format === 'accounting' ? 4 : 2)
  }
  batch = await h.paid(batch.id, batch.version, { reference: 'WORKFLOW-JUNE-01', paidOn: '2026-06-18' }, t.jordan)
  assert.equal(batch.status, 'reimbursed')
  await h.post('batches', { claims: approved.map(c => c.id) }, t.morgan, 409)
  assert.ok((await h.get('state', t.sam)).claims.filter(c => approved.some(a => a.id === c.id)).every(c => c.status === 'reimbursed'))
}))

test('APPROVE-001 category and project route through parallel manager and finance reviews with current roles; the department head cannot approve their own claim', () => withAgency(async (h, t) => {
  await h.post('settings/approval-workflow', { version: 0, rules: [
    { label: 'Joint travel review', condition: { kind: 'category', value: t.c.travel }, stages: [[{ kind: 'manager' }, { kind: 'finance', email: FINANCE }]] },
    { label: 'Launch project sign-off', condition: { kind: 'project', value: 'Launch' }, stages: [[{ kind: 'named', email: HEAD }]] },
  ] })
  let c = await submit(h, await draft(h, t, { title: 'Production travel', amount: '200.00', fixture: 'officeworks', project: 'Launch' }), t.sam)
  assert.deepEqual((await h.get(`claims/${c.id}`, t.sam)).revisions[0].snapshot.workflow.matched, ['Joint travel review', 'Launch project sign-off'])
  await h.post(`claims/${c.id}/decision`, decision(c), t.morgan, 403)
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
}))

test('APPROVE-001 spend requests retain their conditional route and an hourly stipend uses the newly configured finance stage', () => withAgency(async (h, t) => {
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
}))
