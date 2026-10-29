// Original operations assertions, composed as named phases without test registrations.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness, receipt } from '../harness.mjs'
import { sha, sum, claim, submit, approve, central, deactivateAccount, unzip, everywhere, withAgency } from './operations-support.mjs'

// REPORT-001 spend groups by employee, category, merchant, cost centre and month with approved and pending apart, drills to the receipt, is scoped to a manager's people and saves views
async function groupScopedSpend(h, t) {
  const MORGAN = 'morgan@harbourfinch.example'
  const lee = await h.person('lee@harbourfinch.example', { employee: true, manager: true })
  await h.post('settings/members', { email: MORGAN, name: 'morgan', employee: true, finance: true, approver: 'lee@harbourfinch.example' })
  const r = (date, merchant, amount, category, fixture, extra = {}) => ({ kind: 'receipt', date, merchant, amount, allocations: [{ category }], receiptFixture: fixture, ...extra })
  // Six months of spend: approved, pending, a split across cost centres, and a draft that is not spend yet.
  await approve(h, t.priya, await submit(h, t.sam, await claim(h, t.sam, 'January lunch', [r('2026-01-14', 'Bistro', '64.50', t.c.meals, 'bistro')])))
  await approve(h, t.priya, await submit(h, t.sam, await claim(h, t.sam, 'March visit', [{ kind: 'mileage', date: '2026-03-03', merchant: 'Studio to client', distance: '100', allocations: [{ category: t.c.car }] }])))
  await approve(h, t.priya, await submit(h, t.alex, await claim(h, t.alex, 'February hotel', [{ kind: 'receipt', date: '2026-02-10', merchant: 'Hotel Ibis', amount: '236.00', allocations: [{ category: t.c.travel, amount: '200.00', costCentre: 'Sales' }, { category: t.c.travel, amount: '36.00', costCentre: 'Ops' }], receiptFixture: 'hotel' }])))
  await submit(h, t.alex, await claim(h, t.alex, 'June trip', [{ kind: 'per_diem', date: '2026-06-08', days: 2, allocations: [{ category: t.c.travel }] }]))
  await approve(h, lee, await submit(h, t.morgan, await claim(h, t.morgan, 'April paper', [r('2026-04-21', 'Officeworks', '64.95', t.c.office, 'officeworks')])))
  await submit(h, t.sam, await claim(h, t.sam, 'May ride', [r('2026-05-30', 'Uber', '30.00', t.c.travel, 'uber')]))
  await claim(h, t.alex, 'Unsent', [{ kind: 'mileage', date: '2026-05-01', merchant: 'Drive', distance: '10', allocations: [{ category: t.c.car }] }])
  const view = (by, cookie = t.jordan, extra = {}) => h.get(`spend?${new URLSearchParams({ by, from: '2026-01-01', to: '2026-06-30', ...extra })}`, cookie)
  const rows = res => res.groups.map(g => [g.label, g.approvedMinor, g.pendingMinor, g.totalMinor])

  const total = 6450 + 8800 + 23600 + 15000 + 6495 + 3000
  assert.deepEqual(rows(await view('employee')), [['alex', 23600, 15000, 38600], ['sam', 6450 + 8800, 3000, 18250], ['morgan', 6495, 0, 6495]])
  assert.deepEqual(rows(await view('category')), [['Travel', 23600, 15000 + 3000, 41600], ['Car', 8800, 0, 8800], ['Office supplies', 6495, 0, 6495], ['Meals', 6450, 0, 6450]])
  assert.deepEqual(rows(await view('cost-centre')), [['No cost centre', 6450 + 8800 + 6495, 15000 + 3000, total - 23600], ['Sales', 20000, 0, 20000], ['Ops', 3600, 0, 3600]])
  assert.deepEqual(rows(await view('month')).map(g => [g[0], g[3]]), [['2026-01', 6450], ['2026-02', 23600], ['2026-03', 8800], ['2026-04', 6495], ['2026-05', 3000], ['2026-06', 15000]])
  for (const by of ['employee', 'category', 'merchant', 'cost-centre', 'month']) assert.equal((await view(by)).totalMinor, total, `${by} adds up to all spend`)

  // Drill from a category to its lines and open the very receipt.
  const travel = await view('category', t.jordan, { key: t.c.travel })
  assert.deepEqual(travel.lines.map(l => [l.date, l.merchant, l.amountMinor, l.status]).sort(), [['2026-02-10', 'Hotel Ibis', 3600, 'approved'], ['2026-02-10', 'Hotel Ibis', 20000, 'approved'], ['2026-05-30', 'Uber', 3000, 'pending'], ['2026-06-08', 'Per diem', 15000, 'pending']].sort())
  const hotel = travel.lines.find(l => l.merchant === 'Hotel Ibis')
  const bytes = Buffer.from(await (await h.mf.dispatchFetch(`${h.origin}${hotel.receiptLink}`, { headers: { cookie: t.jordan } })).arrayBuffer())
  assert.equal(sha(bytes), sha(await readFile('tests/fixtures/receipts/hotel.png')))

  // A manager sees only the people they approve for; an employee sees none.
  assert.deepEqual(rows(await view('employee', t.priya)).map(g => g[0]), ['alex', 'sam'])
  assert.deepEqual(rows(await view('employee', lee)).map(g => g[0]), ['morgan'])
  assert.deepEqual((await view('category', lee, { key: t.c.travel })).lines, [], 'drilling cannot reach outside the scope')
  assert.equal((await h.send('/api/coaster/spend?by=employee&from=2026-01-01&to=2026-06-30', undefined, t.sam)).status, 403)

  // Save a view and reopen it; it is the saver's own.
  const views = await h.post('spend-views', { name: 'Q1 by category', by: 'category', from: '2026-01-01', to: '2026-03-31' }, t.priya)
  const reopened = await h.get(`spend?view=${views[0].id}`, t.priya)
  assert.deepEqual([reopened.by, reopened.from, reopened.to, reopened.totalMinor], ['category', '2026-01-01', '2026-03-31', 6450 + 8800 + 23600])
  assert.deepEqual(reopened.views.map(v => v.name), ['Q1 by category'])
  await h.get(`spend?view=${views[0].id}`, lee, 404)
}

// REPORT-004 budgets count spend from submission by period, alert the owner and finance once per threshold, flag an expense that would go over, reset each period and show in spend
async function alertPeriodBudgets(h, t) {
  const PRIYA = 'priya@harbourfinch.example', JORDAN = 'jordan@harbourfinch.example', MORGAN = 'morgan@harbourfinch.example'
  // A US business: saved with no currency named, it is in USD (LOCALE-001), on Central time.
  await h.post('settings/business', { name: 'Harbour & Finch Studio', timezone: 'America/Chicago', perDiem: '75.00', receiptThreshold: '' })
  assert.equal((await h.get('state')).business.currency, 'USD')
  const travelBudget = { name: 'Travel', scope: 'category', scopeKey: t.c.travel, period: 'monthly', amount: '5000.00', owner: PRIYA, thresholds: '80, 100', policyRule: true }
  await h.post('budgets', travelBudget, t.sam, 403)
  await h.post('budgets', { ...travelBudget, thresholds: '100, 80' }, t.jordan, 400)
  let list = await h.post('budgets', travelBudget, t.jordan)
  list = await h.post('budgets', { name: 'Meals per person', scope: 'category', scopeKey: t.c.meals, period: 'monthly', amount: '200.00', owner: JORDAN, thresholds: '80, 100', perMember: true }, t.jordan)
  const travel = list.find(b => b.name === 'Travel')
  const r = (date, merchant, amount, category, fixture, extra = {}) => ({ kind: 'receipt', date, merchant, amount, allocations: [{ category }], receiptFixture: fixture, ...extra })
  await approve(h, t.priya, await submit(h, t.sam, await claim(h, t.sam, 'Client visit', [r('2026-06-03', 'Uber', '1000.00', t.c.travel, 'uber')])))
  await submit(h, t.alex, await claim(h, t.alex, 'Sales trip', [r('2026-06-10', 'Hotel Ibis', '3100.00', t.c.travel, 'hotel')]))
  await approve(h, t.priya, await submit(h, t.sam, await claim(h, t.sam, 'Team lunch', [r('2026-06-12', 'Bistro', '150.00', t.c.meals, 'bistro', { explanation: 'Client lunch' })])), { acknowledge: true })
  await submit(h, t.alex, await claim(h, t.alex, 'Offsite lunch', [r('2026-06-15', 'Officeworks cafe', '250.00', t.c.meals, 'officeworks', { explanation: 'Offsite' })]))

  const worker = await h.mf.getWorker()
  const tick = async day => { const before = h.messages.length; await worker.scheduled({ scheduledTime: central(day, 9), cron: '17 * * * *' }); return h.messages.slice(before).filter(m => m.subject.startsWith('Budget alert: ')).map(m => [m.to, m.subject, /for (\S+@\S+) has/.exec(m.text)?.[1] ?? null]) }

  // $4,100 of June travel: one 80% alert to the budget's owner and finance; only Alex is over the per-person meals budget.
  assert.deepEqual(await tick('2026-06-30'), [
    [[JORDAN, MORGAN], 'Budget alert: Meals per person at 100%', 'alex@harbourfinch.example'],
    [[PRIYA, JORDAN, MORGAN], 'Budget alert: Travel at 80%', null],
  ])
  const alertText = h.messages.filter(m => m.subject.startsWith('Budget alert: ')).map(m => m.text + m.html).join(' ')
  assert.ok(!/\$|4,?100|5,?000/.test(alertText), 'by default an alert names the percentage and period, never amounts')
  assert.deepEqual(await tick('2026-06-30'), [], 'once per threshold and period')
  const june = await h.get('budgets?day=2026-06-30', t.jordan)
  const tb = june.find(b => b.name === 'Travel')
  assert.deepEqual([tb.period_key, tb.budgetMinor, tb.actualMinor, tb.percent, tb.approvedMinor, tb.pendingMinor, tb.remainingMinor], ['2026-06', 500000, 410000, 82, 100000, 310000, 90000])
  assert.deepEqual(june.find(b => b.name === 'Meals per person').members.map(m => [m.member, m.actualMinor, m.percent]), [['alex@harbourfinch.example', 25000, 125], ['sam@harbourfinch.example', 15000, 75]])

  // The next travel claim would take it past $5,000: a soft exception the approver sees, then the 100% alert.
  const over = await claim(h, t.sam, 'Conference', [{ kind: 'per_diem', date: '2026-06-22', days: 14, allocations: [{ category: t.c.travel }] }])
  await h.post(`claims/${over.claim.id}/submit`, { version: over.claim.version }, t.sam, 409)
  await h.post(`claims/${over.claim.id}/items`, { version: over.claim.version, item: over.items[0].id, kind: 'per_diem', date: '2026-06-22', days: 14, allocations: [{ category: t.c.travel }], explanation: 'Conference week' }, t.sam)
  const sent = await submit(h, t.sam, await h.get(`claims/${over.claim.id}`, t.sam))
  assert.deepEqual((await h.get(`claims/${sent.id}`, t.priya)).revisions[0].snapshot.exceptions.map(e => [e.code, e.message]), [['over-budget', 'Over the Travel budget of $5,000.00 for 2026-06']])
  assert.deepEqual(await tick('2026-06-30'), [[[PRIYA, JORDAN, MORGAN], 'Budget alert: Travel at 100%', null]])

  // Only the owner may let a budget's alerts carry amounts.
  const allSpend = { name: 'All spend', scope: 'entity', period: 'monthly', amount: '1000.00', owner: JORDAN, thresholds: '100', alertAmounts: true }
  await h.post('budgets', allSpend, t.jordan, 403)
  await h.post('budgets', allSpend)
  assert.deepEqual(await tick('2026-06-30'), [[[JORDAN, MORGAN], 'Budget alert: All spend at 100%', null]])
  assert.match(h.messages.findLast(m => m.subject === 'Budget alert: All spend at 100%').text, /has reached 100% of its budget \(\$5,550\.00 of \$1,000\.00\) for 2026-06/)

  // July starts at zero with no repeat alert; spend analytics shows budget against actual.
  assert.deepEqual(await tick('2026-07-01'), [])
  assert.equal((await h.get('budgets?day=2026-07-01', t.jordan)).find(b => b.name === 'Travel').actualMinor, 0)
  const spendView = await h.get('spend?by=category&from=2026-06-01&to=2026-06-30', t.jordan)
  assert.deepEqual(spendView.budgets.filter(b => b.name === 'Travel').map(b => [b.actualMinor, b.remainingMinor]), [[515000, -15000]])

  // A change is the next version; budgets import from CSV, all rows or none.
  const v2 = await h.post('budgets', { ...travelBudget, id: travel.id, amount: '6000.00' }, t.jordan)
  assert.deepEqual(v2.filter(b => b.id === travel.id).map(b => [b.version, b.amount_minor]), [[2, 600000]])
  const header = 'name,scope,scopeKey,period,amount,owner,thresholds,perMember,policyRule'
  await h.post('budgets/import', { csv: `${header}\nOffice,category,${t.c.office},quarterly,900.00,${JORDAN},100,no,no\nBad,planet,,monthly,10.00,${JORDAN},100,no,no\n` }, t.jordan, 400)
  const imported = await h.post('budgets/import', { csv: `${header}\nOffice,category,${t.c.office},quarterly,900.00,${JORDAN},100,no,no\nEverything,entity,,yearly,250000.00,${JORDAN},"50,90",no,no\n` }, t.jordan)
  assert.deepEqual(imported.map(b => b.name).sort(), ['All spend', 'Everything', 'Meals per person', 'Office', 'Travel'])
}

// POLICY-003 finance works one queue of open exceptions across claims by risk or age, and a 10% audit sample takes a recorded finding
async function reviewExceptionsAndSamples(h, t) {
  const expense = (merchant, amount, extra = {}) => ({ kind: 'receipt', date: '2026-06-10', merchant, amount, allocations: [{ category: t.c.office }], explanation: 'Explained to the approver', ...extra })
  const filed = []
  // Five claims, each with a different exception, submitted oldest first.
  filed.push(await submit(h, t.sam, await claim(h, t.sam, 'No receipt', [expense('Corner shop', '20.00')])))
  filed.push(await submit(h, t.alex, await claim(h, t.alex, 'Big dinner', [expense('Rockpool', '180.00', { allocations: [{ category: t.c.meals }], receiptFixture: 'bistro' })])))
  filed.push(await submit(h, t.morgan, await claim(h, t.morgan, 'Same receipt one', [expense('Officeworks', '30.00', { receiptFixture: 'officeworks' })])))
  filed.push(await submit(h, t.sam, await claim(h, t.sam, 'Same receipt two', [expense('Officeworks again', '31.00', { receiptFixture: 'officeworks' })])))
  filed.push(await submit(h, t.alex, await claim(h, t.alex, 'Taxi', [expense('Taxi', '15.00', { date: '2026-06-11' })])))
  await h.get('exceptions', t.sam, 403)
  let queue = await h.get('exceptions', t.jordan)
  assert.deepEqual(queue.open.map(x => [x.number, x.code, x.risk]), [['CL-0004', 'duplicate-receipt', 5], ['CL-0002', 'over-limit', 3], ['CL-0001', 'missing-receipt', 2], ['CL-0005', 'missing-receipt', 2], ['CL-0004', 'same-receipt', 1]])
  assert.deepEqual((await h.get('exceptions?sort=age', t.jordan)).open.map(x => x.number), ['CL-0001', 'CL-0002', 'CL-0004', 'CL-0004', 'CL-0005'])
  const top = queue.open[0]
  await h.post('exceptions/review', { claim: top.claim, revision: top.revision, item: top.item, code: top.code, note: '' }, t.jordan, 400)
  await h.post('exceptions/review', { claim: top.claim, revision: top.revision, item: top.item, code: top.code, note: 'Two different purchases on one receipt; confirmed with sam' }, t.sam, 403)
  queue = await h.post('exceptions/review', { claim: top.claim, revision: top.revision, item: top.item, code: top.code, note: 'Two different purchases on one receipt; confirmed with sam' }, t.jordan)
  assert.ok(!queue.open.some(x => x.number === 'CL-0004' && x.code === 'duplicate-receipt'), 'a reviewed exception leaves the queue')
  assert.ok(queue.open.some(x => x.number === 'CL-0004' && x.code === 'same-receipt' && x.signal), 'the separate unreviewed receipt signal stays visible')
  await h.post('exceptions/review', { claim: top.claim, revision: top.revision, item: top.item, code: top.code, note: 'Again' }, t.jordan, 409)
  assert.equal((await h.get(`claims/${top.claim}`, t.sam)).events.at(-1).action, 'exception-reviewed')

  // A 10% sample: exactly one of every ten approvals, the tenth.
  await h.post('settings/audit-sample', { percent: '10' }, t.sam, 403)
  await h.post('settings/audit-sample', { percent: '150' }, t.jordan, 400)
  await h.post('settings/audit-sample', { percent: '10' }, t.jordan)
  const approved = []
  for (const c of filed) approved.push(await approve(h, t.priya, c, { acknowledge: true }))
  for (let n = 6; n <= 10; n++) approved.push(await approve(h, t.priya, await submit(h, t.alex, await claim(h, t.alex, `Paper ${n}`, [{ kind: 'mileage', date: '2026-06-12', merchant: `Site visit ${n}`, distance: String(n), allocations: [{ category: t.c.car }] }]))))
  queue = await h.get('exceptions', t.jordan)
  assert.deepEqual(queue.samples.map(s => [s.claim_id, s.ordinal, s.percent]), [[approved[9].id, 10, 10]])
  const sample = queue.samples[0]
  await h.post('audit-samples/finding', { claim: sample.claim_id, revision: sample.revision, outcome: 'issue', finding: '' }, t.jordan, 400)
  await h.post('audit-samples/finding', { claim: approved[0].id, revision: 1, outcome: 'clean' }, t.jordan, 404)
  queue = await h.post('audit-samples/finding', { claim: sample.claim_id, revision: sample.revision, outcome: 'issue', finding: 'Mileage logged without a route; asked for the trip log' }, t.jordan)
  assert.deepEqual([queue.samples[0].outcome, queue.samples[0].finding, queue.samples[0].finding_by], ['issue', 'Mileage logged without a route; asked for the trip log', 'jordan@harbourfinch.example'])
  await h.post('audit-samples/finding', { claim: sample.claim_id, revision: sample.revision, outcome: 'clean' }, t.jordan, 409)
  await assert.rejects(h.db.prepare("UPDATE c_audit_samples SET finding='rewritten' WHERE claim_id=?").bind(sample.claim_id).run(), /permanent/)
  assert.ok((await h.get(`claims/${sample.claim_id}`, t.alex)).events.some(e => e.action === 'audit-finding-recorded'))
}

// ACCT-005 a batch and a period export as CSV and XLSX through a saved column template and as QuickBooks Desktop IIF, naming each receipt by hash and link
async function exportReconciledAccounting(h, t) {
  const one = await claim(h, t.sam, 'Perth pitch', [{ kind: 'receipt', date: '2026-06-04', merchant: 'Qantas', amount: '412.00', allocations: [{ category: t.c.travel, amount: '400.00' }, { category: t.c.meals, amount: '12.00' }], receiptFixture: 'hotel' }])
  const two = await claim(h, t.alex, 'Studio paper', [{ kind: 'receipt', date: '2026-06-05', merchant: 'Officeworks', amount: '64.95', allocations: [{ category: t.c.office }], receiptFixture: 'officeworks' }])
  const a = await approve(h, t.priya, await submit(h, t.sam, one)), b = await approve(h, t.priya, await submit(h, t.alex, two))
  let batch = await h.post('batches', { claims: [a.id, b.id] }, t.morgan)
  const total = 41200 + 6495
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: total }, t.jordan)
  const file = async (path, cookie = t.jordan, status = 200) => { const r = await h.mf.dispatchFetch(`${h.origin}/api/coaster/${path}`, { headers: { cookie } }); assert.equal(r.status, status, path); return r }
  const rowsOf = text => text.trim().split('\r\n').map(r => r.split('","').map(x => x.replace(/^"|"$/g, '')))

  // A saved template picks, orders and names the columns; only finance saves one.
  const columns = [{ field: 'date', header: 'Date' }, { field: 'account_code', header: 'Account' }, { field: 'amount', header: 'Amount' }, { field: 'receipt_sha256', header: 'Receipt SHA-256' }, { field: 'receipt_link', header: 'Receipt' }]
  await h.post('export-templates', { name: 'Ledger import', kind: 'accounting', columns }, t.sam, 403)
  await h.post('export-templates', { name: 'Ledger import', kind: 'accounting', columns: [{ field: 'password' }] }, t.morgan, 400)
  const template = await h.post('export-templates', { name: 'Ledger import', kind: 'accounting', columns }, t.morgan)
  const custom = rowsOf(await (await file(`batches/${batch.id}/accounting.csv?template=${template.id}`)).text())
  assert.deepEqual(custom[0], ['Date', 'Account', 'Amount', 'Receipt SHA-256', 'Receipt'])
  assert.equal(custom.length, 1 + 3)
  assert.equal(Math.round(custom.slice(1).reduce((n, r) => n + Number(r[2]) * 100, 0)), total)
  const hotel = await readFile('tests/fixtures/receipts/hotel.png')
  const linked = custom.find(r => r[3] === sha(hotel))
  assert.ok(linked[4].startsWith(`${h.origin}/api/coaster/receipts/`))
  assert.equal(sha(Buffer.from(await (await file(linked[4].slice(h.origin.length + '/api/coaster/'.length))).arrayBuffer())), sha(hotel), 'the link opens the very receipt the hash names')
  const standard = rowsOf(await (await file(`batches/${batch.id}/accounting.csv`)).text())
  assert.ok(['receipt_sha256', 'receipt_link', 'amount'].every(c => standard[0].includes(c)), 'the default template keeps every field')

  // XLSX: the same lines as numbers in a workbook.
  const book = await file(`batches/${batch.id}/accounting.xlsx?template=${template.id}`)
  assert.equal(book.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  const sheet = unzip(Buffer.from(await book.arrayBuffer()))['xl/worksheets/sheet1.xml'].toString()
  assert.match(sheet, /<t xml:space="preserve">Receipt SHA-256<\/t>/)
  const amounts = [...sheet.matchAll(/<c r="C\d+"><v>([\d.]+)<\/v><\/c>/g)].map(m => Number(m[1]))
  assert.equal(Math.round(amounts.reduce((n, v) => n + v * 100, 0)), total)
  const people = unzip(Buffer.from(await (await file(`batches/${batch.id}/reimbursements.xlsx`)).arrayBuffer()))['xl/worksheets/sheet1.xml'].toString()
  assert.match(people, /sam@harbourfinch\.example/)

  // IIF, checked by a fixture validator: each bill balances, splits post to the category accounts, totals match.
  const iif = (await (await file(`batches/${batch.id}/accounting.iif`)).text()).trim().split('\r\n').map(l => l.split('\t'))
  assert.deepEqual(iif.slice(0, 3).map(l => l[0]), ['!TRNS', '!SPL', '!ENDTRNS'])
  let open = null, splits = 0
  const bills = []
  for (const l of iif.slice(3)) {
    if (l[0] === 'TRNS') { assert.equal(open, null); open = { amount: Math.round(Number(l[6]) * 100), lines: 0, account: l[4], name: l[5], doc: l[7] } }
    else if (l[0] === 'SPL') { open.amount += Math.round(Number(l[6]) * 100); open.lines++; splits += Math.round(Number(l[6]) * 100); assert.ok(['6200', '6300', '6500'].includes(l[4]), l[4]) }
    else { assert.equal(l[0], 'ENDTRNS'); assert.equal(open.amount, 0, 'each bill balances'); bills.push(open); open = null }
  }
  assert.equal(splits, total)
  assert.deepEqual(bills.map(x => [x.account, x.name, x.doc, x.lines]), [['Accounts Payable', 'sam', 'CL-0001', 2], ['Accounts Payable', 'alex', 'CL-0002', 1]])
  await file(`batches/${batch.id}/reimbursements.iif`, t.jordan, 404)

  // A period: every batch reviewed in it; finance and auditors only.
  const period = rowsOf(await (await file('exports/accounting.csv?from=2026-01-01&to=2099-12-31')).text())
  assert.equal(Math.round(period.slice(1).reduce((n, r) => n + Number(r[period[0].indexOf('amount')]) * 100, 0)), total)
  assert.equal(rowsOf(await (await file('exports/accounting.csv?from=2020-01-01&to=2020-12-31')).text()).length, 1, 'a period with no reviewed batch has only the header')
  await file('exports/accounting.csv?from=2026-02-01&to=2026-01-01', t.jordan, 400)
  await file('exports/accounting.csv?from=2026-01-01&to=2099-12-31', t.sam, 403)
  const events = (await h.get(`batches/${batch.id}`, t.jordan)).events.filter(e => e.action === 'batch-exported').map(e => e.detail.format)
  assert.deepEqual(events, ['csv', 'csv', 'xlsx', 'xlsx', 'iif'])
}

export async function preserveFinanceAnalysis() {
  await withAgency(groupScopedSpend)
  await withAgency(alertPeriodBudgets)
  await withAgency(reviewExceptionsAndSamples)
  await withAgency(exportReconciledAccounting)
}
