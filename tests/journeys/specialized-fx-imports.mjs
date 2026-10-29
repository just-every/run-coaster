// Preserved native HTTP assertion phases; callers own test registration.
import assert from 'node:assert/strict'
import { harness } from '../harness.mjs'

const rates = usd => `<gesmes:Envelope><Cube><Cube time="2026-09-07"><Cube currency="USD" rate="9"/></Cube><Cube time="2026-09-04"><Cube currency="USD" rate="${usd}"/><Cube currency="GBP" rate="0.8"/></Cube></Cube></gesmes:Envelope>`
const business = fxEnabled => ({ name: 'Harbour & Finch Studio', currency: 'USD', timezone: 'America/Chicago', perDiem: '', fxEnabled })
const fxCalls = h => h.outbound.filter(r => r.url === 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml')
async function commit(h, input) {
  const preview = await h.post('import/preview', input)
  assert.deepEqual(preview.summary.errors, [])
  return h.post('import/commit', { ...input, fingerprint: preview.fingerprint })
}
async function original(h, input, imported) {
  const status = await h.post('import/status', { source: input.source, id: imported.job.id, mappingVersion: imported.mappingVersion })
  assert.equal(Buffer.from(status.originals.find(o => o.name === input.filename).original.base64, 'base64').toString(), input.csv)
}

// Original assertion phase: CLAIM-003 Ramp and Emburse EUR history retains originals, converts credits and requires a fresh review when ECB rates change
export const foreignCardHistory = async () => {
  let usd = '1.5', unavailable = false
  const h = await harness({ fxRates: () => unavailable ? new Response('', { status: 503 }) : new Response(rates(usd)) })
  try {
    await h.post('settings/business', business(false))
    const ramp = { source: 'ramp', filename: 'ramp-eur.csv', mapping: { date: 'YYYY-MM-DD' }, csv: 'Transaction ID,Transaction Date,User Email,Merchant Name,Amount,Currency\nR-EUR,2026-09-06,sam@harbourfinch.example,Paris taxi,48.00,EUR\nR-CREDIT,2026-09-06,sam@harbourfinch.example,Paris taxi refund,-0.05,EUR\n' }
    const disabled = await h.post('import/preview', ramp)
    assert.ok(disabled.summary.errors.some(e => /enable.*conversion/i.test(e)))
    await h.post('import/commit', { ...ramp, fingerprint: disabled.fingerprint }, undefined, 409)
    assert.equal(fxCalls(h).length, 0)
    assert.equal((await h.get('import')).jobs.length, 0)
    await h.post('settings/business', business(true))
    const preview = await h.post('import/preview', ramp)
    assert.deepEqual(preview.summary.errors, [])
    assert.equal(preview.summary.totalMinor, 7192, 'negative half cents round away from zero')
    assert.equal((await h.get('import')).history.length, 0, 'preview does not retain history')
    assert.equal(fxCalls(h).length, 1, 'one history download serves all rows in a preview')
    usd = '1.6'
    await h.post('import/commit', { ...ramp, fingerprint: preview.fingerprint }, undefined, 409)
    assert.equal((await h.get('import')).jobs.length, 0)
    const rampJob = await commit(h, ramp)
    await original(h, ramp, rampJob)
    const certify = { source: 'certify', filename: 'certify-eur.csv', mapping: { date: 'YYYY-MM-DD' }, csv: 'Expense ID,Report ID,Expense Date,Employee Email,Approver Email,Vendor,Amount,Currency\nC-EUR,C-REPORT,2026-09-06,sam@harbourfinch.example,priya@harbourfinch.example,Paris taxi,48.00,EUR\nC-CREDIT,C-REPORT,2026-09-06,sam@harbourfinch.example,priya@harbourfinch.example,Paris taxi refund,-0.05,EUR\n' }
    const before = fxCalls(h).length
    const certifyJob = await commit(h, certify)
    assert.equal(fxCalls(h).length - before, 2, 'preview and commit each resolve a single frozen rate snapshot')
    await original(h, certify, certifyJob)
    const history = (await h.get('import')).history
    for (const id of ['R-EUR', 'C-EUR']) {
      const expense = history.find(r => r.transactionId === id)
      assert.deepEqual([expense.original_minor, expense.original_currency, expense.amountMinor, expense.currency], [4800, 'EUR', 7680, 'USD'])
      assert.deepEqual([expense.fx_rate, expense.fx_date, expense.fx_source], ['1.6', '2026-09-04', 'ECB reference rates'])
      assert.equal(expense.originalAmount, '48.00')
    }
    for (const id of ['R-CREDIT', 'C-CREDIT']) {
      const expense = history.find(r => r.transactionId === id)
      assert.deepEqual([expense.original_minor, expense.amountMinor], [-5, -8])
    }
    assert.equal(history.find(r => r.transactionId === 'C-EUR').report, 'C-REPORT')
    assert.equal((await h.get('state')).claims.length, 0, 'imported history remains non-reimbursable')
    assert.ok(fxCalls(h).every(r => r.method === 'GET' && r.body === ''), 'the public provider receives no source expense data')
    unavailable = true
    const unavailableInput = { ...ramp, csv: ramp.csv.replaceAll('R-EUR', 'R-UNAVAILABLE') }
    const failed = await h.post('import/preview', unavailableInput)
    assert.ok(failed.summary.errors.some(e => /unavailable/i.test(e)))
    await h.post('import/commit', { ...unavailableInput, fingerprint: failed.fingerprint }, undefined, 409)
    assert.equal((await h.get('import')).history.length, history.length)
    await h.post('import/undo', { source: 'certify', id: certifyJob.job.id, mappingVersion: certifyJob.mappingVersion })
    assert.equal((await h.get('import')).history.filter(r => r.source === 'certify').length, 0)
    assert.equal((await h.get('import')).history.filter(r => r.source === 'ramp').length, 2)
  } finally { await h.close() }
}

const concurHeaders = ['Record Type', 'Employee ID', 'Report ID', 'Report Currency Alpha Code', 'Report Entry ID', 'Report Entry Expense Type Name', 'Report Entry Transaction Date', 'Report Entry Currency Alpha Code', 'Report Entry Vendor Name', 'Report Entry Transaction Amount', 'Report Entry Approved Amount', 'Journal Account Code', 'Journal Debit Or Credit', 'Journal Amount', 'Journal Key']
function concurRow(report, currency, id, originalCurrency, original, amount, journal, journalAmount) {
  return ['DETAIL', 'EMP-17', report, currency, id, 'Travel', '2026-09-06', originalCurrency, 'Paris taxi', original, amount, '6200', journalAmount.startsWith('-') ? 'CR' : 'DR', journalAmount, journal].join(',')
}

// Original assertion phase: CLAIM-003 Concur converts approved EUR journals with exact signed remainders and preserves differing original transaction and report amounts
export const foreignConcurHistory = async () => {
  const h = await harness({ fxRates: rates('1.5') })
  try {
    await h.post('settings/business', business(true))
    const category = await h.post('settings/categories', { name: 'Travel', accountCode: '6200', taxCode: 'NONE' })
    const input = { source: 'concur', filename: 'concur-eur.csv', mapping: { layout: 'headers', employees: { 'EMP-17': 'sam@harbourfinch.example' }, categories: { Travel: category.id } }, csv: [
      concurHeaders.join(','),
      concurRow('R-EUR', 'EUR', 'E-TAXI', 'EUR', '48.00', '48.00', 'J-TAXI-A', '24.00'),
      concurRow('R-EUR', 'EUR', 'E-TAXI', 'EUR', '48.00', '48.00', 'J-TAXI-B', '24.00'),
      concurRow('R-EUR', 'EUR', 'E-TINY', 'EUR', '0.02', '0.02', 'J-TINY-A', '0.01'),
      concurRow('R-EUR', 'EUR', 'E-TINY', 'EUR', '0.02', '0.02', 'J-TINY-B', '0.01'),
      concurRow('R-EUR', 'EUR', 'E-CREDIT', 'EUR', '-0.02', '-0.02', 'J-CREDIT-A', '-0.01'),
      concurRow('R-EUR', 'EUR', 'E-CREDIT', 'EUR', '-0.02', '-0.02', 'J-CREDIT-B', '-0.01'),
      // Original GBP is receipt evidence; approved EUR and its journals control report accounting.
      concurRow('R-EUR', 'EUR', 'E-GBP', 'GBP', '40.00', '48.00', 'J-GBP', '48.00'),
      // A report already settled in USD keeps its approved amount, not a fresh EUR receipt conversion.
      concurRow('R-USD', 'USD', 'E-USD', 'EUR', '48.00', '73.33', 'J-USD', '73.33'),
    ].join('\n') + '\n' }
    const preview = await h.post('import/preview', input)
    assert.deepEqual(preview.summary.errors, [])
    assert.equal(preview.summary.totalMinor, 21733)
    assert.deepEqual(preview.summary.credits, ['E-CREDIT'])
    assert.equal(fxCalls(h).length, 1)
    assert.equal((await h.get('import')).jobs.length, 0)
    const imported = await h.post('import/commit', { ...input, fingerprint: preview.fingerprint })
    assert.equal(fxCalls(h).length, 2)
    await original(h, input, imported)
    const history = (await h.get('import')).history
    const taxi = history.find(r => r.transactionId === 'E-TAXI')
    assert.deepEqual([taxi.originalAmount, taxi.originalCurrency, taxi.original_minor, taxi.original_currency, taxi.amountMinor], ['48.00', 'EUR', 4800, 'EUR', 7200])
    assert.deepEqual([taxi.fx_rate, taxi.fx_date, taxi.fx_source], ['1.5', '2026-09-04', 'ECB reference rates'])
    assert.deepEqual(history.find(r => r.transactionId === 'E-TINY').allocations.map(a => a.amountMinor), [2, 1])
    assert.deepEqual(history.find(r => r.transactionId === 'E-CREDIT').allocations.map(a => a.amountMinor), [-2, -1])
    for (const expense of history.filter(r => r.kind === 'expense')) {
      assert.equal(expense.allocations.reduce((n, a) => n + a.amountMinor, 0), expense.amountMinor)
      assert.equal(expense.allocations.reduce((n, a) => n + a.sourceAmountMinor, 0), expense.reportAmountMinor)
    }
    const gbp = history.find(r => r.transactionId === 'E-GBP')
    assert.deepEqual([gbp.originalAmount, gbp.originalCurrency, gbp.reportAmountMinor, gbp.reportCurrency, gbp.amountMinor], ['40.00', 'GBP', 4800, 'EUR', 7200])
    const usd = history.find(r => r.transactionId === 'E-USD')
    assert.deepEqual([usd.originalAmount, usd.originalCurrency, usd.reportAmountMinor, usd.reportCurrency, usd.amountMinor, usd.fx_rate], ['48.00', 'EUR', 7333, 'USD', 7333, '1'])
    const report = history.find(r => r.kind === 'report' && r.reportId === 'R-EUR')
    assert.deepEqual([report.reportCurrency, report.reportTotalMinor, report.totalMinor], ['EUR', 9600, 14400])
    // Bad allocations are still refused in source units, even if conversion could reconcile them.
    const invalid = { ...input, csv: input.csv.replace('DR,24.00,J-TAXI-A', 'DR,23.99,J-TAXI-A') }
    const bad = await h.post('import/preview', invalid)
    assert.ok(bad.summary.errors.some(e => /allocations do not add up/.test(e)))
    await h.post('import/commit', { ...invalid, fingerprint: bad.fingerprint }, undefined, 409)
    await h.post('import/undo', { source: 'concur', id: imported.job.id, mappingVersion: imported.mappingVersion })
    assert.equal((await h.get('import')).history.length, 0)
  } finally { await h.close() }
}

export async function preserveForeignImports() {
  await foreignCardHistory()
  await foreignConcurHistory()
}
