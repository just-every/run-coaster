// Original operations assertions, composed as named phases without test registrations.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness, receipt } from '../harness.mjs'
import { sha, sum, claim, submit, approve, central, deactivateAccount, unzip, everywhere, withAgency } from './operations-support.mjs'

// ERASURE-001 the owner erases a departed employee's personal data and keeps their paid claims, receipts and history under an opaque subject; holds and unpaid claims refuse it
async function eraseDepartedPersonalData(h, t) {
  const SAM = 'sam@harbourfinch.example', NAME = 'Samwise Quillfeather'
  const member = { email: SAM, name: NAME, employee: true, approver: 'priya@harbourfinch.example' }
  await h.post('settings/members', member)
  // Sam's Expensify history, a paid claim with Sam's comment and Priya's reply, an agent key and a delegate.
  const csv = await readFile('tests/fixtures/expensify-report-template.csv', 'utf8'), mapping = { date: 'YYYY-MM-DD', statuses: { Reimbursed: 'reimbursed', Approved: 'approved', Open: 'open' } }
  const job = await h.post('import/commit', { csv, filename: 'expensify.csv', mapping, fingerprint: (await h.post('import/preview', { csv, filename: 'expensify.csv', mapping })).fingerprint })
  const file = async name => (await readFile(`tests/fixtures/receipts/${name}.png`)).toString('base64')
  const card = { source: 'ramp', csv: (await readFile('tests/fixtures/ramp-transactions.csv', 'utf8')).replaceAll(',USD,', ',AUD,'), filename: 'ramp.csv', mapping: { date: 'YYYY-MM-DD' }, receipts: [{ name: 'RT-1001.png', base64: await file('officeworks') }, { name: 'RT-1002.png', base64: await file('bistro') }] }
  await h.post('import/commit', { ...card, fingerprint: (await h.post('import/preview', card)).fingerprint })
  // The mileage expense reimburses under a key built from Sam's address (no receipt).
  const paid = await approve(h, t.priya, await submit(h, t.sam, await claim(h, t.sam, 'Client visit', [{ kind: 'receipt', date: '2026-05-04', merchant: 'Hotel Ibis', amount: '180.00', allocations: [{ category: t.c.travel }], receiptFixture: 'hotel' }, { kind: 'mileage', date: '2026-05-04', merchant: 'Airport run', distance: '56', allocations: [{ category: t.c.car }] }])))
  const said = await h.post(`claims/${paid.id}/comments`, { body: 'Folio attached, two nights at the Ibis' }, t.sam)
  await h.post(`claims/${paid.id}/comments`, { body: 'Thanks, approved', parent: said.comment }, t.priya)
  let batch = await h.post('batches', { claims: [paid.id] }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 22928 }, t.jordan)
  await h.paid(batch.id, batch.version, { reference: 'ACH-0510', paidOn: '2026-05-10' }, t.jordan)
  // Sam's agent forwards a receipt, uploaded "Sam receipts agent for" Sam's address.
  const key = await h.post('agent-keys', { label: 'Sam receipts agent' }, t.sam)
  assert.equal((await h.send('/api/coaster/agent/claims', { title: 'Forwarded receipt', items: [{ kind: 'receipt', date: '2026-05-09', merchant: 'Officeworks', amount: '18.00', allocations: [{ category: t.c.office }], receipt: { name: 'officeworks.png', base64: (await readFile('tests/fixtures/receipts/officeworks.png')).toString('base64') } }] }, '', { authorization: `Bearer ${key.token}` })).status, 200)
  await h.post('delegates', { delegate: 'alex@harbourfinch.example', level: 'submit' }, t.sam)
  const open = await submit(h, t.sam, await claim(h, t.sam, 'Taxi', [{ kind: 'receipt', date: '2026-05-06', merchant: 'Uber', amount: '20.10', allocations: [{ category: t.c.travel }], receiptFixture: 'uber' }]))

  // Only the owner erases, only a deactivated person, never one with an unpaid claim or under a legal hold.
  await h.post('settings/members/erase', { email: SAM }, t.jordan, 403)
  assert.match((await h.post('settings/members/erase', { email: SAM }, h.owner, 409)).error, /Deactivate Samwise Quillfeather/)
  await h.post('settings/members', { ...member, active: false })
  assert.match((await h.post('settings/members/erase', { email: SAM }, h.owner, 409)).error, new RegExp(`unpaid claims \\(CL-${String(open.number).padStart(4, '0')}\\)`))
  const rejected = await h.post(`claims/${open.id}/decision`, { revision: open.revision, version: open.version, decision: 'rejected', reason: 'Personal trip' }, t.priya)
  const hold = (await h.post('legal-holds', { scope: 'person', member: SAM, reason: 'Wage claim' })).holds[0]
  assert.match((await h.post('settings/members/erase', { email: SAM }, h.owner, 409)).error, /legal hold covers Samwise Quillfeather \(Wage claim\)/)
  await h.post(`legal-holds/${hold.id}/release`, {})

  assert.ok((await everywhere(h.db)).filter(v => v.includes(SAM) || v.includes(NAME)).length > 20, 'their name and address are spread through the records before')
  const receipt = await h.post('settings/members/erase', { email: SAM })
  const { subject } = receipt.retained
  assert.match(receipt.label, /^Former member [0-9a-f]{8}$/); assert.equal(subject, 'former-member-' + receipt.label.slice(-8))
  assert.equal(receipt.erasedBy, 'owner@harbourfinch.example')
  assert.deepEqual(receipt.removed, { name: true, email: true, signInAccount: true, personalPlaidConnections: 0, plaidLinkRequests: 0, agentKeys: 1, delegations: 1, approverAssignments: 0, comments: 1, reminders: 0, discardReasons: 0, bankAccounts: 0 })
  assert.deepEqual(receipt.retained.claims.map(c => [c.claim, c.status, c.totalMinor]), [[`CL-${String(paid.number).padStart(4, '0')}`, 'reimbursed', 22928], [`CL-${String(rejected.number).padStart(4, '0')}`, 'rejected', 2010]])
  const hotel = sha(await readFile('tests/fixtures/receipts/hotel.png'))
  assert.deepEqual(receipt.retained.receiptSha256, [hotel, sha(await readFile('tests/fixtures/receipts/uber.png'))].sort())
  assert.deepEqual((await h.get('retention')).erasures, [receipt], 'the receipt stays with the owner')

  // Their name and address are nowhere in the database: claims, history, snapshots, imported history, sign-in account.
  const rows = await everywhere(h.db)
  assert.deepEqual(rows.filter(v => v.includes(SAM) || v.includes(NAME)), [])
  assert.equal((await h.send('/api/coaster/state', undefined, t.sam)).status, 401, 'their sign-in is gone')
  // Amounts and receipt hashes stay under the opaque subject.
  const kept = await h.get(`claims/${paid.id}`)
  assert.deepEqual([kept.claim.employee_email, kept.claim.status, kept.claim.total_minor], [subject, 'reimbursed', 22928])
  assert.equal(sha(Buffer.from(await (await h.mf.dispatchFetch(`${h.origin}/api/coaster/receipts/${kept.items[0].receipt_id}`, { headers: { cookie: h.owner } })).arrayBuffer())), hotel, 'the receipt bytes stay')
  assert.deepEqual(kept.comments.map(c => [c.author_email, c.body, c.parent_id]), [['priya@harbourfinch.example', 'Thanks, approved', null]], 'their own comment is removed; the reply stays')
  assert.ok((await h.get(`history?q=CL-${String(paid.number).padStart(4, '0')}`)).lines.some(l => l.action === 'claim-submitted' && l.actor_email === subject))
  const state = await h.get('state')
  assert.ok(state.members.some(m => m.email === subject && m.name === receipt.label && m.active === 0))
  const imported = (await h.get('import')).history.find(r => r.id === 'expensify:report:R00A1')
  assert.deepEqual([imported.employee, imported.totalMinor], [undefined, 41200 + 1840 + 4928], 'imported history keeps its amounts without the person')
  const charge = (await h.get('import')).history.find(r => r.id === 'ramp:expense:RT-1002')
  assert.deepEqual([charge.employee, charge.amountMinor, charge.merchant, charge.receipt.sha256], [undefined, 15000, 'Harbour View Bistro', sha(await readFile('tests/fixtures/receipts/bistro.png'))], 'an imported card charge keeps its amount and receipt hash without the person')
  const originals = (await h.post('import/status', { id: job.job.id, mappingVersion: job.mappingVersion })).originals
  assert.ok(JSON.stringify(originals).includes('unavailable-after-erasure'), 'the original Expensify file naming them is withdrawn')
  await h.post('settings/members/erase', { email: SAM }, h.owner, 404)
}

export async function preserveFinancialErasure() {
  await withAgency(eraseDepartedPersonalData)
}
