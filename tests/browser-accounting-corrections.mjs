import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { harness } from './harness.mjs';
import { correctionClaims, correctionBody, correctionPath } from './account-correction-kit.mjs';
import { payrollBrowserRuntime, noOverflow, tooltipProof } from './payroll-browser-runtime.mjs';

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/account-corrections-proof');
await mkdir(evidence,{recursive:true});
const attach=await payrollBrowserRuntime();
const browser=await chromium.launch({headless:true,...(process.env.COASTER_CHROMIUM?{executablePath:process.env.COASTER_CHROMIUM}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
try {
  for(const width of [1440,390]) {
    const h=await harness(); let context;
    try {
      const {t,create,approve}=await correctionClaims(h);
      let c=await approve(await create());
      context=await browser.newContext({viewport:{width,height:1000},deviceScaleFactor:1,serviceWorkers:'block'});
      const transport=await attach(context,h),page=await context.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.goto(h.origin+`/app#/approvals/${c.id}`);
      const panel=page.getByRole('region',{name:'Account coding',exact:true});
      await expect(panel.getByRole('heading',{name:'Account coding',exact:true})).toBeVisible();
      await panel.getByText('Correct an account code',{exact:true}).click();
      await panel.getByLabel('Submitted allocation',{exact:true}).selectOption({index:1});
      await panel.getByLabel('Effective account code',{exact:true}).fill('6800');
      await panel.getByLabel('Correction reason',{exact:true}).fill('Client-specific export account');
      await noOverflow(page);
      await panel.screenshot({path:join(evidence,`account-review-${width}.png`)});
      await panel.getByRole('button',{name:'Save account correction',exact:true}).click();
      await expect(panel).toContainText('Effective account: 6800');
      await panel.getByText('Account correction history',{exact:true}).click();
      await panel.screenshot({path:join(evidence,`account-corrected-${width}.png`)});
      const first=await h.get(`claims/${c.id}`),bytes=first.revisions;
      if(width===1440) {
        assert.equal(first.accountCoding.sequence,1);
        assert.equal(first.accountCoding.corrections[0].after_account,'6800');
        await expect(panel).toContainText('Submitted account: 6500');
        await expect(panel).toContainText('Client-specific export account');
        assert.ok(transport.forwarded.some(r=>r.method==='POST'&&r.path.endsWith('/account-corrections')));
        assert.ok(await panel.locator('p,label,input,select,summary,button').evaluateAll(nodes=>nodes.every(n=>parseFloat(getComputedStyle(n).fontSize)>=13)));
      }
      // A stale browser form is refused without discarding the entered correction.
      await h.post(correctionPath(c),correctionBody(first,{accountCode:'6820',reason:'Second finance correction'}));
      await panel.getByLabel('Effective account code',{exact:true}).fill('6810');
      await panel.getByRole('button',{name:'Save account correction',exact:true}).click();
      await expect(panel.getByRole('alert')).toBeVisible();
      if(width===1440) {
        assert.equal((await h.get(`claims/${c.id}`)).accountCoding.sequence,2);
        await expect(panel.getByLabel('Effective account code',{exact:true})).toHaveValue('6810');
      }
      await panel.screenshot({path:join(evidence,`account-stale-${width}.png`)});
      await page.reload(); await expect(panel).toContainText('Effective account: 6820');
      let batch=await h.post('batches',{claims:[c.id]},t.morgan);
      batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:11000},t.morgan);
      await page.reload(); await expect(panel).toContainText('Effective account: 6820');
      if(width===1440) {
        await expect(panel.getByText('Correct an account code',{exact:true})).toHaveCount(0);
        assert.deepEqual((await h.get(`claims/${c.id}`)).revisions,bytes);
        assert.equal((await h.get(`batches/${batch.id}`,t.morgan)).lines[0].account,'6820');
      }
      await panel.getByText('Account correction history',{exact:true}).click();
      await noOverflow(page);
      await panel.screenshot({path:join(evidence,`account-frozen-${width}.png`)});
      await tooltipProof(page,page.getByRole('link',{name:'Back to approvals',exact:true}));
      if(width===390) await tooltipProof(page,page.locator('.account-menu summary'));
      assert.deepEqual(errors,[]); assert.deepEqual(transport.unexpected,[]);
      console.log(`Account coding screens passed at ${width}`);
    } finally {await context?.close();await h.close();}
  }
} finally {await browser.close();}
