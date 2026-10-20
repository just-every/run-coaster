// AGENT-005 advisory slice: real native sessions, Worker and D1 public doors.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { agency, harness, receipt } from './harness.mjs'

test('AGENT-005 submission freezes cited per-expense recommendations without granting approval authority or widening claim visibility', async () => {
  const h = await harness()
  try {
    const t = await agency(h)
    await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'USD', timezone: 'America/New_York', receiptThreshold: '75.00' })
    const policyVersion = (await h.get('policy', t.morgan)).versions[0].version
    const stranger = await h.person('unrelated-manager@harbourfinch.example', { employee: true, manager: true })
    const auditor = await h.person('audit@harbourfinch.example', { auditor: true })
    let c = await h.post('claims', { title: 'Lunch and dinner policy review' }, t.sam)
    const expected = []
    for (const [merchant, amount, fixture] of [['Lunch', '60.00', 'officeworks'], ['Dinner', '180.00', 'bistro']]) {
      const file = await receipt(fixture)
      const upload = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...file }, t.sam)
      c = await h.post(`claims/${c.id}/items`, {
        version: upload.claim.version, kind: 'receipt', date: '2026-06-16', merchant, amount,
        receipt: upload.receipt, allocations: [{ category: t.c.meals }], explanation: 'Client meeting meal',
      }, t.sam)
      expected.push({ receipt: { id: upload.receipt, sha256: createHash('sha256').update(Buffer.from(file.base64, 'base64')).digest('hex') }, amountMinor: Number(amount) * 100 })
    }
    const networkBefore = h.outbound.length
    c = await h.post(`claims/${c.id}/submit`, { version: c.version }, t.sam)
    assert.equal(c.status, 'submitted', 'recommendations grant no automatic approval')
    let detail = await h.get(`claims/${c.id}`, t.priya)
    const original = detail.revisions[0].snapshot.policyReview
    assert.equal(original.method, 'deterministic-policy-review')
    assert.equal(original.policyVersion, policyVersion)
    assert.equal(original.recommendations.length, 2)
    assert.deepEqual(original.recommendations.map(r => r.recommendation), ['no-policy-exception', 'review'])
    const [lunch, dinner] = original.recommendations
    assert.ok(lunch.reasons.some(r => r.code === 'no-policy-exception' && r.policy === policyVersion && /advice grants no approval/i.test(r.message)))
    assert.deepEqual(dinner.reasons, detail.exceptions.filter(e => e.item === dinner.item).map(({ code, message, policy }) => ({ code, message, ...(policy === undefined ? {} : { policy }) })))
    assert.ok(dinner.reasons.some(r => r.code === 'over-limit' && r.policy === policyVersion))
    for (const [index, review] of original.recommendations.entries()) {
      assert.equal(review.item, detail.items[index].id)
      assert.deepEqual(review.evidence.receipt, expected[index].receipt)
      assert.equal(review.evidence.amountMinor, expected[index].amountMinor)
      assert.equal(review.evidence.date, '2026-06-16')
      assert.deepEqual(review.evidence.allocations, [{ category: t.c.meals, amountMinor: expected[index].amountMinor }])
      assert.equal(review.evidence.requestId, null)
      assert.deepEqual(review.evidence.checksUnavailable, ['receipt-content', 'card-match', 'coding-confidence'])
    }
    assert.equal(detail.decisions.length, 0)
    for (const cookie of [t.sam, t.morgan, auditor, h.owner]) {
      assert.deepEqual((await h.get(`claims/${c.id}`, cookie)).revisions[0].snapshot.policyReview, original)
    }
    await h.get(`claims/${c.id}`, t.alex, 403)
    await h.get(`claims/${c.id}`, stranger, 403)
    const key = await h.post('agent-keys', { label: 'Personal drafting agent' }, t.sam)
    const headers = { authorization: `Bearer ${key.token}` }
    assert.equal((await h.send(`/api/coaster/claims/${c.id}`, undefined, '', headers)).status, 401)
    assert.equal((await h.send(`/api/coaster/claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved' }, '', headers)).status, 401)
    await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved' }, t.priya, 409)
    c = await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'returned', reason: 'Please check the dinner details' }, t.priya)
    await h.post('settings/categories', { id: t.c.meals, name: 'Meals', accountCode: '6300', taxCode: 'GST', limit: '250.00' })
    c = await h.post(`claims/${c.id}/submit`, { version: c.version }, t.sam)
    detail = await h.get(`claims/${c.id}`, t.priya)
    assert.deepEqual(detail.revisions[0].snapshot.policyReview, original, 'return and resubmission never rewrite old evidence')
    const latest = detail.revisions.at(-1).snapshot.policyReview
    assert.ok(latest.policyVersion > policyVersion)
    assert.deepEqual(latest.recommendations.map(r => r.recommendation), ['no-policy-exception', 'no-policy-exception'])
    assert.equal(detail.claim.status, 'submitted')
    const approved = await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved', hold: [dinner.item], reason: 'Confirm dinner evidence' }, t.priya)
    const kept = await h.get(`claims/${c.id}`, t.priya)
    assert.deepEqual(kept.revisions.at(-1).snapshot.policyReview.recommendations.map(r => r.item), [lunch.item], 'partial approval carries only retained-expense advice')
    assert.deepEqual(kept.revisions[0].snapshot.policyReview, original)
    const held = await h.get(`claims/${kept.events.find(e => e.action === 'claim-split').detail.heldClaim}`, t.sam)
    const released = await h.post(`claims/${held.claim.id}/release`, { version: held.claim.version }, t.priya)
    const releasedReview = (await h.get(`claims/${released.id}`, t.priya)).revisions[0].snapshot.policyReview
    assert.deepEqual(releasedReview.recommendations.map(r => r.item), [dinner.item], 'hold release records current-policy advice for the held expense')
    assert.equal(approved.status, 'approved'); assert.equal(released.status, 'approved')
    assert.equal(h.outbound.length, networkBefore, 'review and decisions make no external requests')
  } finally { await h.close() }
})
