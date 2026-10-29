// Original operations assertions, composed as named phases without test registrations.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness, receipt } from '../harness.mjs'
import { sha, sum, claim, submit, approve, central, deactivateAccount, unzip, everywhere, withAgency } from './operations-support.mjs'

// APPROVE-002 an approver delegates for a date range, the owner reassigns a stuck claim and a deactivated approver's queue moves to their manager
async function delegateApprovalQueues(h, t) {
  const day = offset => { const d = new Date(Date.now() + offset * 86400000); return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d) }
  const lunch = (who, title, date) => claim(h, who, title, [{ kind: 'receipt', date, merchant: title, amount: '30.00', allocations: [{ category: t.c.meals }], receiptFixture: who === t.sam ? 'bistro' : who === t.alex ? 'uber' : 'officeworks' }])
  await h.post('delegations', { delegate: 'jordan@harbourfinch.example', startsOn: day(7), endsOn: day(14) }, t.priya)
  const early = await submit(h, t.alex, await lunch(t.alex, 'Before leave', '2026-05-10'))
  assert.equal(early.approver_email, 'priya@harbourfinch.example', 'a delegation for next week leaves this week\'s claims with the approver')
  await h.post('delegations', { delegate: 'sam@harbourfinch.example', startsOn: day(-1), endsOn: day(3) }, t.priya, 400)
  await h.post('delegations', { approver: 'priya@harbourfinch.example', delegate: 'jordan@harbourfinch.example', startsOn: day(-1), endsOn: day(3) }, t.jordan, 403)
  const away = await h.post('delegations', { delegate: 'jordan@harbourfinch.example', startsOn: day(-1), endsOn: day(3) }, t.priya)
  let c = await submit(h, t.sam, await lunch(t.sam, 'During leave', '2026-05-11'))
  assert.deepEqual([c.approver_email, c.on_behalf_of], ['jordan@harbourfinch.example', 'priya@harbourfinch.example'], 'routed to the delegate on behalf of the approver')
  await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved' }, t.priya, 403)
  c = await approve(h, t.jordan, c)
  const seen = await h.get(`claims/${c.id}`, t.priya)
  assert.deepEqual([seen.decisions[0].actor_email, seen.decisions[0].on_behalf_of], ['jordan@harbourfinch.example', 'priya@harbourfinch.example'])
  assert.equal(seen.events.find(e => e.action === 'claim-approved').detail.onBehalfOf, 'priya@harbourfinch.example')
  await h.post(`delegations/${away.id}/revoke`, {}, t.jordan, 403)
  await h.post(`delegations/${away.id}/revoke`, {}, t.priya)
  await h.post(`claims/${early.id}/reassign`, { version: early.version, approver: 'jordan@harbourfinch.example', reason: 'Priya is travelling' }, t.morgan, 403)
  await h.post(`claims/${early.id}/reassign`, { version: early.version, approver: 'alex@harbourfinch.example' }, h.owner, 400)
  const moved = await h.post(`claims/${early.id}/reassign`, { version: early.version, approver: 'jordan@harbourfinch.example', reason: 'Priya is travelling' })
  assert.equal(moved.approver_email, 'jordan@harbourfinch.example')
  assert.deepEqual((await h.get(`claims/${early.id}`)).events.at(-1).detail, { from: 'priya@harbourfinch.example', to: 'jordan@harbourfinch.example', reason: 'Priya is travelling' })
  await h.post('settings/members', { email: 'priya@harbourfinch.example', name: 'priya', employee: true, manager: true, approver: 'jordan@harbourfinch.example' })
  const stuck = await submit(h, t.morgan, await lunch(t.morgan, 'Offsite', '2026-05-12'))
  assert.equal(stuck.approver_email, 'priya@harbourfinch.example')
  await h.post('settings/members', { email: 'priya@harbourfinch.example', name: 'priya', employee: true, manager: true, approver: 'jordan@harbourfinch.example', active: false })
  const after = await h.get(`claims/${stuck.id}`, t.jordan)
  assert.equal(after.claim.approver_email, 'jordan@harbourfinch.example', 'the deactivated approver\'s queue moved to their manager')
  assert.deepEqual(after.events.at(-1).detail, { from: 'priya@harbourfinch.example', to: 'jordan@harbourfinch.example', reason: 'Approver deactivated' })
  await approve(h, t.jordan, after.claim)
}

// APPROVE-004 the owner lets a claim approve itself by rule when every expense is under the amount with its receipt and no exception; anything else goes to a person
async function approveCompliantExpensesByRule(h, t) {
  await h.post('settings/approval-rule', { enabled: true, limit: '75.00' }, t.jordan, 403)
  await h.post('settings/approval-rule', { enabled: true, limit: '' }, h.owner, 400)
  assert.deepEqual(await h.post('settings/approval-rule', { enabled: true, limit: '75.00' }), { ...(await h.get('state')).approvalRule, version: 1, enabled: 1, limit_minor: 7500 })
  await h.post('settings/audit-sample', { percent: '100' }, t.jordan)
  const receiptOf = (merchant, amount, category, fixture) => ({ kind: 'receipt', date: '2026-06-10', merchant, amount, allocations: [{ category }], receiptFixture: fixture })

  // A compliant $40 claim approves at submission, recorded as approved by rule v1 and sampled like any approval.
  const lunch = await submit(h, t.sam, await claim(h, t.sam, 'Client lunch', [receiptOf('Bills Surry Hills', '40.00', t.c.meals, 'bistro')]))
  assert.equal(lunch.status, 'approved')
  const detail = await h.get(`claims/${lunch.id}`, t.sam)
  assert.deepEqual(detail.decisions.map(d => [d.revision, d.decision, d.actor_email]), [[1, 'approved', 'rule v1']])
  assert.match(detail.decisions[0].reason, /under AUD 75\.00 with its receipt and no policy exception/)
  assert.deepEqual(detail.events.filter(e => e.action === 'claim-approved').map(e => [e.actor_email, e.detail.rule]), [['rule v1', 1]])
  assert.deepEqual((await h.get('exceptions', t.jordan)).samples.map(s => [s.claim_id, s.percent]), [[lunch.id, 100]], 'POLICY-003 samples rule approvals')
  await h.post(`claims/${lunch.id}/decision`, { revision: 1, version: lunch.version, decision: 'approved' }, t.priya, 409)
  let batch = await h.post('batches', { claims: [lunch.id] }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 4000 }, t.jordan)
  assert.equal((await h.get(`batches/${batch.id}`, t.jordan)).lines.find(l => l.claim === `CL-${String(lunch.number).padStart(4, '0')}`).approver, 'rule v1', 'the accounting line names the rule version as approver')

  // A $40 expense with an exception, an expense at or over the amount, and an expense with no receipt each route to the approver.
  const unreceipted = await submit(h, t.alex, await claim(h, t.alex, 'Taxi', [{ kind: 'receipt', date: '2026-06-11', merchant: 'Taxi', amount: '40.00', allocations: [{ category: t.c.travel }], explanation: 'Driver had no printer' }]))
  const over = await submit(h, t.alex, await claim(h, t.alex, 'Hotel', [receiptOf('Hotel Ibis', '75.00', t.c.travel, 'hotel')]))
  const mileage = await submit(h, t.sam, await claim(h, t.sam, 'Site visit', [{ kind: 'mileage', date: '2026-06-12', merchant: 'Studio to site', distance: '10', allocations: [{ category: t.c.car }] }]))
  for (const c of [unreceipted, over, mileage]) assert.deepEqual([c.status, c.approver_email], ['submitted', 'priya@harbourfinch.example'])
  assert.equal((await h.get(`claims/${unreceipted.id}`, t.alex)).revisions[0].snapshot.exceptions[0].code, 'missing-receipt')
  assert.equal((await approve(h, t.priya, over)).status, 'approved', 'the approver decides what the rule does not cover')

  // Each change is the next version: a claim approved under v2 says v2, earlier approvals keep v1; turned off, everything goes to a person.
  assert.equal((await h.post('settings/approval-rule', { enabled: 'on', limit: '50.00' })).version, 2)
  const paper = await submit(h, t.alex, await claim(h, t.alex, 'Printer paper', [receiptOf('Officeworks', '40.00', t.c.office, 'officeworks')]))
  assert.deepEqual([paper.status, (await h.get(`claims/${paper.id}`, t.alex)).decisions[0].actor_email], ['approved', 'rule v2'])
  assert.equal((await h.get(`claims/${lunch.id}`, t.sam)).decisions[0].actor_email, 'rule v1')
  assert.deepEqual(await h.post('settings/approval-rule', { enabled: false }), { ...(await h.get('state')).approvalRule, version: 3, enabled: 0, limit_minor: null })
  const ride = await submit(h, t.sam, await claim(h, t.sam, 'Airport ride', [receiptOf('Uber', '30.00', t.c.travel, 'uber')]))
  assert.equal(ride.status, 'submitted')
  await assert.rejects(h.db.prepare('UPDATE c_approval_rules SET limit_minor=1').run(), /permanent/)
}

// APPROVE-007 an employee or their delegate retracts a claim before any decision; the approver, finance or the owner unapproves it until its batch is reviewed
async function retractAndUnapproveClaims(h, t) {
  const SAM = 'sam@harbourfinch.example', ALEX = 'alex@harbourfinch.example', PRIYA = 'priya@harbourfinch.example'
  const d = await claim(h, t.sam, 'Sydney workshop', [{ kind: 'receipt', date: '2026-05-20', merchant: 'Hotel Ibis', amount: '236.00', allocations: [{ category: t.c.travel }], explanation: 'Folio to follow' }])
  let c = await submit(h, t.sam, d)
  await h.post(`claims/${c.id}/retract`, { version: c.version }, t.alex, 403)
  c = await h.post(`claims/${c.id}/retract`, { version: c.version, reason: 'Adding the hotel receipt' }, t.sam)
  assert.deepEqual([c.status, c.revision, c.approver_email], ['draft', 1, null])
  assert.ok(!(await h.get('state', t.priya)).claims.some(x => x.id === c.id), 'it leaves the approver\'s queue')
  await h.get(`claims/${c.id}`, t.priya, 403)
  const r = await h.post(`claims/${c.id}/receipts`, { version: c.version, item: d.items[0].id, ...(await receipt('hotel')) }, t.sam)
  c = await h.post(`claims/${c.id}/submit`, { version: r.claim.version }, t.sam)
  let seen = await h.get(`claims/${c.id}`, t.priya)
  assert.deepEqual([c.revision, seen.revisions.map(x => x.revision)], [2, [1, 2]])
  const retracted = seen.events.find(e => e.action === 'claim-retracted')
  assert.deepEqual([retracted.actor_email, retracted.detail.revision, retracted.detail.reason], [SAM, 1, 'Adding the hotel receipt'], 'the retraction is recorded on revision 1')

  // A delegate retracts in the employee's name; the line is theirs, on the employee's behalf.
  await h.post('delegates', { delegate: ALEX, level: 'submit' }, t.sam)
  const asDelegate = await h.send(`/api/coaster/claims/${c.id}/retract`, { version: c.version }, t.alex, { 'x-coaster-acting-for': SAM })
  assert.equal(asDelegate.status, 200, JSON.stringify(asDelegate.value))
  seen = await h.get(`claims/${c.id}`, t.sam)
  assert.deepEqual(seen.events.filter(e => e.action === 'claim-retracted').map(e => [e.actor_email, e.detail.actingFor ?? null, e.detail.revision]), [[SAM, null, 1], [ALEX, SAM, 2]])
  c = await h.post(`claims/${c.id}/submit`, { version: seen.claim.version }, t.sam)
  assert.equal(c.revision, 3)

  c = await approve(h, t.priya, c)
  await h.post(`claims/${c.id}/retract`, { version: c.version }, t.sam, 409)
  for (const who of [t.sam, t.alex]) await h.post(`claims/${c.id}/unapprove`, { version: c.version, to: 'employee', reason: 'Mine' }, who, 403)
  await h.post(`claims/${c.id}/unapprove`, { version: c.version, to: 'approver', reason: '' }, t.priya, 400)
  c = await h.post(`claims/${c.id}/unapprove`, { version: c.version, to: 'approver', reason: 'Check the room rate first' }, t.priya)
  assert.deepEqual([c.status, c.revision, c.approver_email], ['submitted', 4, PRIYA])
  seen = await h.get(`claims/${c.id}`, t.priya)
  assert.deepEqual(seen.revisions.at(-1).snapshot.reopened, { fromRevision: 3, by: PRIYA, reason: 'Check the room rate first' })
  assert.deepEqual(seen.revisions.at(-1).snapshot.items.map(i => i.receipt.id), seen.revisions.at(-2).snapshot.items.map(i => i.receipt.id))
  c = await approve(h, t.priya, c)

  // In a draft batch finance may still unapprove: the claim leaves the batch and goes back to the employee.
  let batch = await h.post('batches', { claims: [c.id] }, t.morgan)
  c = await h.post(`claims/${c.id}/unapprove`, { version: (await h.get(`claims/${c.id}`, t.morgan)).claim.version, to: 'employee', reason: 'The client pays this one directly' }, t.morgan)
  assert.deepEqual([c.status, c.batch_id], ['returned', null])
  const emptied = await h.get(`batches/${batch.id}`, t.morgan)
  assert.deepEqual([emptied.batch.total_minor, emptied.claims.length], [0, 0])
  seen = await h.get(`claims/${c.id}`, t.sam)
  assert.deepEqual(seen.decisions.map(x => [x.revision, x.decision, x.actor_email]), [[3, 'approved', PRIYA], [4, 'approved', PRIYA]], 'approvals stay in history')
  assert.deepEqual(seen.events.filter(e => e.action === 'claim-unapproved').map(e => [e.actor_email, e.detail.revision, e.detail.to, e.detail.reason, e.detail.approvedBy]),
    [[PRIYA, 3, 'approver', 'Check the room rate first', PRIYA], ['morgan@harbourfinch.example', 4, 'employee', 'The client pays this one directly', PRIYA]])

  // Once a batch is reviewed, unapproval is refused for everyone.
  c = await approve(h, t.priya, await h.post(`claims/${c.id}/submit`, { version: c.version }, t.sam))
  batch = await h.post('batches', { claims: [c.id] }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 23600 }, t.jordan)
  const batched = (await h.get(`claims/${c.id}`, t.priya)).claim
  for (const who of [t.priya, t.jordan, h.owner]) await h.post(`claims/${c.id}/unapprove`, { version: batched.version, to: 'employee', reason: 'Too late' }, who, 409)
}

// APPROVE-005 an approver holds the dinner and approves the other four; the held expense moves to its own claim, is fixed and paid separately, or its hold is released
async function holdAndReleaseExpenses(h, t) {
  const PRIYA = 'priya@harbourfinch.example'
  const five = [
    { kind: 'receipt', date: '2026-05-25', merchant: 'Rockpool', amount: '96.00', allocations: [{ category: t.c.meals }], receiptFixture: 'bistro' },
    { kind: 'receipt', date: '2026-05-25', merchant: 'Uber', amount: '18.40', allocations: [{ category: t.c.travel }], receiptFixture: 'uber' },
    { kind: 'receipt', date: '2026-05-26', merchant: 'Hotel Ibis', amount: '236.00', allocations: [{ category: t.c.travel }], receiptFixture: 'hotel' },
    { kind: 'receipt', date: '2026-05-26', merchant: 'Officeworks', amount: '64.95', allocations: [{ category: t.c.office }], receiptFixture: 'officeworks' },
    { kind: 'mileage', date: '2026-05-27', merchant: 'Airport run', distance: '20', allocations: [{ category: t.c.car }] },
  ]
  const d = await claim(h, t.sam, 'Melbourne client week', five)
  let c = await submit(h, t.sam, d)
  const dinner = d.items[0].id, dinnerReceipt = d.items[0].receipt_id, holdDinner = { decision: 'approved', hold: [dinner], reason: 'Add the attendee list' }
  await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, ...holdDinner }, t.sam, 403)
  await h.post(`claims/${c.id}/decision`, { revision: c.revision - 1, version: c.version, ...holdDinner }, t.priya, 409)
  await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, ...holdDinner, reason: '' }, t.priya, 400)
  await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, ...holdDinner, hold: d.items.map(i => i.id) }, t.priya, 400)
  c = await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, ...holdDinner }, t.priya)
  const rest = 1840 + 23600 + 6495 + 1760
  assert.deepEqual([c.status, c.revision, c.total_minor], ['approved', 2, rest])
  let original = await h.get(`claims/${c.id}`, t.sam)
  assert.deepEqual(original.items.map(i => i.merchant), ['Uber', 'Hotel Ibis', 'Officeworks', 'Airport run'])
  assert.deepEqual(original.revisions.map(r => r.snapshot.items.length), [5, 4], 'revision 1 keeps all five; revision 2 is the approved four')
  assert.deepEqual(original.decisions.map(x => [x.revision, x.decision, x.actor_email]), [[2, 'approved', PRIYA]])
  const heldId = original.revisions[1].snapshot.split.heldClaim
  let held = await h.get(`claims/${heldId}`, t.sam)
  assert.deepEqual([held.claim.status, held.claim.held_from, held.claim.held_by, held.claim.hold_reason, held.claim.approver_email, held.claim.total_minor], ['returned', c.id, PRIYA, 'Add the attendee list', PRIYA, 9600])
  assert.deepEqual(held.items.map(i => [i.id, i.merchant]), [[dinner, 'Rockpool']])
  assert.notEqual(held.items[0].receipt_id, dinnerReceipt); assert.equal(held.items[0].receipt_sha256, d.items[0].receipt_sha256, 'the receipt moves byte for byte')
  assert.equal((await h.send(`/api/coaster/receipts/${dinnerReceipt}`, undefined, t.priya)).status, 200, 'revision 1\'s receipt stays readable')
  assert.deepEqual(original.events.filter(e => e.action === 'claim-split').map(e => [e.actor_email, e.detail.revision, e.detail.heldClaim, e.detail.reason]), [[PRIYA, 1, heldId, 'Add the attendee list']])
  assert.deepEqual(held.events.filter(e => e.action === 'claim-held').map(e => [e.actor_email, e.detail.from, e.detail.reason]), [[PRIYA, c.id, 'Add the attendee list']])

  // The four go to a batch and are paid; the dinner is fixed, resubmitted alone, approved and paid separately.
  let batch = await h.post('batches', { claims: [c.id] }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: rest }, t.jordan)
  batch = await h.paid(batch.id, batch.version, { reference: 'ACH-0601', paidOn: '2026-06-01' }, t.jordan)
  assert.equal((await h.get(`claims/${c.id}`, t.sam)).claim.status, 'reimbursed')
  let hc = await h.post(`claims/${heldId}/items`, { version: held.claim.version, item: dinner, kind: 'receipt', date: '2026-05-25', merchant: 'Rockpool', amount: '96.00', receipt: held.items[0].receipt_id, allocations: [{ category: t.c.meals }], attendees: [{ kind: 'employee', name: 'sam', email: 'sam@harbourfinch.example' }, { kind: 'guest', name: 'Dana Kim' }] }, t.sam)
  await h.post(`claims/${heldId}/release`, { version: hc.version }, t.sam, 403)
  hc = await approve(h, t.priya, await h.post(`claims/${heldId}/submit`, { version: hc.version }, t.sam))
  assert.deepEqual([hc.status, hc.revision, hc.total_minor], ['approved', 1, 9600])
  batch = await h.post('batches', { claims: [heldId] }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 9600 }, t.jordan)
  await h.paid(batch.id, batch.version, { reference: 'ACH-0608', paidOn: '2026-06-08' }, t.jordan)
  assert.equal((await h.get(`claims/${heldId}`, t.sam)).claim.status, 'reimbursed')

  // Or the approver releases a hold before the employee resubmits.
  const again = await submit(h, t.alex, await claim(h, t.alex, 'Two site visits', [{ ...five[4], merchant: 'Site visit north' }, { ...five[4], merchant: 'Site visit south', date: '2026-05-28' }]))
  const split = await h.post(`claims/${again.id}/decision`, { revision: again.revision, version: again.version, decision: 'approved', hold: [(await h.get(`claims/${again.id}`, t.alex)).items[1].id], reason: 'Which project?' }, t.priya)
  const second = (await h.get(`claims/${split.id}`, t.priya)).revisions.at(-1).snapshot.split.heldClaim
  const released = await h.post(`claims/${second}/release`, { version: (await h.get(`claims/${second}`, t.priya)).claim.version, reason: 'Answered by phone' }, t.priya)
  assert.deepEqual([released.status, released.revision], ['approved', 1])
  const record = await h.get(`claims/${second}`, t.alex)
  assert.deepEqual([record.revisions[0].submitted_by, record.decisions[0].actor_email, record.events.at(-1).action], ['alex@harbourfinch.example', PRIYA, 'hold-released'])
}

export async function preserveApprovalOperations() {
  await withAgency(delegateApprovalQueues)
  await withAgency(approveCompliantExpensesByRule)
  await withAgency(retractAndUnapproveClaims)
  await withAgency(holdAndReleaseExpenses)
}
