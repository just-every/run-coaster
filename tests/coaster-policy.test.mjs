// POLICY-001 public API journeys with native sessions and real D1/workerd.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { unstable_splitSqlQuery } from 'wrangler'
import { agency, harness } from './harness.mjs'

async function withAgency(run) { const h = await harness(); try { await run(h, await agency(h)) } finally { await h.close() } }
async function claim(h, cookie, title, items) {
  let c = await h.post('claims', { title }, cookie)
  for (const item of items) c = await h.post(`claims/${c.id}/items`, { version: c.version, ...item }, cookie)
  return h.get(`claims/${c.id}`, cookie)
}
const submit = (h, cookie, d) => h.post(`claims/${d.claim.id}/submit`, { version: d.claim.version }, cookie)
const approve = (h, cookie, c, extra = {}) => h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved', ...extra }, cookie)

test('POLICY-001 finance publishes versioned rules: a soft daily meal limit, a hard blocked merchant and a hard 90-day deadline fire naming their version, and a later version leaves older claims on theirs', () => withAgency(async (h, t) => {
  await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', perDiem: '75.00', receiptThreshold: '500.00' })
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const ago = n => new Date(Date.parse(today + 'T00:00:00Z') - n * 86_400_000).toISOString().slice(0, 10)
  const meal = (date, merchant, amount, explanation) => ({ kind: 'receipt', date, merchant, amount, allocations: [{ category: t.c.meals }], ...(explanation ? { explanation } : {}) })
  const baseline = (await h.get('policy', t.morgan)).versions[0].version
  const v1 = { rules: [{ kind: 'daily-limit', category: t.c.meals, limit: '75.00' }, { kind: 'blocked-merchant', merchant: 'Lucky Star Casino', hard: true }, { kind: 'deadline', days: 90, hard: true }] }
  await h.post('policy', v1, t.sam, 403)
  await h.post('policy', { ...v1, effectiveFrom: ago(1) }, t.morgan, 400)
  assert.deepEqual((await h.post('policy', v1, t.morgan)).versions.filter(v => v.version > baseline).map(v => [v.version, v.effective_from, v.rules.length]), [[baseline + 1, today, 3]])
  // Two dinners on one day go over the daily limit: a soft rule, so each is explained and the approver acknowledges v1.
  const first = await claim(h, t.sam, 'Client dinners', [meal(ago(3), 'Bistro One', '50.00'), meal(ago(3), 'Late Bar', '40.00')])
  assert.deepEqual(first.exceptions.filter(e => e.policy).map(e => [e.code, e.policy, e.hard, e.message]), [0, 1].map(() => ['over-daily-limit', baseline + 1, false, `Meals on ${ago(3)} totals AUD 90.00, over the daily limit of AUD 75.00 (policy v${baseline + 1})`]))
  await h.post(`claims/${first.claim.id}/submit`, { version: first.claim.version }, t.sam, 409)
  let c = first.claim
  for (const item of first.items) c = await h.post(`claims/${c.id}/items`, { version: c.version, item: item.id, ...meal(item.spent_on, item.merchant, (item.amount_minor / 100).toFixed(2), 'Client dinner, then drinks with the client') }, t.sam)
  const sent = await submit(h, t.sam, await h.get(`claims/${c.id}`, t.sam))
  await approve(h, t.priya, sent, { acknowledge: true })
  // Hard rules stop the submission: a blocked merchant however it is written, and an expense older than 90 days.
  const casino = await claim(h, t.sam, 'Night out', [meal(ago(2), '  lucky star   CASINO ', '30.00')])
  assert.match((await h.post(`claims/${casino.claim.id}/submit`, { version: casino.claim.version }, t.sam, 409)).error, new RegExp(`hard policy rule and cannot be submitted: lucky star +CASINO is a blocked merchant \\(policy v${baseline + 1}\\)`))
  const late = await claim(h, t.sam, 'Old ferry', [{ kind: 'receipt', date: ago(91), merchant: 'Ferry', amount: '12.00', allocations: [{ category: t.c.travel }] }])
  assert.match((await h.post(`claims/${late.claim.id}/submit`, { version: late.claim.version }, t.sam, 409)).error, new RegExp(`Spent on ${ago(91)}, more than 90 days before submission \\(policy v${baseline + 1}\\)`))
  await submit(h, t.sam, await claim(h, t.sam, 'Ferry in time', [{ kind: 'receipt', date: ago(90), merchant: 'Ferry back', amount: '12.00', allocations: [{ category: t.c.travel }] }]))
  // Version 2 raises the daily limit; a version dated later waits for its day. New claims use v2, the first keeps v1.
  assert.deepEqual((await h.post('policy', { rules: [{ kind: 'daily-limit', category: t.c.meals, limit: '100.00' }] }, t.jordan)).versions.slice(0, 2).map(v => v.version), [baseline + 2, baseline + 1])
  await h.post('policy', { effectiveFrom: new Date(Date.parse(today + 'T00:00:00Z') + 5 * 86_400_000).toISOString().slice(0, 10), rules: [{ kind: 'blocked-merchant', merchant: 'Cafe Two', hard: true }] }, t.morgan)
  const second = await claim(h, t.sam, 'More dinners', [meal(ago(1), 'Cafe Two', '50.00'), meal(ago(1), 'Wine Bar', '40.00')])
  assert.deepEqual(second.exceptions, [], 'v2 allows $90 a day and v3 is not in effect yet')
  await submit(h, t.sam, second)
  const kept = await h.get(`claims/${first.claim.id}`, t.priya)
  assert.deepEqual([kept.exceptions.map(e => e.policy), kept.decisions.at(-1).exceptions.map(e => e.policy)], [[baseline + 1, baseline + 1], [baseline + 1, baseline + 1]], 'the approved claim keeps the version it was decided under')
  assert.deepEqual((await h.get('policy', t.morgan)).versions.filter(v => v.version > baseline).map(v => [v.version - baseline, v.rules.map(r => r.kind)]), [[3, ['blocked-merchant']], [2, ['daily-limit']], [1, ['daily-limit', 'blocked-merchant', 'deadline']]])
  await assert.rejects(h.db.prepare('UPDATE c_policies SET rules=? WHERE version=1').bind('[]').run(), /permanent/, 'published versions never change')
}))

test('POLICY-001 owner thresholds, per-expense and attendee limits and required fields share an immutable effective configuration', () => withAgency(async (h, t) => {
  await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', receiptThreshold: '75.00' })
  await h.post('settings/categories', { id: t.c.meals, name: 'Meals', accountCode: '6300', taxCode: 'GST', limit: '100.00', perPersonLimit: '60.00', requiredFields: 'Client' })
  const version = (await h.get('policy', t.morgan)).versions[0]
  assert.deepEqual([version.configuration.receipt_threshold_minor, version.configuration.categories.find(c => c.id === t.c.meals).required_fields], [7500, ['Client']])
  const item = { kind: 'receipt', date: '2026-06-16', merchant: 'Team dinner', amount: '150.00', attendees: [{ kind: 'guest', name: 'Sam' }, { kind: 'guest', name: 'Client' }], allocations: [{ category: t.c.meals }], explanation: 'Client launch dinner' }
  const draft = await claim(h, t.sam, 'Versioned configuration', [item])
  assert.deepEqual(draft.exceptions.map(e => [e.code, e.policy]), ['missing-receipt', 'over-limit', 'over-per-person'].map(code => [code, version.version]))
  assert.match((await h.post(`claims/${draft.claim.id}/submit`, { version: draft.claim.version }, t.sam, 409)).error, new RegExp(`Client.*policy v${version.version}`))
  await h.post('settings/categories', { id: t.c.meals, name: 'Meals', accountCode: '6300', taxCode: 'GST', limit: '200.00', perPersonLimit: '100.00' })
  await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', receiptThreshold: '200.00' })
  assert.deepEqual((await h.get(`claims/${draft.claim.id}`, t.sam)).exceptions, [])
  const submitted = await submit(h, t.sam, await h.get(`claims/${draft.claim.id}`, t.sam))
  const snapshot = (await h.get(`claims/${submitted.id}`, t.priya)).revisions[0].snapshot
  assert.ok(snapshot.policyVersion > version.version)
  await h.post('settings/categories', { id: t.c.meals, name: 'Meals', accountCode: '6300', taxCode: 'GST', limit: '20.00', perPersonLimit: '10.00', requiredFields: 'Client' })
  const kept = await h.get(`claims/${submitted.id}`, t.priya)
  assert.deepEqual(kept.exceptions, [], 'submitted checks are frozen, not recalculated from new settings')
  assert.deepEqual(kept.items[0].per_person.map(p => [p.limit_minor, p.over]), [[10000, false]], 'submitted display uses its saved policy')
  assert.deepEqual((await h.get('policy', t.morgan)).versions.find(v => v.version === version.version).configuration, version.configuration)
  // Finance cannot bypass the owner floor by supplying looser rules or forged configuration.
  await h.post('policy', { rules: [{ kind: 'per-expense-limit', category: t.c.meals, limit: '1000.00' }], configuration: { receipt_threshold_minor: 999999, categories: [] } }, t.morgan)
  const floor = await claim(h, t.sam, 'Owner floor still holds', [{ ...item, merchant: 'Another dinner' }])
  assert.ok(floor.exceptions.some(e => e.code === 'over-limit'))
  assert.match((await h.post(`claims/${floor.claim.id}/submit`, { version: floor.claim.version }, t.sam, 409)).error, /Client/)
  await h.post('settings/categories', { id: t.c.office, name: 'Hotel', accountCode: '6301', taxCode: 'GST' })
  const lodging = await claim(h, t.sam, 'Lodging receipt floor', [{ ...item, merchant: 'Low cost hotel', amount: '1.00', attendees: [], allocations: [{ category: t.c.office }] }])
  assert.equal(lodging.exceptions[0].code, 'missing-receipt')
  assert.ok(lodging.exceptions[0].policy)
  await assert.rejects(h.db.prepare('UPDATE c_policy_configurations SET configuration=? WHERE version=?').bind('{}', version.version).run(), /permanent/)
  await assert.rejects(h.db.prepare('DELETE FROM c_policy_configurations WHERE version=?').bind(version.version).run(), /permanent/)
}))

test('POLICY-001 every added rule can block submission or require an explained, acknowledged exception; approval requirements need a request or recorded override', () => withAgency(async (h, t) => {
  await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', receiptThreshold: '500.00' })
  const cases = [
    ['per-expense-limit', 'over-limit', { limit: '10.00' }],
    ['attendee-limit', 'over-per-person', { limit: '10.00' }, { attendees: [{ kind: 'guest', name: 'Sam' }, { kind: 'guest', name: 'Guest' }] }],
    ['receipt-threshold', 'missing-receipt', { limit: '10.00' }],
    ['required-field', 'missing-field', { field: 'Business purpose' }],
    ['blocked-category', 'blocked-category', {}],
    ['weekend', 'weekend-spend', {}, { date: '2026-07-04' }],
    ['holiday', 'holiday-spend', {}, { date: '2026-07-03' }], // Independence Day observed on Friday.
    ['monthly-limit', 'over-monthly-limit', { limit: '10.00' }],
    ['trip-limit', 'over-trip-limit', { limit: '10.00' }],
    ['approval-required', 'needs-pre-approval', {}],
  ]
  let trip = await h.post('requests', { title: 'Client trip', estimate: '100.00' }, t.sam)
  trip = await h.post(`requests/${trip.id}/decision`, { version: trip.version, decision: 'approved' }, t.priya)
  for (const [kind, code, inputs, changes] of cases) {
    const category = (await h.post('settings/categories', { name: kind, accountCode: '6200', taxCode: 'GST' })).id
    const rule = { kind, category, ...inputs }
    const input = { kind: 'receipt', date: '2026-06-16', merchant: kind + ' shop', amount: '30.00', allocations: [{ category }], explanation: 'Necessary client business expense', ...changes, ...(kind === 'trip-limit' ? { request: trip.id } : {}) }
    if (kind === 'required-field') {
      await h.post('policy', { rules: [{ ...rule, hard: true }] }, t.morgan)
      assert.ok((await h.get('state', t.sam)).policyFields.some(r => r.category === category && r.field === inputs.field), 'the employee form receives required field names')
    }
    const hard = (await h.post('policy', { rules: [{ ...rule, hard: true }] }, t.morgan)).versions[0]
    const draft = await claim(h, t.sam, kind, [input])
    assert.deepEqual(draft.exceptions.map(e => [e.code, e.policy, e.hard]), [[code, hard.version, true]], kind)
    assert.match((await h.post(`claims/${draft.claim.id}/submit`, { version: draft.claim.version }, t.sam, 409)).error, /hard policy rule/)
    assert.equal((await h.get(`claims/${draft.claim.id}`, t.sam)).claim.status, 'draft')
    const soft = (await h.post('policy', { rules: [{ ...rule, hard: false }] }, t.morgan)).versions[0]
    const detail = await h.get(`claims/${draft.claim.id}`, t.sam)
    assert.deepEqual(detail.exceptions.map(e => [e.code, e.policy, e.hard]), [[code, soft.version, false]], kind)
    const sent = await submit(h, t.sam, detail)
    await h.post(`claims/${sent.id}/decision`, { revision: sent.revision, version: sent.version, decision: 'approved' }, t.priya, 409)
    if (code === 'needs-pre-approval') {
      await h.post(`claims/${sent.id}/decision`, { revision: sent.revision, version: sent.version, decision: 'approved', acknowledge: true }, t.priya, 409)
      await approve(h, t.priya, sent, { acknowledge: true, override: 'Urgent client need recorded by manager' })
    } else await approve(h, t.priya, sent, { acknowledge: true })
  }
  // Approved links fulfill approval requirements, so they do not raise an exception.
  await h.post('policy', { rules: [{ kind: 'approval-required', category: t.c.travel, hard: true }] }, t.morgan)
  assert.deepEqual((await claim(h, t.sam, 'Approved trip', [{ kind: 'receipt', date: '2026-07-06', merchant: 'Flight', amount: '40.00', request: trip.id, allocations: [{ category: t.c.travel }] }])).exceptions, [])
  // Weekdays and nonholidays do not fire; observed July 3 does, while July 4 itself is the weekend rule's concern.
  await h.post('policy', { rules: [{ kind: 'weekend', hard: true }, { kind: 'holiday', hard: true }] }, t.morgan)
  assert.deepEqual((await claim(h, t.sam, 'Ordinary Monday', [{ kind: 'receipt', date: '2026-07-06', merchant: 'Monday taxi', amount: '12.00', allocations: [{ category: t.c.travel }] }])).exceptions, [])
}))

test('POLICY-001 category totals cross claims within one employee and trip or calendar period, with inclusive cents and rejected spend excluded', () => withAgency(async (h, t) => {
  await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', receiptThreshold: '500.00' })
  let trip = await h.post('requests', { title: 'Conference', estimate: '100.00' }, t.sam)
  trip = await h.post(`requests/${trip.id}/decision`, { version: trip.version, decision: 'approved' }, t.priya)
  const item = (merchant, amount, date = '2026-07-06', request = undefined) => ({ kind: 'receipt', date, merchant, amount, request, allocations: [{ category: t.c.travel }], explanation: 'Conference transport' })
  const first = await claim(h, t.sam, 'First part', [item('Bus', '40.00', '2026-07-06', trip.id)])
  const second = await claim(h, t.sam, 'Second part', [item('Train', '35.00', '2026-07-07', trip.id)])
  await claim(h, t.alex, 'Other employee', [item('Alex flight', '200.00')])
  await claim(h, t.sam, 'Other month', [item('June flight', '200.00', '2026-06-06')])
  for (const kind of ['monthly-limit', 'trip-limit']) {
    await h.post('policy', { rules: [{ kind, category: t.c.travel, limit: '75.00', hard: true }] }, t.morgan)
    assert.deepEqual((await h.get(`claims/${second.claim.id}`, t.sam)).exceptions, [], 'exactly the limit is allowed')
    await h.post('policy', { rules: [{ kind, category: t.c.travel, limit: '74.99', hard: true }] }, t.morgan)
    assert.equal((await h.get(`claims/${second.claim.id}`, t.sam)).exceptions[0].code, kind === 'trip-limit' ? 'over-trip-limit' : 'over-monthly-limit')
  }
  await h.post('policy', { rules: [] }, t.morgan)
  const sent = await submit(h, t.sam, first)
  await h.post(`claims/${sent.id}/decision`, { revision: sent.revision, version: sent.version, decision: 'rejected', reason: 'Not a business cost' }, t.priya)
  await h.post('policy', { rules: [{ kind: 'monthly-limit', category: t.c.travel, limit: '35.00', hard: true }, { kind: 'trip-limit', category: t.c.travel, limit: '35.00', hard: true }] }, t.morgan)
  assert.deepEqual((await h.get(`claims/${second.claim.id}`, t.sam)).exceptions, [], 'rejected spend no longer counts')
  const noTrip = await claim(h, t.sam, 'Trip omitted', [item('Taxi no trip', '1.00')])
  assert.ok(noTrip.exceptions.some(e => e.code === 'needs-pre-approval' && e.hard), 'omitting the trip cannot evade its limit')
  await h.post('policy', { rules: [{ kind: 'daily-limit', category: t.c.travel, limit: '35.00' }] }, t.morgan)
  const sameDay = await claim(h, t.sam, 'Same day', [item('Metro', '0.01', '2026-07-07')])
  assert.equal(sameDay.exceptions[0].code, 'over-daily-limit', 'daily category spend also crosses claim boundaries')
}))

test('POLICY-001 releasing a held expense applies the current hard rules and versioned required fields', () => withAgency(async (h, t) => {
  await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', receiptThreshold: '500.00' })
  const input = (merchant, category) => ({ kind: 'receipt', date: '2026-07-06', merchant, amount: '20.00', allocations: [{ category }] })
  const draft = await claim(h, t.sam, 'Hold the taxi', [input('Train ticket', t.c.travel), input('Taxi ticket', t.c.office)])
  const sent = await submit(h, t.sam, draft)
  await h.post(`claims/${sent.id}/decision`, { revision: sent.revision, version: sent.version, decision: 'approved', hold: [draft.items[1].id], reason: 'Need the project' }, t.priya)
  const heldId = (await h.get(`claims/${sent.id}`, t.priya)).revisions.at(-1).snapshot.split.heldClaim
  const held = (await h.get(`claims/${heldId}`, t.sam)).claim
  await h.post('policy', { rules: [{ kind: 'blocked-merchant', merchant: 'Taxi ticket', hard: true }] }, t.morgan)
  assert.match((await h.post(`claims/${held.id}/release`, { version: held.version, acknowledge: true }, t.priya, 409)).error, /hard policy rule/)
  await h.post('policy', { rules: [] }, t.morgan)
  await h.post('settings/categories', { id: t.c.office, name: 'Office supplies', accountCode: '6500', taxCode: 'GST', requiredFields: 'Project' })
  assert.match((await h.post(`claims/${held.id}/release`, { version: held.version }, t.priya, 409)).error, /Project.*policy v/)
  await h.post('settings/categories', { id: t.c.office, name: 'Office supplies', accountCode: '6500', taxCode: 'GST' })
  assert.equal((await h.post(`claims/${held.id}/release`, { version: held.version }, t.priya)).status, 'approved')
  assert.ok((await h.get(`claims/${held.id}`, t.priya)).revisions[0].snapshot.policyVersion)
}))


test('POLICY-001 upgrade captures a labelled configuration baseline without rewriting recorded exceptions or decisions', () => withAgency(async (h, t) => {
  const draft = await claim(h, t.sam, 'Legacy approved dinner', [{ kind: 'receipt', date: '2026-07-06', merchant: 'Legacy Bistro', amount: '150.00', allocations: [{ category: t.c.meals }], explanation: 'Client party' }])
  const sent = await submit(h, t.sam, draft)
  await approve(h, t.priya, sent, { acknowledge: true })
  const before = await h.get(`claims/${sent.id}`, t.priya)
  // A pre-snapshot installation has the policy table, but not the new configuration table.
  await h.db.prepare('DROP TABLE c_policy_configurations').run()
  const migration = await readFile('migrations/core/0039_policy_configuration.sql', 'utf8')
  await h.db.batch(unstable_splitSqlQuery(migration).map(sql => h.db.prepare(sql)))
  assert.ok((await h.get('policy', t.morgan)).versions.every(v => v.configuration.legacy_capture === 1))
  const after = await h.get(`claims/${sent.id}`, t.priya)
  assert.deepEqual(after.revisions, before.revisions)
  assert.deepEqual(after.decisions, before.decisions)
  assert.deepEqual(after.exceptions, before.exceptions)
}))
