import assert from 'node:assert/strict'
export const personalPath = id => `claims/${id}/personal-spend`
export function personalInput(category,{last4='8839',key='synthetic-coaster-1',amount='12.34',secondAmount='23.46',merchant='synthetic-coaster'}={}) {
  const content=`<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>AUD</CURDEF><CCACCTFROM><ACCTID>${last4}</ACCTID></CCACCTFROM><BANKTRANLIST><DTSTART>20260501</DTSTART><DTEND>20260531</DTEND><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260510</DTPOSTED><TRNAMT>-${amount}</TRNAMT><FITID>${key}</FITID><NAME>${merchant}-1</NAME></STMTTRN><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260511</DTPOSTED><TRNAMT>-${secondAmount}</TRNAMT><FITID>${key}-2</FITID><NAME>${merchant}-2</NAME></STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>-${(Number(amount)+Number(secondAmount)).toFixed(2)}</BALAMT><DTASOF>20260531</DTASOF></LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`
  return {format:'ofx',name:key+'.ofx',issuer:'Synthetic personal card',category,content}
}
export async function importPersonalStatement(door,category,employee,options={}) {
  await door(['statements', 'cards'].join('/'),{issuer:'Synthetic personal card',last4:options.last4??'8839',employee})
  const input=personalInput(category,options),preview=await door(['statements', 'preview'].join('/'),input)
  assert.equal(preview.importable,2)
  return door(['statements', 'commit'].join('/'),{...input,fingerprint:preview.fingerprint})
}

/** Scheduled submission shares the complete expense, leaving the other charge in a private draft. */
export async function splitPersonalStatement(h,t,{markBefore}) {
  const employee=(await h.get('state',t.sam)).actor.email
  const imported=await importPersonalStatement(h.post,t.c.office,employee,{last4:markBefore?'8840':'8841',key:markBefore?'synthetic-coaster-8':'synthetic-coaster-9',merchant:markBefore?'synthetic-coaster-8':'synthetic-coaster-9'})
  await h.post('settings/business',{name:'Harbour & Finch Studio',currency:'AUD',timezone:'Australia/Sydney',perDiem:'75.00',receiptThreshold:'20.00'})
  let d=await h.get(`claims/${imported.claims[0]}`,t.sam)
  const item=d.items.find(i=>i.amount_minor===2346)
  let mark
  if(markBefore) {
    const result=await h.post(personalPath(d.claim.id),{version:d.claim.version,item:item.id,charge:item.card_charge_id,confirm:true},t.sam)
    mark=result.charges.find(p=>p.item_id===item.id)
  }
  await h.post('settings/auto-submit',{schedule:'daily'})
  const worker=await h.mf.getWorker()
  await worker.scheduled({scheduledTime:new Date('2026-06-01T00:00:00Z'),cron:'17 * * * *'})
  d=await h.get(`claims/${d.claim.id}`,t.sam)
  assert.equal(d.claim.status,'submitted')
  assert.deepEqual(d.items.map(i=>i.amount_minor),[1234])
  const held=await h.get(`claims/${d.events.find(e=>e.action==='auto-report-split').detail.heldClaim}`,t.sam)
  assert.equal(held.claim.status,'draft');assert.equal(held.claim.revision,0)
  assert.equal(held.items[0].id,item.id)
  await h.get(`claims/${held.claim.id}`,t.morgan,403)
  return {original:d,held,item,mark}
}
