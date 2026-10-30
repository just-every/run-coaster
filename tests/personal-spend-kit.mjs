import assert from 'node:assert/strict'
export const personalPath = id => `claims/${id}/personal-spend`
export function personalInput(category,{last4='8839',key='synthetic-coaster-1',amount='12.34'}={}) {
  const content=`<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>AUD</CURDEF><CCACCTFROM><ACCTID>${last4}</ACCTID></CCACCTFROM><BANKTRANLIST><DTSTART>20260501</DTSTART><DTEND>20260531</DTEND><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260510</DTPOSTED><TRNAMT>-${amount}</TRNAMT><FITID>${key}</FITID><NAME>synthetic-coaster-1</NAME></STMTTRN><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260511</DTPOSTED><TRNAMT>-23.46</TRNAMT><FITID>${key}-2</FITID><NAME>synthetic-coaster-2</NAME></STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>-${(Number(amount)+23.46).toFixed(2)}</BALAMT><DTASOF>20260531</DTASOF></LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`
  return {format:'ofx',name:key+'.ofx',issuer:'Synthetic personal card',category,content}
}
export async function importPersonalStatement(door,category,employee,options={}) {
  await door('statements/cards',{issuer:'Synthetic personal card',last4:options.last4??'8839',employee})
  const input=personalInput(category,options),preview=await door('statements/preview',input)
  assert.equal(preview.importable,2)
  return door('statements/commit',{...input,fingerprint:preview.fingerprint})
}
