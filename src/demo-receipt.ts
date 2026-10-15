// A one-page PDF receipt for the demo's sample expenses: merchant, date, lines and total
// in Helvetica. Each receipt's bytes differ, so duplicate detection treats them as distinct.

const ascii = (text: string) => text.normalize('NFKD').replace(/[\u2018\u2019]/g, "'").replace(/[^\x20-\x7e]/g, '').replace(/[\\()]/g, '\\$&');

export function receiptPdf(rows: string[]): Uint8Array {
  const text = rows.map((row, i) => `BT /F1 ${i === 0 ? 14 : 10} Tf 24 ${390 - i * 20} Td (${ascii(row)}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 260 420] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => { const at = body.length; body += `${i + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}
