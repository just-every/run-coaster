// Actual provider-hosted Link, with held sandbox application credentials and synthetic bank credentials only.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { harness } from './harness.mjs';
import { payrollBrowserRuntime } from './payroll-browser-runtime.mjs';
import * as dynamic from './plaid-dynamic.mjs';
import { hostedPlaidLink } from './plaid-provider-link.mjs';
import { plaidLiveResponse } from './plaid-live-edge.mjs';
assert.ok(process.env.PLAID_CLIENT_ID && process.env.PLAID_SANDBOX_SECRET,'Inject the held sandbox application credentials');
const items=new Set(),observed=new Map();let lastAccess,readinessRefusal=false;
const h=await harness({plaidEdge:async request=>{
  const path=new URL(request.url).pathname,body=path==='/item/remove'?await request.clone().json():null;
  const response=await plaidLiveResponse(request);
  if(path==='/item/public_token/exchange'&&response.ok){lastAccess=(await response.clone().json()).access_token;items.add(lastAccess);}
  if(path==='/transactions/sync'){readinessRefusal=false;const data=await response.clone().json();if(response.ok)for(const tx of [...data.added,...data.modified])observed.set(tx.transaction_id,tx);else readinessRefusal=data.error_code==='PRODUCT_NOT_READY';}
  if(path==='/item/remove'&&response.ok)items.delete(body.access_token);
  return response;
}});
let browser;
try {
  await h.post('settings/business',{name:'Harbour Studio',currency:'USD',timezone:'UTC',receiptThreshold:''});
  await h.post('plaid/settings',{version:0,clientId:process.env.PLAID_CLIENT_ID,secret:process.env.PLAID_SANDBOX_SECRET,accountMonthly:'2.50',monthlyCap:'10.00',consent:true});
  const email=['synthetic-coaster-750','example.test'].join('@'),employee=await h.person(email,{employee:true});
  const category=(await h.post('settings/categories',{name:'Office supplies',accountCode:'6500',taxCode:'NONE'})).id;
  const attach=await payrollBrowserRuntime(),folder=resolve(process.env.COASTER_EVIDENCE??'.cache/plaid-live-link');await mkdir(folder,{recursive:true});
  browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
  const connection=await hostedPlaidLink({h,browser,attach,scope:'company',cookie:h.owner,folder});
  console.log('LINK_CONNECTED '+JSON.stringify({scope:'company',accounts:connection.accounts.length}));
  assert.ok(lastAccess);
  const sandbox=async(path,body)=>{const response=await fetch('https://sandbox.plaid.com'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,client_id:process.env.PLAID_CLIENT_ID,secret:process.env.PLAID_SANDBOX_SECRET}),redirect:'manual',signal:AbortSignal.timeout(25_000)});if(!response.ok){const failure=await response.json();throw new Error('Actual Sandbox fixture command '+path+' HTTP '+response.status+' '+failure.error_code);}return response.json();};
  const lifecycle=await dynamic.dynamicPlaidLifecycle({h,connection,employee,email,category,access:lastAccess,sandbox,observed,readiness:()=>readinessRefusal});
  console.log(JSON.stringify({sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),providerHostedCompanyLink:true,...lifecycle.proof}));
  const correction=await dynamic.dynamicPostedCorrections({h,access:lastAccess,sandbox,observed,...lifecycle});
  console.log(JSON.stringify(correction));
} catch(error) {
  console.error('Actual provider Link journey failed: '+String(error.message).replace(/([?&]token=)[^&\s]+/g,'$1[redacted]'));process.exitCode=1;
} finally {
  await browser?.close();
  for(const connection of (await h.get('plaid/connections')).connections){try{await h.post(`plaid/connections/${connection.id}/disconnect`,{});}catch{console.error('Native sandbox Link cleanup requires follow-up');}}
  for(const access of items){
    const response=await fetch('https://sandbox.plaid.com/item/remove',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_id:process.env.PLAID_CLIENT_ID,secret:process.env.PLAID_SANDBOX_SECRET,access_token:access}),redirect:'manual'});
    assert.equal(response.status,200,'Provider sandbox cleanup must confirm removal');
  }
  await h.close();
}
