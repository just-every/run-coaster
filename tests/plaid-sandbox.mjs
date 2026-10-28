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
const providerRequests=[],liveItems=new Map(),liveTransactions=new Map();
let lastExchange=null,readinessRefusal=false;
const h=await harness({plaidEdge:async r=>{
  providerRequests.push(new URL(r.url).pathname);
  // Node's configured environment proxy handles the real network edge; application HTTP is never faked.
  const path=new URL(r.url).pathname;
  const requestBody=path==='/item/remove'?await r.clone().json():null;
  let response;
  const requestHeaders=new Headers(r.headers);
  for(const name of ['content-length','host','connection','transfer-encoding'])requestHeaders.delete(name);
  try { response=await fetch(r.url,{method:r.method,headers:requestHeaders,body:await r.text(),redirect:'manual',signal:AbortSignal.timeout(25_000)}); } catch(error) { console.error(JSON.stringify({providerPath:path,transportError:error.name,transportCode:error.cause?.code})); throw error; }
  if(!response.ok){let failure={};try{failure=await response.clone().json()}catch{}console.error(JSON.stringify({providerPath:path,status:response.status,errorCode:failure.error_code,errorType:failure.error_type}));}
  // Inspect a clone only to orchestrate real Sandbox fixtures; the app receives unchanged bytes.
  if(path==='/item/public_token/exchange'&&response.ok){
    const exchanged=await response.clone().json();
    assert.ok(typeof exchanged.access_token==='string'&&typeof exchanged.item_id==='string','Sandbox exchange returned private fixture custody');
    lastExchange={access_token:exchanged.access_token,item_id:exchanged.item_id};
    liveItems.set(exchanged.access_token,lastExchange);
  }
  if(path==='/transactions/sync'&&response.ok){const page=await response.clone().json();for(const tx of [...page.added,...page.modified])liveTransactions.set(tx.transaction_id,{merchant:tx.merchant_name||tx.name,amountMinor:Math.round(tx.amount*100)});}
  if(path==='/transactions/sync'&&!response.ok){
    const failure=await response.clone().json();readinessRefusal=failure.error_code==='PRODUCT_NOT_READY';
  }
  if(path==='/item/remove'&&response.ok)liveItems.delete(requestBody.access_token);
  // Node fetch decodes compressed provider bytes. Do not ask workerd to decompress them a second time.
  const headers=new Headers(response.headers);headers.delete('content-encoding');headers.delete('content-length');
  return new Response(await response.arrayBuffer(),{status:response.status,headers});
}});
const connected=[],cookies=[h.owner];
let linkTokensCreated=0,exchanges=0,fixtureProviderRemovals=0,proof;
try {
  await h.post(['settings','business'].join('/'),{name:'Synthetic Coaster',currency:'USD',timezone:'UTC',receiptThreshold:''});
  const employee=await h.person(address(250),{employee:true});cookies.push(employee);
  const admin=await h.person(address(251),{admin:true,employee:true,manager:true});cookies.push(admin);
  const personalEmployee=await h.person(address(257),{employee:true},address(251));cookies.push(personalEmployee);
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
  const ramp={source:'ramp',filename:'synthetic-coaster-262.csv',mapping:{date:'YYYY-MM-DD'},csv:`Transaction ID,Transaction Date,User Email,Merchant Name,Amount,Currency,Memo,Ramp Category,Accounting Category,Receipt File\nsynthetic-coaster-263,${day},${address(250)},Harbour Parking,12.00,USD,Synthetic visit,Synthetic Coaster Office,6500,\n`};
  const preview=await h.post('import/preview',ramp);await h.post('import/commit',{...ramp,fingerprint:preview.fingerprint});
  for(const scope of ['company','personal']){
    const cookie=scope==='company'?admin:personalEmployee;
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
  for(const c of connected)await h.post(`plaid/connections/${c.id}/assign`,{account:c.account.id,employee:address(c.scope==='company'?250:257),category},c.cookie);
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
  const companyInitial=await syncUntil(company,txs=>txs.some(t=>t.amount_minor===1200));
  assert.equal(companyInitial.find(t=>t.amount_minor===1200).status,'overlap');
  const personalInitial=await syncUntil(personal,txs=>txs.some(t=>t.amount_minor===1875&&t.item_id));
  const personalTx=personalInitial.find(t=>t.amount_minor===1875);
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
  const companyPosted=await syncUntil(company,txs=>txs.some(t=>t.amount_minor===2345&&t.item_id));
  const companyTx=companyPosted.find(t=>t.amount_minor===2345);
  assert.equal(companyTx.status,'posted');
  async function detailFor(tx,cookie){
    for(const claim of (await h.get('state',cookie)).claims){
      const detail=await h.get(`claims/${claim.id}`,cookie);
      if(detail.items.some(i=>i.id===tx.item_id))return detail;
    }
    assert.fail('Synced expense is visible through the employee claim door');
  }
  const companyDetail=await detailFor(companyTx,employee),personalDetail=await detailFor(personalTx,personalEmployee);
  const companyItem=companyDetail.items.find(i=>i.id===companyTx.item_id),personalItem=personalDetail.items.find(i=>i.id===personalTx.item_id);
  assert.equal(companyItem.merchant,liveTransactions.get(companyTx.transaction_id).merchant);assert.equal(personalItem.merchant,liveTransactions.get(personalTx.transaction_id).merchant);
  assert.equal(companyItem.amount_minor,2345);assert.ok(companyItem.card_charge_id);assert.ok(companyItem.receipt_id);
  assert.equal(personalItem.amount_minor,1875);assert.equal(personalItem.card_charge_id,null);
  assert.equal(companyDetail.claim.total_minor,companyDetail.items.filter(i=>!i.card_charge_id).reduce((sum,i)=>sum+i.amount_minor,0),'Company card amount is excluded from reimbursement');
  assert.ok(personalDetail.claim.total_minor>=1875,'Personal charge contributes to reimbursement');
  const attachment=(await h.get('receipt-inbox',employee)).receipts.find(r=>r.id===receipt).attachment;
  assert.equal(attachment.itemId,companyItem.id);
  // Settle the personal claim through ordinary expense editing, submission and manager review.
  // Do this before replay: Sandbox may enrich initial posting facts, correctly creating a reconciliation hold.
  const edited=await h.post(`claims/${personalDetail.claim.id}/items`,{version:personalDetail.claim.version,item:personalItem.id,kind:personalItem.kind,date:personalItem.spent_on,merchant:personalItem.merchant,amount:'18.75',allocations:[{category}],explanation:'Synthetic stationery purchase without a paper receipt'},personalEmployee);
  const submitted=await h.post(`claims/${edited.id}/submit`,{version:edited.version},personalEmployee);
  const rejected=await h.post(`claims/${submitted.id}/decision`,{version:submitted.version,revision:submitted.revision,decision:'rejected',reason:'Synthetic personal purchase'},admin);
  assert.equal(rejected.status,'rejected');
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
  await h.post('settings/members',{email:address(257),name:'synthetic-coaster-257',employee:true,approver:address(251),active:false});
  const beforeErasureRequests=providerRequests.length;
  const erased=await h.post('settings/members/erase',{email:address(257)});
  assert.equal(erased.removed.personalPlaidConnections,1);
  assert.equal(erased.removed.signInAccount,true);
  assert.equal(providerRequests.length,beforeErasureRequests,'Local erasure makes no provider request and does not claim provider revocation');
  assert.ok(erased.retained.claims.some(c=>c.status==='rejected'&&c.totalMinor===1875));
  const retained=await h.get(`claims/${personalDetail.claim.id}`);
  assert.deepEqual([retained.claim.employee_email,retained.claim.status,retained.claim.total_minor],[erased.retained.subject,'rejected',1875]);
  const retainedItem=retained.items.find(i=>i.id===personalItem.id);
  assert.equal(retainedItem.amount_minor,1875);assert.equal(retainedItem.merchant,personalItem.merchant);
  assert.ok(retainedItem.personal_card_charge_id,'Personal feed provenance remains with the retained expense');
  for(const value of [retained,await h.get('state'),await h.get('history'),await h.get('retention')]){
    const text=JSON.stringify(value);
    assert.ok(!text.includes(address(257))&&!text.includes('synthetic-coaster-257'),'Public retained records redact the erased name and address');
  }
  const beforeErasedReplay=providerRequests.length;
  await h.get('state',personalEmployee,401);
  await h.post(`plaid/connections/${personal.id}/sync`,{},personalEmployee,401);
  await h.get(`plaid/connections/${personal.id}/transactions`,personalEmployee,401);
  await h.post(`plaid/connections/${personal.id}/disconnect`,{},personalEmployee,401);
  await h.post(`plaid/connections/${personal.id}/sync`,{},h.owner,404);
  await h.get(`plaid/connections/${personal.id}/transactions`,h.owner,404);
  await h.post(`plaid/connections/${personal.id}/disconnect`,{},h.owner,404);
  assert.equal(providerRequests.length,beforeErasedReplay,'Erased session and deleted connection replays make no physical provider request');
  assert.ok(!(await h.get('plaid/connections',admin)).connections.some(c=>c.id===personal.id));
  // Company disconnect retains the normal application/provider removal contract.
  await h.post(`plaid/connections/${company.id}/disconnect`,{},company.cookie);
  connected.length=0;
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_plaid_connections').first()).n,0);
  assert.equal(providerRequests.filter(p=>p==='/item/remove').length,1);
  proof={sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),environment:'sandbox',companyCard:true,personalCard:true,linkTokensCreated,exchanges,maskedAccountsVerified:2,providerRemovalsConfirmed:2,applicationProviderRemovalsConfirmed:1,fixtureProviderRemovalsConfirmed:1,personalErasure:true,erasedExpenseRetained:true,erasedSessionReplayRefused:true,erasedIdentityRedacted:true,localErasureDoesNotRevokeProvider:true,adminConnection:true,deniedRoles:4,monthToDateMinor:500,capRefusal:true,manualClaimAtCap:true,companyPostedExpense:true,personalPostedExpense:true,companyNonReimbursable:true,personalReimbursable:true,rampOverlap:true,receiptOptInBeforeProviderCharge:true,receiptAttachedOnce:true,replayNoDuplicateExpenses:true,nativeAudit:true,personalPrivacy:true,livePendingTransition:false,livePostedModification:false,livePostedRemoval:false,gaps:['Live pending transition is not exercised by this credit-only custom fixture','No deterministic documented endpoint was used to modify or remove an already posted transaction'],outcome:'PASS'};
} finally {
  for(const c of connected){try{await h.post(['plaid','connections',c.id,'disconnect'].join('/'),{},c.cookie);}catch{console.error('Sandbox connection cleanup requires explicit follow-up');}}
  // A refused account validation may leave pending custody for explicit item removal.
  for(const cookie of cookies){
    const listed=await h.send('/api/coaster/plaid/connections',undefined,cookie);
    if(listed.status===401||listed.status===403)continue;
    assert.equal(listed.status,200,'Live fixture cleanup can list native connections');
    for(const c of listed.value.connections){try{await h.post(['plaid','connections',c.id,'disconnect'].join('/'),{},cookie);}catch{console.error('Pending sandbox item removal remains unconfirmed');}}
  }
  // Fixture-only provider cleanup uses in-memory exchange custody, including the locally erased personal Item.
  // This is separate from application erasure, which does not revoke the provider Item.
  for(const item of liveItems.values()){
    try{await sandbox('/item/remove',{access_token:item.access_token});fixtureProviderRemovals++;}catch{console.error('Sandbox item cleanup requires explicit follow-up');}
  }
  await h.close();
}

assert.equal(providerRequests.filter(p=>p==='/item/remove').length+fixtureProviderRemovals,2,'Both real provider fixtures were removed, one by normal disconnect and one by fixture-only cleanup');
assert.equal(fixtureProviderRemovals,1);
console.log(JSON.stringify(proof));
