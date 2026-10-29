// Preserved native HTTP assertion phases; callers own test registration.
import assert from 'node:assert/strict'
import { agency, harness, receipt } from '../harness.mjs'

const SAM = 'sam@harbourfinch.example', PRIYA = 'priya@harbourfinch.example'
const MORGAN = 'morgan@harbourfinch.example', JORDAN = 'jordan@harbourfinch.example', CASEY = 'casey@harbourfinch.example'
const decision = c => ({ revision: c.revision, version: c.version, decision: 'approved' })
const approveClaim = (h, c, cookie, status = 200) => h.post(`claims/${c.id}/decision`, decision(c), cookie, status)
const approveRequest = (h, r, cookie, status = 200) => h.post(`requests/${r.id}/decision`, { version: r.version, decision: 'approved' }, cookie, status)

async function setup(run) {
  const h = await harness()
  try {
    const t = await agency(h)
    const casey = await h.person(CASEY, { employee: true, finance: true }, PRIYA)
    await h.post('settings/approval-workflow', { version: 0, rules: [
      { label: 'Finance review', condition: { kind: 'always', value: '' }, stages: [[{ kind: 'finance', email: MORGAN }]] },
    ] })
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' })
    await run(h, { ...t, casey, today })
  } finally { await h.close() }
}

async function submittedPair(h, t, title, fixture, cookie = t.sam) {
  let claim = await h.post('claims', { title }, cookie)
  const upload = await h.post(`claims/${claim.id}/receipts`, { version: claim.version, ...(await receipt(fixture)) }, cookie)
  claim = await h.post(`claims/${claim.id}/items`, {
    version: upload.claim.version, kind: 'receipt', date: '2026-06-17', merchant: title,
    amount: '100.00', receipt: upload.receipt, allocations: [{ category: t.c.travel }],
  }, cookie)
  claim = await h.post(`claims/${claim.id}/submit`, { version: claim.version }, cookie)
  const request = await h.post('requests', { title, estimate: '100.00', purpose: 'Client travel' }, cookie)
  return { claim, request }
}

async function activateFinance(h, t, pair) {
  return { claim: await approveClaim(h, pair.claim, t.priya), request: await approveRequest(h, pair.request, t.priya) }
}

async function readPair(h, pair, cookie) {
  const [detail, state] = await Promise.all([h.get(`claims/${pair.claim.id}`, cookie), h.get('state', cookie)])
  return { detail, claim: detail.claim, request: state.requests.find(r => r.id === pair.request.id) }
}

const waiting = record => record.workflow_tasks.filter(task => task.status === 'waiting')
function assertFinance(pair, address, onBehalfOf = null) {
  for (const record of [pair.claim, pair.request]) {
    assert.deepEqual([record.status, record.assigned_emails, record.approver_email, record.on_behalf_of], ['submitted', [address], address, onBehalfOf])
    assert.deepEqual(waiting(record).map(task => [task.email, task.role, task.on_behalf_of]), [[address, 'finance', onBehalfOf]])
  }
}

// Original assertion phase: APPROVE-001 finance out-of-office applies when a stage activates; deactivation moves only the original finance queue and records both claim and request history
export const financeDelegationQueue = () => setup(async (h, t) => {
  await h.post('settings/members', { email: MORGAN, name: 'morgan', employee: true, finance: true, approver: JORDAN })
  const old = await activateFinance(h, t, await submittedPair(h, t, 'Travel awaiting finance', 'uber'))
  assertFinance(old, MORGAN)
  const oldDetail = (await h.get(`claims/${old.claim.id}`, t.sam)).revisions
  const later = await submittedPair(h, t, 'Travel awaiting manager', 'hotel')
  const dates = { startsOn: t.today, endsOn: t.today }
  await h.post('delegations', { role: 'finance', delegate: PRIYA, ...dates }, t.morgan, 400)
  await h.post('delegations', { role: 'finance', delegate: MORGAN, ...dates }, t.morgan, 400)
  await h.post('delegations', { role: 'finance', approver: MORGAN, delegate: CASEY, ...dates }, t.jordan, 403)
  await h.post('delegates', { delegate: CASEY, level: 'full' }, t.morgan)
  const delegatedSettings = await h.send('/api/coaster/delegations', { role: 'finance', delegate: JORDAN, ...dates }, t.casey, { 'x-coaster-acting-for': MORGAN })
  assert.equal(delegatedSettings.status, 403, 'Full access cannot set another person\'s out-of-office')

  const implicit = await h.post('delegations', { delegate: CASEY, ...dates }, t.morgan)
  assert.equal(implicit.review_role, 'finance', 'a finance-only person defaults to finance delegation')
  await h.post(`delegations/${implicit.id}/revoke`, {}, t.morgan)
  await h.post('delegations', { role: 'finance', delegate: CASEY, ...dates }, t.morgan)
  const unchanged = await readPair(h, old, t.sam)
  assertFinance(unchanged, MORGAN)
  assert.deepEqual([unchanged.claim.version, unchanged.request.version], [old.claim.version, old.request.version], 'setting out-of-office does not rewrite existing assignments')

  const delegated = await activateFinance(h, t, later)
  assertFinance(delegated, CASEY, MORGAN)
  await approveClaim(h, delegated.claim, t.morgan, 403)
  await approveRequest(h, delegated.request, t.morgan, 403)
  await approveClaim(h, delegated.claim, t.jordan, 403)
  await approveRequest(h, delegated.request, t.jordan, 403)
  const delegatedDetail = (await h.get(`claims/${delegated.claim.id}`, t.sam)).revisions

  await h.post('settings/members', { email: MORGAN, name: 'morgan', employee: true, finance: true, approver: JORDAN, active: false })
  const [moved, kept] = await Promise.all([readPair(h, old, t.sam), readPair(h, delegated, t.sam)])
  assertFinance(moved, JORDAN)
  assert.ok(moved.claim.version > old.claim.version && moved.request.version > old.request.version)
  assert.deepEqual(moved.detail.revisions, oldDetail, 'queue movement preserves the submitted revision')
  assert.ok(moved.detail.events.some(e => e.detail.from === MORGAN && e.detail.to === JORDAN))
  const history = await h.get('history')
  assert.ok(history.lines.some(line => line.detail.kind === 'request' && line.detail.record === old.request.id && line.detail.from === MORGAN && line.detail.to === JORDAN), 'a request queue move has its own history line')
  assertFinance(kept, CASEY, MORGAN)
  assert.deepEqual([kept.claim.version, kept.request.version, kept.detail.revisions], [delegated.claim.version, delegated.request.version, delegatedDetail], 'deactivating the original reviewer leaves their delegate\'s active tasks intact')
  await approveClaim(h, { ...moved.claim, version: old.claim.version }, t.jordan, 409)
  await approveRequest(h, { ...moved.request, version: old.request.version }, t.jordan, 409)

  const approvedOld = await approveClaim(h, moved.claim, t.jordan)
  const approvedDelegated = await approveClaim(h, kept.claim, t.casey)
  assert.equal((await approveRequest(h, moved.request, t.jordan)).status, 'approved')
  const approvedRequest = await approveRequest(h, kept.request, t.casey)
  assert.deepEqual([approvedRequest.status, approvedRequest.decided_by, approvedRequest.decided_on_behalf_of], ['approved', CASEY, MORGAN])
  const completed = await h.get(`claims/${approvedDelegated.id}`, t.sam)
  assert.deepEqual([completed.decisions.at(-1).actor_email, completed.decisions.at(-1).on_behalf_of], [CASEY, MORGAN])
  const batch = await h.post('batches', { claims: [approvedOld.id, approvedDelegated.id] }, t.jordan)
  const payment = await h.get(`batches/${batch.id}`, t.jordan)
  assert.deepEqual([batch.total_minor, payment.lines.length, payment.lines.map(line => line.approver)], [20000, 2, [JORDAN, CASEY]])
})

// Original assertion phase: APPROVE-001 a finance delegate never reviews their own spend; a manager without finance cannot inherit or be assigned the finance task
export const financeDelegationSeparation = () => setup(async (h, t) => {
  await h.post('delegations', { role: 'finance', approver: MORGAN, delegate: CASEY, startsOn: t.today, endsOn: t.today })
  const own = await activateFinance(h, t, await submittedPair(h, t, 'Casey client travel', 'officeworks', t.casey))
  assertFinance(own, MORGAN)
  await approveClaim(h, own.claim, t.casey, 403)
  await approveRequest(h, own.request, t.casey, 403)
  await h.post('delegates', { delegate: CASEY, level: 'full' }, t.morgan)
  const asMorgan = { 'x-coaster-acting-for': MORGAN }
  const claimSelf = await h.send(`/api/coaster/claims/${own.claim.id}/decision`, decision(own.claim), t.casey, asMorgan)
  const requestSelf = await h.send(`/api/coaster/requests/${own.request.id}/decision`, { version: own.request.version, decision: 'approved' }, t.casey, asMorgan)
  assert.deepEqual([claimSelf.status, requestSelf.status], [403, 403], 'acting for the assigned finance reviewer cannot bypass self-review protection')

  const before = await readPair(h, own, t.casey)
  await h.post('settings/members', { email: MORGAN, name: 'morgan', employee: true, finance: true, approver: PRIYA, active: false })
  const stuck = await readPair(h, own, t.casey)
  assertFinance(stuck, MORGAN)
  assert.deepEqual([stuck.claim.version, stuck.request.version, stuck.detail.decisions, stuck.detail.revisions], [before.claim.version, before.request.version, before.detail.decisions, before.detail.revisions], 'a successor lacking finance leaves the frozen finance queue for the owner')
  await approveClaim(h, stuck.claim, t.priya, 403)
  await approveRequest(h, stuck.request, t.priya, 403)
  await h.post(`claims/${stuck.claim.id}/reassign`, { version: stuck.claim.version, approver: PRIYA, reason: 'Cover finance review' }, h.owner, 400)
  await h.post(`requests/${stuck.request.id}/reassign`, { version: stuck.request.version, approver: PRIYA, reason: 'Cover finance review' }, h.owner, 400)
  const claim = await h.post(`claims/${stuck.claim.id}/reassign`, { version: stuck.claim.version, approver: JORDAN, reason: 'Finance reviewer unavailable' })
  const request = await h.post(`requests/${stuck.request.id}/reassign`, { version: stuck.request.version, approver: JORDAN, reason: 'Finance reviewer unavailable' })
  assertFinance({ claim, request }, JORDAN)
  assert.equal((await approveClaim(h, claim, t.jordan)).status, 'approved')
  assert.equal((await approveRequest(h, request, t.jordan)).status, 'approved')
  const completed = await h.get(`claims/${claim.id}`, t.casey)
  assert.deepEqual(completed.revisions, before.detail.revisions)
  assert.deepEqual(completed.decisions.map(d => d.actor_email), [PRIYA, JORDAN])
})

export async function preserveFinanceDelegation() {
  await financeDelegationQueue()
  await financeDelegationSeparation()
}
