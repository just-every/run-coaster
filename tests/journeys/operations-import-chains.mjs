import assert from 'node:assert/strict'
import { agency, harness, receipt } from '../harness.mjs'

const SAM = 'sam@harbourfinch.example', PRIYA = 'priya@harbourfinch.example', JORDAN = 'jordan@harbourfinch.example'

async function setup(run) {
  const h = await harness()
  try { await run(h, await agency(h)) } finally { await h.close() }
}

/** Configuration enters through the same reviewed public import door as history.
 * Reading opaque identities does not bypass any application write. */
async function importChain(h, employee = SAM, managers = [PRIYA, JORDAN]) {
  const keys = [employee, ...managers].map(() => crypto.randomUUID()), chain = crypto.randomUUID()
  const crosswalk = { [chain]: crypto.randomUUID() }
  const members = []
  for (const [i, address] of [employee, ...managers].entries()) {
    const m = await h.db.prepare('SELECT * FROM c_members WHERE email=?').bind(address).first()
    crosswalk[keys[i]] = m.member_id
    members.push({ key: keys[i], email: address, name: m.name, employee: true, manager: Boolean(m.is_manager) })
  }
  const input = { source: 'certify', configuration: { members, categories: [], chains: [{ key: chain, employee: keys[0], steps: keys.slice(1) }] }, mapping: { crosswalk } }
  const preview = await h.post('import/preview', input)
  assert.deepEqual(preview.summary.errors, [])
  const committed = await h.post('import/commit', { ...input, fingerprint: preview.fingerprint })
  assert.equal(committed.job.state, 'completed')
  return committed
}

async function draft(h, t, expenses = 1) {
  let c = await h.post('claims', { title: 'Chain review' }, t.sam)
  for (let i = 0; i < expenses; i++) {
    const r = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...(await receipt(i ? 'hotel' : 'uber')) }, t.sam)
    c = await h.post(`claims/${c.id}/items`, { version: r.claim.version, kind: 'receipt', date: '2026-06-17', merchant: i ? 'Train' : 'Taxi', amount: i ? '20.00' : '10.00', receipt: r.receipt, allocations: [{ category: t.c.travel }] }, t.sam)
  }
  return c
}
const submit = (h, t, c) => h.post(`claims/${c.id}/submit`, { version: c.version }, t.sam)
const decide = (h, c, cookie, extra = {}) => h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved', ...extra }, cookie)

// MOVE-003 imported ordered managers decide every step of one frozen revision; rules, early payment, stale decisions and reopen cannot skip the chain
async function decideEveryImportedChainStep(h, t) {
  await importChain(h)
  await h.post('settings/approval-rule', { enabled: true, limit: '75.00' })
  await h.post('settings/audit-sample', { percent: '100' }, t.jordan)
  let c = await submit(h, t, await draft(h, t))
  assert.deepEqual([c.status, c.approver_email], ['submitted', PRIYA], 'a compliant expense still needs every imported manager')
  await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved' }, t.jordan, 403)
  const original = c
  c = await decide(h, c, t.priya)
  assert.deepEqual([c.status, c.revision, c.approver_email], ['submitted', original.revision, JORDAN])
  assert.equal((await h.get('exceptions', t.jordan)).samples.length, 0, 'an intermediate step is not a completed approval sample')
  await h.post('batches', { claims: [c.id] }, t.morgan, 409)
  await h.post(`claims/${c.id}/retract`, { version: c.version }, t.sam, 409)
  await h.post(`claims/${c.id}/decision`, { revision: original.revision, version: original.version, decision: 'approved' }, t.priya, 403)
  c = await decide(h, c, t.jordan)
  assert.equal(c.status, 'approved')
  assert.equal((await h.get('exceptions', t.jordan)).samples.length, 1)
  let detail = await h.get(`claims/${c.id}`, t.sam)
  assert.deepEqual(detail.decisions.map(d => [d.revision, d.decision_step, d.actor_email]), [[1, 0, PRIYA], [1, 1, JORDAN]])
  assert.deepEqual(detail.revisions[0].snapshot.approvalChain.steps.map(s => s.email), [PRIYA, JORDAN])

  c = await h.post(`claims/${c.id}/unapprove`, { version: c.version, to: 'approver', reason: 'Review again' }, t.jordan)
  assert.deepEqual([c.status, c.revision, c.approver_email], ['submitted', 2, PRIYA])
  c = await decide(h, c, t.priya)
  c = await decide(h, c, t.jordan, { decision: 'returned', reason: 'Clarify the journey' })
  assert.equal(c.status, 'returned')
  c = await submit(h, t, c)
  assert.deepEqual([c.revision, c.approver_email], [3, PRIYA], 'correction starts the chain again')
  c = await decide(h, c, t.priya)
  c = await decide(h, c, t.jordan)
  detail = await h.get(`claims/${c.id}`, t.sam)
  assert.equal(detail.decisions.length, 6)
  assert.deepEqual((await h.get('exceptions', t.jordan)).samples.map(s => s.ordinal), [2, 1])
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' })
  const aging = await h.get(`reports/aging?from=${today}&to=${today}`, t.morgan)
  assert.deepEqual([aging.totals.claims, aging.totals.amountMinor], [1, 1000])
  const batch = await h.post('batches', { claims: [c.id] }, t.morgan)
  const exported = await h.get(`batches/${batch.id}`, t.morgan)
  assert.deepEqual([batch.total_minor, exported.lines.length, exported.people[0].amountMinor, exported.lines[0].approver], [1000, 1, 1000, JORDAN])
}

// MOVE-003 only the final chain manager may hold expenses; kept expenses approve and held expenses must traverse the chain again
async function holdOnlyAtFinalChainStep(h, t) {
  await importChain(h)
  let c = await submit(h, t, await draft(h, t, 2))
  const item = (await h.get(`claims/${c.id}`, t.sam)).items[1].id
  const hold = { hold: [item], reason: 'Correct the journey' }
  await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved', ...hold }, t.priya, 409)
  c = await decide(h, c, t.priya)
  c = await decide(h, c, t.jordan, hold)
  assert.deepEqual([c.status, c.total_minor], ['approved', 1000])
  const split = (await h.get(`claims/${c.id}`, t.sam)).events.find(e => e.action === 'claim-split')
  let held = (await h.get(`claims/${split.detail.heldClaim}`, t.sam)).claim
  await h.post(`claims/${held.id}/release`, { version: held.version }, t.jordan, 409)
  held = await submit(h, t, held)
  assert.deepEqual([held.status, held.approver_email], ['submitted', PRIYA])
  held = await decide(h, held, t.priya)
  held = await decide(h, held, t.jordan)
  assert.deepEqual([held.status, held.total_minor], ['approved', 2000])
}

// MOVE-003 delegation and owner reassignment replace only the current chain step, while a deactivated later manager blocks progress
async function replaceCurrentImportedChainStep(h, t) {
  await importChain(h)
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' })
  await h.post('delegations', { delegate: JORDAN, startsOn: today, endsOn: today }, t.priya)
  let c = await submit(h, t, await draft(h, t))
  assert.deepEqual([c.approver_email, c.on_behalf_of], [JORDAN, PRIYA])
  c = await h.post(`claims/${c.id}/reassign`, { version: c.version, approver: PRIYA, reason: 'Manager is back' })
  await h.post('settings/members', { email: JORDAN, name: 'jordan', employee: true, manager: true, finance: true, active: false })
  await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved' }, t.priya, 409)
  assert.equal((await h.get(`claims/${c.id}`, t.sam)).decisions.length, 0, 'a blocked transition records no partial decision')
  await h.post('settings/members', { email: JORDAN, name: 'jordan', employee: true, manager: true, finance: true, active: true })
  c = await decide(h, c, t.priya)
  assert.deepEqual([c.status, c.approver_email], ['submitted', JORDAN])
  c = await decide(h, c, t.jordan)
  assert.equal(c.status, 'approved')
}

export async function preserveImportedChains() {
  await setup(decideEveryImportedChainStep)
  await setup(holdOnlyAtFinalChainStep)
  await setup(replaceCurrentImportedChainStep)
}
