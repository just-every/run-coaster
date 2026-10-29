import { preserveWorkflow } from './journeys/specialized-workflow.mjs'
import { preserveWorkflowLifecycle } from './journeys/specialized-workflow-lifecycle.mjs'
import { preserveFinanceDelegation } from './journeys/specialized-finance-delegation.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness, receipt } from './harness.mjs'

const SAM = 'sam@harbourfinch.example', PRIYA = 'priya@harbourfinch.example'
const HEAD = 'jordan@harbourfinch.example', FINANCE = 'morgan@harbourfinch.example'
const conditionalRules = () => [
  { label: 'Department head for large purchases', condition: { kind: 'amount', value: '1000.00' }, stages: [[{ kind: 'department-head' }]] },
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
const csvRows = text => text.trim().split('\r\n').map(row => row.split('\",\"').map(cell => cell.replace(/^\"|\"$/g, '')))
const csvTotal = text => { const [header, ...rows] = csvRows(text); return Math.round(rows.reduce((total, row) => total + Number(row[header.indexOf('amount')]) * 100, 0)) }

test('APPROVE-001 owner configures three conditional paths; frozen reviews finish once and reimburse exactly the approved total', async () => {
  await preserveWorkflow()
  await preserveWorkflowLifecycle()
  await preserveFinanceDelegation()
  await (() => withAgency(async (h, t) => {
  const department=await h.post('settings/departments',{name:'Sales',head:HEAD})
  await h.post('settings/members',{email:SAM,name:'sam',employee:true,approver:PRIYA,department:department.id})
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
  const aging=await h.get('reports/aging',t.morgan)
  assert.deepEqual([aging.totals.claims,aging.totals.amountMinor],[approved.length,190000],'aging counts completed workflows once, excluding the pending threshold-boundary claim')
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

  // The manager works a batch of new claims through the same native review
  // door. Stale rows and unreviewed rows stay unchanged; the rest finish once.
  const pending=[]
  for(const [merchant,distance] of [['North site','10'],['South site','12']]){
    let c=await h.post('claims',{title:merchant},t.sam)
    c=await h.post(`claims/${c.id}/items`,{version:c.version,kind:'mileage',date:'2026-06-19',merchant,distance,allocations:[{category:t.c.car}]},t.sam)
    pending.push(await submit(h,c,t.sam))
  }
  const entry=c=>({id:c.id,revision:c.revision,version:c.version,reviewed:true,acknowledge:true})
  const before=await Promise.all(pending.map(c=>h.get(`claims/${c.id}`,t.sam)))
  const refused=await h.post('approvals/bulk',{claims:[{...entry(pending[0]),reviewed:false},{...entry(pending[1]),version:pending[1].version-1}]},t.priya)
  assert.ok(refused.results.every(r=>!r.approved))
  assert.deepEqual(await Promise.all(pending.map(c=>h.get(`claims/${c.id}`,t.sam))),before)
  const bulk=await h.post('approvals/bulk',{claims:pending.map(entry)},t.priya)
  assert.ok(bulk.results.every(r=>r.approved&&r.claimStatus==='approved'))
  for(const c of pending){const d=await h.get(`claims/${c.id}`,t.sam);assert.equal(d.decisions.length,1);assert.ok(d.events.some(e=>e.detail.bulkId===bulk.bulkId))}
  assert.ok((await h.post('approvals/bulk',{claims:pending.map(entry)},t.priya)).results.every(r=>!r.approved))


  // A Full delegate can review the manager's queue, but cannot approve their own expense.
  let own=await h.post('claims',{title:'Delegate own visit'},t.alex)
  own=await h.post(`claims/${own.id}/items`,{version:own.version,kind:'mileage',date:'2026-06-20',merchant:'Delegate own visit',distance:'9',allocations:[{category:t.c.car}]},t.alex)
  own=await submit(h,own,t.alex)
  const grant=await h.post('delegates',{delegate:'alex@harbourfinch.example',level:'full'},t.priya)
  const headers={'x-coaster-acting-for':PRIYA}
  assert.equal((await h.send(`/api/coaster/claims/${own.id}/decision`,decision(own),t.alex,headers)).status,403)
  const reviewed=await approve(h,own,t.priya)
  assert.equal(reviewed.status,'approved')
  await h.post(`delegates/${grant.id}/revoke`,{},t.priya)

}))()
})