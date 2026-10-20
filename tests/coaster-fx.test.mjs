// CLAIM-003 / DATA-001: real production HTTP, sessions, D1, revisions and exports;
// only the public ECB download is faked at the network edge.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { harness, receipt } from './harness.mjs'

function visiblePdf(doc) {
  return doc.getPages().map(page => {
    const fonts = page.node.Resources().lookup(PDFName.of('Font'), PDFDict), chars = new Map()
    for (const name of fonts.keys()) {
      const map = fonts.lookup(name, PDFDict).lookup(PDFName.of('ToUnicode'))
      if (!(map instanceof PDFRawStream)) continue
      for (const [, glyph, codes] of Buffer.from(decodePDFRawStream(map).decode()).toString().matchAll(/<([a-f\d]{4})>\s*<([a-f\d]+)>/gi)) {
        const bytes = Buffer.from(codes, 'hex')
        chars.set(glyph.toUpperCase(), Array.from({ length: bytes.length / 2 }, (_, i) => String.fromCharCode(bytes.readUInt16BE(i * 2))).join(''))
      }
    }
    const content = page.node.Contents(), streams = content instanceof PDFArray ? content.asArray().map(ref => doc.context.lookup(ref)) : [content]
    return streams.filter(s => s instanceof PDFRawStream).flatMap(s => [...Buffer.from(decodePDFRawStream(s).decode()).toString().matchAll(/<([a-f\d]+)>\s*Tj/gi)].map(([, text]) => (text.match(/.{4}/g) || []).map(c => chars.get(c.toUpperCase()) || '').join(''))).join('\n')
  }).join('\n')
}

const xml = `<gesmes:Envelope><Cube><Cube time='2026-06-12'><Cube currency='USD' rate='1.125'/><Cube currency='GBP' rate='0.9'/></Cube><Cube time='2026-06-11'><Cube currency='USD' rate='1.10'/></Cube></Cube></gesmes:Envelope>`

test('CLAIM-003 DATA-001 original Paris taxi, date-specific exact FX, frozen approval/export and owner opt-in', async () => {
  let mode = 'ok'
  const h = await harness({ fxRates: () => mode === 'ok' ? new Response(xml) : mode === 'redirect' ? new Response('', { status: 302, headers: { location: 'https://unrelated.example/' } }) : new Response('unavailable', { status: 503 }) })
  try {
    const settings = { name: 'Harbour & Finch US', currency: 'USD', timezone: 'America/Chicago', receiptThreshold: '', salesTaxAccount: '2100', salesTaxCode: 'TAX' }
    await h.post('settings/business', settings)
    const category = (await h.post('settings/categories', { name: 'Travel', accountCode: '6200', taxCode: 'NONE' })).id
    const manager = await h.person('priya@harbourfinch.example', { manager: true })
    const employee = await h.person('sam@harbourfinch.example', { employee: true }, 'priya@harbourfinch.example')
    let c = await h.post('claims', { title: 'Paris client visit' }, employee)
    const expense = { version: c.version, kind: 'receipt', date: '2026-06-14', merchant: 'Paris Taxi', amount: '48.00', currency: 'EUR', allocations: [{ category }] }
    const before = h.outbound.length
    await h.post(`claims/${c.id}/items`, expense, employee, 409)
    assert.equal(h.outbound.length, before, 'off means no ECB request')
    await h.post('settings/business', { ...settings, fxEnabled: true }, employee, 403)
    await h.post('settings/business', { ...settings, fxEnabled: true })
    assert.equal((await h.get('state')).business.fx_enabled, 1)
    const uploaded = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...await receipt('bistro') }, employee)
    c = await h.post(`claims/${c.id}/items`, { ...expense, version: uploaded.claim.version, receipt: uploaded.receipt }, employee)
    let detail = await h.get(`claims/${c.id}`, employee)
    const item = detail.items[0]
    assert.equal(c.total_minor, 5400)
    assert.deepEqual([item.original_minor, item.original_currency, item.fx_rate, item.fx_date, item.fx_source], [4800, 'EUR', '1.125', '2026-06-12', 'ECB reference rates'])
    const requests = h.outbound.slice(before)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml')
    assert.equal(requests[0].method, 'GET'); assert.equal(requests[0].body, '')
    for (const key of ['cookie', 'authorization', 'referer']) assert.equal(requests[0].headers[key], undefined)
    assert.ok(!JSON.stringify(requests).includes('Paris'))
    c = await h.post(`claims/${c.id}/submit`, { version: c.version }, employee)
    const frozen = (await h.get(`claims/${c.id}`, manager)).revisions[0].snapshot.items[0]
    assert.deepEqual([frozen.original_minor, frozen.amount_minor, frozen.fx_date], [4800, 5400, '2026-06-12'])
    c = await h.post(`claims/${c.id}/decision`, { version: c.version, revision: c.revision, decision: 'approved' }, manager)
    let batch = await h.post('batches', { claims: [c.id] })
    batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 5400 })
    mode = 'unavailable'
    const csv = await h.get(`batches/${batch.id}/accounting.csv`)
    const lines = csv.trim().split('\r\n').map(r => r.split('","').map(x => x.replace(/^"|"$/g, '')))
    const row = Object.fromEntries(lines[0].map((key, i) => [key, lines[1][i]]))
    assert.deepEqual([row.original_amount, row.original_currency, row.exchange_rate, row.rate_date, row.rate_source, row.amount, row.currency], ['48.00', 'EUR', '1.125', '2026-06-12', 'ECB reference rates', '54.00', 'USD'])
    const xlsx = await h.send(`/api/coaster/batches/${batch.id}/accounting.xlsx`, undefined, h.owner)
    assert.equal(xlsx.status, 200)
    assert.match(xlsx.text, /original_amount/); assert.match(xlsx.text, /ECB reference rates/)
    const iif = await h.get(`batches/${batch.id}/accounting.iif`)
    assert.match(iif, /original 48.00 EUR/); assert.match(iif, /1 EUR = 1.125 USD/)
    for (const path of [`claims/${c.id}/pdf`, `batches/${batch.id}/pdf`]) {
      const response = await h.mf.dispatchFetch(h.origin + '/api/coaster/' + path, { headers: { cookie: h.owner } })
      assert.equal(response.status, 200)
      const pdf = await PDFDocument.load(await response.arrayBuffer())
      const text = visiblePdf(pdf)
      assert.match(text, /Original amount: EUR 48.00/)
      assert.match(text, /Exchange rate: 1 EUR = 1.125 USD/)
      assert.match(text, /Rate date: 2026-06-12/)
      assert.match(text, /ECB reference rate, not your card/)
    }
    assert.deepEqual((await h.get(`claims/${c.id}`)).revisions[0].snapshot.items[0], frozen)

    // Cross rates, exact half-up cents, split reconciliation and tax preserve entered amounts.
    let split = await h.post('claims', { title: 'London taxi and parking' }, employee)
    mode = 'ok'
    split = await h.post(`claims/${split.id}/items`, { ...expense, version: split.version, currency: 'GBP', amount: '48.01', salesTax: '0.01', allocations: [{ category, amount: '20.00' }, { category, amount: '28.00' }] }, employee)
    detail = await h.get(`claims/${split.id}`, employee)
    assert.equal(split.total_minor, 6001)
    assert.equal(detail.items[0].sales_tax_minor, 1)
    assert.deepEqual(detail.items[0].allocations.map(a => [a.original_minor, a.amount_minor]), [[2000, 2500], [2800, 3500]])
    let half = await h.post('claims', { title: 'Half cent' }, employee)
    half = await h.post(`claims/${half.id}/items`, { ...expense, version: half.version, amount: '0.04' }, employee)
    assert.equal(half.total_minor, 5)
    const unchanged = await h.get(`claims/${half.id}`, employee)
    for (const [changes, status] of [[{ currency: 'XYZ' }, 422], [{ date: '1990-01-01' }, 422], [{ date: '2099-01-01' }, 400]]) {
      await h.post(`claims/${half.id}/items`, { ...expense, ...changes, version: half.version }, employee, status)
      assert.deepEqual(await h.get(`claims/${half.id}`, employee), unchanged)
    }
    for (const failure of ['unavailable', 'redirect']) {
      mode = failure
      await h.post(`claims/${half.id}/items`, { ...expense, version: half.version }, employee, 502)
      assert.deepEqual(await h.get(`claims/${half.id}`, employee), unchanged)
    }
    let hand = await h.post('claims', { title: 'Manual rate during ECB outage' }, employee)
    hand = await h.post(`claims/${hand.id}/items`, { ...expense, manualRate: '1.15', explanation: 'Rate from my exchange receipt', version: hand.version }, employee)
    hand = await h.post(`claims/${hand.id}/submit`, { version: hand.version }, employee)
    const approverView = await h.get(`claims/${hand.id}`, manager)
    assert.equal(approverView.revisions[0].snapshot.items[0].fx_source, 'rate entered by hand')
    assert.equal(approverView.revisions[0].snapshot.items[0].amount_minor, 5520)
    await h.post('settings/business', { ...settings, fxEnabled: false })
    const end = h.outbound.length
    const manual = await h.post(`claims/${half.id}/items`, { ...expense, manualRate: '1.2', version: half.version }, employee)
    const manualItem = (await h.get(`claims/${half.id}`, employee)).items.at(-1)
    assert.deepEqual([manualItem.original_minor, manualItem.amount_minor, manualItem.fx_rate, manualItem.fx_date, manualItem.fx_source], [4800, 5760, '1.2', '2026-06-14', 'rate entered by hand'])
    assert.equal(h.outbound.length, end, 'manual input never contacts the provider')
    half = manual
    await h.post(`claims/${half.id}/items`, { ...expense, version: half.version }, employee, 409)
    await h.post(`claims/${half.id}/items`, { ...expense, currency: 'USD', version: half.version }, employee)
    assert.equal(h.outbound.length, end, 'domestic saves still work with conversion off')
    const agent = await h.post('agent-keys', { label: 'Travel helper' }, employee)
    const proposal = await h.send('/api/coaster/agent/claims', { title: 'Agent foreign draft', items: [{ ...expense, version: undefined, manualRate: '1.2' }] }, '', { authorization: `Bearer ${agent.token}` })
    assert.equal(proposal.status, 200)
    const accepted = await h.post(`proposals/${proposal.value.id}/accept`, {}, employee)
    const prepared = (await h.get(`claims/${accepted.claim.id}`, employee)).items[0]
    assert.deepEqual([prepared.original_minor, prepared.original_currency, prepared.amount_minor, prepared.fx_source], [4800, 'EUR', 5760, 'rate entered by hand'])
  } finally { await h.close() }
})
