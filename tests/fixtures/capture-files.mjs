import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { encode as encodeWebp } from '@stacksjs/ts-webp'

// An actual parseable three-page folio, with a large uncompressed content
// stream. The stream is PDF whitespace, so it does not obscure the folio text.
export async function captureFolio(size) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let page = 1; page <= 3; page++) {
    const sheet = pdf.addPage([612,792])
    sheet.drawText(`Harbour Hotel - Folio page ${page} of 3`, { x: 40, y: 730, font, size: 18 })
    sheet.drawText(`Sam - 2026-10-12 - Room ${100 + page} - USD 240.00`, { x: 40, y: 680, font, size: 12 })
  }
  if (!size) return Buffer.from(await pdf.save({ useObjectStreams: false }))
  let padding = size - 5_000
  const ref = pdf.context.register(pdf.context.stream(Buffer.alloc(padding,32)))
  pdf.getPages()[2].node.addContentStream(ref)
  let bytes
  for (let pass = 0; pass < 4; pass++) {
    bytes = Buffer.from(await pdf.save({ useObjectStreams: false }))
    if (bytes.length === size) break
    padding += size - bytes.length
    pdf.context.assign(ref,pdf.context.stream(Buffer.alloc(padding,32)))
  }
  assert.equal(bytes.length,size)
  assert.equal((await PDFDocument.load(bytes)).getPageCount(),3,'large receipt is a genuine three-page PDF')
  return bytes
}

export async function captureFiles() {
  const [png,jpeg,heic] = await Promise.all(['bistro.png','report-bistro.jpg','report-bistro.heic'].map(name => readFile(new URL(`./receipts/${name}`,import.meta.url))))
  const pixels = new Uint8Array(8*8*4).fill(255)
  const webp = Buffer.from(encodeWebp({ width: 8,height: 8,data: pixels },{ backend: 'pure-ts',lossless: true }))
  const pdf = await captureFolio(), largePdf = await captureFolio(8_000_000)
  const formats = [{ extension: 'png',bytes: png,mediaType: 'image/png' },{ extension: 'jpg',bytes: jpeg,mediaType: 'image/jpeg' },{ extension: 'webp',bytes: webp,mediaType: 'image/webp' },{ extension: 'heic',bytes: heic,mediaType: 'image/heic' },{ extension: 'pdf',bytes: pdf,mediaType: 'application/pdf' }]
  const files = Array.from({ length: 30 },(_,index) => {
    const input = index === 14 ? { extension: 'pdf',bytes: largePdf,mediaType: 'application/pdf' } : formats[index % formats.length]
    return { name: `receipt-${index + 1}.${input.extension}`,bytes: input.bytes,mediaType: input.mediaType,source: index === 0 ? 'camera' : 'upload' }
  })
  return { files,oversized: { name: 'too-large.pdf',bytes: Buffer.alloc(12_000_000),mediaType: 'application/pdf' } }
}
