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
const regressions = [];
const record = (name, actual, expected) => {
  try { assert.deepEqual(actual, expected, name); }
  catch (error) { regressions.push(error.message); }
};
const number = c => `CL-${String(c.number).padStart(4, '0')}`;
const browser = await chromium.launch({ headless: true, ...(process.env.COASTER_CHROMIUM ? { executablePath: process.env.COASTER_CHROMIUM } : {}), args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] });
try {
  for (const width of [1440, 390]) {
    const h = await harness();
    let context;
    try {
      const { team, claims, create } = await bulkClaims(h);
      context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
      const transport = await attach(context, { ...h, owner: team.priya });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const capture = async name => {
        await page.evaluate(() => document.fonts.ready);
        await noOverflow(page);
        if (width === 1440) record(`readable text on ${name}`, await page.evaluate(() => {
          const walker = document.createTreeWalker(document.querySelector('.app'), NodeFilter.SHOW_TEXT), small = [];
          while (walker.nextNode()) {
            const node = walker.currentNode, parent = node.parentElement;
            if (!node.textContent.trim() || parent.closest('.visually-hidden, svg, script, style') || !parent.checkVisibility()) continue;
            const size = parseFloat(getComputedStyle(parent).fontSize);
            if (size < 13) small.push({ text: node.textContent.trim(), size });
          }
          return small;
        }), []);
        const path = join(evidence, `${width}-${name}.png`);
        if (name === 'audit') await page.locator('section').filter({ has: page.getByRole('heading', { name: 'History and audit pack', exact: true }) }).screenshot({ path });
        else await page.screenshot({ path, fullPage: true });
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
        record('complete success counts', await bulk.getByRole('status').locator('p').allTextContents(), ['3 claims approved · 0 claims not approved']);
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
      const mixed = [await create('Repeated client visit'), await create('Repeated client visit'), await create('Other client visit')];
      await page.reload();
      await bulk.getByText('Approve several claims', { exact: true }).click();
      for (const c of mixed) await bulk.getByRole('checkbox', { name: new RegExp(number(c)) }).check();
      await bulk.getByRole('button', { name: 'Review selected claims', exact: true }).click();
      await expect(bulk.getByRole('article')).toHaveCount(3);
      for (const review of await bulk.getByRole('article').all()) await review.getByRole('checkbox').check();
      // The employee resubmits after review, through the public door: one stale claim must fail independently.
      const retracted = await h.post(`claims/${mixed[1].id}/retract`, { version: mixed[1].version }, team.sam);
      const resubmitted = await h.post(`claims/${mixed[1].id}/submit`, { version: retracted.version }, team.sam);
      const refusedBefore = await h.get(`claims/${resubmitted.id}`, team.sam);
      await capture('mixed-review');
      await bulk.getByRole('button', { name: 'Approve 3 claims', exact: true }).click();
      await expect(bulk.getByRole('heading', { name: 'Bulk approval results', exact: true })).toBeVisible();
      const outcome = bulk.getByRole('status');
      await expect(outcome.getByRole('listitem')).toHaveCount(3);
      if (width === 1440) {
        record('partial failure counts', await outcome.locator('p').allTextContents(), ['2 claims approved · 1 claim not approved']);
        const rows = await outcome.getByRole('listitem').allTextContents();
        for (const [i, c] of mixed.entries()) {
          record(`result identifies ${number(c)}`, rows[i].includes(`${number(c)} · ${c.title} · revision 1:`), true);
          assert.ok(rows[i].includes(i === 1 ? 'Not approved:' : ': Approved'), `actual outcome for ${number(c)}`);
          const detail = await h.get(`claims/${c.id}`, team.sam);
          assert.equal(detail.claim.status, i === 1 ? 'submitted' : 'approved');
        }
        assert.deepEqual(await h.get(`claims/${mixed[1].id}`, team.sam), refusedBefore, 'stale browser decision leaves claim unchanged');
      }
      await capture('mixed-results');
      await page.goto(h.origin + `/app#/approvals/${mixed[0].id}`);
      const history = page.getByRole('region', { name: 'History', exact: true });
      await expect(history.locator('time').first()).toBeVisible();
      if (width === 1440) {
        record('audit metadata is at least 13px', await history.locator('time').evaluateAll(nodes => nodes.every(node => parseFloat(getComputedStyle(node).fontSize) >= 13)), true);
      }
      await tooltipProof(page, page.getByRole('link', { name: 'Back to approvals', exact: true }));
      await capture('history');
      const split = h.owner.indexOf('=');
      await context.addCookies([{ name: h.owner.slice(0, split), value: h.owner.slice(split + 1), url: h.origin, httpOnly: true, sameSite: 'Lax' }]);
      await page.goto(h.origin + '/app#/settings');
      await page.reload();
      await page.getByLabel('Claim, batch, person or words', { exact: true }).fill(number(mixed[0]));
      await page.getByRole('button', { name: 'Search history', exact: true }).click();
      const audit = page.locator('.audit-lines');
      await expect(audit.locator('small').first()).toBeVisible();
      await expect(audit).toContainText('by bulk approval');
      if (width === 1440) record('numbered audit metadata is at least 13px', await audit.locator('small').evaluateAll(nodes => nodes.every(node => parseFloat(getComputedStyle(node).fontSize) >= 13)), true);
      await capture('audit');
      assert.deepEqual(errors, []);
      assert.deepEqual(transport.unexpected, []);
      console.log(`Bulk queue browser proof passed at ${width}px`);
    } finally { await context?.close(); await h.close(); }
  }
} finally { await browser.close(); }

assert.deepEqual(regressions, [], 'bulk outcome regressions');
