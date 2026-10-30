import assert from 'node:assert/strict'
export const personalPath = id => `claims/${id}/personal-spend`
export function personalInput(category,{last4='8839',key='synthetic-coaster-1',amount='12.34',secondAmount='23.46'}={}) {
  const content=`<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>AUD</CURDEF><CCACCTFROM><ACCTID>${last4}</ACCTID></CCACCTFROM><BANKTRANLIST><DTSTART>20260501</DTSTART><DTEND>20260531</DTEND><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260510</DTPOSTED><TRNAMT>-${amount}</TRNAMT><FITID>${key}</FITID><NAME>synthetic-coaster-1</NAME></STMTTRN><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260511</DTPOSTED><TRNAMT>-${secondAmount}</TRNAMT><FITID>${key}-2</FITID><NAME>synthetic-coaster-2</NAME></STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>-${(Number(amount)+Number(secondAmount)).toFixed(2)}</BALAMT><DTASOF>20260531</DTASOF></LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`
  return {format:'ofx',name:key+'.ofx',issuer:'Synthetic personal card',category,content}
}
export async function importPersonalStatement(door,category,employee,options={}) {
  await door(['statements', 'cards'].join('/'),{issuer:'Synthetic personal card',last4:options.last4??'8839',employee})
  const input=personalInput(category,options),preview=await door(['statements', 'preview'].join('/'),input)
  assert.equal(preview.importable,2)
  return door(['statements', 'commit'].join('/'),{...input,fingerprint:preview.fingerprint})
}
