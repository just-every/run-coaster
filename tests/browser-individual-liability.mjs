import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { harness } from './harness.mjs';
import { individualProgram } from './individual-liability-kit.mjs';
import { payrollBrowserRuntime, noOverflow, tooltipProof } from './payroll-browser-runtime.mjs';

const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/individual-liability');
await mkdir(evidence,{recursive:true});
const attach=await payrollBrowserRuntime();
const browser=await chromium.launch({headless:true,...(process.env.COASTER_CHROMIUM?{executablePath:process.env.COASTER_CHROMIUM}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
try {
  const h=await harness({clock:Date.parse('2031-06-10T10:00:00Z'),bindings:origin=>({RER_DEV_ORIGIN:origin})});let f;
  try {
    f=await individualProgram(h);
    // Assert the user journey once; the phone captures show the same changed screens.
    for(const width of [1440,390]){
      const contexts=[];
      try {
        const person=async cookie=>{const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});contexts.push(context);await attach(context,{...h,owner:cookie});return context.newPage();};
        const employee=await person(f.employee),owner=await person(h.owner),finance=await person(f.finance);
        const shot=async(page,name)=>{await page.evaluate(()=>document.fonts.ready);await noOverflow(page);await page.screenshot({path:join(evidence,`${name}-${width}.png`),fullPage:true});};
        await owner.goto(h.origin+'/app#/settings');
        const panel=owner.getByRole('region',{name:'Scheduled card program feed',exact:true});
        await panel.getByText('Connect an SFTP program feed',{exact:true}).click();
        await expect(panel.getByLabel('Card liability',{exact:true})).toBeVisible();
        await panel.getByLabel('Card liability',{exact:true}).selectOption('individual');
        await shot(owner,'program-liability');
        await employee.goto(h.origin+`/app#/claims/${f.claim.id}`);
        if(width===1440){
          for(const name of ['synthetic-coaster-1214','synthetic-coaster-1215']){
            await employee.getByRole('button',{name:`Mark personal ${name}`,exact:true}).click();
            await expect(employee.getByRole('button',{name:`Mark business ${name}`,exact:true})).toBeVisible();
          }
          await expect(employee.getByText(/personal, excluded from reimbursement/)).toHaveCount(2);
          await expect(employee.getByText(/business, reimbursable to employee/)).toHaveCount(4);
        }
        await tooltipProof(employee,employee.locator('.panel-close'));
        await shot(employee,'classified-charges');
        if(width===1440){
          await employee.getByRole('button',{name:'Submit for approval',exact:true}).click();
          await expect(employee.locator('.detail .badge',{hasText:'Submitted'})).toBeVisible();
          let claim=(await h.get(`claims/${f.claim.id}`,f.employee)).claim;
          await h.post(`claims/${claim.id}/decision`,{version:claim.version,revision:claim.revision,decision:'approved',acknowledge:true},f.manager);
          f.batch=await h.post('batches',{claims:[claim.id]},f.finance);
          assert.equal(f.batch.total_minor,10000);
        }
        await finance.goto(h.origin+`/app#/batches/${f.batch.id}`);
        await expect(finance.getByRole('heading',{name:/RB-0001/,level:2})).toBeVisible();
        if(width===1440)assert.equal((await h.get(`batches/${f.batch.id}`,f.finance)).lines.length,4);
        await shot(finance,'employee-reimbursement-batch');
      } finally {await Promise.all(contexts.map(c=>c.close()));}
    }
    console.log('Individual-liability native screens at 1440 and 390; classification, employee batch and icon tooltip verified');
  }finally{await h.close();await f?.issuer.close();}
}finally{await browser.close();}
