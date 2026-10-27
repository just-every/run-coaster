// Held-key sandbox proof through native HTTP doors. Never print credentials or provider bodies.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { harness } from './harness.mjs';

assert.ok(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET,'Inject the named Plaid sandbox bindings');
const keys={client_id:process.env.PLAID_CLIENT_ID,secret:process.env.PLAID_SECRET};
async function sandbox(path,body){
  const response=await fetch('https://sandbox.plaid.com'+path,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(25_000),headers:{'content-type':'application/json','Plaid-Version':'2020-09-14'},body:JSON.stringify({...body,...keys})});
  assert.equal(response.status,200,'Plaid sandbox '+path+' HTTP '+response.status);
  return response.json();
}
const providerRequests=[];
const h=await harness({plaidEdge:async r=>{
  providerRequests.push(new URL(r.url).pathname);
  // Node's configured environment proxy handles the real network edge; application HTTP is never faked.
  return fetch(r);
}});
const connected=[],cookies=[h.owner];
let linkTokensCreated=0,exchanges=0;
try {
  await h.post(['settings','business'].join('/'),{name:'Synthetic Coaster',currency:'USD',timezone:'UTC',receiptThreshold:''});
  const employee=await h.person('synthetic-coaster-250@example.test',{employee:true});cookies.push(employee);
  const admin=await h.person('synthetic-coaster-251@example.test',{admin:true,employee:true});cookies.push(admin);
  const denied=[];
  for(const [i,roles] of [{cardAdmin:true},{manager:true},{auditor:true},{bookkeeper:true}].entries())denied.push(await h.person(`synthetic-coaster-${252+i}@example.test`,roles));
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
    const custom={seed:'synthetic-coaster-'+scope,override_accounts:[{type:'credit',subtype:'credit card',starting_balance:100,meta:{name:'Synthetic Coaster card',official_name:'Synthetic Coaster card'}}]};
    const publicToken=await sandbox('/sandbox/public_token/create',{institution_id:'ins_109508',initial_products:['transactions'],options:{override_username:'user_custom',override_password:JSON.stringify(custom)}});
    const result=await h.post(['plaid','exchange'].join('/'),{link:link.id,publicToken:publicToken.public_token,consent:true},cookie);
    connected.push({id:result.id,cookie});exchanges++;
    assert.equal(result.estimatedUsdMinor,250);
    assert.equal(result.accounts.length,1);assert.equal(result.accounts[0].type,'credit');assert.match(result.accounts[0].last4,/^\d{4}$/);
    assert.equal((await h.get(['plaid','connections'].join('/'),cookie)).connections.filter(c=>c.scope===scope).length,1);
    const stored=await h.db.prepare('SELECT credentials_sealed FROM c_plaid_connections WHERE id=?').bind(result.id).first();
    assert.ok(!stored.credentials_sealed.includes(keys.secret));
  }
  assert.equal((await h.get(['plaid','settings'].join('/'))).monthToDateMinor,500);
  const fullCapRequests=providerRequests.length;
  await h.post(['plaid','link'].join('/'),{scope:'company',consent:true},admin,409);
  assert.equal(providerRequests.length,fullCapRequests);
  assert.ok((await h.post('claims',{title:'Synthetic manual claim at the Plaid cap'},employee)).id);
  for(const c of connected)await h.post(['plaid','connections',c.id,'disconnect'].join('/'),{},c.cookie);
  connected.length=0;
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_plaid_connections').first()).n,0);
  assert.equal(providerRequests.filter(p=>p==='/item/remove').length,2);
  console.log(JSON.stringify({source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),environment:'sandbox',companyCard:true,personalCard:true,linkTokensCreated,exchanges,maskedAccountsVerified:2,providerRemovalsConfirmed:2,adminConnection:true,deniedRoles:4,monthToDateMinor:500,capRefusal:true,manualClaimAtCap:true,transactionSync:'not implemented',outcome:'PASS'}));
} finally {
  for(const c of connected){try{await h.post(['plaid','connections',c.id,'disconnect'].join('/'),{},c.cookie);}catch{console.error('Sandbox connection cleanup requires explicit follow-up');}}
  // A refused account validation may leave pending custody for explicit item removal.
  for(const cookie of cookies){
    for(const c of (await h.get(['plaid','connections'].join('/'),cookie)).connections){try{await h.post(['plaid','connections',c.id,'disconnect'].join('/'),{},cookie);}catch{console.error('Pending sandbox item removal remains unconfirmed');}}
  }
  await h.close();
}
