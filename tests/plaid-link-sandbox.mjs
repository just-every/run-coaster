// Actual provider-hosted Link, with held sandbox application credentials and synthetic bank credentials only.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { harness } from './harness.mjs';
import { payrollBrowserRuntime } from './payroll-browser-runtime.mjs';
import { dynamicPlaidLifecycle } from './plaid-dynamic.mjs';
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
let browser, page;
try {
  await h.post('settings/business',{name:'Harbour Studio',currency:'USD',timezone:'UTC',receiptThreshold:''});
  await h.post('plaid/settings',{version:0,clientId:process.env.PLAID_CLIENT_ID,secret:process.env.PLAID_SANDBOX_SECRET,accountMonthly:'2.50',monthlyCap:'10.00',consent:true});
  const email=['synthetic-coaster-750','example.test'].join('@'),employee=await h.person(email,{employee:true});
  const category=(await h.post('settings/categories',{name:'Office supplies',accountCode:'6500',taxCode:'NONE'})).id;
  const attach=await payrollBrowserRuntime(),folder=resolve(process.env.COASTER_EVIDENCE??'.cache/plaid-live-link');await mkdir(folder,{recursive:true});
  browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});await attach(context,h);
  await context.route(/^https:\/\/([a-zA-Z0-9-]+\.)*plaid\.com\//,route=>route.continue());
  page=await context.newPage();await page.goto(h.origin+'/app#/settings');
  const section=page.getByRole('region',{name:'Plaid transaction feeds',exact:true});
  await section.getByText('Connect a transaction feed',{exact:true}).click();
  await section.getByLabel('Feed scope',{exact:true}).selectOption('company');
  await section.getByRole('checkbox',{name:/I authorize sharing selected accounts/}).check();
  await section.getByRole('button',{name:'Open Plaid Link',exact:true}).click();
  const frame=page.frameLocator('iframe[title="Plaid Link"]');
  await frame.getByRole('button',{name:'Continue without phone number',exact:true}).click({timeout:60_000});
  await frame.getByText('Select your institution',{exact:true}).waitFor({state:'visible',timeout:60_000});
  await frame.locator('input:visible').first().waitFor({state:'visible',timeout:60_000});
  await frame.locator('input:visible').first().fill('First Platypus Bank');
  await frame.getByText('First Platypus Bank',{exact:true}).click({timeout:60_000});
  await frame.getByText('3 associated institutions',{exact:true}).waitFor({state:'visible',timeout:60_000});
  await frame.getByText('First Platypus Bank',{exact:true}).last().click();
  await frame.locator('input[type="password"]').waitFor({state:'visible',timeout:60_000});
  await frame.getByLabel('Username',{exact:true}).fill('user_transactions_dynamic');
  await frame.getByLabel('Password',{exact:true}).fill('pass_good');
  await frame.getByRole('button',{name:'Submit',exact:true}).click();
  await frame.getByText('Your accounts',{exact:true}).waitFor({state:'visible',timeout:60_000});
  await frame.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(section.getByText(/Plaid feed connected:/)).toBeVisible({timeout:60_000});
  const connections=(await h.get('plaid/connections')).connections;assert.equal(connections.length,1);assert.equal(connections[0].scope,'company');assert.ok(connections[0].accounts.some(account=>account.type==='credit'));
  console.log('LINK_CONNECTED '+JSON.stringify({scope:'company',accounts:connections[0].accounts.length}));

  await page.screenshot({path:join(folder,'1440-provider-link.png'),fullPage:false});
  assert.ok(lastAccess);
  const sandbox=async(path,body)=>{const response=await fetch('https://sandbox.plaid.com'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,client_id:process.env.PLAID_CLIENT_ID,secret:process.env.PLAID_SANDBOX_SECRET}),redirect:'manual',signal:AbortSignal.timeout(25_000)});assert.equal(response.status,200,'Actual Sandbox fixture command '+path);return response.json();};
  const lifecycle=await dynamicPlaidLifecycle({h,connection:connections[0],employee,email,category,access:lastAccess,sandbox,observed,readiness:()=>readinessRefusal});
  console.log(JSON.stringify({sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),providerHostedCompanyLink:true,...lifecycle}));
} catch(error) {
  if(page){for(const frame of page.frames().slice(1)){let location;try{const url=new URL(frame.url());location=url.origin+url.pathname}catch{location='initializing'};const text=await frame.locator('body').innerText().catch(()=>'(unavailable)');console.error(JSON.stringify({frame:location,text:text.slice(0,1800)}));}await page.screenshot({path:'.cache/plaid-live-link/failed-viewport.png'}).catch(()=>{});}
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
