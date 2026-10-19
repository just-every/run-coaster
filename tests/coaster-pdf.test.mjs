import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream, StandardFonts, degrees } from 'pdf-lib'
import { encode as encodeWebp } from '@stacksjs/ts-webp'
import { agency, harness } from './harness.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
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

function attachments(doc) {
  const names = doc.catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('EmbeddedFiles'), PDFDict).lookup(PDFName.of('Names'), PDFArray)
  return Array.from({ length: names.size() / 2 }, (_, i) => {
    const file = names.lookup(i * 2 + 1, PDFDict), ef = file.lookup(PDFName.of('EF'), PDFDict).lookup(PDFName.of('F'), PDFRawStream)
    return Buffer.from(decodePDFRawStream(ef).decode())
  })
}

test('REPORT-005 / CLAIM-006 paid claim and batch PDFs reconcile, preserve ordered receipt pages and bytes, filter real billable customers and enforce claim access', async () => {
  const h = await harness()
  try {
    const team = await agency(h)
    const invoice = await PDFDocument.create(), invoiceFont = await invoice.embedFont(StandardFonts.Helvetica)
    for (const [index, label] of ['Hotel folio page one', 'Hotel folio page two'].entries()) {
      const page = invoice.addPage([420, 580]); page.drawText(label, { x: 40, y: 500, font: invoiceFont });
      if (index === 1) page.setRotation(degrees(90))
    }
    const receipts = [await readFile('tests/fixtures/receipts/report-bistro.jpg'), await readFile('tests/fixtures/receipts/report-bistro.heic'), Buffer.from(await invoice.save())]
    let claim = await h.post('claims', { title: 'Paid client trip' }, team.sam)
    const entries = [
      { merchant: 'Client dinner', amount: '180.00', category: team.c.meals, billable: true, customer: 'Acme', project: 'Discovery', explanation: 'Three guests; approved client dinner' },
      { merchant: 'Other customer taxi', amount: '60.00', category: team.c.travel, billable: true, customer: 'Other', project: 'Delivery' },
      { merchant: 'Acme hotel', amount: '120.00', category: team.c.travel, billable: true, customer: 'Acme', project: 'Hosting' },
    ]
    for (const [index, entry] of entries.entries()) {
      const upload = await h.post(`claims/${claim.id}/receipts`, { version: claim.version, name: ['dinner.jpg', 'taxi.heic', 'hotel.pdf'][index], base64: receipts[index].toString('base64') }, team.sam)
      claim = upload.claim
      claim = await h.post(`claims/${claim.id}/items`, { version: claim.version, kind: 'receipt', date: `2026-05-0${index + 1}`, ...entry, receipt: upload.receipt, allocations: [{ category: entry.category, costCentre: 'Delivery', description: index === 2 ? 'Room and lodging' : '' }], description: 'Client workshop' }, team.sam)
    }
    const draft = await h.get(`claims/${claim.id}`, team.sam)
    await h.post(`claims/${claim.id}/comments`, { body: 'Café workshop: dinner confirmed.' }, team.sam)
    await h.post(`claims/${claim.id}/comments`, { body: 'Only for the other customer', item: draft.items[1].id }, team.sam)
    claim = await h.post(`claims/${claim.id}/submit`, { version: claim.version }, team.sam)
    claim = await h.post(`claims/${claim.id}/decision`, { revision: claim.revision, version: claim.version, decision: 'returned', reason: 'Code the dinner to Delivery' }, team.priya)
    claim = await h.post(`claims/${claim.id}/items`, { version: claim.version, item: draft.items[0].id, kind: 'receipt', date: draft.items[0].spent_on, ...entries[0], project: ' Delivery ', receipt: draft.items[0].receipt_id, allocations: [{ category: team.c.meals, costCentre: 'Delivery' }], description: 'Client workshop' }, team.sam)
    claim = await h.post(`claims/${claim.id}/submit`, { version: claim.version }, team.sam)
    const revised = await h.get(`claims/${claim.id}`, team.sam)
    assert.equal(revised.items[0].project, 'Delivery')
    assert.deepEqual(revised.revisions.map(r => r.snapshot.items[0].project), ['Discovery', 'Delivery'], 'correcting a project preserves the earlier submitted coding')
    claim = await h.post(`claims/${claim.id}/decision`, { revision: claim.revision, version: claim.version, decision: 'approved', acknowledge: true, reason: 'Client work checked' }, team.priya)
    const key = await h.post('agent-keys', { label: 'Project coding agent' }, team.sam)
    const proposal = await h.send('/api/coaster/agent/claims', { title: 'Nonbillable Acme mileage', items: [{ kind: 'mileage', date: '2026-05-04', merchant: 'Office trip', distance: '10', customer: 'Acme', project: 'Delivery', billable: true, category: team.c.car }] }, '', { authorization: `Bearer ${key.token}` })
    assert.equal(proposal.status, 200)
    assert.equal(proposal.value.payload.items[0].project, 'Delivery')
    let second = (await h.post(`proposals/${proposal.value.id}/accept`, {}, team.sam)).claim
    const agentDraft = await h.get(`claims/${second.id}`, team.sam)
    assert.deepEqual([agentDraft.items[0].customer, agentDraft.items[0].project, !!agentDraft.items[0].billable], ['Acme', 'Delivery', true])
    second = await h.post(`claims/${second.id}/items`, { version: second.version, item: agentDraft.items[0].id, kind: 'mileage', date: '2026-05-04', merchant: 'Office trip', distance: '10', customer: 'Acme', project: 'Delivery', billable: false, category: team.c.car }, team.sam)
    second = await h.post(`claims/${second.id}/submit`, { version: second.version }, team.sam)
    second = await h.post(`claims/${second.id}/decision`, { revision: second.revision, version: second.version, decision: 'approved' }, team.priya)
    const batch = await h.post('batches', { claims: [second.id, claim.id] }, team.morgan)
    let reviewed = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 36880 }, team.morgan)
    await h.post(`batches/${batch.id}/paid`, { version: reviewed.version, reference: 'ACH-REPORT-005', paidOn: '2026-05-10' }, team.morgan)
    const batchDetail = await h.get(`batches/${batch.id}`, team.morgan)
    const dinner = batchDetail.lines.find(l => l.merchant === 'Client dinner')
    assert.deepEqual([dinner.billable, dinner.customer, dinner.project, dinner.amountMinor], [true, 'Acme', 'Delivery', 18000])
    const columns = ['merchant', 'billable', 'customer', 'project', 'amount', 'receipt_sha256'].map(field => ({ field }))
    const template = await h.post('export-templates', { name: 'Client rebilling', kind: 'accounting', columns }, team.morgan)
    const ledger = await h.send(`/api/coaster/batches/${batch.id}/accounting.csv?template=${template.id}`, undefined, team.morgan)
    assert.equal(ledger.status, 200)
    assert.ok(ledger.text.includes(`"Client dinner","true","Acme","Delivery","180.00","${sha(receipts[0])}"`))
    assert.ok(ledger.text.includes('"Office trip","false","Acme","Delivery","8.80"'))
    await h.post('settings/categories', { id: team.c.meals, name: 'Recoded meals', accountCode: '9999', taxCode: 'Changed tax', limit: '120.00' })
    const fetchPdf = async (path, cookie, status = 200) => {
      const response = await h.mf.dispatchFetch(`${h.origin}/api/coaster/${path}`, { headers: { cookie } })
      assert.equal(response.status, status, response.status === status ? '' : await response.clone().text())
      if (status !== 200) return
      assert.match(response.headers.get('content-type'), /application\/pdf/)
      assert.match(response.headers.get('content-disposition'), /attachment/)
      assert.match(response.headers.get('cache-control'), /no-store/)
      const bytes = Buffer.from(await response.arrayBuffer()), doc = await PDFDocument.load(bytes)
      return { bytes, doc, pages: doc.getPages().map(p => pageText(doc, p)) }
    }
    const full = await fetchPdf(`claims/${claim.id}/pdf`, team.sam), text = full.pages.join('\n')
    assert.match(text, /Claim total: AUD 360\.00/); assert.match(text, /Meals: AUD 180\.00/); assert.match(text, /Travel: AUD 180\.00/)
    for (const value of ['sam@harbourfinch.example', '2026-05-01 to 2026-05-03', 'priya@harbourfinch.example', 'approved', 'ACH-REPORT-005', '2026-05-10', 'Account 6300', 'Tax GST', 'Cost center Delivery', 'Three guests', 'Exception:', 'Café workshop']) assert.ok(text.includes(value), value)
    assert.ok(!text.includes('Recoded meals')); assert.ok(!text.includes('Account 9999'), 'a later category edit never recodes the submitted evidence')
    const receiptPages = full.pages.filter(page => /SHA-256/.test(page) && /receipt \d+ of/.test(page))
    assert.equal(receiptPages.length, 4, 'JPEG + HEIC + both PDF folio pages render')
    assert.ok(receiptPages[0].includes(sha(receipts[0]))); assert.ok(receiptPages[1].includes(sha(receipts[1])))
    assert.ok(receiptPages[2].includes(sha(receipts[2]))); assert.ok(receiptPages[3].includes(sha(receipts[2])))
    assert.deepEqual(attachments(full.doc).map(sha).sort(), receipts.map(sha).sort(), 'exact original receipts remain independently verifiable')
    const filtered = await fetchPdf(`claims/${claim.id}/pdf?customer=Acme`, team.morgan), filteredText = filtered.pages.join('\n')
    assert.match(filteredText, /Customer total: AUD 300\.00/)
    assert.ok(!filteredText.includes('Other customer taxi')); assert.ok(!filteredText.includes('Only for the other customer'))
    assert.deepEqual(attachments(filtered.doc).map(sha).sort(), [receipts[0], receipts[2]].map(sha).sort())
    const projectPdf = await fetchPdf(`claims/${claim.id}/pdf?customer=Acme&project=Delivery`, team.morgan)
    const projectText = projectPdf.pages.join('\n')
    assert.match(projectText, /Customer total: AUD 180\.00/)
    assert.ok(projectText.includes('Project: Delivery'))
    assert.ok(!projectText.includes('Acme hotel') && !projectText.includes('Other customer taxi'))
    assert.deepEqual(attachments(projectPdf.doc).map(sha), [sha(receipts[0])])
    await fetchPdf(`claims/${claim.id}/pdf?customer=Other&project=Hosting`, team.morgan, 404)
    await fetchPdf(`claims/${claim.id}/pdf?customer=Acme&project=delivery`, team.sam, 404)
    const batchPdf = await fetchPdf(`batches/${batch.id}/pdf`, team.morgan)
    const batchText = batchPdf.pages.join('\n')
    assert.match(batchText, /Total: AUD 368\.80/)
    assert.ok(batchText.includes('Nonbillable Acme mileage'))
    const batchSummaries = batchPdf.pages.filter(page => /Employee:/.test(page))
    assert.ok(batchSummaries[0].includes('Paid client trip')); assert.ok(batchSummaries[1].includes('Nonbillable Acme mileage'))
    assert.deepEqual(attachments(batchPdf.doc).map(sha).sort(), receipts.map(sha).sort())
    const customerBatch = await fetchPdf(`batches/${batch.id}/pdf?customer=Acme`, team.morgan)
    assert.match(customerBatch.pages.join('\n'), /Total: AUD 300\.00/)
    assert.ok(!customerBatch.pages.join('\n').includes('Nonbillable Acme mileage'))
    const projectBatch = await fetchPdf(`batches/${batch.id}/pdf?customer=Acme&project=Delivery`, team.morgan)
    assert.match(projectBatch.pages.join('\n'), /Total: AUD 180\.00/)
    assert.ok(!projectBatch.pages.join('\n').includes('Nonbillable Acme mileage'))
    await fetchPdf(`claims/${claim.id}/pdf`, team.alex, 403)
    await fetchPdf(`claims/${claim.id}/pdf?customer=Acme`, team.alex, 403)
    await fetchPdf(`batches/${batch.id}/pdf`, team.sam, 403)
    await fetchPdf(`claims/${claim.id}/pdf?customer=Missing`, team.sam, 404)
    let privateClaim = await h.post('claims', { title: 'Private billable draft' }, team.sam)
    privateClaim = await h.post(`claims/${privateClaim.id}/items`, { version: privateClaim.version, kind: 'receipt', date: '2026-06-01', merchant: 'Not billable to Acme', amount: '22.00', customer: 'Acme', billable: false, category: team.c.travel }, team.sam)
    await fetchPdf(`claims/${privateClaim.id}/pdf?customer=Acme`, team.sam, 404)
    await fetchPdf(`claims/${privateClaim.id}/pdf`, team.morgan, 403)
    await h.post(`claims/${privateClaim.id}/items`, { version: privateClaim.version, kind: 'receipt', date: '2026-06-02', merchant: 'Invalid billable expense', amount: '10.00', billable: true, category: team.c.travel }, team.sam, 400)
    const beforeInvalid = await h.get(`claims/${privateClaim.id}`, team.sam)
    await h.post(`claims/${privateClaim.id}/items`, { version: privateClaim.version, kind: 'mileage', date: '2026-06-02', distance: '1', category: team.c.car, customer: 'Acme', project: { forged: 'Delivery' } }, team.sam, 400)
    const afterInvalid = await h.get(`claims/${privateClaim.id}`, team.sam)
    assert.deepEqual([afterInvalid.claim.version, afterInvalid.items], [beforeInvalid.claim.version, beforeInvalid.items], 'invalid project coding writes nothing')
    await fetchPdf(`claims/${privateClaim.id}/pdf?project=Delivery`, team.sam, 404)
    const blank = await PDFDocument.create(); blank.addPage()
    const pixels = Uint8Array.from({ length: 8 * 8 * 4 }, (_, i) => i % 4 === 3 ? 255 : (Math.floor(i / 4) + i % 4) % 3 === 0 ? 255 : 0)
    const extra = [await readFile('tests/fixtures/receipts/bistro.png'), Buffer.from(encodeWebp({ width: 8, height: 8, data: pixels }, { backend: 'pure-ts', lossless: true })), Buffer.from(await blank.save())]
    for (const [index, bytes] of extra.entries()) {
      const upload = await h.post(`claims/${privateClaim.id}/receipts`, { version: privateClaim.version, name: ['original.png', 'original.webp', 'blank-page.pdf'][index], base64: bytes.toString('base64') }, team.sam)
      privateClaim = await h.post(`claims/${privateClaim.id}/items`, { version: upload.claim.version, kind: 'receipt', date: `2026-06-0${index + 3}`, merchant: ['PNG receipt', 'WebP receipt', 'Blank PDF page'][index], amount: '10.00', category: team.c.travel, receipt: upload.receipt }, team.sam)
    }
    const longComment = 'Detailed business purpose and attendee notes. '.repeat(42) + 'Final comment retained.'
    await h.post(`claims/${privateClaim.id}/comments`, { body: longComment }, team.sam)
    await h.post(`claims/${privateClaim.id}/comments`, { body: longComment.replace('Final comment retained.', 'Last continuation retained.') }, team.sam)
    const extraPdf = await fetchPdf(`claims/${privateClaim.id}/pdf`, team.sam)
    const extraText = extraPdf.pages.join('\n').replace(/\s+/g, ' ')
    assert.ok(extraText.includes('Final comment retained.') && extraText.includes('Last continuation retained.'), 'long comment threads survive wrapping and page breaks')
    assert.equal(extraPdf.pages.filter(page => /receipt \d+ of/.test(page)).length, 3, 'PNG, WebP and a genuinely blank PDF page each occupy a stamped page')
    assert.deepEqual(attachments(extraPdf.doc).map(sha).sort(), extra.map(sha).sort())
    // Oversized compressed photos refuse rendering safely; the employee keeps the original.
    const oversized = await readFile('tests/fixtures/receipts/report-oversized.heic')
    const oversizedUpload = await h.post(`claims/${privateClaim.id}/receipts`, { version: privateClaim.version, name: 'large-camera-receipt.heic', base64: oversized.toString('base64') }, team.sam)
    privateClaim = await h.post(`claims/${privateClaim.id}/items`, { version: oversizedUpload.claim.version, kind: 'receipt', date: '2026-07-07', merchant: 'Large camera receipt', amount: '10.00', category: team.c.travel, receipt: oversizedUpload.receipt }, team.sam)
    await fetchPdf(`claims/${privateClaim.id}/pdf`, team.sam, 422)
    const original = await h.mf.dispatchFetch(`${h.origin}/api/coaster/receipts/${oversizedUpload.receipt}`, { headers: { cookie: team.sam } })
    assert.equal(original.status, 200)
    assert.equal(sha(Buffer.from(await original.arrayBuffer())), sha(oversized), 'a rendering refusal never removes or rewrites the original')
    // CLAIM-006: every native kind carries project coding, including each split and sales-tax export line.
    await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', receiptThreshold: '', perDiem: '75', salesTaxAccount: 'Tax control', salesTaxCode: 'Sales tax' })
    let coded = await h.post('claims', { title: 'Project cost export' }, team.sam)
    coded = await h.post(`claims/${coded.id}/items`, { version: coded.version, kind: 'per_diem', date: '2026-07-10', days: 1, category: team.c.travel, billable: true, customer: 'Acme', project: 'Strategy' }, team.sam)
    coded = await h.post(`claims/${coded.id}/items`, { version: coded.version, kind: 'receipt', date: '2026-07-10', merchant: 'Project materials', amount: '100', salesTax: '10', allocations: [{category:team.c.office,amount:'40'},{category:team.c.travel,amount:'50'}], explanation: 'Client materials', billable: true, customer: 'Acme', project: 'Strategy' }, team.sam)
    coded = await h.post(`claims/${coded.id}/submit`, { version: coded.version }, team.sam)
    coded = await h.post(`claims/${coded.id}/decision`, { version: coded.version, revision: coded.revision, decision: 'approved', acknowledge: true }, team.priya)
    const codedBatch = await h.post('batches', { claims: [coded.id] }, team.morgan)
    await h.post(`batches/${codedBatch.id}/approve`, { version: codedBatch.version, expectedTotal: 17500 }, team.morgan)
    const codedLines = (await h.get(`batches/${codedBatch.id}`, team.morgan)).lines
    assert.deepEqual(codedLines.map(l => l.amountMinor).sort((a,b)=>a-b), [1000,4000,5000,7500])
    assert.ok(codedLines.every(l => l.billable && l.customer === 'Acme' && l.project === 'Strategy'), 'project coding reaches per diem, both allocations and the tax line')
    const book = await h.mf.dispatchFetch(`${h.origin}/api/coaster/batches/${codedBatch.id}/accounting.xlsx?template=${template.id}`, {headers:{cookie:team.morgan}})
    assert.equal(book.status,200)
    const workbook = Buffer.from(await book.arrayBuffer()), view = new DataView(workbook.buffer,workbook.byteOffset,workbook.length)
    let end=workbook.length-22; while(view.getUint32(end,true)!==0x06054b50) end--
    let directory=view.getUint32(end+16,true), sheet=''
    for(let n=view.getUint16(end+10,true);n>0;n--) {
      const size=view.getUint32(directory+20,true), length=view.getUint16(directory+28,true), offset=view.getUint32(directory+42,true)
      const name=workbook.subarray(directory+46,directory+46+length).toString()
      const data=offset+30+view.getUint16(offset+26,true)+view.getUint16(offset+28,true)
      if(name==='xl/worksheets/sheet1.xml') sheet=workbook.subarray(data,data+size).toString()
      directory+=46+length+view.getUint16(directory+30,true)+view.getUint16(directory+32,true)
    }
    const exportedRows=[...sheet.matchAll(/<row[^>]*>(.*?)<\/row>/g)].slice(1).map(m=>m[1])
    assert.equal(exportedRows.length,4)
    assert.ok(exportedRows.every(row=>['true','Acme','Strategy'].every(value=>row.includes(`>${value}</t>`))), 'XLSX preserves billing coding on all four accounting lines')
    if (process.env.PDF_EVIDENCE_DIR) {
      await mkdir(process.env.PDF_EVIDENCE_DIR, { recursive: true })
      await writeFile(`${process.env.PDF_EVIDENCE_DIR}/paid-claim.pdf`, full.bytes)
      await writeFile(`${process.env.PDF_EVIDENCE_DIR}/customer-claim.pdf`, filtered.bytes)
      await writeFile(`${process.env.PDF_EVIDENCE_DIR}/project-claim.pdf`, projectPdf.bytes)
      await writeFile(`${process.env.PDF_EVIDENCE_DIR}/project-batch.pdf`, projectBatch.bytes)
      await writeFile(`${process.env.PDF_EVIDENCE_DIR}/paid-batch.pdf`, batchPdf.bytes)
      await writeFile(`${process.env.PDF_EVIDENCE_DIR}/draft-extra-formats.pdf`, extraPdf.bytes)
    }
  } finally { await h.close() }
})
