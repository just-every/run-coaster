// One business-flow test per CONTRACT.md clause, through the public HTTP API
// with real native sessions, workerd and D1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { agency, harness, receipt } from './harness.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sum = (csv, column) => { const [head, ...rows] = csv.trim().split('\r\n').map(r => r.split('","').map(x => x.replace(/^"|"$/g, ''))); const i = head.indexOf(column); return Math.round(rows.reduce((n, r) => n + Number(r[i]) * 100, 0)) }

async function withAgency(run) {
  const h = await harness()
  try { await run(h, await agency(h)) } finally { await h.close() }
}
/** A claim with expenses; each expense may carry a receipt fixture. Returns the claim detail. */
async function claim(h, cookie, title, items) {
  let c = await h.post('claims', { title }, cookie)
  for (const item of items) {
    let receiptId
    if (item.receiptFixture) { const r = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...(await receipt(item.receiptFixture)) }, cookie); c = r.claim; receiptId = r.receipt }
    c = await h.post(`claims/${c.id}/items`, { version: c.version, receipt: receiptId, ...item, receiptFixture: undefined }, cookie)
  }
  return h.get(`claims/${c.id}`, cookie)
}
const submit = (h, cookie, d) => h.post(`claims/${d.claim.id}/submit`, { version: d.claim.version }, cookie)
const approve = async (h, cookie, c, extra = {}) => h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved', ...extra }, cookie)

test('COA-001 the owner sets up the business, categories and people; nobody else can', () => withAgency(async (h, t) => {
  const state = await h.get('state')
  assert.equal(state.business.currency, 'AUD')
  assert.deepEqual(state.business.mileage_rates, [{ effective_from: '2026-01-01', rate_thousandths: 880 }], 'a non-USD business starts with no IRS table and adds its own rate')
  assert.deepEqual(state.categories.map(c => c.name), ['Car', 'Meals', 'Office supplies', 'Travel'])
  assert.equal(state.members.find(m => m.email === 'sam@harbourfinch.example').approver_email, 'priya@harbourfinch.example')
  await h.post('settings/business', { name: 'Taken over', currency: 'AUD', timezone: 'Australia/Sydney', mileageRate: '1.00' }, t.morgan, 403)
  await h.post('settings/members', { email: 'sam@harbourfinch.example', name: 'Sam', employee: true, finance: true }, t.sam, 403)
  await h.post('settings/mileage-rates', { effectiveFrom: '2026-01-01', rate: '2.00' }, t.jordan, 403)
  assert.equal((await h.get('state')).business.mileage_rates[0].rate_thousandths, 880, 'refused writes changed nothing')
  await h.post('settings/members', { email: 'self@harbourfinch.example', name: 'Self', employee: true, approver: 'self@harbourfinch.example' }, h.owner, 400)
  await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'AUDX', timezone: 'Australia/Sydney', mileageRate: '0.88' }, h.owner, 400)
  await claim(h, t.sam, 'First', [])
  await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'NZD', timezone: 'Pacific/Auckland', mileageRate: '0.88' }, h.owner, 409)
}))

test('COA-002 an employee captures receipt, mileage and per diem expenses with receipt provenance', () => withAgency(async (h, t) => {
  const d = await claim(h, t.sam, 'Sydney client workshop', [
    { kind: 'receipt', date: '2026-04-29', merchant: 'Harbour View Bistro', amount: '64.50', allocations: [{ category: t.c.meals }], receiptFixture: 'bistro' },
    { kind: 'mileage', date: '2026-04-28', merchant: 'Studio to client', distance: '142.5', allocations: [{ category: t.c.car }] },
    { kind: 'per_diem', date: '2026-04-29', days: 2, allocations: [{ category: t.c.travel }] },
  ])
  assert.deepEqual(d.items.map(i => i.amount_minor), [6450, 12540, 15000])
  assert.equal(d.claim.total_minor, 6450 + 12540 + 15000)
  const bytes = await readFile('tests/fixtures/receipts/bistro.png'), r = d.receipts[0]
  assert.equal(r.sha256, sha(bytes)); assert.equal(r.size, bytes.length); assert.equal(r.uploaded_by, 'sam@harbourfinch.example'); assert.equal(r.media_type, 'image/png')
  const download = await h.send(`/api/coaster/receipts/${r.id}`, undefined, t.sam)
  assert.equal(download.status, 200)
  assert.equal(sha(Buffer.from(await (await h.mf.dispatchFetch(`${h.origin}/api/coaster/receipts/${r.id}`, { headers: { cookie: t.sam } })).arrayBuffer())), sha(bytes))
  const c = d.claim
  for (const bad of [{ date: '2026-02-30' }, { amount: '-4.00' }, { amount: '12.345' }, { kind: 'teleport' }, { allocations: [{ category: 'missing' }] }])
    await h.post(`claims/${c.id}/items`, { version: c.version, kind: 'receipt', date: '2026-04-29', merchant: 'X', amount: '1.00', allocations: [{ category: t.c.meals }], ...bad }, t.sam, 400)
  await h.post(`claims/${c.id}/receipts`, { version: c.version, name: 'not-a-receipt.pdf', base64: Buffer.from('<script>alert(1)</script>').toString('base64') }, t.sam, 400)
  assert.equal((await h.get(`claims/${c.id}`, t.sam)).items.length, 3, 'refused input changed nothing')
}))

test('COA-003 one expense splits across categories and cost centres, adding up exactly', () => withAgency(async (h, t) => {
  let c = await h.post('claims', { title: 'Team offsite' }, t.sam)
  const split = [{ category: t.c.meals, costCentre: 'Studio', amount: '60.00' }, { category: t.c.travel, costCentre: 'Client: Lyra', amount: '40.00' }]
  await h.post(`claims/${c.id}/items`, { version: c.version, kind: 'receipt', date: '2026-05-01', merchant: 'Bay Ferry', amount: '100.00', allocations: [split[0], { ...split[1], amount: '39.99' }] }, t.sam, 400)
  c = await h.post(`claims/${c.id}/items`, { version: c.version, kind: 'receipt', date: '2026-05-01', merchant: 'Bay Ferry', amount: '100.00', allocations: split, explanation: 'Receipt lost at sea' }, t.sam)
  const d = await h.get(`claims/${c.id}`, t.sam)
  assert.deepEqual(d.items[0].allocations.map(a => [a.category_name, a.cost_centre, a.amount_minor]), [['Meals', 'Studio', 6000], ['Travel', 'Client: Lyra', 4000]])
  c = await submit(h, t.sam, d); c = await approve(h, t.priya, c, { acknowledge: true })
  const batch = await h.post('batches', { claims: [c.id] }, t.morgan)
  await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 10000 }, t.morgan)
  const csv = (await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`, undefined, t.morgan)).text
  assert.match(csv, /"Meals","6300","GST","Studio","60.00"/); assert.match(csv, /"Travel","6200","GST","Client: Lyra","40.00"/)
}))

test('COA-004 policy exceptions need an explanation and stay visible to the manager, the batch and the export', () => withAgency(async (h, t) => {
  const d = await claim(h, t.sam, 'Client dinner', [
    { kind: 'receipt', date: '2026-05-02', merchant: 'Rockpool', amount: '180.00', allocations: [{ category: t.c.meals }], receiptFixture: 'hotel' },
    { kind: 'receipt', date: '2026-05-02', merchant: 'Taxi', amount: '22.00', allocations: [{ category: t.c.travel }] },
  ])
  assert.deepEqual(d.exceptions.map(e => e.code).sort(), ['missing-receipt', 'over-limit'])
  await h.post(`claims/${d.claim.id}/submit`, { version: d.claim.version }, t.sam, 409)
  let c = d.claim
  for (const item of d.items) c = await h.post(`claims/${c.id}/items`, { version: c.version, item: item.id, kind: 'receipt', date: item.spent_on, merchant: item.merchant, amount: (item.amount_minor / 100).toFixed(2), receipt: item.receipt_id, allocations: [{ category: item.allocations[0].category_id }], explanation: item.merchant === 'Taxi' ? 'Cash taxi, driver had no receipts' : 'Client of four; approved in advance' }, t.sam)
  c = await h.post(`claims/${c.id}/submit`, { version: c.version }, t.sam)
  const seen = await h.get(`claims/${c.id}`, t.priya)
  assert.equal(seen.exceptions.length, 2)
  assert.ok(seen.items.every(i => i.explanation))
  await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved' }, t.priya, 409)
  c = await approve(h, t.priya, c, { acknowledge: true })
  assert.equal((await h.get(`claims/${c.id}`, t.priya)).decisions[0].exceptions.length, 2)
  const batch = await h.post('batches', { claims: [c.id] }, t.morgan)
  const detail = await h.get(`batches/${batch.id}`, t.morgan)
  assert.deepEqual(detail.lines.map(l => l.exceptions).sort(), ['missing-receipt', 'over-limit'])
  await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 20200 }, t.morgan)
  const csv = (await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`, undefined, t.morgan)).text
  assert.match(csv, /"over-limit","Client of four; approved in advance"/); assert.match(csv, /"missing-receipt","Cash taxi, driver had no receipts"/)
  const split = await claim(h, t.sam, 'Split dinner', [{ kind: 'receipt', date: '2026-05-05', merchant: 'Rockpool', amount: '180.00', allocations: [{ category: t.c.meals, amount: '90.00' }, { category: t.c.meals, amount: '90.00' }], receiptFixture: 'bistro' }])
  assert.deepEqual(split.exceptions.map(e => e.message), ['Over the Meals limit of AUD 120.00'], 'splitting one expense within a category never slips under its limit')
  await submit(h, t.sam, split).catch(() => {})
  assert.equal((await h.get(`claims/${split.claim.id}`, t.sam)).claim.status, 'draft', 'the over-limit split still needs an explanation')
  const lunches = await claim(h, t.sam, 'Two lunches', [
    { kind: 'receipt', date: '2026-05-06', merchant: 'Rockpool', amount: '45.00', allocations: [{ category: t.c.meals }], receiptFixture: 'uber' },
    { kind: 'receipt', date: '2026-05-06', merchant: ' rockpool ', amount: '45.00', allocations: [{ category: t.c.meals }], receiptFixture: 'officeworks' },
  ])
  assert.deepEqual(lunches.exceptions.map(e => [e.code, e.message]), [0, 1].map(() => ['possible-duplicate', 'Same date, merchant and amount as another expense in this claim']), 'distinct receipts with the same date, merchant and amount on one claim are flagged')
  await submit(h, t.sam, lunches).catch(() => {})
  assert.equal((await h.get(`claims/${lunches.claim.id}`, t.sam)).claim.status, 'draft', 'the possible duplicates need explanations')
  let l = lunches.claim
  for (const item of lunches.items) l = await h.post(`claims/${l.id}/items`, { version: l.version, item: item.id, kind: 'receipt', date: item.spent_on, merchant: item.merchant, amount: '45.00', receipt: item.receipt_id, allocations: [{ category: t.c.meals }], explanation: 'Two separate client lunches that day' }, t.sam)
  assert.equal((await h.post(`claims/${l.id}/submit`, { version: l.version }, t.sam)).status, 'submitted', 'a possible duplicate is explained, not blocked')
}))

test('COA-005 an exact duplicate expense can never be reimbursed twice', () => withAgency(async (h, t) => {
  const make = async (who, title) => { const d = await claim(h, who, title, [{ kind: 'receipt', date: '2026-05-03', merchant: 'Officeworks', amount: '64.95', allocations: [{ category: t.c.office }], receiptFixture: 'officeworks', explanation: 'Printer paper' }]); return d }
  const first = await make(t.sam, 'Supplies'), second = await make(t.alex, 'Supplies again')
  assert.ok(second.exceptions.some(e => e.code === 'duplicate-receipt'), 'the second identical receipt is flagged before submission')
  let a = await approve(h, t.priya, await submit(h, t.sam, first), { acknowledge: true }), b = await approve(h, t.priya, await submit(h, t.alex, second), { acknowledge: true })
  const both = await h.send('/api/coaster/batches', { claims: [a.id, b.id] }, t.morgan)
  assert.equal(both.status, 409); assert.match(both.value.error, /same exact expense/)
  const batch = await h.post('batches', { claims: [a.id] }, t.morgan)
  const again = await h.send('/api/coaster/batches', { claims: [b.id] }, t.morgan)
  assert.equal(again.status, 409); assert.match(again.value.error, /already reimbursed/)
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_reimbursement_keys').first()).n, 1)
  await assert.rejects(h.db.prepare("INSERT INTO c_reimbursement_keys(key,batch_id,claim_id,item_id) SELECT key,batch_id,?,'x' FROM c_reimbursement_keys").bind(b.id).run(), /UNIQUE/)
  await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 6495 }, t.morgan)
  assert.equal((await h.get(`claims/${b.id}`, t.alex)).claim.status, 'approved', 'the duplicate stays visible and unpaid')
  const cab = { kind: 'receipt', date: '2026-06-05', merchant: 'Cab', amount: '22.00', allocations: [{ category: t.c.travel }], explanation: 'Driver had no receipts' }
  const twice = await claim(h, t.sam, 'Out and back', [cab, cab])
  assert.equal(twice.exceptions.filter(e => e.code === 'possible-duplicate').length, 2, 'the same expense twice in one claim is flagged before submission')
  const refused = await h.send(`/api/coaster/claims/${twice.claim.id}/submit`, { version: twice.claim.version }, t.sam)
  assert.equal(refused.status, 409); assert.match(refused.value.error, /only one could be reimbursed/)
  const fixed = await h.post(`claims/${twice.claim.id}/items`, { version: twice.claim.version, item: twice.items[1].id, ...cab, merchant: 'Cab back to the studio' }, t.sam)
  const paid = await approve(h, t.priya, await h.post(`claims/${fixed.id}/submit`, { version: fixed.version }, t.sam), { acknowledge: true })
  assert.equal((await h.post('batches', { claims: [paid.id] }, t.morgan)).total_minor, 4400, 'once corrected, the claim batches whole')
}))

test('COA-006 only the assigned manager decides the exact submitted revision, never their own', () => withAgency(async (h, t) => {
  const d = await claim(h, t.sam, 'Workshop', [{ kind: 'receipt', date: '2026-05-04', merchant: 'Uber', amount: '38.60', allocations: [{ category: t.c.travel }], receiptFixture: 'uber' }])
  let c = await submit(h, t.sam, d)
  assert.equal(c.approver_email, 'priya@harbourfinch.example')
  await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved' }, t.jordan, 403)
  await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved' }, t.sam, 403)
  await h.post(`claims/${c.id}/decision`, { revision: c.revision - 1, version: c.version, decision: 'approved' }, t.priya, 409)
  await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'returned', reason: '' }, t.priya, 400)
  c = await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'rejected', reason: 'Personal travel' }, t.priya)
  assert.equal(c.status, 'rejected')
  const own = await claim(h, t.priya, 'Own claim', [{ kind: 'receipt', date: '2026-05-04', merchant: 'Cafe', amount: '9.00', allocations: [{ category: t.c.meals }], receiptFixture: 'bistro' }])
  await h.post(`claims/${own.claim.id}/submit`, { version: own.claim.version }, t.priya, 409)
  const detail = await h.get(`claims/${c.id}`, t.sam)
  assert.deepEqual(detail.decisions.map(x => [x.decision, x.reason, x.actor_email, x.revision]), [['rejected', 'Personal travel', 'priya@harbourfinch.example', 1]])
  await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved' }, t.priya, 409)
}))

test('COA-007 a returned claim is corrected and resubmitted without losing the old evidence', () => withAgency(async (h, t) => {
  const d = await claim(h, t.sam, 'Brisbane trip', [{ kind: 'receipt', date: '2026-05-05', merchant: 'Hotel Ibis', amount: '236.00', allocations: [{ category: t.c.travel }], receiptFixture: 'bistro' }])
  let c = await submit(h, t.sam, d)
  const firstReceipt = d.items[0].receipt_id
  c = await h.post(`claims/${c.id}/decision`, { revision: 1, version: c.version, decision: 'returned', reason: 'That is a bistro receipt, not the hotel' }, t.priya)
  assert.equal(c.status, 'returned')
  const r = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...(await receipt('hotel')) }, t.sam)
  c = await h.post(`claims/${c.id}/items`, { version: r.claim.version, item: d.items[0].id, kind: 'receipt', date: '2026-05-05', merchant: 'Hotel Ibis', amount: '236.00', receipt: r.receipt, allocations: [{ category: t.c.travel }] }, t.sam)
  c = await h.post(`claims/${c.id}/submit`, { version: c.version }, t.sam)
  assert.equal(c.revision, 2)
  const seen = await h.get(`claims/${c.id}`, t.priya)
  assert.deepEqual(seen.revisions.map(x => x.snapshot.items[0].receipt.id), [firstReceipt, r.receipt])
  assert.deepEqual(seen.decisions.map(x => x.decision), ['returned'])
  assert.equal((await h.send(`/api/coaster/receipts/${firstReceipt}`, undefined, t.priya)).status, 200, 'the superseded receipt stays downloadable')
  await assert.rejects(h.db.prepare('DELETE FROM c_receipts WHERE id=?').bind(firstReceipt).run(), /permanent/)
  await assert.rejects(h.db.prepare("UPDATE c_revisions SET total_minor=1 WHERE claim_id=?").bind(c.id).run(), /permanent/)
  c = await approve(h, t.priya, c)
  assert.deepEqual((await h.get(`claims/${c.id}`, t.sam)).decisions.map(x => [x.revision, x.decision]), [[1, 'returned'], [2, 'approved']])
}))

test('COA-008 access follows employee, manager and finance roles in every handler', () => withAgency(async (h, t) => {
  const draft = await claim(h, t.sam, 'Private draft', [{ kind: 'receipt', date: '2026-05-06', merchant: 'Cafe', amount: '12.00', allocations: [{ category: t.c.meals }], receiptFixture: 'bistro' }])
  const id = draft.claim.id, receiptId = draft.items[0].receipt_id
  for (const who of [t.alex, t.priya, t.morgan, h.owner]) {
    assert.equal((await h.send(`/api/coaster/claims/${id}`, undefined, who)).status, 403)
    assert.equal((await h.send(`/api/coaster/receipts/${receiptId}`, undefined, who)).status, 403)
    assert.ok(!(await h.get('state', who)).claims.some(c => c.id === id))
  }
  await h.post(`claims/${id}/items`, { version: draft.claim.version, kind: 'receipt', date: '2026-05-06', merchant: 'Forged', amount: '1.00', allocations: [{ category: t.c.meals }] }, t.alex, 403)
  const submitted = await submit(h, t.sam, draft)
  assert.equal((await h.send(`/api/coaster/claims/${id}`, undefined, t.alex)).status, 403, 'another employee never sees it')
  assert.equal((await h.send(`/api/coaster/claims/${id}`, undefined, t.jordan)).status, 200, 'finance sees submitted claims')
  assert.equal((await h.send(`/api/coaster/claims/${id}`, undefined, t.priya)).status, 200, 'the assigned manager sees it')
  await h.post('batches', { claims: [id] }, t.priya, 403)
  await h.post('settings/categories', { name: 'Gifts', accountCode: '1', taxCode: 'GST' }, t.jordan, 403)
  await h.post('import/preview', { csv: 'a\n1' }, t.morgan, 403)
  assert.equal((await h.send('/api/coaster/state', undefined, '')).status, 401)
  const crossSite = await h.mf.dispatchFetch(`${h.origin}/api/coaster/claims`, { method: 'POST', headers: { cookie: t.sam, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"title":"x"}' })
  assert.equal(crossSite.status, 403)
  await h.post(`claims/${id}/decision`, { revision: 1, version: submitted.version, decision: 'approved', employee_email: 'alex@harbourfinch.example', approver_email: 'alex@harbourfinch.example' }, t.alex, 403)
  await h.post('settings/members', { email: 'sam@harbourfinch.example', name: 'sam', employee: true, active: false })
  assert.equal((await h.send('/api/coaster/state', undefined, t.sam)).status, 403, 'a deactivated member loses access at once')
  assert.equal((await h.send(`/api/coaster/claims/${id}`, undefined, t.sam)).status, 403)
}))

test('COA-009 finance batches approved claims, reviews reconciled totals, exports CSV and records payment', () => withAgency(async (h, t) => {
  const one = await claim(h, t.sam, 'Melbourne pitch', [{ kind: 'receipt', date: '2026-05-07', merchant: 'Qantas', amount: '412.00', allocations: [{ category: t.c.travel }], receiptFixture: 'hotel' }, { kind: 'mileage', date: '2026-05-07', merchant: 'Airport run', distance: '56', allocations: [{ category: t.c.car }] }])
  const two = await claim(h, t.alex, 'Studio supplies', [{ kind: 'receipt', date: '2026-05-08', merchant: 'Officeworks', amount: '64.95', allocations: [{ category: t.c.office }], receiptFixture: 'officeworks' }])
  const three = await claim(h, t.morgan, 'Finance offsite', [{ kind: 'receipt', date: '2026-05-08', merchant: 'Uber', amount: '20.10', allocations: [{ category: t.c.travel }], receiptFixture: 'uber' }])
  const a = await approve(h, t.priya, await submit(h, t.sam, one)), b = await approve(h, t.priya, await submit(h, t.alex, two)), m = await approve(h, t.priya, await submit(h, t.morgan, three))
  let batch = await h.post('batches', { claims: [a.id, b.id, m.id] }, t.morgan)
  const total = 41200 + 4928 + 6495 + 2010
  assert.equal(batch.total_minor, total)
  await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: total }, t.morgan, 403)
  await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: total - 1 }, t.jordan, 409)
  await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`, undefined, t.jordan).then(r => assert.equal(r.status, 409, 'no export before review'))
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: total }, t.jordan)
  const accounting = (await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`, undefined, t.jordan)).text
  const people = (await h.send(`/api/coaster/batches/${batch.id}/reimbursements.csv`, undefined, t.jordan)).text
  assert.equal(sum(accounting, 'amount'), total); assert.equal(sum(people, 'amount'), total)
  assert.equal(accounting.trim().split('\r\n').length, 1 + 4); assert.equal(people.trim().split('\r\n').length, 1 + 3)
  assert.match(accounting, new RegExp(sha(await readFile('tests/fixtures/receipts/hotel.png'))))
  await h.post(`batches/${batch.id}/remove`, { version: batch.version, claim: a.id }, t.jordan, 409)
  batch = await h.post(`batches/${batch.id}/paid`, { version: batch.version, reference: 'CBA-ABA-0517', paidOn: '2026-05-17' }, t.jordan)
  assert.equal(batch.status, 'reimbursed')
  assert.deepEqual((await h.get('state', t.jordan)).claims.filter(c => [a.id, b.id, m.id].includes(c.id)).map(c => c.status), ['reimbursed', 'reimbursed', 'reimbursed'])
  const events = (await h.get(`batches/${batch.id}`, t.jordan)).events.map(e => e.action)
  assert.deepEqual(events.filter(e => e.startsWith('batch-')), ['batch-created', 'batch-approved', 'batch-exported', 'batch-exported', 'batch-reimbursed'])
}))

test('COA-010 an agent prepares claims and batches; only the person accepts them', () => withAgency(async (h, t) => {
  const key = await h.post('agent-keys', { label: 'Receipt inbox agent' }, t.sam)
  const bearer = { authorization: `Bearer ${key.token}` }
  const asAgent = (path, body) => h.send('/api/coaster/agent/' + path, body, '', bearer)
  const context = await asAgent('context')
  assert.equal(context.status, 200); assert.equal(context.value.for.email, 'sam@harbourfinch.example')
  const proposal = await asAgent('claims', { title: 'Receipts from email', note: 'Two receipts forwarded on Monday', items: [
    { kind: 'receipt', date: '2026-05-09', merchant: 'Uber', amount: '38.60', allocations: [{ category: t.c.travel }], receipt: await receipt('uber') },
    { kind: 'mileage', date: '2026-05-09', merchant: 'Client visit', distance: '20', allocations: [{ category: t.c.car }] },
  ] })
  assert.equal(proposal.status, 200, JSON.stringify(proposal.value)); assert.equal(proposal.value.status, 'proposed')
  for (const [path, body] of [['/api/coaster/claims', { title: 'x' }], ['/api/coaster/state', undefined], [`/api/coaster/proposals/${proposal.value.id}/accept`, {}]])
    assert.equal((await h.send(path, body, '', bearer)).status, 401, `${path} needs a native session`)
  await h.post(`proposals/${proposal.value.id}/accept`, {}, t.alex, 403)
  const accepted = await h.post(`proposals/${proposal.value.id}/accept`, {}, t.sam)
  const d = await h.get(`claims/${accepted.claim.id}`, t.sam)
  assert.equal(d.claim.status, 'draft'); assert.equal(d.claim.prepared_by, 'Receipt inbox agent'); assert.equal(d.claim.total_minor, 3860 + 1760)
  assert.equal(d.receipts[0].source, 'agent'); assert.equal(d.items[0].receipt_id, d.receipts[0].id)
  assert.ok(d.events.some(e => e.action === 'proposal-accepted' && e.actor_email === 'sam@harbourfinch.example'))
  await h.post(`proposals/${proposal.value.id}/accept`, {}, t.sam, 409)
  const c = await approve(h, t.priya, await submit(h, t.sam, d))
  const finance = await h.post('agent-keys', { label: 'Month-end agent' }, t.morgan)
  const batchProposal = await h.send('/api/coaster/agent/batches', { claims: [c.id], note: 'Everything approved this week' }, '', { authorization: `Bearer ${finance.token}` })
  assert.equal(batchProposal.status, 200, JSON.stringify(batchProposal.value))
  assert.equal((await asAgent('batches', { claims: [c.id] })).status, 403, "an employee's agent cannot propose batches")
  const batch = (await h.post(`proposals/${batchProposal.value.id}/accept`, {}, t.morgan)).batch
  assert.equal(batch.status, 'draft'); assert.equal(batch.prepared_by, 'Month-end agent')
  const declined = await asAgent('claims', { title: 'Wrong', items: [{ kind: 'receipt', date: '2026-05-09', merchant: 'Cafe', amount: '5.00', allocations: [{ category: t.c.meals }] }] })
  assert.equal((await h.post(`proposals/${declined.value.id}/decline`, { reason: 'Personal coffee' }, t.sam)).status, 'declined')
  await h.post(`agent-keys/${key.id}/revoke`, {}, t.sam)
  assert.equal((await asAgent('context')).status, 401)
  const alexKey = await h.post('agent-keys', { label: 'Alex agent' }, t.alex), asAlex = { authorization: `Bearer ${alexKey.token}` }
  assert.equal((await h.send('/api/coaster/agent/context', undefined, '', asAlex)).status, 200)
  const operators = (await h.send('/auth/operators', undefined, h.owner)).value
  const alexAccount = (Array.isArray(operators) ? operators : operators.operators).find(o => o.email === 'alex@harbourfinch.example')
  assert.equal((await h.send('/auth/operator/status', { operatorId: alexAccount.id, status: 'inactive' }, h.owner)).status, 200)
  assert.equal((await h.send('/api/coaster/agent/context', undefined, '', asAlex)).status, 401, 'a deactivated sign-in account stops its agent keys too')
  assert.equal((await h.send('/api/coaster/agent/claims', { title: 'After', items: [{ kind: 'receipt', date: '2026-05-09', merchant: 'Taxi', amount: '22.00', allocations: [{ category: t.c.travel }] }] }, '', asAlex)).status, 401)
}))

test('COA-011 the Expensify move-in kit previews without writing, imports exactly, flags re-claims and undoes', () => withAgency(async (h, t) => {
  const csv = await readFile('tests/fixtures/expensify-report-template.csv', 'utf8')
  const mapping = { date: 'YYYY-MM-DD', statuses: { Reimbursed: 'reimbursed', Approved: 'approved' } }
  const before = await h.db.prepare('SELECT (SELECT COUNT(*) FROM ik_jobs) + (SELECT COUNT(*) FROM c_history) AS n').first()
  let preview = await h.post('import/preview', { csv, filename: 'expensify.csv', mapping })
  assert.deepEqual(preview.summary.unmappedStatuses, ['Open'])
  assert.ok(preview.summary.errors.length > 0)
  await h.post('import/commit', { csv, filename: 'expensify.csv', mapping, fingerprint: preview.fingerprint }, h.owner, 409)
  mapping.statuses.Open = 'open'
  preview = await h.post('import/preview', { csv, filename: 'expensify.csv', mapping })
  assert.deepEqual(preview.summary.errors, [])
  assert.equal(preview.summary.reports, 3); assert.equal(preview.summary.expenses, 6); assert.equal(preview.summary.totalMinor, 41200 + 1840 + 4928 + 23600 + 3860 + 6495)
  assert.match(preview.summary.warnings[0], /policyName/)
  assert.equal((await h.db.prepare('SELECT (SELECT COUNT(*) FROM ik_jobs) + (SELECT COUNT(*) FROM c_history) AS n').first()).n, before.n, 'preview writes nothing')
  const malformed = await h.send('/api/coaster/import/preview', { csv: csv.replace('Qantas,412.00', 'Qantas,"412.00"x'), filename: 'bad.csv', mapping }, h.owner)
  assert.equal(malformed.status, 400); assert.match(malformed.value.error, /closing quote/)
  await h.post('import/commit', { csv: csv.replace('412.00', '413.00'), filename: 'expensify.csv', mapping, fingerprint: preview.fingerprint }, h.owner, 409)
  const done = await h.post('import/commit', { csv, filename: 'expensify.csv', mapping, fingerprint: preview.fingerprint })
  assert.equal(done.job.state, 'completed')
  const history = await h.get('import')
  assert.equal(history.history.filter(r => r.kind === 'report').length, 3)
  assert.equal(history.history.find(r => r.id === 'expensify:report:R00A1').status, 'reimbursed')
  const reclaim = await claim(h, t.sam, 'Old flight', [{ kind: 'receipt', date: '2026-03-02', merchant: 'qantas', amount: '412.00', allocations: [{ category: t.c.travel }], receiptFixture: 'hotel' }])
  assert.match(reclaim.exceptions.find(e => e.code === 'possible-duplicate').message, /imported report R00A1/)
  assert.equal((await h.get('state', t.sam)).claims.length, 1, 'imported reports never become claims')
  const status = await h.post('import/status', { id: done.job.id, mappingVersion: done.mappingVersion })
  assert.equal(status.originals[0].sha256, sha(Buffer.from(csv)))
  const undone = await h.post('import/undo', { id: done.job.id, mappingVersion: done.mappingVersion })
  assert.equal(undone.job.state, 'undone')
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_history').first()).n, 0)
  preview = await h.post('import/preview', { csv, filename: 'expensify.csv', mapping })
  const again = await h.post('import/commit', { csv, filename: 'expensify.csv', mapping, fingerprint: preview.fingerprint })
  assert.equal(again.job.state, 'completed', 'the same file imports again after an undo')
  assert.equal((await h.get('import')).history.filter(r => r.kind === 'report').length, 3)
}))

test('APPROVE-002 an approver delegates for a date range, the owner reassigns a stuck claim and a deactivated approver\'s queue moves to their manager', () => withAgency(async (h, t) => {
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
}))

test('LOCALE-001 a new business starts on US defaults: USD, a US zone, IRS mileage by trip date, the $75/lodging rule and sales tax on its own line', async () => {
  const h = await harness()
  try {
    await h.post('settings/business', { name: 'Tallgrass Outdoor Co.', timezone: 'America/Chicago', perDiem: '' })
    let { business } = await h.get('state')
    assert.equal(business.currency, 'USD'); assert.equal(business.timezone, 'America/Chicago'); assert.equal(business.receipt_threshold_minor, 7500)
    assert.deepEqual(business.mileage_rates.slice(-2), [{ effective_from: '2025-01-01', rate_thousandths: 700 }, { effective_from: '2026-01-01', rate_thousandths: 725 }], 'seeded with the IRS standard business rate for each year')
    const category = async (name, extra = {}) => (await h.post('settings/categories', { name, accountCode: '6000', taxCode: 'TAX', ...extra })).id
    const c = { lodging: await category('Lodging', { receiptAlways: false }), meals: await category('Meals'), car: await category('Mileage', { taxCode: 'NON' }) }
    assert.deepEqual((await h.get('state')).categories.map(x => [x.name, x.receipt_always]), [['Lodging', 1], ['Meals', 0], ['Mileage', 0]], 'lodging always needs a receipt')
    const dana = await h.person('dana@tallgrass.example', { employee: true, manager: true })
    const jordan = await h.person('jordan@tallgrass.example', { employee: true, finance: true }, 'dana@tallgrass.example')
    const taxed = { kind: 'receipt', date: '2026-01-05', merchant: 'Office Depot', amount: '107.25', salesTax: '7.25', allocations: [{ category: c.meals }], receiptFixture: 'officeworks' }
    const early = await h.post('claims', { title: 'Too early' }, jordan)
    await h.post(`claims/${early.id}/items`, { version: early.version, ...taxed, receiptFixture: undefined }, jordan, 400)
    await h.post('settings/business', { name: 'Tallgrass Outdoor Co.', timezone: 'America/Chicago', perDiem: '', salesTaxAccount: '2200', salesTaxCode: 'TAX' })
    business = (await h.get('state')).business
    assert.equal(business.receipt_threshold_minor, 7500, 'saving again keeps the threshold')
    await h.post(`claims/${early.id}/items`, { version: early.version, ...taxed, allocations: [{ category: c.meals, amount: '107.25' }], receiptFixture: undefined }, jordan, 400)
    const d = await claim(h, jordan, 'Omaha trip', [
      { kind: 'mileage', date: '2025-12-30', merchant: 'Kansas City to Omaha', distance: '186', allocations: [{ category: c.car }] },
      { kind: 'mileage', date: '2026-01-02', merchant: 'Omaha to Kansas City', distance: '186', allocations: [{ category: c.car }] },
      { kind: 'receipt', date: '2026-01-02', merchant: 'Corner Cafe', amount: '60.00', allocations: [{ category: c.meals }] },
      { kind: 'receipt', date: '2026-01-02', merchant: 'Steakhouse', amount: '80.00', allocations: [{ category: c.meals }] },
      { kind: 'receipt', date: '2026-01-01', merchant: 'Hampton Inn', amount: '50.00', allocations: [{ category: c.lodging }] },
      taxed,
    ])
    assert.deepEqual(d.items.map(i => [i.rate_thousandths, i.amount_minor]).slice(0, 2), [[700, 13020], [725, 13485]], 'each trip at its year\'s IRS rate')
    assert.deepEqual(d.exceptions.map(e => [d.items.find(i => i.id === e.item).merchant, e.message]), [['Steakhouse', 'No receipt for an expense over $75.00'], ['Hampton Inn', 'Lodging always needs a receipt']])
    assert.equal(d.items[5].sales_tax_minor, 725); assert.equal(d.items[5].allocations[0].amount_minor, 10000)
    let x = d.claim
    for (const item of d.items.filter(i => d.exceptions.some(e => e.item === i.id)))
      x = await h.post(`claims/${x.id}/items`, { version: x.version, item: item.id, kind: 'receipt', date: item.spent_on, merchant: item.merchant, amount: (item.amount_minor / 100).toFixed(2), allocations: [{ category: item.allocations[0].category_id }], explanation: 'Receipt lost' }, jordan)
    x = await approve(h, dana, await h.post(`claims/${x.id}/submit`, { version: x.version }, jordan), { acknowledge: true })
    const batch = await h.post('batches', { claims: [x.id] }, jordan)
    await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: x.total_minor }, h.owner)
    const csv = (await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`, undefined, h.owner)).text
    assert.match(csv, /"Office Depot","","receipt","Meals","6000","TAX","","100.00"/); assert.match(csv, /"Office Depot","","receipt","Sales tax","2200","TAX","","7.25"/)
    assert.equal(sum(csv, 'amount'), x.total_minor, 'the sales tax line keeps the export equal to the batch total')
    await h.post('settings/mileage-rates', { effectiveFrom: '2027-01-01', rate: '0.75' })
    assert.equal((await h.get('state')).business.mileage_rates.at(-1).rate_thousandths, 750, 'the owner adds next year\'s rate')
  } finally { await h.close() }
})

/** The files of a stored ZIP by name, read through its central directory, each checked against its CRC-32. */
function unzip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length), files = {}
  let end = bytes.length - 22
  while (v.getUint32(end, true) !== 0x06054b50) end--
  let at = v.getUint32(end + 16, true)
  for (let n = v.getUint16(end + 10, true); n > 0; n--) {
    assert.equal(v.getUint32(at, true), 0x02014b50)
    const size = v.getUint32(at + 20, true), nameLength = v.getUint16(at + 28, true), offset = v.getUint32(at + 42, true)
    const start = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true), data = bytes.subarray(start, start + size)
    assert.equal(crc32(data), v.getUint32(at + 16, true))
    files[bytes.subarray(at + 46, at + 46 + nameLength).toString()] = data
    at += 46 + nameLength + v.getUint16(at + 30, true) + v.getUint16(at + 32, true)
  }
  return files
}

test('REPORT-003 history is searchable across a claim\'s capture, approval and payment; an auditor reads everything, changes nothing and exports a period\'s audit pack', () => withAgency(async (h, t) => {
  const audrey = await h.person('audrey@harbourfinch.example', { auditor: true })
  const key = await h.post('agent-keys', { label: 'Receipt inbox agent' }, t.sam)
  const proposal = await h.send('/api/coaster/agent/claims', { title: 'Sydney client visit', items: [{ kind: 'receipt', date: '2026-05-09', merchant: 'Uber', amount: '38.60', allocations: [{ category: t.c.travel }], receipt: await receipt('uber') }] }, '', { authorization: `Bearer ${key.token}` })
  let c = (await h.post(`proposals/${proposal.value.id}/accept`, {}, t.sam)).claim
  const lunch = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...(await receipt('bistro')) }, t.sam)
  c = await h.post(`claims/${c.id}/items`, { version: lunch.claim.version, kind: 'receipt', date: '2026-05-09', merchant: 'Harbour View Bistro', amount: '150.00', receipt: lunch.receipt, allocations: [{ category: t.c.meals }], explanation: 'Client lunch for three' }, t.sam)
  c = await approve(h, t.priya, await h.post(`claims/${c.id}/submit`, { version: c.version }, t.sam), { acknowledge: true })
  let batch = await h.post('batches', { claims: [c.id] }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 18860 }, t.jordan)
  batch = await h.post(`batches/${batch.id}/paid`, { version: batch.version, reference: 'ACH-2026-0517', paidOn: '2026-05-17' }, t.jordan)
  const number = `CL-${String(c.number).padStart(4, '0')}`

  const found = (await h.get(`history?q=${number}`, audrey)).lines
  for (const step of ['proposal-accepted', 'receipt-added', 'expense-added', 'claim-submitted', 'claim-approved', 'claim-batched', 'batch-approved', 'batch-reimbursed'])
    assert.ok(found.some(l => l.action === step), `${step} is in the claim's history`)
  assert.deepEqual(found.map(l => l.seq), found.map(l => l.seq).toSorted((a, b) => a - b), 'in history order')
  assert.ok(found.every(l => l.claim?.id === c.id || (!l.claim && l.batch?.id === batch.id)), 'only this claim and its batch')
  const paid = found.find(l => l.action === 'batch-reimbursed')
  assert.deepEqual([paid.actor_email, paid.detail.reference, paid.channel, typeof paid.at], ['jordan@harbourfinch.example', 'ACH-2026-0517', 'app', 'string'])
  const prepared = (await h.get('history?q=claim-proposed', audrey)).lines
  assert.deepEqual([prepared[0].channel, prepared[0].agent, prepared[0].actor_email], ['agent', 'Receipt inbox agent', 'sam@harbourfinch.example'], 'an agent\'s line names the agent and the person it acted for')
  assert.deepEqual((await h.get('history?q=ach-2026', t.morgan)).lines.map(l => l.action), ['batch-reimbursed'], 'finance searches by any words')
  assert.equal((await h.get(`history?q=${number}&from=2020-01-01&to=2020-12-31`, audrey)).lines.length, 0)
  for (const who of [t.sam, t.priya]) {
    await h.get(`history?q=${number}`, who, 403)
    await h.get('audit-pack?from=2026-01-01&to=2026-03-31', who, 403)
  }

  const draft = await claim(h, t.alex, 'Studio supplies', [{ kind: 'receipt', date: '2026-05-10', merchant: 'Officeworks', amount: '64.95', allocations: [{ category: t.c.office }], receiptFixture: 'officeworks' }])
  assert.equal((await h.send(`/api/coaster/claims/${draft.claim.id}`, undefined, audrey)).status, 403, 'a draft stays the employee\'s until submitted')
  const pending = await submit(h, t.alex, draft)
  assert.equal((await h.get(`claims/${c.id}`, audrey)).claim.status, 'reimbursed')
  assert.equal((await h.send(`/api/coaster/receipts/${lunch.receipt}`, undefined, audrey)).status, 200)
  assert.equal((await h.get(`batches/${batch.id}`, audrey)).batch.paid_reference, 'ACH-2026-0517')
  assert.equal((await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`, undefined, audrey)).status, 200)
  assert.deepEqual((await h.get('state', audrey)).claims.map(x => x.id).sort(), [c.id, pending.id].sort())
  const lines = async () => (await h.db.prepare('SELECT COUNT(*) AS n FROM c_events').first()).n, before = await lines()
  for (const [path, body] of [
    ['claims', { title: 'Audit lunch' }], [`claims/${pending.id}/decision`, { revision: pending.revision, version: pending.version, decision: 'approved' }],
    [`claims/${pending.id}/reassign`, { version: pending.version, approver: 'jordan@harbourfinch.example' }], ['batches', { claims: [c.id] }],
    [`batches/${batch.id}/paid`, { version: batch.version, reference: 'X', paidOn: '2026-05-18' }], ['settings/business', { name: 'Audited', currency: 'AUD', timezone: 'Australia/Sydney' }],
    ['settings/categories', { name: 'Gifts', accountCode: '1', taxCode: 'GST' }], ['settings/members', { email: 'audrey@harbourfinch.example', name: 'Audrey', employee: true, finance: true }],
    ['settings/mileage-rates', { effectiveFrom: '2026-01-01', rate: '2.00' }], ['delegations', { delegate: 'priya@harbourfinch.example', startsOn: '2026-05-01', endsOn: '2026-05-31' }],
    ['agent-keys', { label: 'Audit agent' }], ['import/preview', { csv: 'a\n1' }],
  ]) await h.post(path, body, audrey, 403)
  assert.equal(await lines(), before, 'every refused write left history untouched')

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const [year, month] = today.split('-').map(Number), q = Math.floor((month - 1) / 3) * 3, day = (m, d) => new Date(Date.UTC(year, m, d)).toISOString().slice(0, 10)
  const download = async (from, to) => { const r = await h.mf.dispatchFetch(`${h.origin}/api/coaster/audit-pack?from=${from}&to=${to}`, { headers: { cookie: audrey } }); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/zip'); return unzip(Buffer.from(await r.arrayBuffer())) }
  const files = await download(day(q, 1), day(q + 3, 0)), manifest = JSON.parse(files['manifest.json'].toString())
  assert.deepEqual(manifest.claims.map(x => x.number), [number, `CL-${String(pending.number).padStart(4, '0')}`])
  const packed = manifest.claims[0]
  assert.equal(packed.totalMinor, 18860)
  assert.deepEqual([packed.decisions[0].decision, packed.decisions[0].by, packed.decisions[0].exceptionsAcknowledged.map(e => e.code)], ['approved', 'priya@harbourfinch.example', ['over-limit']])
  assert.deepEqual(packed.revisions[0].exceptions.map(e => [e.code, packed.revisions[0].items.find(i => i.id === e.item).explanation]), [['over-limit', 'Client lunch for three']])
  assert.deepEqual([packed.payment.batch, packed.payment.reference, packed.payment.paidBy], [`RB-${String(batch.number).padStart(4, '0')}`, 'ACH-2026-0517', 'jordan@harbourfinch.example'])
  const stored = (await h.db.prepare('SELECT id,sha256,bytes FROM c_receipts WHERE claim_id IN (?,?)').bind(c.id, pending.id).all()).results
  assert.equal(stored.length, 3)
  for (const row of stored) {
    const entry = manifest.receipts.find(x => x.id === row.id)
    assert.equal(sha(Buffer.from(row.bytes)), entry.sha256); assert.equal(sha(files[entry.file]), entry.sha256, `${entry.name} in the pack is the stored bytes`)
  }
  for (const item of packed.revisions[0].items) assert.equal(sha(files[item.receipt.file]), item.receipt.sha256)
  assert.equal(sha(files[manifest.receipts.find(x => x.id === lunch.receipt).file]), sha(await readFile('tests/fixtures/receipts/bistro.png')))
  const history = files['history.csv'].toString().trim().split('\r\n')
  assert.equal(history.length, 1 + manifest.history.lines); assert.match(history.find(l => l.includes('"batch-reimbursed"')), /ACH-2026-0517/)
  assert.deepEqual(JSON.parse((await download(day(q - 3, 1), day(q, 0)))['manifest.json'].toString()).claims, [], 'the quarter before holds none of them')
  assert.ok((await h.get('history?q=audit-pack-exported', t.morgan)).lines.some(l => l.actor_email === 'audrey@harbourfinch.example' && l.detail.claims === 2), 'each download is a history line')
}))

test('ADMIN-005 a delegate prepares and submits in someone else\'s name on their behalf, never approves their own or that person\'s claims, and stops the moment access ends', () => withAgency(async (h, t) => {
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
}))

test('CLAIM-007 a three-night folio is itemized into categorized parts, a dinner\'s attendees meet a per-person limit, and a blank required field blocks submission by name', () => withAgency(async (h, t) => {
  const lodging = (await h.post('settings/categories', { name: 'Lodging', accountCode: '6210', taxCode: 'GST' })).id
  const meals = await h.post('settings/categories', { id: t.c.meals, name: 'Meals', accountCode: '6300', taxCode: 'GST', perPersonLimit: '75.00', requiredFields: 'Business purpose, Client' })
  assert.deepEqual([meals.per_person_limit_minor, meals.required_fields], [7500, ['Business purpose', 'Client']])
  const purpose = { 'Business purpose': 'Lyra rebrand workshop', Client: 'Lyra' }
  const d = await claim(h, t.sam, 'Lyra workshop week', [
    { kind: 'receipt', date: '2026-05-14', merchant: 'Harbour Grand Hotel', amount: '1038.75', receiptFixture: 'hotel', fields: purpose, allocations: [
      { category: lodging, description: 'Room, 3 nights', amount: '867.00' }, { category: lodging, description: 'Room tax', amount: '104.04' },
      { category: t.c.meals, description: 'In-room dining', amount: '52.71' }, { category: t.c.travel, description: 'Incidentals: parking', amount: '15.00' }] },
    { kind: 'receipt', date: '2026-05-15', merchant: 'Rockpool', amount: '320.00', receiptFixture: 'bistro', allocations: [{ category: t.c.meals }], fields: { 'Business purpose': 'Pitch dinner' }, attendees: [
      { kind: 'employee', name: 'Sam Taylor', email: 'sam@harbourfinch.example' }, { kind: 'employee', name: 'Priya Nair', email: 'priya@harbourfinch.example' }, { kind: 'guest', name: 'Dana Cho' }, { kind: 'guest', name: 'Lee Park' }] },
  ])
  const [folio, dinner] = d.items
  assert.deepEqual(folio.allocations.map(a => [a.description, a.category_name, a.amount_minor]), [['Room, 3 nights', 'Lodging', 86700], ['Room tax', 'Lodging', 10404], ['In-room dining', 'Meals', 5271], ['Incidentals: parking', 'Travel', 1500]])
  assert.deepEqual(dinner.attendees.map(a => a.kind), ['employee', 'employee', 'guest', 'guest'])
  assert.deepEqual(d.exceptions.map(e => [e.code, e.item]), [['over-per-person', dinner.id]])
  assert.match(d.exceptions[0].message, /80\.00 a person for 4 people, over the Meals limit of AUD 75\.00 a person/)
  await h.post(`claims/${d.claim.id}/items`, { version: d.claim.version, item: dinner.id, kind: 'receipt', date: '2026-05-15', merchant: 'Rockpool', amount: '320.00', allocations: [{ category: t.c.meals }], attendees: [{ kind: 'employee', name: 'Stranger', email: 'stranger@elsewhere.example' }] }, t.sam, 400)
  const refused = await h.send(`/api/coaster/claims/${d.claim.id}/submit`, { version: d.claim.version }, t.sam)
  assert.equal(refused.status, 409); assert.match(refused.value.error, /Client for Rockpool \(Meals\)/); assert.doesNotMatch(refused.value.error, /Harbour Grand Hotel/)
  let c = await h.post(`claims/${d.claim.id}/items`, { version: d.claim.version, item: dinner.id, kind: 'receipt', date: '2026-05-15', merchant: 'Rockpool', amount: '320.00', receipt: dinner.receipt_id, allocations: [{ category: t.c.meals }], attendees: dinner.attendees, fields: { 'Business purpose': 'Pitch dinner', Client: 'Lyra' }, explanation: 'Pitch dinner for four with the client' }, t.sam)
  c = await approve(h, t.priya, await submit(h, t.sam, await h.get(`claims/${c.id}`, t.sam)), { acknowledge: true })
  const seen = await h.get(`claims/${c.id}`, t.priya)
  assert.deepEqual(seen.revisions[0].snapshot.items[1].attendees.map(a => a.name), ['Sam Taylor', 'Priya Nair', 'Dana Cho', 'Lee Park'], 'the approver sees who was there')
  assert.equal(seen.revisions[0].snapshot.items[1].fields.Client, 'Lyra')
  let batch = await h.post('batches', { claims: [c.id] }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 103875 + 32000 }, t.jordan)
  const csv = (await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`, undefined, t.jordan)).text
  assert.match(csv, /"Room tax","receipt","Lodging","6210","GST","","104.04"/); assert.match(csv, /"In-room dining","receipt","Meals","6300","GST","","52.71"/)
  assert.equal(sum(csv, 'amount'), 103875 + 32000)
}))

test('CLAIM-005 a conference is requested and approved before spending, linked expenses show estimate against actual, and an unlinked expense over the threshold needs pre-approval', () => withAgency(async (h, t) => {
  await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', perDiem: '75.00', receiptThreshold: '', preapprovalThreshold: '500.00' })
  const PRIYA = 'priya@harbourfinch.example'
  const trip = await h.post('requests', { title: 'Sydney design conference', purpose: 'Speaker slot and two nights', estimate: '2400.00' }, t.sam)
  assert.deepEqual([trip.status, trip.approver_email, trip.estimate_minor, trip.actual_minor], ['submitted', PRIYA, 240000, 0])
  const laptop = await h.post('requests', { title: 'Laptop', estimate: '1800.00' }, t.sam)
  const draft = await h.post('claims', { title: 'Early booking' }, t.sam)
  const linked = { version: draft.version, kind: 'receipt', date: '2026-05-20', merchant: 'Design Week tickets', amount: '1450.00', allocations: [{ category: t.c.travel }] }
  await h.post(`claims/${draft.id}/items`, { ...linked, request: trip.id }, t.sam, 409)
  await h.post(`requests/${trip.id}/decision`, { version: trip.version, decision: 'approved' }, t.sam, 403)
  await h.post(`requests/${trip.id}/decision`, { version: trip.version, decision: 'approved' }, t.jordan, 403)
  await h.post(`requests/${trip.id}/decision`, { version: trip.version + 1, decision: 'approved' }, t.priya, 409)
  await h.post(`requests/${laptop.id}/decision`, { version: laptop.version, decision: 'rejected' }, t.priya, 400)
  assert.equal((await h.post(`requests/${laptop.id}/decision`, { version: laptop.version, decision: 'rejected', reason: 'Use the studio spare' }, t.priya)).status, 'rejected')
  assert.equal((await h.post(`requests/${trip.id}/decision`, { version: trip.version, decision: 'approved' }, t.priya)).status, 'approved')
  await h.post(`claims/${draft.id}/items`, { ...linked, request: laptop.id }, t.sam, 409)
  await h.post(`claims/${(await h.post('claims', { title: 'Not mine' }, t.alex)).id}/items`, { ...linked, version: 1, request: trip.id }, t.alex, 403)

  const d = await claim(h, t.sam, 'Sydney design conference', [
    { kind: 'receipt', date: '2026-05-20', merchant: 'Design Week tickets', amount: '1450.00', allocations: [{ category: t.c.travel }], receiptFixture: 'officeworks', request: trip.id },
    { kind: 'receipt', date: '2026-05-21', merchant: 'Harbour Grand Hotel', amount: '780.00', allocations: [{ category: t.c.travel }], receiptFixture: 'hotel', request: trip.id },
    { kind: 'receipt', date: '2026-05-22', merchant: 'Studio monitor', amount: '640.00', allocations: [{ category: t.c.office }], receiptFixture: 'uber' },
  ])
  assert.deepEqual(d.requests.map(r => [r.number, r.estimate_minor, r.actual_minor, r.claim_minor]), [[trip.number, 240000, 223000, 223000]])
  assert.deepEqual(d.exceptions.map(e => [e.code, d.items.find(i => i.id === e.item).merchant]), [['needs-pre-approval', 'Studio monitor']])
  assert.match(d.exceptions[0].message, /Over AUD 500\.00 without an approved spend request/)
  await h.post(`claims/${d.claim.id}/submit`, { version: d.claim.version }, t.sam, 409)
  const monitor = d.items[2]
  let c = await h.post(`claims/${d.claim.id}/items`, { version: d.claim.version, item: monitor.id, kind: 'receipt', date: monitor.spent_on, merchant: monitor.merchant, amount: '640.00', receipt: monitor.receipt_id, allocations: [{ category: t.c.office }], explanation: 'Replacement for a failed monitor before a deadline' }, t.sam)
  c = await submit(h, t.sam, await h.get(`claims/${c.id}`, t.sam))
  const seen = await h.get(`claims/${c.id}`, t.priya)
  assert.deepEqual(seen.requests.map(r => [r.title, r.estimate_minor, r.actual_minor]), [['Sydney design conference', 240000, 223000]], 'the approver sees estimate against actual')
  assert.deepEqual(seen.revisions[0].snapshot.items.map(i => i.request_id), [trip.id, trip.id, null])
  const mine = (await h.get('state', t.sam)).requests
  assert.deepEqual(mine.map(r => [r.title, r.status, r.actual_minor]), [['Laptop', 'rejected', 0], ['Sydney design conference', 'approved', 223000]])
  assert.equal((await h.get('state', t.alex)).requests.length, 0, 'another employee sees none of them')
}))

test('APPROVE-007 an employee or their delegate retracts a claim before any decision; the approver, finance or the owner unapproves it until its batch is reviewed', () => withAgency(async (h, t) => {
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
}))

test('APPROVE-006 an approver asks a named person about one expense without deciding; the answer closes the question and frozen comments stay in history', () => withAgency(async (h, t) => {
  const SAM = 'sam@harbourfinch.example', PRIYA = 'priya@harbourfinch.example'
  const audrey = await h.person('audrey@harbourfinch.example', { auditor: true })
  const d = await claim(h, t.sam, 'Client dinner', [{ kind: 'receipt', date: '2026-05-21', merchant: 'Rockpool', amount: '96.00', allocations: [{ category: t.c.meals }], receiptFixture: 'bistro' }, { kind: 'receipt', date: '2026-05-21', merchant: 'Uber', amount: '18.40', allocations: [{ category: t.c.travel }], receiptFixture: 'uber' }])
  const c = await submit(h, t.sam, d), dinner = d.items[0].id
  await h.post(`claims/${c.id}/comments`, { body: 'Which client was this for?', asks: SAM }, t.alex, 403)
  await h.post(`claims/${c.id}/comments`, { body: 'Which client?', item: dinner, asks: 'alex@harbourfinch.example' }, t.priya, 400)
  const asked = await h.post(`claims/${c.id}/comments`, { body: 'Which client was thsi for?', item: dinner, asks: SAM }, t.priya)
  assert.equal(asked.notified, 'accepted')
  const mail = h.messages.findLast(m => m.to.includes(SAM))
  assert.match(mail.subject, /question about CL-/); assert.match(mail.text, /Which client was thsi for\?/); assert.match(mail.text, new RegExp(`#/claims/${c.id}`))
  let seen = await h.get(`claims/${c.id}`, t.priya)
  assert.deepEqual([seen.claim.status, seen.claim.version], ['submitted', c.version], 'the claim stays pending, its version unchanged')
  assert.equal((await h.get('state', t.priya)).claims.find(x => x.id === c.id).open_questions, 1, 'the open question shows on the approver\'s queue')
  await h.post(`comments/${asked.comment}/edit`, { body: 'Which client was this for?' }, t.sam, 403)
  await h.post(`comments/${asked.comment}/edit`, { body: 'Which client was this for?' }, t.priya)

  // Finance and an auditor can comment too; only the named person's reply answers the question.
  await h.post(`claims/${c.id}/comments`, { body: 'Coded to client entertainment once known', parent: asked.comment }, t.jordan)
  assert.equal((await h.get('state', t.priya)).claims.find(x => x.id === c.id).open_questions, 1)
  await h.post(`claims/${c.id}/comments`, { body: 'Sampled for the quarterly review' }, audrey)
  await h.post(`claims/${c.id}/comments`, { body: 'Harbour Bank, the pitch team', parent: asked.comment }, t.sam)
  seen = await h.get(`claims/${c.id}`, t.priya)
  const question = seen.comments.find(x => x.id === asked.comment)
  assert.deepEqual([question.open, question.item_id, question.body, question.edited_at !== null, question.replies], [false, dinner, 'Which client was this for?', true, 2])
  assert.equal((await h.get('state', t.priya)).claims.find(x => x.id === c.id).open_questions, 0)
  await h.post(`comments/${asked.comment}/edit`, { body: 'Who was at the dinner?' }, t.priya, 409)
  await assert.rejects(h.db.prepare('UPDATE c_comments SET body=? WHERE id=?').bind('Rewritten', asked.comment).run(), /permanent/)
  await assert.rejects(h.db.prepare('DELETE FROM c_comments WHERE id=?').bind(asked.comment).run(), /permanent/)

  const approved = await approve(h, t.priya, seen.claim)
  assert.equal(approved.status, 'approved')
  const history = (await h.get(`claims/${c.id}`, t.sam)).events.filter(e => ['question-asked', 'comment-edited', 'comment-added', 'question-answered'].includes(e.action))
  assert.deepEqual(history.map(e => [e.action, e.actor_email]), [['question-asked', PRIYA], ['comment-edited', PRIYA], ['comment-added', 'jordan@harbourfinch.example'], ['comment-added', 'audrey@harbourfinch.example'], ['question-answered', SAM]])
  assert.equal(history[1].detail.previous, 'Which client was thsi for?', 'the earlier wording stays in history')
}))

test('APPROVE-005 an approver holds the dinner and approves the other four; the held expense moves to its own claim, is fixed and paid separately, or its hold is released', () => withAgency(async (h, t) => {
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
  batch = await h.post(`batches/${batch.id}/paid`, { version: batch.version, reference: 'ACH-0601', paidOn: '2026-06-01' }, t.jordan)
  assert.equal((await h.get(`claims/${c.id}`, t.sam)).claim.status, 'reimbursed')
  let hc = await h.post(`claims/${heldId}/items`, { version: held.claim.version, item: dinner, kind: 'receipt', date: '2026-05-25', merchant: 'Rockpool', amount: '96.00', receipt: held.items[0].receipt_id, allocations: [{ category: t.c.meals }], attendees: [{ kind: 'employee', name: 'sam', email: 'sam@harbourfinch.example' }, { kind: 'guest', name: 'Dana Kim' }] }, t.sam)
  await h.post(`claims/${heldId}/release`, { version: hc.version }, t.sam, 403)
  hc = await approve(h, t.priya, await h.post(`claims/${heldId}/submit`, { version: hc.version }, t.sam))
  assert.deepEqual([hc.status, hc.revision, hc.total_minor], ['approved', 1, 9600])
  batch = await h.post('batches', { claims: [heldId] }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 9600 }, t.jordan)
  await h.post(`batches/${batch.id}/paid`, { version: batch.version, reference: 'ACH-0608', paidOn: '2026-06-08' }, t.jordan)
  assert.equal((await h.get(`claims/${heldId}`, t.sam)).claim.status, 'reimbursed')

  // Or the approver releases a hold before the employee resubmits.
  const again = await submit(h, t.alex, await claim(h, t.alex, 'Two site visits', [{ ...five[4], merchant: 'Site visit north' }, { ...five[4], merchant: 'Site visit south', date: '2026-05-28' }]))
  const split = await h.post(`claims/${again.id}/decision`, { revision: again.revision, version: again.version, decision: 'approved', hold: [(await h.get(`claims/${again.id}`, t.alex)).items[1].id], reason: 'Which project?' }, t.priya)
  const second = (await h.get(`claims/${split.id}`, t.priya)).revisions.at(-1).snapshot.split.heldClaim
  const released = await h.post(`claims/${second}/release`, { version: (await h.get(`claims/${second}`, t.priya)).claim.version, reason: 'Answered by phone' }, t.priya)
  assert.deepEqual([released.status, released.revision], ['approved', 1])
  const record = await h.get(`claims/${second}`, t.alex)
  assert.deepEqual([record.revisions[0].submitted_by, record.decisions[0].actor_email, record.events.at(-1).action], ['alex@harbourfinch.example', PRIYA, 'hold-released'])
}))

test('DATA-001 with no optional provider connected, the claim-to-batch journey sends data only through the declared mail adapter', () => withAgency(async (h, t) => {
  const d = await claim(h, t.sam, 'Brisbane visit', [{ kind: 'receipt', date: '2026-06-02', merchant: 'Hotel Ibis', amount: '236.00', allocations: [{ category: t.c.travel }], receiptFixture: 'hotel' }])
  let c = await submit(h, t.sam, d)
  await h.post(`claims/${c.id}/comments`, { body: 'Which client was this for?', asks: 'sam@harbourfinch.example' }, t.priya)
  c = await approve(h, t.priya, c)
  let batch = await h.post('batches', { claims: [c.id] }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 23600 }, t.jordan)
  assert.equal((await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`, undefined, t.jordan)).status, 200)
  await h.post(`batches/${batch.id}/paid`, { version: batch.version, reference: 'ACH-0603', paidOn: '2026-06-03' }, t.jordan)
  assert.equal((await h.get(`claims/${c.id}`, t.sam)).claim.status, 'reimbursed', 'the core flow works with no optional provider connected')

  // Each outbound host belongs to a flow seed.json declares; with no identity provider linked, only mail leaves.
  const declared = new Set(JSON.parse(await readFile('seed.json', 'utf8')).externals.map(e => e.id))
  const flowOf = { 'api.resend.com': 'mail-provider' }
  assert.ok(h.outbound.length >= 6, 'invitations and the question were mailed')
  for (const request of h.outbound) assert.ok(declared.has(flowOf[new URL(request.url).host]), `undeclared outbound ${request.method} ${request.url}`)
  assert.deepEqual([...new Set(h.outbound.map(r => `${r.method} ${r.url}`))], ['POST https://api.resend.com/emails'])
  const receiptBytes = (await readFile('tests/fixtures/receipts/hotel.png')).toString('base64').slice(0, 64)
  for (const message of h.messages) {
    assert.equal(message.attachments, undefined, 'no receipt or file leaves by mail')
    assert.ok(!JSON.stringify(message).includes(receiptBytes))
  }
}))
