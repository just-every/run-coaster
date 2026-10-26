import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {agency,harness} from './harness.mjs';
import {payrollBrowserRuntime,noOverflow,tooltipProof} from './payroll-browser-runtime.mjs';
import {receiptAddress,threeMails,receiptMail,deliverMail,aliasCode} from './fixtures/receipt-email.mjs';
const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/email-proof');await mkdir(evidence,{recursive:true});
const attach=await payrollBrowserRuntime(),shots=[];
const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
try{for(const width of [1440,390]){
 const h=await harness();let member,owner;
 try{
  const t=await agency(h),errors=[];
  await h.post('settings/receipt-email',{address:receiptAddress,consent:true});
  const {originals}=await threeMails(h),alias='sam.receipts@example.net';
  await deliverMail(h,receiptMail({from:alias}),alias);
  const capture=async(page,name,section)=>{await page.evaluate(()=>document.fonts.ready);await section.scrollIntoViewIfNeeded();await noOverflow(page);const path=join(evidence,`${width}-${name}.png`);await section.screenshot({path});shots.push(path);};
  member=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});await attach(member,{...h,owner:t.sam});const page=await member.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(h.origin+'/app#/claims');const inbox=page.getByRole('region',{name:'Receipt inbox',exact:true});
  await expect(inbox.getByRole('link',{name:'Download source message',exact:true})).toHaveCount(3);
  const rows=inbox.locator('.receipt-inbox-list > li');await expect(rows).toHaveCount(3);await capture(page,'three-receipts',inbox);
  for(const r of (await h.get('receipt-inbox',t.sam)).receipts){const response=await member.request.get(h.origin+r.emailSource.sourceUrl);assert.equal(response.status(),200);const bytes=await response.body();assert.ok(originals.some(raw=>raw.equals(bytes)));}
  if(width===390)await tooltipProof(page,page.locator('.account-menu summary'));
  await page.goto(h.origin+'/app#/settings');const settings=page.getByRole('region',{name:'Receipt email',exact:true});await expect(settings.getByLabel('Your other email address',{exact:true})).toBeVisible();
  await settings.getByLabel('Your other email address',{exact:true}).fill(alias);await settings.getByRole('button',{name:'Send confirmation code',exact:true}).click();
  const code=aliasCode(h,alias);await expect(settings.getByLabel(`Confirmation code for ${alias}`)).toBeVisible();await capture(page,'alias-pending',settings);
  await settings.getByLabel(`Confirmation code for ${alias}`).fill(code);await settings.getByRole('button',{name:'Confirm alias',exact:true}).click();await expect(settings.getByText('Alias confirmed. Future receipts from this address can enter your inbox.',{exact:true})).toBeVisible();
  await deliverMail(h,receiptMail({from:alias,subject:'Alias airline receipt'}),alias);await page.goto(h.origin+'/app#/claims');await expect(page.getByRole('link',{name:'Download source message',exact:true})).toHaveCount(4);await capture(page,'alias-landed',page.getByRole('region',{name:'Receipt inbox',exact:true}));
  owner=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});await attach(owner,h);const ownerPage=await owner.newPage();await ownerPage.goto(h.origin+'/app#/settings');const held=ownerPage.getByRole('region',{name:'Receipt email',exact:true});await expect(held.getByText('Held: Unknown sender; no inbox assignment',{exact:true})).toBeVisible();await capture(ownerPage,'owner-held',held);
  assert.equal((await h.get('settings/receipt-email')).held.length,1);assert.equal((await h.get('receipt-inbox',t.sam)).receipts.length,4);assert.deepEqual(errors,[]);
 }finally{await member?.close();await owner?.close();await h.close();}
}}finally{await browser.close();}
console.log(`Receipt email screens passed at 1440 and 390: ${shots.length} screenshots`);
