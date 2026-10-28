// Held-key sandbox proof through native HTTP doors. Never print credentials or provider bodies.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { harness } from './harness.mjs';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const address=n=>[`synthetic-coaster-${n}`,'example.test'].join('@');

assert.ok(process.env.PLAID_CLIENT_ID && process.env.PLAID_SANDBOX_SECRET,'Inject the named Plaid sandbox bindings');
const keys={client_id:process.env.PLAID_CLIENT_ID,secret:process.env.PLAID_SANDBOX_SECRET};
async function sandbox(path,body){
  const response=await fetch('https://sandbox.plaid.com'+path,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(25_000),headers:{'content-type':'application/json','Plaid-Version':'2020-09-14'},body:JSON.stringify({...body,...keys})});
  assert.equal(response.status,200,'Plaid sandbox '+path+' HTTP '+response.status);
  return response.json();
}
const providerRequests=[],liveItems=new Map();
let lastExchange=null,readinessRefusal=false;
const h=await harness({plaidEdge:async r=>{
  providerRequests.push(new URL(r.url).pathname);
  // Node's configured environment proxy handles the real network edge; application HTTP is never faked.
  const path=new URL(r.url).pathname;
  const requestBody=path==='/item/remove'?await r.clone().json():null;
  const response=await fetch(r);
  // Inspect a clone only to orchestrate real Sandbox fixtures; the app receives unchanged bytes.
  if(path==='/item/public_token/exchange'&&response.ok){
    const exchanged=await response.clone().json();
    assert.ok(typeof exchanged.access_token==='string'&&typeof exchanged.item_id==='string','Sandbox exchange returned private fixture custody');
    lastExchange={access_token:exchanged.access_token,item_id:exchanged.item_id};
    liveItems.set(exchanged.access_token,lastExchange);
  }
  if(path==='/transactions/sync'&&!response.ok){
    const failure=await response.clone().json();readinessRefusal=failure.error_code==='PRODUCT_NOT_READY';
  }
  if(path==='/item/remove'&&response.ok)liveItems.delete(requestBody.access_token);
  return response;
}});
const connected=[],cookies=[h.owner];
let linkTokensCreated=0,exchanges=0;
try {
  await h.post(['settings','business'].join('/'),{name:'Synthetic Coaster',currency:'USD',timezone:'UTC',receiptThreshold:''});
  const employee=await h.person(address(250),{employee:true});cookies.push(employee);
  const admin=await h.person(address(251),{admin:true,employee:true});cookies.push(admin);
  const category=(await h.post('settings/categories',{name:'Synthetic Coaster Office',accountCode:'6500',taxCode:'NONE'})).id;
  const day=new Date(Date.now()-86_400_000).toISOString().slice(0,10);
  const denied=[];
  for(const [i,roles] of [{cardAdmin:true},{manager:true},{auditor:true},{bookkeeper:true}].entries())denied.push(await h.person(address(252+i),roles));
  await h.post(['plaid','settings'].join('/'),{version:0,clientId:keys.client_id,secret:keys.secret,accountMonthly:'2.50',monthlyCap:'5.00',consent:true});
  const initial=await h.get(['plaid','settings'].join('/'));
  assert.deepEqual([initial.accountMonthlyMinor,initial.monthToDateMinor,initial.monthlyCapMinor],[250,0,500]);
  const requestsBeforeRefusal=providerRequests.length;
  for(const cookie of denied)await h.post(['plaid','link'].join('/'),{scope:'company',consent:true},cookie,403);
  assert.equal(providerRequests.length,requestsBeforeRefusal);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_plaid_links').first()).n,0);
  for(const scope of ['company','personal']){
    const cookie=scope==='company'?admin:employee;
    const link=await h.post(['plaid','link'].join('/'),{scope,consent:true},cookie);
    assert.ok(link.linkToken && link.environment==='sandbox');linkTokensCreated++;
    const custom={version:2,seed:'synthetic-coaster-'+(scope==='company'?260:261),override_accounts:[{type:'credit',subtype:'credit card',starting_balance:100,meta:{name:'Synthetic Coaster card',official_name:'Synthetic Coaster card'},transactions:[{date_transacted:day,date_posted:day,amount:scope==='company'?12:18.75,description:scope==='company'?'Harbour Parking':'Harbour Stationery',currency:'USD'}]}]};
    const publicToken=await sandbox('/sandbox/public_token/create',{institution_id:'ins_109508',initial_products:['transactions'],options:{override_username:'user_custom',override_password:JSON.stringify(custom)}});
    const result=await h.post(['plaid','exchange'].join('/'),{link:link.id,publicToken:publicToken.public_token,consent:true},cookie);
    assert.ok(lastExchange,'Native exchange was observed at the real provider edge');
    connected.push({id:result.id,cookie,scope,account:result.accounts[0],privateItem:lastExchange});lastExchange=null;exchanges++;
    assert.equal(result.estimatedUsdMinor,250);
    assert.equal(result.accounts.length,1);assert.equal(result.accounts[0].type,'credit');assert.match(result.accounts[0].last4,/^\d{4}$/);
    assert.equal((await h.get(['plaid','connections'].join('/'),cookie)).connections.filter(c=>c.scope===scope).length,1);
    const stored=await h.db.prepare('SELECT credentials_sealed FROM c_plaid_connections WHERE id=?').bind(result.id).first();
    assert.ok(!stored.credentials_sealed.includes(keys.secret));
  }
  const company=connected.find(c=>c.scope==='company'),personal=connected.find(c=>c.scope==='personal');
  for(const c of connected)await h.post(`plaid/connections/${c.id}/assign`,{account:c.account.id,employee:address(250),category},c.cookie);
  const ramp={source:'ramp',filename:'synthetic-coaster-262.csv',mapping:{date:'YYYY-MM-DD'},csv:`Transaction ID,Transaction Date,User Email,Merchant Name,Amount,Currency,Memo,Ramp Category,Accounting Category,Receipt File\nsynthetic-coaster-263,${day},${address(250)},Harbour Parking,12.00,USD,Synthetic visit,Synthetic Coaster Office,6500,\n`};
  const preview=await h.post('import/preview',ramp);await h.post('import/commit',{...ramp,fingerprint:preview.fingerprint});
  // Sandbox initialization is asynchronous. These are explicit subsequent native sync commands,
  // bounded to 60 seconds of polling delay, solely for documented eventual transaction readiness.
  async function syncUntil(c,predicate){
    for(let attempt=0;attempt<31;attempt++){
      readinessRefusal=false;
      const result=await h.send(`/api/coaster/plaid/connections/${c.id}/sync`,{},c.cookie);
      assert.ok(result.status===200||(result.status===502&&readinessRefusal),'Native Sandbox sync succeeded or reported documented initial readiness');
      if(result.status===200){
        const txs=(await h.get(`plaid/connections/${c.id}/transactions`,c.cookie)).transactions;
        if(predicate(txs))return txs;
      }
      if(attempt<30)await delay(2000);
    }
    assert.fail('Sandbox transactions did not become visible within the bounded readiness polls');
  }
  const companyInitial=await syncUntil(company,txs=>txs.some(t=>t.merchant==='Harbour Parking'&&t.amount_minor===1200));
  assert.equal(companyInitial.find(t=>t.merchant==='Harbour Parking'&&t.amount_minor===1200).status,'overlap');
  const personalInitial=await syncUntil(personal,txs=>txs.some(t=>t.merchant==='Harbour Stationery'&&t.amount_minor===1875&&t.item_id));
  const personalTx=personalInitial.find(t=>t.merchant==='Harbour Stationery'&&t.amount_minor===1875);
  assert.equal(personalTx.status,'posted');
  await h.get(`plaid/connections/${personal.id}/transactions`,h.owner,403);
  await h.get(`plaid/connections/${personal.id}/transactions`,admin,403);
  const rule=await h.get('settings/card-matching');await h.post('settings/card-matching',{version:rule.version,enabled:true,windowDays:7,tipPercent:0,fxPercent:0});
  const form=new FormData();form.append('file',new File([await readFile('tests/fixtures/receipts/officeworks.png')],'synthetic-coaster-264.png',{type:'image/png'}));form.append('source','upload');
  const request=new Request(h.origin+'/api/coaster/receipt-inbox',{method:'POST',headers:{origin:h.origin,cookie:employee},body:form});
  const response=await h.mf.dispatchFetch(request.url,{method:'POST',headers:Object.fromEntries(request.headers),body:await request.arrayBuffer()});
  assert.equal(response.status,200,'Native receipt upload succeeded');
  const uploaded=await response.json(),receipt=uploaded.receipt.id;
  await h.post(`receipt-inbox/${receipt}/card-match`,{expectedSequence:0,enabled:true,merchant:'Harbour Supplies',date:day,total:'23.45',currency:'USD',last4:company.account.last4,notice:uploaded.receipt.matchChoice.notice},employee);
  assert.equal((await h.get('receipt-inbox',employee)).receipts.find(r=>r.id===receipt).attachment,null);
  // A real provider fixture mutation occurs only after the receipt's explicit opt-in.
  await sandbox('/sandbox/transactions/create',{access_token:company.privateItem.access_token,transactions:[{account_id:company.account.id,date_transacted:day,date_posted:day,amount:23.45,description:'Harbour Supplies',iso_currency_code:'USD'}]});
  const companyPosted=await syncUntil(company,txs=>txs.some(t=>t.merchant==='Harbour Supplies'&&t.amount_minor===2345&&t.item_id));
  const companyTx=companyPosted.find(t=>t.merchant==='Harbour Supplies'&&t.amount_minor===2345);
  assert.equal(companyTx.status,'posted');
  async function detailFor(tx){
    for(const claim of (await h.get('state',employee)).claims){
      const detail=await h.get(`claims/${claim.id}`,employee);
      if(detail.items.some(i=>i.id===tx.item_id))return detail;
    }
    assert.fail('Synced expense is visible through the employee claim door');
  }
  const companyDetail=await detailFor(companyTx),personalDetail=await detailFor(personalTx);
  const companyItem=companyDetail.items.find(i=>i.id===companyTx.item_id),personalItem=personalDetail.items.find(i=>i.id===personalTx.item_id);
  assert.equal(companyItem.amount_minor,2345);assert.ok(companyItem.card_charge_id);assert.ok(companyItem.receipt_id);
  assert.equal(personalItem.amount_minor,1875);assert.equal(personalItem.card_charge_id,null);
  assert.equal(companyDetail.claim.total_minor,companyDetail.items.filter(i=>!i.card_charge_id).reduce((sum,i)=>sum+i.amount_minor,0),'Company card amount is excluded from reimbursement');
  assert.ok(personalDetail.claim.total_minor>=1875,'Personal charge contributes to reimbursement');
  const attachment=(await h.get('receipt-inbox',employee)).receipts.find(r=>r.id===receipt).attachment;
  assert.equal(attachment.itemId,companyItem.id);
  const before=JSON.stringify((await h.db.prepare('SELECT id,claim_id,amount_minor,card_charge_id,receipt_id FROM c_items ORDER BY id').all()).results);
  for(const c of connected){const replay=await h.post(`plaid/connections/${c.id}/sync`,{},c.cookie);assert.equal(replay.expenses,0);}
  assert.equal(JSON.stringify((await h.db.prepare('SELECT id,claim_id,amount_minor,card_charge_id,receipt_id FROM c_items ORDER BY id').all()).results),before);
  assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM c_capture_lifecycle WHERE receipt_id=? AND kind='attached'").bind(receipt).first()).n,1);
  const audit=(await h.get('history')).lines.filter(e=>e.action==='plaid-synced'||e.action==='plaid-expense-created');
  assert.ok(audit.some(e=>e.action==='plaid-expense-created'));assert.ok(audit.every(e=>e.actor_email&&e.channel==='app'&&e.at));
  assert.equal((await h.get(['plaid','settings'].join('/'))).monthToDateMinor,500);
  const fullCapRequests=providerRequests.length;
  await h.post(['plaid','link'].join('/'),{scope:'company',consent:true},admin,409);
  assert.equal(providerRequests.length,fullCapRequests);
  assert.ok((await h.post('claims',{title:'Synthetic manual claim at the Plaid cap'},employee)).id);
  for(const c of connected)await h.post(['plaid','connections',c.id,'disconnect'].join('/'),{},c.cookie);
  connected.length=0;
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_plaid_connections').first()).n,0);
  assert.equal(providerRequests.filter(p=>p==='/item/remove').length,2);
  console.log(JSON.stringify({sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),environment:'sandbox',companyCard:true,personalCard:true,linkTokensCreated,exchanges,maskedAccountsVerified:2,providerRemovalsConfirmed:2,adminConnection:true,deniedRoles:4,monthToDateMinor:500,capRefusal:true,manualClaimAtCap:true,companyPostedExpense:true,personalPostedExpense:true,companyNonReimbursable:true,personalReimbursable:true,rampOverlap:true,receiptOptInBeforeProviderCharge:true,receiptAttachedOnce:true,replayNoDuplicateExpenses:true,nativeAudit:true,personalPrivacy:true,livePendingTransition:false,livePostedModification:false,livePostedRemoval:false,gaps:['Live pending transition is not exercised by this credit-only custom fixture','No deterministic documented endpoint was used to modify or remove an already posted transaction'],outcome:'PASS'}));
} finally {
  for(const c of connected){try{await h.post(['plaid','connections',c.id,'disconnect'].join('/'),{},c.cookie);}catch{console.error('Sandbox connection cleanup requires explicit follow-up');}}
  // A refused account validation may leave pending custody for explicit item removal.
  for(const cookie of cookies){
    for(const c of (await h.get(['plaid','connections'].join('/'),cookie)).connections){try{await h.post(['plaid','connections',c.id,'disconnect'].join('/'),{},cookie);}catch{console.error('Pending sandbox item removal remains unconfirmed');}}
  }
  // Exchange custody captured at the network edge also covers an Item whose native activation failed.
  for(const item of liveItems.values()){
    try{await sandbox('/item/remove',{access_token:item.access_token});}catch{console.error('Sandbox item cleanup requires explicit follow-up');}
  }
  await h.close();
}
