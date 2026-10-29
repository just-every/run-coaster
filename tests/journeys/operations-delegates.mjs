// Original operations assertions, composed as named phases without test registrations.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness, receipt } from '../harness.mjs'
import { sha, sum, claim, submit, approve, central, deactivateAccount, unzip, everywhere, withAgency } from './operations-support.mjs'

// ADMIN-005 a delegate prepares and submits in someone else's name on their behalf, never approves their own or that person's claims, and stops the moment access ends
async function prepareAndDecideAsDelegate(h, t) {
  await h.post('settings/members', { email: 'priya@harbourfinch.example', name: 'priya', employee: true, manager: true, approver: 'jordan@harbourfinch.example' })
  const casey = await h.person('casey@harbourfinch.example', { employee: true }, 'priya@harbourfinch.example')
  const PRIYA = 'priya@harbourfinch.example', CASEY = 'casey@harbourfinch.example'
  const grant = await h.post('delegates', { delegate: CASEY, level: 'submit' }, t.priya)
  assert.equal(grant.notified, 'accepted')
  const notice = h.messages.findLast(m => m.to.includes(PRIYA))
  assert.match(notice.subject, /casey can now act for you/); assert.match(notice.text, /Submit only delegate access/)
  const forPriya = (path, body, status = 200) => h.send('/api/coaster/' + path, body, casey, { 'x-coaster-acting-for': PRIYA }).then(r => { assert.equal(r.status, status, `${path}: ${JSON.stringify(r.value)}`); return r.value })
  assert.deepEqual((await forPriya('state')).actor.delegate, { email: CASEY, name: 'casey', level: 'submit', grant: grant.id })

  let c = await forPriya('claims', { title: 'Board week' })
  assert.equal(c.employee_email, PRIYA, 'the claim is in the executive\'s name')
  for (const [fixture, merchant, amount, category] of [['bistro', 'Harbour View Bistro', '64.50', t.c.meals], ['uber', 'Uber', '38.60', t.c.travel], ['officeworks', 'Officeworks', '64.95', t.c.office]]) {
    const r = await forPriya(`claims/${c.id}/receipts`, { version: c.version, ...(await receipt(fixture)) })
    c = await forPriya(`claims/${c.id}/items`, { version: r.claim.version, kind: 'receipt', date: '2026-05-12', merchant, amount, receipt: r.receipt, allocations: [{ category }] })
  }
  c = await forPriya(`claims/${c.id}/submit`, { version: c.version })
  assert.deepEqual([c.status, c.approver_email], ['submitted', 'jordan@harbourfinch.example'])
  const mine = await h.get(`claims/${c.id}`, t.priya)
  assert.ok(mine.receipts.length === 3 && mine.receipts.every(r => r.uploaded_by === CASEY))
  assert.equal(mine.revisions[0].submitted_by, CASEY)
  const submitted = mine.events.find(e => e.action === 'claim-submitted')
  assert.deepEqual([submitted.actor_email, submitted.detail.actingFor], [CASEY, PRIYA], 'history: submitted by the assistant on behalf of the executive')
  assert.equal((await h.send(`/api/coaster/claims/${c.id}`, undefined, casey)).status, 403, 'without acting for her, the assistant is just an employee')

  const sams = await submit(h, t.sam, await claim(h, t.sam, 'Client lunch', [{ kind: 'receipt', date: '2026-05-13', merchant: 'Rockpool', amount: '48.00', allocations: [{ category: t.c.meals }], receiptFixture: 'hotel' }]))
  const caseys = await submit(h, casey, await claim(h, casey, 'Own taxi', [{ kind: 'receipt', date: '2026-05-13', merchant: 'Taxi', amount: '22.00', allocations: [{ category: t.c.travel }], explanation: 'Cash taxi, no receipt given' }]))
  await forPriya(`claims/${sams.id}/decision`, { revision: sams.revision, version: sams.version, decision: 'approved' }, 403)
  for (const [path, body] of [['agent-keys', { label: 'Her agent' }], ['delegates', { delegate: 'alex@harbourfinch.example', level: 'full' }], ['delegations', { delegate: 'jordan@harbourfinch.example', startsOn: '2026-05-01', endsOn: '2026-05-31' }], ['settings/business', { name: 'Taken', currency: 'AUD', timezone: 'Australia/Sydney' }]])
    await forPriya(path, body, 403)

  const full = await h.post('delegates', { delegate: CASEY, level: 'full' }, t.priya)
  assert.equal((await h.get('state', t.priya)).delegates.filter(g => g.delegate_email === CASEY).map(g => g.level).join(), 'full', 'the new level replaces the old grant')
  await forPriya(`claims/${caseys.id}/decision`, { revision: caseys.revision, version: caseys.version, decision: 'approved' }, 403)
  await forPriya(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved' }, 403)
  const approved = await forPriya(`claims/${sams.id}/decision`, { revision: sams.revision, version: sams.version, decision: 'approved' })
  const decided = await h.get(`claims/${sams.id}`, t.sam)
  assert.deepEqual([approved.status, decided.decisions[0].actor_email, decided.decisions[0].on_behalf_of], ['approved', CASEY, PRIYA])
  assert.equal(decided.events.find(e => e.action === 'claim-approved').detail.actingFor, PRIYA)
  const board = await approve(h, t.jordan, await h.get(`claims/${c.id}`, t.jordan).then(x => x.claim))
  let batch = await h.post('batches', { claims: [sams.id, board.id] }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: batch.total_minor }, t.jordan)
  const ledger = (await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`, undefined, t.jordan)).text
  assert.match(ledger, /"approved by casey@harbourfinch\.example on behalf of priya@harbourfinch\.example"/)
  assert.match(ledger, /"submitted by casey@harbourfinch\.example on behalf of priya@harbourfinch\.example"/)

  const count = async () => (await h.db.prepare('SELECT (SELECT COUNT(*) FROM c_events) + (SELECT COUNT(*) FROM c_claims) AS n').first()).n
  await h.post(`delegates/${full.id}/revoke`, {}, t.priya)
  const before = await count()
  await forPriya('claims', { title: 'After revoke' }, 403)
  await forPriya('state', undefined, 403)
  assert.equal(await count(), before, 'refused with no write')

  await h.post('delegates', { grantor: 'alex@harbourfinch.example', delegate: 'morgan@harbourfinch.example', level: 'submit' }, t.sam, 403)
  const byOwner = await h.post('delegates', { grantor: 'sam@harbourfinch.example', delegate: 'alex@harbourfinch.example', level: 'submit' })
  assert.match(h.messages.findLast(m => m.to.includes('sam@harbourfinch.example')).text, /Rose Owner gave alex/)
  const forSam = { 'x-coaster-acting-for': 'sam@harbourfinch.example' }
  assert.equal((await h.send('/api/coaster/state', undefined, t.alex, forSam)).status, 200)
  await h.post(`delegates/${byOwner.id}/revoke`, {})
  assert.equal((await h.send('/api/coaster/state', undefined, t.alex, forSam)).status, 403, 'the owner revokes for anyone')
  await h.post('delegates', { grantor: 'sam@harbourfinch.example', delegate: 'alex@harbourfinch.example', level: 'full' })
  assert.equal((await h.send('/api/coaster/state', undefined, t.alex, forSam)).status, 200)
  await h.post('settings/members', { email: 'sam@harbourfinch.example', name: 'sam', employee: true, active: false })
  assert.equal((await h.send('/api/coaster/state', undefined, t.alex, forSam)).status, 403, 'deactivating the granting person ends the access')

  await h.post('settings/members', { email: 'owner@harbourfinch.example', name: 'Rose Owner', employee: true })
  await h.post('delegates', { delegate: 'jordan@harbourfinch.example', level: 'full' })
  const forOwner = (path, body) => h.send('/api/coaster/' + path, body, t.jordan, { 'x-coaster-acting-for': 'owner@harbourfinch.example' }).then(r => r.status)
  assert.equal(await forOwner('settings/categories', { name: 'Gifts', accountCode: '6600', taxCode: 'GST' }), 200, 'a Full delegate has the whole row of the person they act for')
  assert.deepEqual([await forOwner('delegates', { delegate: 'alex@harbourfinch.example', level: 'full' }), await forOwner('agent-keys', { label: 'Owner agent' })], [403, 403], 'but never their delegates or keys')
}

// ADMIN-005 a Full delegate of a finance member is refused once that member's sign-in account is deactivated
async function revokeInactivePrincipalAccess(h, t) {
  const MORGAN = 'morgan@harbourfinch.example'
  const taxi = await approve(h, t.priya, await submit(h, t.sam, await claim(h, t.sam, 'Client taxi', [{ kind: 'receipt', date: '2026-05-13', merchant: 'Taxi', amount: '22.00', allocations: [{ category: t.c.travel }], receiptFixture: 'uber' }])))
  const batch = await h.post('batches', { claims: [taxi.id] }, t.jordan)
  await h.post('delegates', { delegate: 'alex@harbourfinch.example', level: 'full' }, t.morgan)
  const forMorgan = (path, body) => h.send('/api/coaster/' + path, body, t.alex, { 'x-coaster-acting-for': MORGAN }).then(r => r.status)
  assert.equal(await forMorgan('reports/aging'), 200, 'the delegate reads reports in the finance member\'s row')
  await deactivateAccount(h, MORGAN)
  assert.deepEqual([await forMorgan('reports/aging'), await forMorgan(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: batch.total_minor })], [403, 403], 'a deactivated sign-in account ends the access its delegates hold')
  assert.equal((await h.get(`batches/${batch.id}`, t.jordan)).batch.status, 'draft', 'refused with no write')
}

export async function preserveDelegateOperations() {
  await withAgency(prepareAndDecideAsDelegate)
  await withAgency(revokeInactivePrincipalAccess)
}
