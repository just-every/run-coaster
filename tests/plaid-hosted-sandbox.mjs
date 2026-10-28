// Held-key qualification of the actual hosted company and personal Link doors at both viewports.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { harness } from './harness.mjs';
import { payrollBrowserRuntime } from './payroll-browser-runtime.mjs';
import { plaidLiveResponse } from './plaid-live-edge.mjs';
import { dynamicPlaidLifecycle } from './plaid-dynamic.mjs';
import { hostedPlaidLink } from './plaid-provider-link.mjs';
assert.ok(process.env.PLAID_CLIENT_ID&&process.env.PLAID_SANDBOX_SECRET,'Inject held Sandbox application credentials');
const items=new Set(),connections=[],observed=new Map();let lastAccess,readinessRefusal=false;
const h=await harness({plaidEdge:async request=>{
 const path=new URL(request.url).pathname,body=path==='/item/remove'?await request.clone().json():null,response=await plaidLiveResponse(request);
 if(path==='/item/public_token/exchange'&&response.ok){lastAccess=(await response.clone().json()).access_token;items.add(lastAccess);}
 if(path==='/transactions/sync'){const data=await response.clone().json();readinessRefusal=!response.ok&&data.error_code==='PRODUCT_NOT_READY';if(response.ok)for(const tx of [...data.added,...data.modified])observed.set(tx.transaction_id,tx);}
 if(path==='/item/remove'&&response.ok)items.delete(body.access_token);
 return response;
}});
let browser;
try {
 await h.post('settings/business',{name:'Harbour Studio',currency:'USD',timezone:'UTC',receiptThreshold:''});
 await h.post('plaid/settings',{version:0,clientId:process.env.PLAID_CLIENT_ID,secret:process.env.PLAID_SANDBOX_SECRET,accountMonthly:'2.50',monthlyCap:'20.00',consent:true});
 const address=n=>[`synthetic-coaster-${n}`,'example.test'].join('@');
 const admin=await h.person(address(760),{admin:true,employee:true}),employee=await h.person(address(761),{employee:true});
 browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
 const attach=await payrollBrowserRuntime(),folder=resolve('.cache/plaid-hosted');await mkdir(folder,{recursive:true});
 const category=(await h.post('settings/categories',{name:'Office supplies',accountCode:'6500',taxCode:'NONE'})).id;
 const sandbox=async(path,body)=>{const response=await fetch('https://sandbox.plaid.com'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,client_id:process.env.PLAID_CLIENT_ID,secret:process.env.PLAID_SANDBOX_SECRET}),redirect:'manual',signal:AbortSignal.timeout(25_000)});if(!response.ok){const failure=await response.json();throw new Error('Sandbox fixture command '+path+' HTTP '+response.status+' '+failure.error_code);}return response.json();};
 const results=[];let lifecycle;
 for(const width of [1440,390])for(const [scope,cookie] of [['company',admin],['personal',employee]]){
  const connection=await hostedPlaidLink({h,browser,attach,scope,cookie,width,folder});connections.push({id:connection.id,cookie});
  assert.equal(connection.estimatedUsdMinor,connection.accounts.length*250);
  await h.get(`plaid/connections/${connection.id}/transactions`,scope==='company'?employee:admin,403);
  if(width===1440&&scope==='company'){lifecycle=(await dynamicPlaidLifecycle({h,connection,employee,email:address(761),category,access:lastAccess,sandbox,observed,readiness:()=>readinessRefusal,cookie})).proof;}
  await h.post(`plaid/connections/${connection.id}/disconnect`,{},cookie);connections.pop();
  assert.ok(!(await h.get('plaid/connections',cookie)).connections.some(row=>row.id===connection.id));
  results.push({scope,width,verifiedAccounts:connection.accounts.length});
 }
 assert.equal(items.size,0,'Every real Sandbox item is removed through explicit native disconnection');
 console.log(JSON.stringify({sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),providerHostedLink:results,lifecycle,providerItemsRemaining:items.size}));
} catch(error){console.error(String(error.message).replace(/([?&]token=)[^&\s]+/g,'$1[redacted]'));process.exitCode=1;}
finally {
 await browser?.close();
 for(const connection of connections)await h.post(`plaid/connections/${connection.id}/disconnect`,{},connection.cookie);
 for(const access of items){const response=await fetch('https://sandbox.plaid.com/item/remove',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_id:process.env.PLAID_CLIENT_ID,secret:process.env.PLAID_SANDBOX_SECRET,access_token:access}),redirect:'manual',signal:AbortSignal.timeout(25_000)});assert.equal(response.status,200,'Sandbox fixture cleanup');}
 await h.close();
}
