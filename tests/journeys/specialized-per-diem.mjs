// Preserved native HTTP assertion phases; callers own test registration.
import assert from 'node:assert/strict'
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { harness, agency } from '../harness.mjs'

const decode = stream => Buffer.from(decodePDFRawStream(stream).decode()).toString('utf8')

// Read the generated PDF's actual visible text through its font's Unicode map.
function pageText(document, page) {
  const fonts = page.node.Resources().lookup(PDFName.of('Font'), PDFDict), characters = new Map()
  for (const name of fonts.keys()) {
    const font = fonts.lookup(name, PDFDict), map = font.lookup(PDFName.of('ToUnicode'))
    if (!(map instanceof PDFRawStream)) continue
    for (const [, glyph, codes] of decode(map).matchAll(/<([a-f\d]{4})>\s*<([a-f\d]+)>/gi)) {
      const bytes = Buffer.from(codes, 'hex')
      characters.set(glyph.toUpperCase(), Array.from({ length: bytes.length / 2 }, (_, i) => String.fromCharCode(bytes.readUInt16BE(i * 2))).join(''))
    }
  }
  const contents = page.node.Contents(), streams = contents instanceof PDFArray ? contents.asArray().map(ref => document.context.lookup(ref)) : [contents]
  return streams.filter(s => s instanceof PDFRawStream).flatMap(s => [...decode(s).matchAll(/<([a-f\d]+)>\s*Tj/gi)].map(([, text]) => (text.match(/.{4}/g) || []).map(code => characters.get(code.toUpperCase()) || '').join(''))).join('\n')
}


async function withTeam(run) {
  const h = await harness()
  try {
    const t = await agency(h)
    await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'USD', timezone: 'America/Chicago', perDiem: '75.00', receiptThreshold: '75.00' })
    await run(h, t)
  } finally { await h.close() }
}
async function location(h, cookie, method, match) {
  const rows = (await h.get(`per-diem/locations?method=${method}`, cookie)).locations
  const row = rows.find(r => match.test(r.label))
  assert.ok(row, `Published ${method} location ${match}`)
  return row.id
}
const quote = (h, cookie, date, perDiem) => h.post('per-diem/quote', { date, perDiem }, cookie)
async function save(h, t, date, perDiem, extra = {}) {
  const claim = await h.post('claims', { title: 'Conference allowance' }, t.sam)
  await h.post(`claims/${claim.id}/items`, { version: claim.version, kind: 'per_diem', date, perDiem, category: t.c.travel, ...extra }, t.sam)
  return h.get(`claims/${claim.id}`, t.sam)
}

// Original assertion phase: CLAIM-002 Chicago M&IE uses four daily rates, 75% travel days and the full provided lunch; quotes never write and submitted evidence survives later settings
export const perDiemChicago = () => withTeam(async (h, t) => {
  const locationId = await location(h, t.sam, 'gsa', /^Chicago · Cook \/ Lake · IL/)
  const input = { method: 'gsa', locationId, endDate: '2026-06-11', component: 'mie', providedMeals: [{ date: '2026-06-09', meals: ['lunch'] }] }
  const before = await h.get('state', t.sam), outbound = h.outbound.length
  const q = await quote(h, t.sam, '2026-06-08', input)
  assert.deepEqual((await h.get('state', t.sam)).claims, before.claims, 'a preview creates no claim or expense')
  assert.deepEqual(q.days.map(d => [d.travelPercent, d.mieRateMinor, d.deductionMinor, d.mieMinor]), [[75, 9200, 0, 6900], [100, 9200, 2600, 6600], [100, 9200, 0, 9200], [75, 9200, 0, 6900]])
  assert.equal(q.totalMinor, 29600)
  assert.ok(q.days.every(d => d.source.startsWith('https://www.gsa.gov/') && d.effectiveFrom <= d.date && d.effectiveTo >= d.date))
  let d = await save(h, t, '2026-06-08', { ...input, totalMinor: 1, days: [] })
  assert.equal(d.claim.total_minor, q.totalMinor, 'client-supplied totals and rates never price the expense')
  assert.deepEqual(d.items[0].per_diem, q)
  assert.equal(d.items[0].rate_thousandths, null, 'a varying daily rate is never labeled as one flat rate')
  const submitted = await h.post(`claims/${d.claim.id}/submit`, { version: d.claim.version }, t.sam)
  const frozen = (await h.get(`claims/${submitted.id}`, t.priya)).revisions[0].snapshot.items[0].per_diem
  assert.deepEqual(frozen, q)
  await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'USD', timezone: 'America/Chicago', perDiem: '200.00', receiptThreshold: '75.00' })
  await h.post(`claims/${submitted.id}/decision`, { version: submitted.version, revision: submitted.revision, decision: 'approved' }, t.priya)
  d = await h.get(`claims/${submitted.id}`, t.sam)
  assert.deepEqual(d.items[0].per_diem, q)
  assert.deepEqual(d.revisions[0].snapshot.items[0].per_diem, frozen)
  const batch = await h.post('batches', { claims: [submitted.id] }, t.morgan)
  assert.equal(batch.total_minor, 29600)
  await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 29600 }, t.morgan)
  const csv = await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`, undefined, t.morgan)
  assert.equal(csv.status, 200)
  assert.ok(csv.text.includes('per_diem') && csv.text.includes('2026-06-09') && csv.text.includes('FY2026_PerDiemMasterRatesFile.xlsx'), 'accounting keeps the copied daily evidence')
  const workbook = await h.mf.dispatchFetch(`${h.origin}/api/coaster/batches/${batch.id}/accounting.xlsx`, { headers: { cookie: t.morgan } })
  assert.equal(workbook.status, 200)
  const sheet = Buffer.from(await workbook.arrayBuffer()).toString('utf8')
  assert.ok(['per_diem', '2026-06-09', 'FY2026_PerDiemMasterRatesFile.xlsx'].every(value => sheet.includes(value)), 'XLSX carries the copied daily provenance as well as CSV')
  const pdf = await h.mf.dispatchFetch(`${h.origin}/api/coaster/claims/${submitted.id}/pdf`, { headers: { cookie: t.sam } })
  assert.equal(pdf.status, 200)
  const doc = await PDFDocument.load(await pdf.arrayBuffer()), printed = doc.getPages().map(p => pageText(doc, p)).join('\n')
  assert.match(printed, /2026-06-09.*FY2026.*26\.00.*lunch.*66\.00/)
  assert.match(printed, /Source: https:\/\/www.gsa.gov\//)
  assert.equal(h.outbound.length, outbound, 'published tables and allowance calculation send no trip or employee data externally')
})

// Original assertion phase: CLAIM-002 a trip spanning 1 October selects each fiscal year and each month lodging rate; furnished meals keep incidentals and a single day is reduced once
export const perDiemFiscalBoundary = () => withTeam(async (h, t) => {
  const locationId = await location(h, t.sam, 'gsa', /^Chicago · Cook \/ Lake · IL/)
  const input = { method: 'gsa', locationId, endDate: '2026-10-02', component: 'both' }
  const q = await quote(h, t.sam, '2026-09-29', input)
  assert.deepEqual(q.days.map(d => d.fiscalYear), [2026, 2026, 2027, 2027])
  assert.deepEqual(q.days.map(d => d.source.endsWith('FY2026_PerDiemMasterRatesFile.xlsx')), [true, true, false, false])
  assert.ok(q.days.slice(2).every(d => d.source.endsWith('FY2027_PerDiemRates_Validated090126.xlsx')))
  assert.deepEqual(q.days.map(d => d.lodgingMinor), [22300, 22300, 23200, 0], 'only the three actual nights receive lodging')
  assert.equal(q.totalMinor, 100000, 'the trip applies both actual fiscal-year lodging rates')
  assert.equal(q.totalMinor, q.days.reduce((s, d) => s + d.mieMinor + d.lodgingMinor, 0))
  assert.deepEqual((await save(h, t, '2026-09-29', input)).items[0].per_diem, q)
  const one = await quote(h, t.sam, '2026-06-08', { ...input, endDate: '2026-06-08', providedMeals: [{ date: '2026-06-08', meals: ['breakfast', 'lunch', 'dinner'] }] })
  assert.deepEqual([one.days[0].travelPercent, one.days[0].mieMinor, one.days[0].lodgingMinor], [75, 500, 0])
  const lodging = await quote(h, t.sam, '2026-06-08', { ...input, endDate: '2026-06-10', component: 'lodging' })
  assert.ok(lodging.days.every(d => d.mieMinor === 0))
  assert.equal(lodging.totalMinor, lodging.days[0].lodgingRateMinor + lodging.days[1].lodgingRateMinor)
})

// Original assertion phase: CLAIM-002 State foreign allowances and IRS high-low seasons use published effective rates; company flat rate remains an explicit alternative
export const perDiemForeignAndCompany = () => withTeam(async (h, t) => {
  const foreign = (await h.get('per-diem/locations?method=state', t.sam)).locations
  const london = foreign.find(r => /LONDON/i.test(r.label) && /UNITED KINGDOM/i.test(r.label))
  assert.ok(london)
  const input = { method: 'state', locationId: london.id, endDate: '2026-06-11', component: 'both', providedMeals: [{ date: '2026-06-09', meals: ['lunch'] }] }
  const q = await quote(h, t.sam, '2026-06-08', input)
  assert.ok(q.days.every(d => d.source.startsWith('https://allowances.state.gov/') && d.mieRateMinor > 0 && d.lodgingRateMinor > 0))
  assert.equal(q.days[1].deductionMinor, q.days[1].mealRates.lunch)
  assert.deepEqual((await save(h, t, '2026-06-08', input)).items[0].per_diem, q)
  const highlow = await location(h, t.sam, 'high-low', /Silverthorne\/Breckenridge/i)
  const winter = await quote(h, t.sam, '2026-01-10', { method: 'high-low', locationId: highlow, endDate: '2026-01-11', component: 'both' })
  const spring = await quote(h, t.sam, '2026-05-10', { method: 'high-low', locationId: highlow, endDate: '2026-05-11', component: 'both' })
  assert.deepEqual([winter.days[0].mieRateMinor + winter.days[0].lodgingRateMinor, spring.days[0].mieRateMinor + spring.days[0].lodgingRateMinor], [31900, 22500])
  assert.ok(winter.days.every(d => d.source.startsWith('https://www.irs.gov/')))
  const company = await save(h, t, '2026-06-08', undefined, { days: 4, merchant: 'Company allowance' })
  assert.equal(company.items[0].amount_minor, 30000, 'the owner-set flat company alternative keeps COA-002 days times rate')
})

// Original assertion phase: CLAIM-002 invalid trips, missing publication coverage and foreign coding cannot change a claim; official USD allowances convert explicitly for a non-USD business
export const perDiemRefusalsAndConversion = () => withTeam(async (h, t) => {
  const locationId = await location(h, t.sam, 'gsa', /^Chicago · Cook \/ Lake · IL/)
  const input = { method: 'gsa', locationId, endDate: '2026-06-11', component: 'mie' }
  const claim = await h.post('claims', { title: 'Invalid allowances' }, t.sam)
  for (const [changes, status] of [[{ endDate: '2026-02-30' }, 400], [{ endDate: '2026-06-07' }, 400], [{ endDate: '2026-09-01' }, 400], [{ locationId: 'unknown' }, 409], [{ method: 'invented' }, 400], [{ providedMeals: [{ date: '2026-06-20', meals: ['lunch'] }] }, 400]]) {
    await h.post(`claims/${claim.id}/items`, { version: claim.version, kind: 'per_diem', date: '2026-06-08', category: t.c.travel, perDiem: { ...input, ...changes } }, t.sam, status)
  }
  assert.match((await h.post('per-diem/quote', { date: '2030-06-08', perDiem: { ...input, endDate: '2030-06-11' } }, t.sam, 409)).error, /No published/)
  await h.post(`claims/${claim.id}/items`, { version: claim.version, kind: 'per_diem', date: '2026-06-08', category: t.c.travel, perDiem: input }, t.alex, 403)
  const kept = await h.get(`claims/${claim.id}`, t.sam)
  assert.deepEqual([kept.claim.version, kept.items.length, kept.claim.total_minor], [claim.version, 0, 0])
  // A separate installation uses its existing explicit FX path, with the USD daily evidence retained.
  const other = await harness()
  try {
    const team = await agency(other)
    const converted = await save(other, team, '2026-06-08', input, { manualRate: '1.50' })
    assert.equal(converted.items[0].original_currency, 'USD')
    assert.equal(converted.items[0].amount_minor, converted.items[0].per_diem.totalMinor * 1.5)
    assert.equal(converted.items[0].fx_source, 'rate entered by hand')
  } finally { await other.close() }
})

export async function preservePerDiem() {
  await perDiemChicago()
  await perDiemFiscalBoundary()
  await perDiemForeignAndCompany()
  await perDiemRefusalsAndConversion()
}
