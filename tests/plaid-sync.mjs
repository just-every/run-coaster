import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harness } from './harness.mjs';
import { plaidFixture, plaidConfig, plaidTransaction } from './fixtures/plaid.mjs';
const address = n => [`synthetic-coaster-${n}`, 'example.test'].join('@');
export async function plaidSetup(options={}) {
  const edge=plaidFixture(),h=await harness({clock:Date.now(),plaidEdge:r=>edge.fetch(r),...options});
  try {
  await h.post('settings/business',{name:'Harbour Studio',currency:'USD',timezone:'UTC',receiptThreshold:''});
  const manager=await h.person(address(351),{employee:true,manager:true});
  const employee=await h.person(address(352),{employee:true},address(351));
  const other=await h.person(address(353),{employee:true},address(351));
  const category=await h.post('settings/categories',{name:'Office',accountCode:'6500',taxCode:'NONE'});
  await h.post('plaid/settings',{...plaidConfig,monthlyCap:'20.00'});
  const connect=async(scope='company',cookie=h.owner,token='synthetic-coaster-354')=>{
    const link=await h.post('plaid/link',{scope,consent:true},cookie);
    return h.post('plaid/exchange',{link:link.id,publicToken:token,consent:true},cookie);
  };
  return {h,edge,manager,employee,other,email:address(352),otherEmail:address(353),category:category.id,connect};
  } catch(error) { await h.close(); throw error; }
}
export const page = (added=[], modified=[], removed=[], cursor='synthetic-coaster-cursor-1',has_more=false)=>({added,modified,removed:removed.map(transaction_id=>({transaction_id})),next_cursor:cursor,has_more});
export async function uploadWaiting(h,employee,tx) {
  const form=new FormData();form.append('file',new File([await readFile('tests/fixtures/receipts/officeworks.png')],'synthetic-coaster-receipt.png',{type:'image/png'}));form.append('source','upload');
  const req=new Request(h.origin+'/api/coaster/receipt-inbox',{method:'POST',headers:{origin:h.origin,cookie:employee},body:form});
  const response=await h.mf.dispatchFetch(req.url,{method:'POST',headers:Object.fromEntries(req.headers),body:await req.arrayBuffer()});
  assert.equal(response.status,200,await response.clone().text());const uploaded=await response.json(),id=uploaded.receipt.id;
  await h.post(`receipt-inbox/${id}/card-match`,{expectedSequence:0,enabled:true,merchant:tx.merchant_name,date:tx.authorized_date,total:tx.amount.toFixed(2),currency:'USD',last4:'1008',notice:uploaded.receipt.matchChoice.notice},employee);
  return id;
}
export async function companyTransactionJourney() {
  const t=await plaidSetup(),{h,edge}=t;
  try {
    const ramp={source:'ramp',filename:'synthetic-coaster-ramp.csv',mapping:{date:'YYYY-MM-DD'},csv:`Transaction ID,Transaction Date,User Email,Merchant Name,Amount,Currency,Memo,Ramp Category,Accounting Category,Receipt File\nsynthetic-coaster-356,2026-10-15,${t.email},Harbour Parking,12.00,USD,Synthetic visit,Office,6500,\n`};
    const preview=await h.post('import/preview',ramp);await h.post('import/commit',{...ramp,fingerprint:preview.fingerprint});
    const connection=await t.connect(),base=`plaid/connections/${connection.id}`;
    await h.post(base+'/assign',{account:connection.accounts[0].id,employee:t.email,category:t.category});
    await h.post(base+'/assign',{account:'synthetic-coaster-unverified',employee:t.email,category:t.category},h.owner,409);
    const rule=await h.get('settings/card-matching');await h.post('settings/card-matching',{version:rule.version,enabled:true,windowDays:7,tipPercent:0,fxPercent:0});
    const pending=plaidTransaction({transaction_id:'synthetic-coaster-355',pending:true});
    const receipt=await uploadWaiting(h,t.employee,pending);
    const overlap=plaidTransaction({transaction_id:'synthetic-coaster-357',merchant_name:'Harbor Parking Inc',name:'Harbour Parking',amount:12});
    edge.pages.push(page([pending,overlap]));
    assert.deepEqual(await h.post(base+'/sync',{}),{added:2,modified:0,removed:0,expenses:0,cursor:'synthetic-coaster-cursor-1'});
    assert.equal((await h.get('state',t.employee)).claims.length,0);
    let inbox=await h.get('receipt-inbox',t.employee);assert.equal(inbox.receipts.find(r=>r.id===receipt).attachment,null);
    const posted=plaidTransaction({transaction_id:'synthetic-coaster-358',pending_transaction_id:pending.transaction_id});
    edge.pages.push(page([],[],[pending.transaction_id],'synthetic-coaster-cursor-2',true),page([posted],[],[],'synthetic-coaster-cursor-3'));
    const synced=await h.post(base+'/sync',{});assert.deepEqual([synced.added,synced.removed,synced.expenses],[1,1,1]);
    const txs=(await h.get(base+'/transactions')).transactions;assert.deepEqual(txs.map(r=>r.status).sort(),['overlap','posted','removed']);
    let claims=(await h.get('state',t.employee)).claims;assert.equal(claims.length,1);
    let detail=await h.get(`claims/${claims[0].id}`,t.employee);assert.equal(detail.items.length,1);assert.equal(detail.items[0].amount_minor,4250);assert.ok(detail.items[0].card_charge_id);assert.ok(detail.items[0].receipt_id);assert.equal(detail.claim.total_minor,0);
    inbox=await h.get('receipt-inbox',t.employee);assert.equal(inbox.receipts.find(r=>r.id===receipt).attachment.itemId,detail.items[0].id);
    const attached=(await h.db.prepare("SELECT * FROM c_capture_lifecycle WHERE receipt_id=? AND kind='attached'").bind(receipt).all()).results;assert.equal(attached.length,1);assert.equal(attached[0].actor_email,'automation: card match');
    edge.pages.push(page([posted],[],[],'synthetic-coaster-cursor-3'));
    assert.equal((await h.post(base+'/sync',{})).expenses,0);
    assert.equal((await h.get(`claims/${claims[0].id}`,t.employee)).items.length,1);
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM c_capture_lifecycle WHERE receipt_id=? AND kind='attached'").bind(receipt).first()).n,1);
    const card=(await h.get('statements')).cards[0];
    const statement={format:'ofx',name:'synthetic-coaster-statement.ofx',issuer:card.issuer,category:t.category,content:`OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD<CCACCTFROM><ACCTID>1008</CCACCTFROM><BANKTRANLIST><DTSTART>20261001<DTEND>20261031<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261015<DTUSER>20261015<TRNAMT>-42.50<FITID>synthetic-coaster-359<NAME>Harbour Stationery</STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>-42.50<DTASOF>20261031</LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`};
    const statementPreview=await h.post('statements/preview',statement);assert.equal(statementPreview.importable,0);assert.equal(statementPreview.duplicates.length,1);
    const imported=await h.post('statements/commit',{...statement,fingerprint:statementPreview.fingerprint});
    assert.deepEqual(imported.claims,[],'a matching statement links the existing Plaid charge without another expense');
    const reconciliation=await h.post(`statements/${imported.file}/reconcile`,{last4:'1008',openingBalance:'0.00'});
    assert.equal(reconciliation.unresolved,0);assert.equal(reconciliation.heldMinor,4250);
    const closed=await h.post(`statements/reconciliations/${reconciliation.id}/close`,{});
    assert.deepEqual([closed.ledger.cardAccountMinor,closed.ledger.statementMinor,closed.ledger.matches],[4250,4250,true]);
    assert.equal((await h.get(`claims/${claims[0].id}`,t.employee)).items.length,1);
    const before=JSON.stringify((await h.get(`claims/${claims[0].id}`,t.employee)).items);
    edge.pages.push(page([],[{...posted,amount:43.50}],[],'synthetic-coaster-cursor-4'));
    assert.equal((await h.post(base+'/sync',{})).modified,1);
    assert.equal((await h.get(base+'/transactions')).transactions.find(tx=>tx.transaction_id===posted.transaction_id).status,'review');
    detail=await h.get(`claims/${claims[0].id}`,t.employee);assert.equal(JSON.stringify(detail.items),before,'a source correction never rewrites receipt or expense facts');
    const refused=await h.post(`claims/${detail.claim.id}/submit`,{version:detail.claim.version},t.employee,409);assert.match(refused.error,/Plaid.*reconciliation/);
    edge.pages.push(page([],[],[posted.transaction_id],'synthetic-coaster-cursor-5'));
    await h.post(base+'/sync',{});assert.equal((await h.get(`claims/${claims[0].id}`,t.employee)).items.length,1);
    const events=(await h.get('history')).lines.filter(e=>e.action==='plaid-synced');assert.equal(events.length,5);assert.ok(events.every(e=>e.actor_email&&e.channel==='app'&&e.at));assert.deepEqual(events.map(e=>e.seq),events.map(e=>e.seq).sort((a,b)=>a-b));
    for(const request of edge.calls){const payload=JSON.stringify(request.body);assert.ok(!payload.includes(t.email)&&!payload.includes('Harbour Stationery')&&!payload.includes('Harbour Parking')&&!payload.includes(receipt),'provider requests contain only declared connection and cursor inputs');}
    const requests=edge.calls.length;await h.post(base+'/sync',{},t.other,403);assert.equal(edge.calls.length,requests);
    await h.post(base+'/disconnect',{});await h.post(base+'/sync',{},h.owner,404);assert.equal(edge.items.size,0);
  }finally{await h.close();}
}
export async function personalTransactionJourney() {
  const t=await plaidSetup(),{h,edge}=t;
  try {
    const connection=await t.connect('personal',t.employee),base=`plaid/connections/${connection.id}`;
    await h.post(base+'/assign',{account:connection.accounts[0].id,employee:t.otherEmail,category:t.category},t.employee,403);
    await h.post(base+'/assign',{account:connection.accounts[0].id,employee:t.email,category:t.category},t.employee);
    edge.pages.push(page([plaidTransaction()]));
    assert.equal((await h.post(base+'/sync',{},t.employee)).expenses,1);
    const claim=(await h.get('state',t.employee)).claims[0],detail=await h.get(`claims/${claim.id}`,t.employee);
    assert.equal(detail.items.length,1);assert.equal(detail.items[0].amount_minor,4250);assert.equal(detail.items[0].card_charge_id,null);assert.equal(detail.claim.total_minor,4250);
    await h.get(base+'/transactions',h.owner,403);await h.get(base+'/transactions',t.other,403);
    edge.pages.push(page([plaidTransaction()]));assert.equal((await h.post(base+'/sync',{},t.employee)).expenses,0);
    assert.equal((await h.get(`claims/${claim.id}`,t.employee)).items.length,1);
    const edited=await h.post(`claims/${claim.id}/items`,{version:detail.claim.version,item:detail.items[0].id,kind:'receipt',date:'2026-10-15',merchant:'Harbour Stationery',amount:'42.50',category:t.category,explanation:'Original receipt unavailable'},t.employee);
    const submitted=await h.post(`claims/${claim.id}/submit`,{version:edited.version},t.employee);
    await h.post(`claims/${claim.id}/decision`,{version:submitted.version,revision:submitted.revision,decision:'rejected',reason:'Synthetic close',acknowledge:true},t.manager);
    const requests=edge.calls.length;
    await h.post('settings/members',{email:t.email,name:'Synthetic departed employee',employee:true,active:false});
    await h.post('settings/members/erase',{email:t.email});
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_plaid_connections WHERE id=?').bind(connection.id).first()).n,0);
    await h.post(base+'/sync',{},t.employee,401);assert.equal(edge.calls.length,requests);
    assert.equal((await h.db.prepare('SELECT amount_minor FROM c_items WHERE id=?').bind(detail.items[0].id).first()).amount_minor,4250);
    for(const table of ['c_plaid_transactions','c_plaid_assignments'])assert.ok(!JSON.stringify((await h.db.prepare(`SELECT * FROM ${table}`).all()).results).includes(t.email));
  }finally{await h.close();}
}

export async function monthlyPlaidJourney() {
  const t=await plaidSetup(),{h,edge}=t;
  try {
    const connection=await t.connect(),base=`plaid/connections/${connection.id}`;
    await h.post(base+'/assign',{account:connection.accounts[0].id,employee:t.email,category:t.category});
    const worker=await h.mf.getWorker(),at=new Date('2040-02-01T00:00:00Z');
    await worker.scheduled({scheduledTime:at,cron:'17 * * * *'});
    await worker.scheduled({scheduledTime:at,cron:'17 * * * *'});
    const costs=(await h.db.prepare("SELECT * FROM c_plaid_costs WHERE month='2040-02' AND kind='settled'").all()).results;
    assert.equal(costs.length,1);assert.equal(costs[0].accounts,1);assert.equal(costs[0].usd_minor,250);
    assert.equal(edge.calls.filter(c=>c.path==='/transactions/sync').length,0,'cost-only schedule sends no provider request');
    await h.post('plaid/settings',{...plaidConfig,version:1,monthlyCap:'1.00'});
    const requests=edge.calls.length,refused=await h.post(base+'/sync',{},h.owner,409);assert.match(refused.error,/cap/);assert.equal(edge.calls.length,requests);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_plaid_sync_state').first()).n,0);
    assert.ok((await h.post('claims',{title:'Manual claim while optional feed is capped'},t.employee)).id);
    await h.post('plaid/settings',{...plaidConfig,version:2,monthlyCap:'20.00'});
    let revoke=true;
    const nativeFetch=edge.fetch.bind(edge);
    edge.fetch=async request=>{const response=await nativeFetch(request);if(new URL(request.url).pathname==='/transactions/sync'&&revoke){revoke=false;await h.post(base+'/disconnect',{});}return response;};
    edge.pages.push(page([plaidTransaction()]));
    await h.post(base+'/sync',{},h.owner,409);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_plaid_transactions').first()).n,0,'revocation fences the in-flight financial commit');
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_items').first()).n,0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_plaid_sync_state').first()).n,0);
  }finally{await h.close();}
}

export async function personalCreditJourney() {
  const t=await plaidSetup(),{h,edge}=t;
  try {
    const finance=await h.person(address(360),{employee:true,finance:true});
    const connection=await t.connect('personal',t.employee),base=`plaid/connections/${connection.id}`;
    await h.post(base+'/assign',{account:connection.accounts[0].id,employee:t.email,category:t.category},t.employee);
    edge.pages.push(page([plaidTransaction()]));await h.post(base+'/sync',{},t.employee);
    const claim=(await h.get('state',t.employee)).claims[0],detail=await h.get(`claims/${claim.id}`,t.employee);
    const edited=await h.post(`claims/${claim.id}/items`,{version:detail.claim.version,item:detail.items[0].id,kind:'receipt',date:'2026-10-15',merchant:'Harbour Stationery',amount:'42.50',category:t.category,explanation:'Original receipt unavailable'},t.employee);
    const submitted=await h.post(`claims/${claim.id}/submit`,{version:edited.version},t.employee);
    const approved=await h.post(`claims/${claim.id}/decision`,{version:submitted.version,revision:submitted.revision,decision:'approved',acknowledge:true},t.manager);
    const draft=await h.post('batches',{claims:[approved.id]},finance),reviewed=await h.post(`batches/${draft.id}/approve`,{version:draft.version,expectedTotal:4250});
    const released=await h.post(`batches/${draft.id}/release`,{version:reviewed.version});
    edge.pages.push(page([plaidTransaction({transaction_id:'synthetic-coaster-361',amount:-10})],[],[],'synthetic-coaster-cursor-2'));
    assert.equal((await h.post(base+'/sync',{},t.employee)).expenses,0);
    const refused=await h.post(`batches/${draft.id}/paid`,{version:released.version,reference:'Synthetic manual payment',paidOn:'2026-10-20'},h.owner,409);
    assert.match(refused.error,/Plaid.*credit.*reconciliation/);
    assert.equal((await h.db.prepare('SELECT status FROM c_batches WHERE id=?').bind(draft.id).first()).status,'approved');
    assert.equal((await h.db.prepare('SELECT amount_minor FROM c_items WHERE id=?').bind(detail.items[0].id).first()).amount_minor,4250);
    let manual=await h.post('claims',{title:'Manual expenses remain available despite an unresolved feed credit'},t.employee);
    manual=await h.post(`claims/${manual.id}/items`,{version:manual.version,kind:'receipt',date:'2026-10-15',merchant:'Harbour Stationery',amount:'42.50',category:t.category,explanation:'Synthetic receipt missing'},t.employee);
    const duplicate=await h.post(`claims/${manual.id}/submit`,{version:manual.version},t.employee,409);assert.match(duplicate.error,/personal Plaid source expense/);
    const manualDetail=await h.get(`claims/${manual.id}`,t.employee);
    manual=await h.post(`claims/${manual.id}/items`,{version:manual.version,item:manualDetail.items[0].id,kind:'receipt',date:'2026-10-15',merchant:'Unrelated manual supplies',amount:'1.00',category:t.category,explanation:'Synthetic receipt missing'},t.employee);
    assert.equal((await h.post(`claims/${manual.id}/submit`,{version:manual.version},t.employee)).status,'submitted');
  }finally{await h.close();}
}
