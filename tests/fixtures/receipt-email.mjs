import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
export const receiptAddress='receipts@harbourfinch.example';
export function receiptMail({from='sam@harbourfinch.example',subject='Airline receipt',html='<h1>Harbour Air</h1><p>Flight Denver to Boston</p><p>Total USD 245.80</p>',file,inline=false}={}) {
 const headers=`From: ${from}\r\nTo: ${receiptAddress}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\n`;
 const body=file?`Content-Type: multipart/mixed; boundary="synthetic-coaster-8200"\r\n\r\n--synthetic-coaster-8200\r\nContent-Type: text/plain\r\n\r\nYour receipt is attached.\r\n--synthetic-coaster-8200\r\nContent-Type: ${file.type??'application/octet-stream'}\r\nContent-Disposition: ${inline?'inline':'attachment'}; filename="${file.name}"\r\n${inline?'Content-ID: <receipt-photo>\r\n':''}Content-Transfer-Encoding: base64\r\n\r\n${Buffer.from(file.bytes).toString('base64')}\r\n--synthetic-coaster-8200--\r\n`:`Content-Type: text/html; charset=UTF-8\r\n\r\n${html}`;
 return Buffer.from(headers+body);
}
export async function deliverMail(h,raw,from='sam@harbourfinch.example',to=receiptAddress) {
 const r=await h.send('/__test/email',{from,to,base64:raw.toString('base64')});
 assert.equal(r.status,200,JSON.stringify(r.value));return r.value;
}
export async function threeMails(h) {
 const photo=await readFile('tests/fixtures/receipts/bistro.png');
 const {PDFDocument}=await import('pdf-lib');const doc=await PDFDocument.create();doc.addPage().drawText('Harbour invoice - Total USD 120.00');const pdf=Buffer.from(await doc.save());
 const originals=[receiptMail(),receiptMail({subject:'Invoice',file:{name:'invoice.pdf',bytes:pdf}}),receiptMail({subject:'Photo',file:{name:'receipt.png',bytes:photo},inline:true})];
 for(const raw of originals)await deliverMail(h,raw);
 return {originals,photo,pdf};
}
export function aliasCode(h,address) {
 const mail=h.messages.findLast(m=>m.to.includes(address)&&m.subject==='Confirm your Coaster receipt address');assert.ok(mail);
 const code=mail.text.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/)?.[0];assert.ok(code);return code;
}
