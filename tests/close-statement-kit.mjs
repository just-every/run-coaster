import assert from 'node:assert/strict'

export const closePeriod = { from: '2026-05-01', to: '2026-05-31' }
const closePath = ['preparations', 'close'].join('/')
export const prepareClose = h => h.post(closePath, closePeriod)

/** Synthetic recorded periods, not a provider feed. Use ordinary import and reconciliation doors. */
export async function importCloseStatement(door, category, employee, { last4 = '8821', start = '20260420', end = '20260605', date = '20260510', credit = true, key = 'synthetic-coaster-821', issuer = 'Synthetic close card' } = {}) {
  await door('statements/cards', { issuer, last4, employee })
  const content = `<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>AUD</CURDEF><CCACCTFROM><ACCTID>${last4}</ACCTID></CCACCTFROM><BANKTRANLIST>${start ? `<DTSTART>${start}</DTSTART>` : ''}${end ? `<DTEND>${end}</DTEND>` : ''}<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>${date}</DTPOSTED><TRNAMT>-12.34</TRNAMT><FITID>${key}</FITID><NAME>Synthetic close purchase</NAME></STMTTRN>${credit ? `<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>${date}</DTPOSTED><TRNAMT>2.01</TRNAMT><FITID>${key}-credit</FITID><NAME>Synthetic close refund</NAME></STMTTRN>` : ''}</BANKTRANLIST><LEDGERBAL><BALAMT>-${credit ? '10.33' : '12.34'}</BALAMT><DTASOF>${end || date}</DTASOF></LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`
  const input = { format: 'ofx', name: `${key}.ofx`, issuer, category, content }
  const preview = await door('statements/preview', input)
  assert.equal(preview.importable, 1)
  const imported = await door('statements/commit', { ...input, fingerprint: preview.fingerprint })
  return { ...imported, last4, open: () => door(`statements/${imported.file}/reconcile`, { last4, openingBalance: '0.00' }) }
}
