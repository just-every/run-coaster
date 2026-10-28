// Native entity screens and receipt decisions use real HTTP; only public rate transport is a fixture.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { chromium,expect } from '@playwright/test';
import { harness } from './harness.mjs';
import { entityScenario,entityRates } from './entity-kit.mjs';
import { payrollBrowserRuntime,noOverflow,tooltipProof } from './payroll-browser-runtime.mjs';
const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/entity-proof');
await mkdir(evidence,{recursive:true});
const attach=await payrollBrowserRuntime(),browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
try {
 for(const width of [1440,390]) {
  const h=await harness({fxRates:entityRates});let context;
  try {
   const f=await entityScenario(h);
   context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
   const transport=await attach(context,h),page=await context.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   const actor=async cookie=>{const split=cookie.indexOf('=');await context.addCookies([{name:cookie.slice(0,split),value:cookie.slice(split+1),url:h.origin,httpOnly:true,sameSite:'Lax'}]);};
   const shot=async(name,region)=>{
    await noOverflow(page);
    if(region)await region.scrollIntoViewIfNeeded();
    const small=await (region??page.locator('.app')).evaluate(root=>[...root.querySelectorAll('*')].filter(el=>el.checkVisibility()&&[...el.childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim())&&!el.closest('svg,.visually-hidden,script,style')&&parseFloat(getComputedStyle(el).fontSize)<13).map(el=>el.textContent.slice(0,60)));
    assert.deepEqual(small,[],`readable ${name}`);
    await (region??page).screenshot({path:join(evidence,`${width}-${name}.png`),...(region?{}:{fullPage:true})});
   };
   await page.goto(h.origin+'/app#/settings');
   const entitySection=page.locator('section').filter({has:page.getByRole('heading',{name:'Entities',exact:true})});
   await entitySection.getByLabel('Configure entity',{exact:true}).selectOption('new');
   await entitySection.getByLabel('Entity name',{exact:true}).fill('Harbour Finch Canada');
   await entitySection.getByLabel('Currency',{exact:true}).fill('CAD');
   await entitySection.getByLabel('Time zone',{exact:true}).fill('America/Toronto');
   await shot('entity-create',entitySection);
   await entitySection.getByLabel('Configure entity',{exact:true}).selectOption(f.ca.id);
   await expect(entitySection.getByLabel('Currency',{exact:true})).toHaveValue('CAD');
   await expect(entitySection.getByLabel('Time zone',{exact:true})).toHaveValue('America/Toronto');
   await shot('entity-membership',entitySection);
   const categorySection=page.locator('section').filter({has:page.getByRole('heading',{name:'Harbour Finch Canada · Expense categories',exact:true})});
   await expect(categorySection).toContainText('CA-6300');await shot('entity-chart',categorySection);
   const workflowSection=page.locator('section').filter({has:page.getByRole('heading',{name:'Approval workflows',exact:true})});
   await expect(workflowSection.first()).toContainText('Canadian finance review');
   await shot('entity-routing',workflowSection.first());
   const policySection=page.locator('section').filter({has:page.getByRole('heading',{name:'Expense policy',exact:true})});
   await shot('entity-policy',policySection.first());
   await actor(f.team.sam);
   for(const [index,id] of ['primary',f.ca.id].entries()) {
    const title=`Browser ${width} ${id==='primary'?'US':'Canada'}`;
    await page.goto(h.origin+'/app#/claims');await page.reload();
    await page.getByRole('button',{name:'New claim',exact:true}).click();
    await page.getByLabel('Claim title',{exact:true}).fill(title);
    await page.getByLabel('Entity',{exact:true}).selectOption(id);
    await shot(`claim-create-${index}`);
    await page.getByRole('button',{name:'Start claim',exact:true}).click();
    await page.getByRole('button',{name:'Add expense',exact:true}).click();
    await page.getByLabel('Merchant',{exact:true}).fill(`${title} client lunch`);
    await page.getByLabel('Date',{exact:true}).fill('2026-10-02');
    await page.getByLabel('Amount',{exact:true}).fill(index?'20.02':'14.03');
    await page.getByLabel('Category',{exact:true}).selectOption(index?f.category.id:f.us.categories.find(c=>c.name==='Meals').id);
    await expect(page.getByLabel('Currency',{exact:true})).toHaveValue(index?'CAD':'USD');
    await page.getByLabel('Receipt photo or PDF',{exact:true}).setInputFiles(resolve(`tests/fixtures/receipts/${index?'uber':'hotel'}.png`));
    await shot(`expense-${index}`);
    await page.locator('form.item-form').getByRole('button',{name:'Add expense',exact:true}).click();
    await expect(page.locator('form.item-form')).toHaveCount(0);
    await page.getByRole('button',{name:'Submit for approval',exact:true}).click();
    await expect(page.locator('.detail .badge').first()).toHaveText('Submitted');
    const current=(await h.get('state',f.team.sam)).claims.find(c=>c.title===title);
    const detail=await h.get(`claims/${current.id}`,f.team.sam);
    assert.equal(detail.claim.currency,index?'CAD':'USD');assert.equal(detail.items[0].amount_minor,index?2002:1403);
    assert.equal(detail.receipts.length,1);assert.equal(detail.revisions[0].snapshot.entity.id,id);
    await shot(`submitted-${index}`);
    await actor(f.team.priya);await page.goto(h.origin+`/app#/approvals/${current.id}`);await page.reload();
    await expect(page.getByRole('region',{name:'Decision',exact:true})).toBeVisible();
    await shot(`review-${index}`);
    await page.getByRole('button',{name:'Approve',exact:true}).click();
    if(index) {
     await actor(f.team.morgan);await page.reload();
     await page.getByRole('button',{name:'Approve',exact:true}).click();
    }
    await expect(page.locator('.detail .badge').first()).toHaveText('Approved');
    await tooltipProof(page,page.getByRole('link',{name:'Back to approvals',exact:true}));
    await shot(`approved-${index}`);
    await actor(f.team.sam);
   }
   await actor(f.team.morgan);await page.goto(h.origin+'/app#/settings');await page.reload();
   await page.getByText('Consolidated entity report',{exact:true}).click();
   await page.getByLabel('Report from',{exact:true}).fill('2026-10-01');
   await page.getByLabel('Report until',{exact:true}).fill('2026-10-31');
   await page.getByRole('button',{name:'Create USD report',exact:true}).click();
   const result=page.getByRole('region',{name:'Consolidated report result',exact:true});
   await expect(result.getByRole('heading')).toHaveText('$204.08 USD');
   await expect(result).toContainText('Harbour Finch Canada');
   await expect(result).toContainText('Harbour Finch US');
   assert.equal((await result.textContent()).includes('Private Canadian draft'),false);
   await result.getByText('Conversion evidence',{exact:true}).last().click();
   await expect(result).toContainText('0.75');await expect(result).toContainText('ECB reference rates');
   await shot('consolidated-report',result);
   assert.deepEqual(errors,[]);assert.deepEqual(transport.unexpected,[]);
   console.log(`Native entity screens, receipts and approvals passed at ${width}px`);
  } finally {await context?.close();await h.close();}
 }
} finally {await browser.close();}
