// Original operations assertions, composed as named phases without test registrations.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness, receipt } from '../harness.mjs'
import { sha, sum, claim, submit, approve, central, deactivateAccount, unzip, everywhere, withAgency } from './operations-support.mjs'

// REPORT-002 finance runs reimbursement aging, approval cycle time, receipt compliance, unsubmitted spend and exception trends, each matching the records and exportable as CSV
async function deliverOperationalReports(h, t) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const run = (name, cookie = t.jordan, status) => h.get(`reports/${name}?from=${today}&to=${today}`, cookie, status)
  const lunch = await claim(h, t.sam, 'Client lunch', [
    { kind: 'receipt', date: '2026-06-01', merchant: 'Bistro', amount: '40.00', allocations: [{ category: t.c.meals }], receiptFixture: 'bistro' },
    { kind: 'receipt', date: '2026-06-01', merchant: 'Taxi', amount: '20.00', allocations: [{ category: t.c.travel }], explanation: 'Driver had no printer' },
  ])
  const a = await approve(h, t.priya, await submit(h, t.sam, lunch), { acknowledge: true })
  let batch = await h.post('batches', { claims: [a.id] }, t.morgan)
  // The approver holds the mileage and approves the paper: the held claim ages from its hold (APPROVE-005).
  const paper = await submit(h, t.sam, await claim(h, t.sam, 'Paper', [{ kind: 'receipt', date: '2026-06-02', merchant: 'Officeworks', amount: '64.95', allocations: [{ category: t.c.office }], receiptFixture: 'officeworks' }, { kind: 'mileage', date: '2026-06-02', merchant: 'Studio to store', distance: '5', allocations: [{ category: t.c.car }] }]))
  const d = await approve(h, t.priya, paper, { hold: [(await h.get(`claims/${paper.id}`, t.sam)).items[1].id], reason: 'Which store?' })
  const held = await h.get(`claims/${(await h.get(`claims/${d.id}`, t.priya)).revisions.at(-1).snapshot.split.heldClaim}`, t.sam)
  const b = await submit(h, t.alex, await claim(h, t.alex, 'Hotel', [{ kind: 'receipt', date: '2026-06-03', merchant: 'Hotel Ibis', amount: '150.00', allocations: [{ category: t.c.travel }], receiptFixture: 'hotel' }]))
  await h.post(`claims/${b.id}/decision`, { revision: b.revision, version: b.version, decision: 'returned', reason: 'Wrong dates' }, t.priya)
  await claim(h, t.alex, 'Site visit', [{ kind: 'mileage', date: '2026-06-04', merchant: 'Studio to site', distance: '10', allocations: [{ category: t.c.car }] }])
  await submit(h, t.morgan, await claim(h, t.morgan, 'Team dinner', [{ kind: 'receipt', date: '2026-06-05', merchant: 'Uber Eats', amount: '130.00', allocations: [{ category: t.c.meals }], receiptFixture: 'uber', explanation: 'Whole team' }]))

  // Reports are for finance, auditors and the owner; the period must make sense.
  await run('aging', t.sam, 403); await run('aging', t.priya, 403); await run('payroll', t.jordan, 404)
  await h.get(`reports/aging?from=${today}&to=2020-01-01`, t.jordan, 400)

  // Aging: every approved claim not yet paid, from its approval.
  const aging = await run('aging')
  const number = c => `CL-${String(c.number).padStart(4, '0')}`
  assert.deepEqual(aging.rows.map(r => [r[0], r[3], r[4], r[5], r[6]]).sort(), [[number(a), 0, '0–7 days', 'batched', '60.00'], [number(d), 0, '0–7 days', 'approved', '64.95'], [number(held.claim), 0, '0–7 days', 'held', '4.40']].sort())
  assert.deepEqual([aging.totals.claims, aging.totals.amountMinor, aging.totals.buckets['0–7 days'].claims], [3, 6000 + 6495 + 440, 3])
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 6000 }, t.jordan)
  await h.paid(batch.id, batch.version, { reference: 'ACH-1', paidOn: today }, t.jordan)
  assert.deepEqual((await run('aging')).totals.amountMinor, 6495 + 440, 'a paid claim leaves the aging report')

  // Cycle time: each decision timed from its revision's submission, per approver.
  const decisions = (await Promise.all([a, d, b].map(c => h.get(`claims/${c.id}`, t.jordan)))).flatMap(x => x.decisions.map(dec => ({ ...dec, submitted: x.revisions.find(r => r.revision === dec.revision).submitted_at })))
  const hours = decisions.map(x => (Date.parse(x.at) - Date.parse(x.submitted)) / 3_600_000).sort((x, y) => x - y), tenth = x => Math.round(x * 10) / 10
  const middle = hours.length % 2 ? hours[hours.length >> 1] : (hours[hours.length / 2 - 1] + hours[hours.length / 2]) / 2
  const count = kind => decisions.filter(x => x.decision === kind).length
  const cycle = await run('cycle-time')
  assert.deepEqual(cycle.rows, [['priya@harbourfinch.example', decisions.length, count('approved'), count('returned'), 0, tenth(hours.reduce((n, x) => n + x, 0) / hours.length), tenth(middle), tenth(hours.at(-1)), 0]], 'decided the day they were submitted: none over the service level')
  assert.equal(count('returned'), 1)

  // Receipt compliance: receipt expenses on each claim's latest submitted revision.
  const receipts = await run('receipts')
  assert.deepEqual(receipts.rows, [['alex@harbourfinch.example', 1, 1, 0, 0, 100], ['morgan@harbourfinch.example', 1, 1, 0, 0, 100], ['sam@harbourfinch.example', 3, 2, 1, 1, 66.7]])
  assert.deepEqual(receipts.totals, { expenses: 5, withReceipt: 4, missingExceptions: 1, ratePercent: 80 })

  // Unsubmitted spend: draft and returned claims' expenses dated by the period's end.
  const unsubmitted = await run('unsubmitted')
  assert.deepEqual(unsubmitted.rows, [['alex@harbourfinch.example', 2, 2, '2026-06-03', '158.80'], ['sam@harbourfinch.example', 1, 1, '2026-06-02', '4.40']], 'a held claim is back with its employee')

  // Exception trends: by month submitted and exception.
  const trends = await run('exceptions')
  assert.deepEqual(trends.rows, [[today.slice(0, 7), 'missing-receipt', 1, '20.00'], [today.slice(0, 7), 'over-limit', 1, '130.00']])

  // Each exports as CSV with a totals row equal to the report.
  const file = await h.mf.dispatchFetch(`${h.origin}/api/coaster/reports/receipts?from=${today}&to=${today}&format=csv`, { headers: { cookie: t.jordan } })
  assert.equal(file.headers.get('content-type'), 'text/csv; charset=utf-8')
  const rows = (await file.text()).trim().split('\r\n').map(r => r.split(',').map(x => x.replace(/^"|"$/g, '')))
  assert.deepEqual([rows[0], rows.at(-1)], [receipts.columns, ['Total', '5', '4', '1', '1', '80']])

  // Scheduled delivery to people who may read reports: on the last US business day, from 08:00 business time, once a period.
  const JORDAN = 'jordan@harbourfinch.example', MORGAN = 'morgan@harbourfinch.example'
  await h.post('report-schedules', { report: 'unsubmitted', cadence: 'last-business-day', recipients: JORDAN }, t.sam, 403)
  await h.post('report-schedules', { report: 'unsubmitted', cadence: 'last-business-day', recipients: 'sam@harbourfinch.example' }, t.jordan, 400)
  const [schedule] = await h.post('report-schedules', { report: 'unsubmitted', cadence: 'last-business-day', recipients: `${JORDAN}, ${MORGAN}` }, t.jordan)
  const sydney = (day, hour) => {
    const guess = Date.parse(`${day}T${String(hour).padStart(2, '0')}:17:00Z`)
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map(x => [x.type, x.value]))
    return new Date(guess - (Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - guess))
  }
  const worker = await h.mf.getWorker()
  // The same hourly run also chases and escalates open items (FOLLOWUP-001/002); only report mail is counted here.
  const tick = async (day, hour) => { const before = h.messages.length; await worker.scheduled({ scheduledTime: sydney(day, hour), cron: '17 * * * *' }); return h.messages.slice(before).filter(m => / \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/.test(m.subject)) }
  assert.deepEqual(await tick('2026-10-29', 9), [], 'Thursday is not the last business day')
  assert.deepEqual(await tick('2026-10-30', 7), [], 'not before 08:00')
  const sent = await tick('2026-10-30', 8)
  assert.deepEqual(sent.map(m => [m.to, m.subject]), [[[JORDAN, MORGAN], 'Unsubmitted spend for accruals: 2026-10-01 to 2026-10-30']], 'Friday 30 October: the 31st is a Saturday')
  const link = sent[0].text.match(/https?:\/\/\S+/)[0]
  assert.ok(!/163\.20|158\.80|alex@/.test(sent[0].text + sent[0].html), 'the mail carries no figures or names, only the link')
  const delivered = await h.mf.dispatchFetch(link, { headers: { cookie: t.jordan } })
  assert.equal(delivered.status, 200)
  assert.equal((await delivered.text()).trim().split('\r\n').at(-1), '"Total","3","3","","163.20"', 'the delivered link opens the report for the period')
  assert.equal((await h.mf.dispatchFetch(link)).status, 401, 'the link needs a Coaster sign-in')
  assert.deepEqual(await tick('2026-10-30', 9), [], 'once a period')
  assert.deepEqual(await tick('2027-05-31', 9), [], 'Memorial Day is not a business day')
  assert.equal((await tick('2027-05-28', 8)).length, 1)
  assert.ok((await h.get('history?q=report-delivered', t.jordan)).lines.length >= 2)
  // Only the owner opts a schedule in to sending the figures, attached as CSV (first business day, for the month before).
  await h.post('report-schedules', { report: 'unsubmitted', cadence: 'first-business-day', recipients: JORDAN, includeFigures: true }, t.jordan, 403)
  await h.post('report-schedules', { report: 'unsubmitted', cadence: 'first-business-day', recipients: JORDAN, includeFigures: true })
  const [figures] = await tick('2026-12-01', 8)
  assert.equal(figures.subject, 'Unsubmitted spend for accruals: 2026-11-01 to 2026-11-30')
  assert.deepEqual(figures.attachments.map(a => [a.filename, Buffer.from(a.content, 'base64').toString().trim().split('\r\n').at(-1)]), [['coaster-unsubmitted-2026-11-01-to-2026-11-30.csv', '"Total","3","3","","163.20"']])
  await h.post(`report-schedules/${schedule.id}/stop`, {}, t.jordan)
  assert.deepEqual(await tick('2027-06-30', 9), [], 'a stopped schedule sends nothing')
}

// REPORT-002 a scheduled report with its figures stops reaching a recipient once their sign-in account is deactivated
async function excludeInactiveReportRecipients(h, t) {
  const JORDAN = 'jordan@harbourfinch.example', MORGAN = 'morgan@harbourfinch.example'
  await h.post('report-schedules', { report: 'unsubmitted', cadence: 'first-business-day', recipients: `${JORDAN}, ${MORGAN}`, includeFigures: true })
  await deactivateAccount(h, MORGAN)
  const before = h.messages.length
  // 09:17 on Tuesday 1 December 2026 in Sydney, the first business day of the month.
  await (await h.mf.getWorker()).scheduled({ scheduledTime: new Date('2026-11-30T22:17:00Z'), cron: '17 * * * *' })
  const sent = h.messages.slice(before).filter(m => m.subject === 'Unsubmitted spend for accruals: 2026-11-01 to 2026-11-30')
  assert.deepEqual(sent.map(m => [m.to, m.attachments.length]), [[[JORDAN], 1]], 'only recipients who can still sign in receive the figures')
}

// REPORT-003 history is searchable across a claim's capture, approval and payment; an auditor reads everything, changes nothing and exports a period's audit pack
async function exportSearchableAuditHistory(h, t) {
  const audrey = await h.person('audrey@harbourfinch.example', { auditor: true })
  const key = await h.post('agent-keys', { label: 'Receipt inbox agent' }, t.sam)
  const proposal = await h.send('/api/coaster/agent/claims', { title: 'Sydney client visit', items: [{ kind: 'receipt', date: '2026-05-09', merchant: 'Uber', amount: '38.60', allocations: [{ category: t.c.travel }], receipt: await receipt('uber') }] }, '', { authorization: `Bearer ${key.token}` })
  let c = (await h.post(`proposals/${proposal.value.id}/accept`, {}, t.sam)).claim
  const lunch = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...(await receipt('bistro')) }, t.sam)
  c = await h.post(`claims/${c.id}/items`, { version: lunch.claim.version, kind: 'receipt', date: '2026-05-09', merchant: 'Harbour View Bistro', amount: '150.00', receipt: lunch.receipt, allocations: [{ category: t.c.meals }], explanation: 'Client lunch for three' }, t.sam)
  c = await approve(h, t.priya, await h.post(`claims/${c.id}/submit`, { version: c.version }, t.sam), { acknowledge: true })
  let batch = await h.post('batches', { claims: [c.id] }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 18860 }, t.jordan)
  batch = await h.paid(batch.id, batch.version, { reference: 'ACH-2026-0517', paidOn: '2026-05-17' }, t.jordan)
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
}

export async function preserveReporting() {
  await withAgency(deliverOperationalReports)
  await withAgency(excludeInactiveReportRecipients)
  await withAgency(exportSearchableAuditHistory)
}
