import { preservePolicy } from './journeys/specialized-policy.mjs'
// POLICY-001 public API journeys with native sessions and real D1/workerd.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness } from './harness.mjs'

async function withAgency(run) { const h = await harness(); try { await run(h, await agency(h)) } finally { await h.close() } }
async function claim(h, cookie, title, items) {
  let c = await h.post('claims', { title }, cookie)
  for (const item of items) c = await h.post(`claims/${c.id}/items`, { version: c.version, ...item }, cookie)
  return h.get(`claims/${c.id}`, cookie)
}
const submit = (h, cookie, d) => h.post(`claims/${d.claim.id}/submit`, { version: d.claim.version }, cookie)
const approve = (h, cookie, c, extra = {}) => h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved', ...extra }, cookie)

test('POLICY-001 finance publishes versioned rules: a soft daily meal limit, a hard blocked merchant and a hard 90-day deadline fire naming their version, and a later version leaves older claims on theirs', async () => {
  await preservePolicy()
  await (() => withAgency(async (h, t) => {
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
}))()
})