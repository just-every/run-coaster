// Original operations assertions, composed as named phases without test registrations.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness, receipt } from '../harness.mjs'
import { sha, sum, claim, submit, approve, central, deactivateAccount, unzip, everywhere, withAgency } from './operations-support.mjs'

// CLAIM-007 a three-night folio is itemized into categorized parts, a dinner's attendees meet a per-person limit, and a blank required field blocks submission by name
async function itemizeExpenses(h, t) {
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
  assert.match(d.exceptions[0].message, /AUD 320\.00 for 4 people is AUD 80\.00 a person, over the Meals limit of AUD 75\.00 a person/)
  assert.deepEqual(dinner.per_person.map(p => [p.share_minor, p.limit_minor, p.over]), [[8000, 7500, true]])
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

  // The homepage's $101.95 dinner for three: each share shows rounded half up to the cent ($33.98), under $75; the limit
  // is checked against the exact share, so a $33.98 limit is exceeded by $33.98333….
  const three = [{ kind: 'employee', name: 'alex', email: 'alex@harbourfinch.example' }, { kind: 'guest', name: 'Dana Kim' }, { kind: 'guest', name: 'Lee Park' }]
  const small = await claim(h, t.alex, 'Client dinner', [{ kind: 'receipt', date: '2026-05-16', merchant: 'Union Station Grill', amount: '101.95', receiptFixture: 'uber', allocations: [{ category: t.c.meals }], attendees: three }])
  assert.deepEqual(small.items[0].per_person.map(p => [p.share_minor, p.limit_minor, p.over, p.people]), [[3398, 7500, false, 3]])
  assert.deepEqual(small.exceptions, [])
  await h.post('settings/categories', { id: t.c.meals, name: 'Meals', accountCode: '6300', taxCode: 'GST', perPersonLimit: '33.98', requiredFields: 'Business purpose, Client' })
  const tight = await h.get(`claims/${small.claim.id}`, t.alex)
  assert.deepEqual(tight.items[0].per_person.map(p => [p.share_minor, p.over]), [[3398, true]])
  assert.deepEqual(tight.exceptions.map(e => [e.code, e.message]), [['over-per-person', 'AUD 101.95 for 3 people is AUD 33.98 a person, over the Meals limit of AUD 33.98 a person']])
}

// CLAIM-005 a conference is requested and approved before spending, linked expenses show estimate against actual, and an unlinked expense over the threshold is approved only once a request is linked or with the approver's recorded override
async function requireSpendPreapproval(h, t) {
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

  // The gate sits at approval: acknowledging is not enough; link an approved request or record an override.
  const gated = await h.send(`/api/coaster/claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved', acknowledge: true }, t.priya)
  assert.deepEqual([gated.status, /no approved request linked/.test(gated.value.error)], [409, true])
  await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved', acknowledge: true, hold: [seen.items[0].id], reason: 'Ticket invoice needed' }, t.priya, 409)
  c = await h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'returned', reason: 'Link a spend request for the monitor' }, t.priya)
  const screen = await h.post('requests', { title: 'Studio monitor', estimate: '650.00' }, t.sam)
  await h.post(`requests/${screen.id}/decision`, { version: screen.version, decision: 'approved' }, t.priya)
  c = await h.post(`claims/${c.id}/items`, { version: c.version, item: monitor.id, kind: 'receipt', date: monitor.spent_on, merchant: monitor.merchant, amount: '640.00', receipt: monitor.receipt_id, allocations: [{ category: t.c.office }], request: screen.id }, t.sam)
  c = await approve(h, t.priya, await h.post(`claims/${c.id}/submit`, { version: c.version }, t.sam))
  assert.deepEqual([c.status, (await h.get(`claims/${c.id}`, t.sam)).revisions.at(-1).snapshot.exceptions], ['approved', []])

  const rush = await submit(h, t.sam, await claim(h, t.sam, 'Rush hardware', [{ kind: 'receipt', date: '2026-05-23', merchant: 'Camera store', amount: '820.00', allocations: [{ category: t.c.office }], receiptFixture: 'bistro', explanation: 'Shoot moved forward a week' }]))
  const ok = await approve(h, t.priya, rush, { acknowledge: true, override: 'Client shoot moved forward; agreed with Jordan' })
  assert.equal(ok.status, 'approved')
  const record = await h.get(`claims/${rush.id}`, t.sam)
  assert.deepEqual([record.decisions[0].reason, record.events.find(e => e.action === 'claim-approved').detail.preApprovalOverride], ['Client shoot moved forward; agreed with Jordan', 'Client shoot moved forward; agreed with Jordan'], 'the override is in the audit trail')
  let batch = await h.post('batches', { claims: [ok.id] }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 82000 }, t.jordan)
  assert.match((await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`, undefined, t.jordan)).text, /approved without a spend request: Client shoot moved forward; agreed with Jordan/, 'and in the accounting report')
}

// CLAIM-008 an expense filed 75 days after the spend is flagged to finance, marked non-accountable and labelled taxable; a contractor is flagged for 1099 review and a taxable stipend is labelled taxable
async function labelAccountablePlanExpenses(h, t) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const ago = n => new Date(Date.parse(today + 'T00:00:00Z') - n * 86_400_000).toISOString().slice(0, 10)
  await h.post('settings/members', { email: 'casey@harbourfinch.example', name: 'Casey', contractor: true, finance: true }, h.owner, 400)
  const casey = await h.person('casey@harbourfinch.example', { employee: true, contractor: true }, 'priya@harbourfinch.example')
  const late = await claim(h, t.sam, 'Spring conference', [
    { kind: 'receipt', date: ago(75), merchant: 'Qantas', amount: '412.00', allocations: [{ category: t.c.travel }], receiptFixture: 'hotel' },
    { kind: 'receipt', date: ago(10), merchant: 'Officeworks', amount: '64.95', allocations: [{ category: t.c.office }], receiptFixture: 'officeworks' },
  ])
  const [lateItem, onTime] = late.items
  const a = await approve(h, t.priya, await submit(h, t.sam, late))
  const c = await approve(h, t.priya, await submit(h, casey, await claim(h, casey, 'Site visit', [{ kind: 'receipt', date: ago(5), merchant: 'Uber', amount: '20.10', allocations: [{ category: t.c.travel }], receiptFixture: 'uber' }])))
  // CLAIM-009's taxable stipend, paid by the hourly run and approved like any claim.
  await h.post('allowances', { name: 'Phone stipend', type: 'stipend', category: t.c.office, period: 'monthly', amount: '30.00', tax: 'taxable', startsOn: '2026-06-01', member: 'sam@harbourfinch.example' }, t.jordan)
  await (await h.mf.getWorker()).scheduled({ scheduledTime: central('2026-06-02', 9), cron: '17 * * * *' })
  const stipendClaim = (await h.get('state', t.priya)).claims.find(x => x.title.startsWith('Phone stipend · '))
  const s = await approve(h, t.priya, (await h.get(`claims/${stipendClaim.id}`, t.priya)).claim)

  // Finance sees the 75-day expense, and only it, as an accountable-plan lapse; employees cannot read the list.
  await h.get('accountable-plan', t.sam, 403)
  const plan = await h.get('accountable-plan', t.morgan)
  assert.deepEqual(plan.lapsed.map(x => [x.item, x.daysAfterSpend, x.filedOn, x.nonAccountable]), [[lateItem.id, 75, today, null]])
  assert.ok(!plan.lapsed.some(x => x.item === onTime.id), 'the expense filed 10 days after the spend is within the plan')
  await h.post(`claims/${a.id}/items/${lateItem.id}/accountable-plan`, { reason: 'Filed after the 60-day window' }, t.sam, 403)
  const marked = await h.post(`claims/${a.id}/items/${lateItem.id}/accountable-plan`, { reason: 'Filed after the 60-day window' }, t.morgan)
  assert.deepEqual(marked.nonAccountable.map(x => [x.item, x.nonAccountable.by, x.nonAccountable.reason]), [[lateItem.id, 'morgan@harbourfinch.example', 'Filed after the 60-day window']])

  let batch = await h.post('batches', { claims: [a.id, c.id, s.id] }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 41200 + 6495 + 2010 + 3000 }, t.jordan)
  await h.post(`claims/${a.id}/items/${onTime.id}/accountable-plan`, { reason: 'Too late' }, t.morgan, 409)
  await h.paid(batch.id, batch.version, { reference: 'ACH-0820', paidOn: today }, t.jordan)
  // The files label the non-accountable expense and the taxable stipend as taxable pay, and flag the contractor; the payroll
  // handoff that carries taxable pay is PAY-003's.
  const table = async file => { const [head, ...rows] = (await h.send(`/api/coaster/batches/${batch.id}/${file}`, undefined, t.jordan)).text.trim().split('\r\n').map(r => r.slice(1, -1).split('","')); return rows.map(r => Object.fromEntries(head.map((k, i) => [k, r[i]]))) }
  const people = await table('reimbursements.csv'), lines = await table('accounting.csv')
  assert.deepEqual(people.map(p => [p.employee, p.amount, p.taxable_amount, p.form_1099_review]).sort(), [
    ['casey@harbourfinch.example', '20.10', '0.00', 'true'], ['sam@harbourfinch.example', '506.95', '442.00', 'false']])
  assert.deepEqual(lines.map(l => [l.merchant, l.taxable, l.form_1099_review]).sort(), [['Officeworks', 'false', 'false'], ['Phone stipend', 'true', 'false'], ['Qantas', 'true', 'false'], ['Uber', 'false', 'true']])
  const history = (await h.get('history')).lines
  assert.deepEqual(history.filter(l => l.action === 'expense-non-accountable').map(l => [l.actor_email, l.detail.item, l.detail.reason]), [['morgan@harbourfinch.example', lateItem.id, 'Filed after the 60-day window']])
}

// CLAIM-009 two expenses saved at the same moment against one cap are never reimbursed past it
async function serializeAllowanceConsumption() {
  // Both saves are held at the D1 edge once they have read what is left of the cap, until both have read it.
  let held = false, arrived = 0, bothRead
  const together = new Promise(resolve => { bothRead = resolve })
  const h = await harness({ d1Barrier: async request => {
    if (held && request.url.endsWith('/after-allowance-read')) { if (++arrived === 2) bothRead(); await Promise.race([together, new Promise(resolve => setTimeout(resolve, 10_000))]) }
    return new Response('open')
  } })
  try {
    const t = await agency(h)
    const cap = (await h.post('allowances', { name: 'Software', type: 'cap', period: 'monthly', amount: '100.00', startsOn: '2026-01-01' }, t.jordan)).all.find(a => a.name === 'Software')
    // Finance's merchant rule codes the expense, so the employee sends no coding of their own.
    await h.post('coding/automatic/rules', { version: (await h.get('coding/automatic/rules', t.morgan)).version, scope: 'finance', merchant: 'Figma', coding: { category: t.c.office }, active: true }, t.morgan)
    const expense = { kind: 'receipt', date: '2026-08-03', merchant: 'Figma', amount: '80.00', allowance: cap.id }
    const drafts = [await h.post('claims', { title: 'Design seat' }, t.sam), await h.post('claims', { title: 'Second design seat' }, t.sam)]
    held = true
    const saves = await Promise.all(drafts.map(c => h.send(`/api/coaster/claims/${c.id}/items`, { version: c.version, ...expense }, t.sam)))
    held = false
    assert.equal(arrived, 2, 'both saves read the same balance')
    assert.deepEqual(saves.map(r => r.status).sort(), [200, 409], 'the save that read a balance already spent is refused')
    const refused = drafts[saves.findIndex(r => r.status === 409)]
    const repriced = await h.post(`claims/${refused.id}/items`, { version: refused.version, ...expense }, t.sam)
    assert.deepEqual((await h.get(`claims/${repriced.id}`, t.sam)).items.map(i => [i.amount_minor, i.claimed_minor]), [[2000, 8000]], 'saved again, it is reimbursed only what is left and keeps its over-allowance')
    assert.equal((await h.get('allowances?day=2026-08-20', t.sam)).mine.find(a => a.name === 'Software').remaining_minor, 0)
  } finally { await h.close() }
}

export async function preserveClaimOperations() {
  await withAgency(itemizeExpenses)
  await withAgency(requireSpendPreapproval)
  await withAgency(labelAccountablePlanExpenses)
  await serializeAllowanceConsumption()
}
