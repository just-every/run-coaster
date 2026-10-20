import { PDFDocument, StandardFonts } from 'pdf-lib'

/** Distinct synthetic business receipts for the two keyboard journeys. */
export async function keyboardReceipt({ merchant, date, amount, reference }) {
  const pdf = await PDFDocument.create(), page = pdf.addPage([280, 240])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const [index, line] of [merchant, `Receipt ${reference}`, date, 'Client workshop transport', `Total AUD ${amount}`, 'Paid in cash'].entries())
    page.drawText(line, { x: 24, y: 210 - index * 28, size: 12, font })
  return Buffer.from(await pdf.save())
}
