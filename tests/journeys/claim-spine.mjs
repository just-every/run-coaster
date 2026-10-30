// Original claim-spine assertion phases, composed into the surviving business journey.
// Each phase keeps its isolated native-session/workerd/D1 harness and closes it.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { agency, harness, receipt } from '../harness.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sum = (csv, column) => { const [head, ...rows] = csv.trim().split('\r\n').map(r => r.split('","').map(x => x.replace(/^"|"$/g, ''))); const i = head.indexOf(column); return Math.round(rows.reduce((n, r) => n + Number(r[i]) * 100, 0)) }

async function withAgency(run, options) {
  const h = await harness(options)
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

// COA-001 the owner sets up the business, categories and people; nobody else can
async function configureBusiness(h, t) {
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
}

// COA-002 an employee captures receipt, mileage and per diem expenses with receipt provenance
async function captureExpenses(h, t) {
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
}

// COA-003 one expense splits across categories and cost centres, adding up exactly
async function splitExpenses(h, t) {
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
}

// COA-004 policy exceptions need an explanation and stay visible to the manager, the batch and the export
async function explainPolicyExceptions(h, t) {
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
}

// COA-005 an exact duplicate expense can never be reimbursed twice
async function preventDuplicateReimbursement(h, t) {
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
}

// COA-006 only the assigned manager decides the exact submitted revision, never their own
async function decideSubmittedRevision(h, t) {
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
}

// COA-007 a returned claim is corrected and resubmitted without losing the old evidence
async function retainCorrectionEvidence(h, t) {
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
}

// COA-008 access follows employee, manager and finance roles in every handler
async function scopeClaimAccess(h, t) {
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
}

// COA-009 finance batches approved claims, reviews reconciled totals, exports CSV and records payment
async function reconcileReimbursements(h, t) {
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
  // ACCT-008 permits reviewed removal with renewed review; release still locks the batch.
  batch = await h.post(`batches/${batch.id}/release`, { version: batch.version })
  const released = await h.get(`batches/${batch.id}`, t.jordan)
  await h.post(`batches/${batch.id}/remove`, { version: batch.version, claim: a.id }, t.jordan, 409)
  assert.deepEqual(await h.get(`batches/${batch.id}`, t.jordan), released, 'refused removal preserves the released claims, review, totals and history')
  batch = await h.post(`batches/${batch.id}/paid`, { version: batch.version, reference: 'CBA-ABA-0517', paidOn: '2026-05-17' }, t.jordan)
  assert.equal(batch.status, 'reimbursed')
  assert.deepEqual((await h.get('state', t.jordan)).claims.filter(c => [a.id, b.id, m.id].includes(c.id)).map(c => c.status), ['reimbursed', 'reimbursed', 'reimbursed'])
  const events = (await h.get(`batches/${batch.id}`, t.jordan)).events.map(e => e.action)
  assert.deepEqual(events.filter(e => e.startsWith('batch-')), ['batch-created', 'batch-approved', 'batch-exported', 'batch-exported', 'batch-released', 'batch-reimbursed'])
}

// COA-009 a finance member acting as another finance member's delegate cannot review a batch holding their own claim
async function requireIndependentReviewer(h, t) {
  const JORDAN = 'jordan@harbourfinch.example'
  const own = await approve(h, t.priya, await submit(h, t.morgan, await claim(h, t.morgan, 'Finance offsite', [{ kind: 'receipt', date: '2026-05-08', merchant: 'Uber', amount: '20.10', allocations: [{ category: t.c.travel }], receiptFixture: 'uber' }])))
  const batch = await h.post('batches', { claims: [own.id] }, t.jordan)
  const review = { version: batch.version, expectedTotal: batch.total_minor }
  await h.post(`batches/${batch.id}/approve`, review, t.morgan, 403)
  await h.post('delegates', { delegate: 'morgan@harbourfinch.example', level: 'full' }, t.jordan)
  const delegated = await h.send(`/api/coaster/batches/${batch.id}/approve`, review, t.morgan, { 'x-coaster-acting-for': JORDAN })
  assert.equal(delegated.status, 403, 'acting for someone else never makes a person the independent reviewer of their own claim')
  const reviewed = await h.post(`batches/${batch.id}/approve`, review, t.jordan)
  assert.deepEqual([reviewed.status, reviewed.reviewed_by], ['approved', JORDAN])
}

// COA-010 an agent prepares claims and batches; only the person accepts them
async function acceptAgentProposals(h, t) {
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
}

// COA-011 the Expensify move-in kit previews without writing, imports exactly, flags re-claims and undoes
async function moveExpensifyHistory(h, t) {
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
}

// LOCALE-001 a new business starts on US defaults: USD, a US zone, IRS mileage by trip date, the $75/lodging rule and sales tax on its own line
async function applyUsDefaults() {
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
}

/** Preserve the published claim guarantees and US-default assertions without registering tests. */
export async function preserveClaimSpine() {
  await withAgency(configureBusiness)
  await withAgency(captureExpenses)
  await withAgency(splitExpenses)
  await withAgency(explainPolicyExceptions)
  await withAgency(preventDuplicateReimbursement)
  await withAgency(decideSubmittedRevision)
  await withAgency(retainCorrectionEvidence)
  await withAgency(scopeClaimAccess)
  await withAgency(reconcileReimbursements)
  await withAgency(requireIndependentReviewer)
  await withAgency(acceptAgentProposals)
  await withAgency(moveExpensifyHistory)
  await applyUsDefaults()
}
