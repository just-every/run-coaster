// Original operations assertions, composed as named phases without test registrations.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness, receipt } from '../harness.mjs'
import { sha, sum, claim, submit, approve, central, deactivateAccount, unzip, everywhere, withAgency } from './operations-support.mjs'

// MOVE-004 Ramp, Brex and Navan card exports come in as read-only history with receipts, memos and coding, flag a re-claim and undo
async function importCardHistory(h, t) {
  const SAM = 'sam@harbourfinch.example', ALEX = 'alex@harbourfinch.example'
  await h.post('settings/business', { name: 'Harbour & Finch Studio', timezone: 'America/Chicago', perDiem: '75.00', receiptThreshold: '75.00' })
  const csv = await readFile('tests/fixtures/ramp-transactions.csv', 'utf8')
  const uber = await readFile('tests/fixtures/receipts/uber.png'), bistro = await readFile('tests/fixtures/receipts/bistro.png')
  const receipts = [{ name: 'RT-1001.png', base64: uber.toString('base64') }, { name: 'RT-1002.png', base64: bistro.toString('base64') }]
  const ramp = { source: 'ramp', csv, filename: 'ramp.csv', mapping: { date: 'YYYY-MM-DD' } }
  await h.post('import/preview', { ...ramp, receipts }, t.jordan, 403)
  let preview = await h.post('import/preview', { ...ramp, receipts: receipts.slice(0, 1) })
  assert.deepEqual(preview.summary.errors, ['Row 3: receipt RT-1002.png was not added'])
  await h.post('import/commit', { ...ramp, receipts: receipts.slice(0, 1), fingerprint: preview.fingerprint }, h.owner, 409)
  preview = await h.post('import/preview', { ...ramp, receipts })
  assert.deepEqual([preview.summary.errors, preview.summary.charges, preview.summary.totalMinor, preview.summary.receipts, preview.summary.credits], [[], 4, 2010 + 15000 + 6495 - 1200, 2, ['RT-1004']])
  assert.ok(preview.summary.warnings.some(w => /Card Last 4/.test(w)))
  const done = await h.post('import/commit', { ...ramp, receipts, fingerprint: preview.fingerprint })
  assert.equal(done.job.state, 'completed')
  const rows = (await h.get('import')).history.filter(r => r.source === 'ramp')
  assert.deepEqual(rows.map(r => [r.transactionId, r.employee, r.date, r.merchant, r.amountMinor, r.memo, r.category, r.glCode, r.receipt?.sha256 ?? null]), [
    ['RT-1001', SAM, '2026-04-02', 'Uber', 2010, 'Airport to client', 'Rideshare', '6200 Travel', sha(uber)],
    ['RT-1002', SAM, '2026-04-03', 'Harbour View Bistro', 15000, 'Client lunch', 'Restaurants', '6300 Meals', sha(bistro)],
    ['RT-1003', ALEX, '2026-04-07', 'Staples', 6495, 'Printer paper', 'Office Supplies', '6500 Office', null],
    ['RT-1004', ALEX, '2026-04-08', 'Staples', -1200, 'Returned toner', 'Office Supplies', '6500 Office', null],
  ], 'the refund comes in as a negative-amount record')
  const status = await h.post('import/status', { source: 'ramp', id: done.job.id, mappingVersion: done.mappingVersion })
  assert.deepEqual(status.originals.map(o => o.sha256).sort(), [sha(Buffer.from(csv)), sha(uber), sha(bistro)].sort(), 'the export and each receipt are kept byte for byte')
  // Claiming an imported card charge again out of pocket is a possible duplicate; imported charges never become claims.
  const reclaim = await claim(h, t.sam, 'Client lunch', [{ kind: 'receipt', date: '2026-04-03', merchant: 'harbour view bistro', amount: '150.00', allocations: [{ category: t.c.meals }], receiptFixture: 'hotel' }])
  assert.match(reclaim.exceptions.find(e => e.code === 'possible-duplicate').message, /imported Ramp card charge RT-1002/)
  assert.equal((await h.get('state', t.sam)).claims.length, 1)

  // Brex and Navan exports in their own columns and date formats.
  const brex = { source: 'brex', filename: 'brex.csv', mapping: { date: 'YYYY-MM-DD' }, csv: 'Transaction ID,Posted Date,Card Member Email,Merchant,Amount,Currency,Memo,Category,GL Account,Receipt File\nBX-1,2026-04-10,sam@harbourfinch.example,Delta,320.00,USD,Flight to Austin,Airfare,6200,\n' }
  const navan = { source: 'navan', filename: 'navan.csv', mapping: { date: 'MM/DD/YYYY' }, csv: 'Transaction ID,Transaction Date,Employee Email,Merchant,Amount,Currency,Description,Expense Type,GL Code,Receipt File\nNV-1,04/12/2026,alex@harbourfinch.example,Hilton Austin,412.00,USD,Offsite night,Lodging,6250,\n' }
  for (const kit of [brex, navan]) assert.equal((await h.post('import/commit', { ...kit, fingerprint: (await h.post('import/preview', kit)).fingerprint })).job.state, 'completed')
  assert.deepEqual((await h.get('import')).history.filter(r => r.source !== 'ramp').map(r => [r.source, r.label, r.date, r.amountMinor, r.memo, r.category]), [['brex', 'Brex card charge BX-1', '2026-04-10', 32000, 'Flight to Austin', 'Airfare'], ['navan', 'Navan card charge NV-1', '2026-04-12', 41200, 'Offsite night', 'Lodging']])
  // Undo takes back exactly that import.
  assert.equal((await h.post('import/undo', { source: 'ramp', id: done.job.id, mappingVersion: done.mappingVersion })).job.state, 'undone')
  assert.deepEqual((await h.get('import')).history.map(r => r.source).sort(), ['brex', 'navan'])
}

// MOVE-003 Emburse Certify and Chrome River exports come in as read-only expense history with their reports, approvers and receipts, flag a re-claim and undo
async function importEmburseHistory(h, t) {
  const SAM = 'sam@harbourfinch.example', PRIYA = 'priya@harbourfinch.example'
  await h.post('settings/business', { name: 'Harbour & Finch Studio', timezone: 'America/Chicago', perDiem: '75.00', receiptThreshold: '75.00' })
  const office = await readFile('tests/fixtures/receipts/officeworks.png'), hotel = await readFile('tests/fixtures/receipts/hotel.png'), bistro = await readFile('tests/fixtures/receipts/bistro.png')
  const csv = await readFile('tests/fixtures/certify-expenses.csv', 'utf8')
  const certify = { source: 'certify', csv, filename: 'certify.csv', mapping: { date: 'YYYY-MM-DD' }, receipts: [{ name: 'CE-501.png', base64: office.toString('base64') }, { name: 'CE-502.png', base64: hotel.toString('base64') }] }
  await h.post('import/preview', certify, t.jordan, 403)
  const count = async () => (await h.db.prepare('SELECT (SELECT COUNT(*) FROM ik_jobs) + (SELECT COUNT(*) FROM c_history) AS n').first()).n, before = await count()
  let preview = await h.post('import/preview', { ...certify, receipts: certify.receipts.slice(0, 1) })
  assert.deepEqual(preview.summary.errors, ['Row 3: receipt CE-502.png was not added'])
  preview = await h.post('import/preview', certify)
  assert.deepEqual([preview.summary.errors, preview.summary.charges, preview.summary.receipts, preview.summary.totalMinor, preview.summary.credits], [[], 4, 2, 38840 + 21200 + 4210 - 800, ['CE-504']])
  assert.ok(preview.summary.warnings.some(w => /Cost Center/.test(w)), 'unmapped columns are named')
  assert.equal(await count(), before, 'preview writes nothing')
  const done = await h.post('import/commit', { ...certify, fingerprint: preview.fingerprint })
  assert.equal(done.job.state, 'completed')
  const chrome = { source: 'chromeriver', csv: await readFile('tests/fixtures/chromeriver-expenses.csv', 'utf8'), filename: 'chromeriver.csv', mapping: { date: 'MM/DD/YYYY' }, receipts: [{ name: 'LI-9001.png', base64: bistro.toString('base64') }] }
  const second = await h.post('import/commit', { ...chrome, fingerprint: (await h.post('import/preview', chrome)).fingerprint })
  const history = (await h.get('import')).history
  assert.deepEqual(history.filter(r => r.emburse).map(r => [r.label, r.report, r.employee, r.approver, r.date, r.merchant, r.amountMinor, r.memo, r.category, r.glCode, r.receipt?.sha256 ?? null]), [
    ['Certify expense CE-501', 'CR-77', SAM, PRIYA, '2026-02-10', 'Delta Air Lines', 38840, 'Flight to Atlanta client', 'Airfare', '6200', sha(office)],
    ['Certify expense CE-502', 'CR-77', SAM, PRIYA, '2026-02-11', 'Hilton Garden Inn', 21200, 'One night near the client', 'Lodging', '6210', sha(hotel)],
    ['Certify expense CE-503', 'CR-78', 'alex@harbourfinch.example', PRIYA, '2026-02-15', 'Staples', 4210, 'Toner', 'Office Supplies', '6500', null],
    ['Certify expense CE-504', 'CR-78', 'alex@harbourfinch.example', PRIYA, '2026-02-16', 'Staples', -800, 'Returned toner', 'Office Supplies', '6500', null],
    ['Chrome River expense LI-9001', 'ER-3301', SAM, 'jordan@harbourfinch.example', '2026-03-03', 'Union Station Grill', 6450, 'Client dinner', 'Meals', '6300', sha(bistro)],
    ['Chrome River expense LI-9002', 'ER-3301', SAM, 'jordan@harbourfinch.example', '2026-03-04', 'Lyft', 1875, 'Ride to the client', 'Ground Transportation', '6200', null],
  ])
  const status = await h.post('import/status', { source: 'certify', id: done.job.id, mappingVersion: done.mappingVersion })
  assert.deepEqual(status.originals.map(o => o.sha256).sort(), [sha(Buffer.from(csv)), sha(office), sha(hotel)].sort(), 'the export and each receipt are kept byte for byte')
  // Claiming an imported Emburse expense again is a possible duplicate; imported expenses never become claims.
  const reclaim = await claim(h, t.sam, 'Atlanta flight', [{ kind: 'receipt', date: '2026-02-10', merchant: 'delta air lines', amount: '388.40', allocations: [{ category: t.c.travel }], receiptFixture: 'uber' }])
  assert.match(reclaim.exceptions.find(e => e.code === 'possible-duplicate').message, /imported Certify expense CE-501/)
  assert.equal((await h.get('state', t.sam)).claims.length, 1)
  // Undo takes back exactly that import.
  assert.equal((await h.post('import/undo', { source: 'chromeriver', id: second.job.id, mappingVersion: second.mappingVersion })).job.state, 'undone')
  assert.deepEqual((await h.get('import')).history.map(r => r.source), ['certify', 'certify', 'certify', 'certify'])
}

export async function preserveMigrationHistory() {
  await withAgency(importCardHistory)
  await withAgency(importEmburseHistory)
}
