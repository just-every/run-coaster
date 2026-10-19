import { zip } from './zip';

/** A one-sheet XLSX workbook: strings as inline text (never formulas), numbers as numbers. */
const NS = 'http://schemas.openxmlformats.org';
const xml = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const column = (n: number): string => n < 26 ? String.fromCharCode(65 + n) : column(Math.floor(n / 26) - 1) + column(n % 26);

export function xlsx(rows: (string | number)[][], at: Date) {
  const sheet = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => typeof v === 'number'
    ? `<c r="${column(c)}${r + 1}"><v>${v}</v></c>`
    : `<c r="${column(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(String(v ?? ''))}</t></is></c>`).join('')}</row>`).join('');
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const parts: Record<string, string> = {
    '[Content_Types].xml': `${head}<Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `${head}<Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${head}<workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets><sheet name="Coaster" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${head}<Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `${head}<worksheet xmlns="${NS}/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`,
  };
  return zip(Object.entries(parts).map(([name, text]) => ({ name, bytes: new TextEncoder().encode(text) })), at);
}
