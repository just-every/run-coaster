import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { harness } from './harness.mjs';
import { apiPath, cardChaseFixture } from './card-chase-kit.mjs';
import { noOverflow, payrollBrowserRuntime, tooltipProof } from './payroll-browser-runtime.mjs';

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/card-chase-proof');
await mkdir(evidence, { recursive: true });
const attach = await payrollBrowserRuntime();
const browser = await chromium.launch({ headless: true, ...(process.env.COASTER_CHROMIUM ? { executablePath: process.env.COASTER_CHROMIUM } : {}), args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] });
try {
  for (const width of [1440, 390]) {
    const h = await harness();
    let context;
    try {
      const f = await cardChaseFixture(h);
      for (const day of ['2026-06-02', '2026-06-04', '2026-06-08']) await f.tick(day);
      context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
      await attach(context, { ...h, owner: f.sam });
      const page = await context.newPage();
      await page.goto(h.origin + '/app#/claims/' + f.id);
      const panel = page.locator('.claim-detail');
      await expect(page.getByRole('button', { name: 'Change Client supplies', exact: true })).toBeVisible();
      if (width === 1440) {
        assert.equal((await f.reminders()).length, 3);
        await tooltipProof(page, page.getByRole('link', { name: 'Back to claims', exact: true }));
      }
      await noOverflow(page);
      await page.screenshot({ path: join(evidence, `${width}-missing-evidence.png`), fullPage: true });
      await page.getByRole('button', { name: 'Change Client supplies', exact: true }).click();
      await page.getByLabel('Receipt photo or PDF', { exact: true }).setInputFiles('tests/fixtures/receipts/officeworks.png');
      await page.getByRole('button', { name: 'Save expense', exact: true }).click();
      await expect(page.getByRole('link', { name: 'Open receipt officeworks.png', exact: true })).toBeVisible();
      if (width === 1440) {
        await tooltipProof(page, page.getByRole('link', { name: 'Open receipt officeworks.png', exact: true }));
        await h.post(apiPath('settings', 'reminders'), { days: '1,3,5,6', quietFrom: '20', quietUntil: '8', escalateAfter: '' }, f.morgan);
        assert.deepEqual(await f.tick('2026-06-09'), []);
        assert.equal((await f.reminders()).length, 3);
      }
      await noOverflow(page);
      await page.screenshot({ path: join(evidence, `${width}-evidence-attached.png`), fullPage: true });
    } finally { await context?.close(); await h.close(); }
  }
} finally { await browser.close(); }
console.log('Card chase screen proof passed at 1440 and 390');
