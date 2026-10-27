// Real native queue and HTTP decisions; only static assets are served by the browser runtime.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { harness } from './harness.mjs';
import { bulkClaims } from './bulk-approval-kit.mjs';
import { noOverflow, payrollBrowserRuntime, tooltipProof } from './payroll-browser-runtime.mjs';

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/bulk-proof');
await mkdir(evidence, { recursive: true });
const attach = await payrollBrowserRuntime();
const browser = await chromium.launch({ headless: true, ...(process.env.COASTER_CHROMIUM ? { executablePath: process.env.COASTER_CHROMIUM } : {}), args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] });
try {
  for (const width of [1440, 390]) {
    const h = await harness();
    let context;
    try {
      const { team, claims } = await bulkClaims(h);
      context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
      const transport = await attach(context, { ...h, owner: team.priya });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const capture = async name => {
        await page.evaluate(() => document.fonts.ready);
        await noOverflow(page);
        await page.screenshot({ path: join(evidence, `${width}-${name}.png`), fullPage: true });
      };
      await page.goto(h.origin + '/app#/approvals');
      const bulk = page.getByRole('region', { name: 'Bulk approval', exact: true });
      await bulk.getByText('Approve several claims', { exact: true }).click();
      await capture('queue');
      for (const c of claims) await bulk.getByRole('checkbox', { name: new RegExp('^' + c.title) }).check();
      await bulk.getByRole('button', { name: 'Review selected claims', exact: true }).click();
      const approve = bulk.getByRole('button', { name: 'Approve 3 claims', exact: true });
      await expect(approve).toBeVisible();
      if (width === 1440) {
        await expect(approve).toBeDisabled();
        for (const c of claims) {
          const review = bulk.getByRole('article', { name: `Review ${c.title}`, exact: true });
          await expect(review).toContainText('Over the Meals limit');
          await expect(review).toContainText('No receipt');
          await expect(review).toContainText(`Client visit for ${c.title}; original receipt lost`);
        }
      }
      await capture('exceptions');
      for (const [i, c] of claims.entries()) {
        await bulk.getByRole('checkbox', { name: `I reviewed ${c.title}, its expenses, exceptions and explanations`, exact: true }).check();
        if (width === 1440 && i < 2) await expect(approve).toBeDisabled();
      }
      await approve.click();
      await expect(bulk.getByRole('heading', { name: 'Bulk approval results', exact: true })).toBeVisible();
      if (width === 1440) {
        for (const c of claims) {
          await expect(bulk.getByRole('status')).toContainText(`${c.title} · revision 1: Approved`);
          const d = await h.get(`claims/${c.id}`, team.sam);
          assert.equal(d.claim.status, 'approved');
          assert.deepEqual(d.decisions.map(x => x.revision), [1]);
          assert.equal(d.events.find(x => x.action === 'claim-approved').detail.channel, 'bulk');
        }
        assert.ok(transport.forwarded.some(r => r.method === 'POST' && r.path === '/api/coaster/approvals/bulk'));
      }
      if (width === 390) await tooltipProof(page, page.locator('.account-menu summary'));
      await capture('results');
      assert.deepEqual(errors, []);
      assert.deepEqual(transport.unexpected, []);
      console.log(`Bulk queue browser proof passed at ${width}px`);
    } finally { await context?.close(); await h.close(); }
  }
} finally { await browser.close(); }
