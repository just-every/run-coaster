import assert from 'node:assert/strict';
import { plaidSetup, page, uploadWaiting } from './plaid-sync.mjs';
import { plaidTransaction } from './fixtures/plaid.mjs';

/** Public native correction door: immutable evidence, exact authority and never-submitted eligibility. */
export async function plaidCorrectionsJourney() {
  const t = await plaidSetup(), { h, edge } = t;
  try {
    const connection = await t.connect(), base = `plaid/connections/${connection.id}`;
    await h.post(base+'/assign',{account:connection.accounts[0].id,employee:t.email,category:t.category});
    const a=plaidTransaction({transaction_id:'synthetic-coaster-701',merchant_name:'Synthetic alpha',amount:20.005});
    const b=plaidTransaction({transaction_id:'synthetic-coaster-702',merchant_name:'Synthetic beta',amount:30});
    edge.pages.push(page([a,b])); await h.post(base+'/sync',{});
    const tx = id => h.db.prepare('SELECT * FROM c_plaid_transactions WHERE connection_id=? AND transaction_id=?').bind(connection.id,id).first();
    const latest = id => h.db.prepare('SELECT MAX(seq) AS seq FROM c_plaid_changes WHERE connection_id=? AND transaction_id=?').bind(connection.id,id).first();
    const original=await tx(a.transaction_id), oldCharge=await h.db.prepare('SELECT * FROM c_card_charges WHERE id=?').bind(original.charge_id).first();
    const oldSource=await h.db.prepare('SELECT * FROM c_plaid_sources WHERE id=?').bind(oldCharge.file_id).first();
    assert.equal(oldCharge.amount_minor,2001);assert.equal(JSON.parse(Buffer.from(oldSource.bytes).toString()).provider_amount,'20.005','the exact provider decimal survives native cent rounding');
    const item=await h.db.prepare('SELECT * FROM c_items WHERE id=?').bind(original.item_id).first();
    edge.pages.push(page([],[{...a,amount:21}], [b.transaction_id], 'synthetic-coaster-cursor-701')); await h.post(base+'/sync',{});
    const claim=await h.db.prepare('SELECT * FROM c_claims WHERE id=?').bind(item.claim_id).first();
    const seq=(await latest(a.transaction_id)).seq, request={transaction:a.transaction_id,changeSeq:seq,version:claim.version,consent:true};
    await h.post(base+'/reconcile',request,t.employee,403);
    await h.post(base+'/reconcile',{...request,changeSeq:seq-1},h.owner,409);
    const replaced=await h.post(base+'/reconcile',request);
    assert.equal(replaced.reason,'provider-replacement'); assert.notEqual(replaced.item,original.item_id); assert.notEqual(replaced.charge,original.charge_id);
    assert.deepEqual(await h.db.prepare('SELECT * FROM c_card_charges WHERE id=?').bind(original.charge_id).first(),oldCharge);
    assert.deepEqual(await h.db.prepare('SELECT * FROM c_plaid_sources WHERE id=?').bind(oldSource.id).first(),oldSource);
    assert.equal(await h.db.prepare('SELECT id FROM c_items WHERE id=?').bind(original.item_id).first(),null);
    const record=await h.db.prepare('SELECT * FROM c_plaid_corrections WHERE old_item_id=?').bind(original.item_id).first();
    assert.equal(JSON.parse(record.prior_snapshot).item.id,original.item_id);
    await h.post(base+'/reconcile',request,h.owner,409);
    const rowB=await tx(b.transaction_id), bItem=await h.db.prepare('SELECT * FROM c_items WHERE id=?').bind(rowB.item_id).first();
    const nextClaim=await h.db.prepare('SELECT * FROM c_claims WHERE id=?').bind(bItem.claim_id).first();
    const removed=await h.post(base+'/reconcile',{transaction:b.transaction_id,changeSeq:(await latest(b.transaction_id)).seq,version:nextClaim.version,consent:true});
    assert.equal(removed.reason,'provider-removal'); assert.equal(removed.item,null);
    assert.ok(await h.db.prepare('SELECT id FROM c_card_charges WHERE id=?').bind(rowB.charge_id).first());
    assert.equal(await h.db.prepare('SELECT id FROM c_items WHERE id=?').bind(rowB.item_id).first(),null);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_card_effective_charges WHERE id IN (?,?)').bind(original.charge_id,rowB.charge_id).first()).n,0,'retired immutable charges do not count as current company spend');

    edge.pages.push(page([b],[],[],'synthetic-coaster-cursor-706'));assert.equal((await h.post(base+'/sync',{})).expenses,0);assert.equal((await tx(b.transaction_id)).item_id,null,'replayed removed source never resurrects its retired expense');

    const attached=plaidTransaction({transaction_id:'synthetic-coaster-703',merchant_name:'Synthetic receipt',amount:40});
    await uploadWaiting(h,t.employee,attached); edge.pages.push(page([attached],[],[],'synthetic-coaster-cursor-702')); await h.post(base+'/sync',{});
    const attachedRow=await tx(attached.transaction_id), attachedItem=await h.db.prepare('SELECT * FROM c_items WHERE id=?').bind(attachedRow.item_id).first();
    assert.ok(attachedItem.receipt_id);
    edge.pages.push(page([],[{...attached,amount:41}],[],'synthetic-coaster-cursor-703')); await h.post(base+'/sync',{});
    const attachedClaim=await h.db.prepare('SELECT * FROM c_claims WHERE id=?').bind(attachedItem.claim_id).first();
    await h.post(base+'/reconcile',{transaction:attached.transaction_id,changeSeq:(await latest(attached.transaction_id)).seq,version:attachedClaim.version,consent:true},h.owner,409);
    await closedCorrectionRefused(t,connection,base);
  } finally { await h.close(); }
  await submittedCorrectionRefused();
  await personalCorrection();
}

async function submittedCorrectionRefused() {
  const t=await plaidSetup(), {h,edge}=t;
  try {
    await h.post('settings/business',{name:'Harbour Studio',currency:'USD',timezone:'UTC',receiptThreshold:'100.00'});
    const connection=await t.connect(),base=`plaid/connections/${connection.id}`;
    await h.post(base+'/assign',{account:connection.accounts[0].id,employee:t.email,category:t.category});
    const original=plaidTransaction({transaction_id:'synthetic-coaster-704'});
    edge.pages.push(page([original])); await h.post(base+'/sync',{});
    const claim=(await h.get('state',t.employee)).claims[0], detail=await h.get(`claims/${claim.id}`,t.employee);
    const submitted=await h.post(`claims/${claim.id}/submit`,{version:detail.claim.version},t.employee);
    await h.post(`claims/${claim.id}/decision`,{version:submitted.version,revision:submitted.revision,decision:'returned',reason:'Synthetic return',acknowledge:true},t.manager);
    edge.pages.push(page([],[{...original,amount:43}],[],'synthetic-coaster-cursor-704')); await h.post(base+'/sync',{});
    const returned=await h.get(`claims/${claim.id}`,t.employee), change=await h.db.prepare('SELECT MAX(seq) AS seq FROM c_plaid_changes WHERE connection_id=? AND transaction_id=?').bind(connection.id,original.transaction_id).first();
    await h.post(base+'/reconcile',{transaction:original.transaction_id,changeSeq:change.seq,version:returned.claim.version,consent:true},h.owner,409);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_plaid_corrections').first()).n,0);
  } finally { await h.close(); }
}

async function personalCorrection() {
  const t=await plaidSetup(), {h,edge}=t;
  try {
    const connection=await t.connect('personal',t.employee),base=`plaid/connections/${connection.id}`;
    await h.post(base+'/assign',{account:connection.accounts[0].id,employee:t.email,category:t.category},t.employee);
    const original=plaidTransaction({transaction_id:'synthetic-coaster-705'});
    edge.pages.push(page([original])); await h.post(base+'/sync',{},t.employee);
    const claim=(await h.get('state',t.employee)).claims[0], detail=await h.get(`claims/${claim.id}`,t.employee);
    assert.equal(detail.claim.total_minor,4250); assert.equal(detail.items[0].card_charge_id,null);
    const before=await h.db.prepare('SELECT * FROM c_plaid_personal_charges WHERE item_id=?').bind(detail.items[0].id).first(); assert.ok(before);
    edge.pages.push(page([],[{...original,amount:45}],[],'synthetic-coaster-cursor-705')); await h.post(base+'/sync',{},t.employee);
    const change=await h.db.prepare('SELECT MAX(seq) AS seq FROM c_plaid_changes WHERE connection_id=? AND transaction_id=?').bind(connection.id,original.transaction_id).first();
    const request={transaction:original.transaction_id,changeSeq:change.seq,version:detail.claim.version,consent:true};
    await h.post(base+'/reconcile',request,h.owner,403); await h.post(base+'/reconcile',request,t.other,403);
    const result=await h.post(base+'/reconcile',request,t.employee); assert.equal(result.charge,null);
    const current=await h.get(`claims/${claim.id}`,t.employee); assert.equal(current.claim.total_minor,4500); assert.equal(current.items[0].card_charge_id,null);
    const after=await h.db.prepare('SELECT * FROM c_plaid_personal_charges WHERE item_id=?').bind(result.item).first(); assert.ok(after); assert.notEqual(before.id,after.id);
    assert.deepEqual(await h.db.prepare('SELECT * FROM c_plaid_personal_charges WHERE id=?').bind(before.id).first(),before);
    const edited=await h.post(`claims/${claim.id}/items`,{version:current.claim.version,item:result.item,kind:'receipt',date:original.authorized_date,merchant:original.merchant_name,amount:'45.00',category:t.category,explanation:'Synthetic original unavailable'},t.employee);
    const submitted=await h.post(`claims/${claim.id}/submit`,{version:edited.version},t.employee);
    await h.post(`claims/${claim.id}/decision`,{version:submitted.version,revision:submitted.revision,decision:'rejected',reason:'Synthetic close',acknowledge:true},t.manager);
    await h.post('settings/members',{email:t.email,name:'Synthetic departed person',employee:true,active:false});await h.post('settings/members/erase',{email:t.email});
    for(const table of ['c_plaid_personal_charges','c_plaid_corrections'])assert.ok(!JSON.stringify((await h.db.prepare(`SELECT * FROM ${table}`).all()).results).includes(t.email),'erasure redacts retained correction identities and snapshots');
    assert.equal((await h.db.prepare('SELECT amount_minor FROM c_items WHERE id=?').bind(result.item).first()).amount_minor,4500);await h.post(base+'/sync',{},t.employee,401);
  } finally { await h.close(); }
}

async function closedCorrectionRefused(t,connection,base) {
  const {h,edge}=t,tx=plaidTransaction({transaction_id:'synthetic-coaster-707',date:'2026-11-15',authorized_date:'2026-11-15',merchant_name:'Synthetic closed supplies',amount:50});
  edge.pages.push(page([tx],[],[],'synthetic-coaster-cursor-707'));await h.post(base+'/sync',{});
  const card=(await h.get('statements')).cards.find(card=>card.last4==='1008');
  const statement={format:'ofx',name:'synthetic-coaster-707.ofx',issuer:card.issuer,category:t.category,content:'OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD<CCACCTFROM><ACCTID>1008</CCACCTFROM><BANKTRANLIST><DTSTART>20261101<DTEND>20261130<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261115<DTUSER>20261115<TRNAMT>-50.00<FITID>synthetic-coaster-708<NAME>Synthetic closed supplies</STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>-50.00<DTASOF>20261130</LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>'};
  const preview=await h.post('statements/preview',statement),imported=await h.post('statements/commit',{...statement,fingerprint:preview.fingerprint});
  const analysis=await h.post(`statements/${imported.file}/reconcile`,{last4:'1008',openingBalance:'0.00'});assert.equal(analysis.heldMinor,5000);
  const closed=await h.post(`statements/reconciliations/${analysis.id}/close`,{});assert.equal(closed.ledger.cardAccountMinor,5000);
  edge.pages.push(page([],[{...tx,amount:51}],[],'synthetic-coaster-cursor-708'));await h.post(base+'/sync',{});
  const current=(await h.get(base+'/transactions')).transactions.find(row=>row.transaction_id===tx.transaction_id);
  const refused=await h.post(base+'/reconcile',{transaction:tx.transaction_id,changeSeq:current.changeSeq,version:current.claimVersion,consent:true},h.owner,409);assert.match(refused.error,/closed card period/);
  assert.equal((await h.db.prepare('SELECT amount_minor FROM c_items WHERE id=?').bind(current.item_id).first()).amount_minor,5000);
}
