import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { agency, harness } from './harness.mjs';
import { noOverflow, payrollBrowserRuntime } from './payroll-browser-runtime.mjs';

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/notifications-proof');
await mkdir(evidence, { recursive: true });
const attach = await payrollBrowserRuntime();
const browser = await chromium.launch({ headless: true, ...(process.env.COASTER_CHROMIUM ? { executablePath: process.env.COASTER_CHROMIUM } : {}), args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] });
try {
  for (const width of [1440, 390]) {
    const h = await harness();
    let context;
    try {
      const team = await agency(h);
      context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
      const transport = await attach(context, { ...h, owner: team.sam });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(h.origin + '/app#/settings');
      const panel = page.getByRole('region', { name: 'Notifications', exact: true });
      const zone = panel.getByLabel('Your notification time zone', { exact: true });
      await expect(zone).toHaveValue('Australia/Sydney');
      const capture = async name => {
        await page.evaluate(() => document.fonts.ready);
        await noOverflow(page);
        await panel.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(evidence, `${width}-${name}.png`), fullPage: true });
      };
      await capture('defaults');
      await zone.fill('Invalid/Timezone');
      await zone.press('Tab');
      await expect(panel.getByRole('alert')).toBeVisible();
      await expect(zone).toHaveValue('Invalid/Timezone');
      await capture('failed-save-keeps-value');
      await zone.fill('Australia/Brisbane');
      await zone.press('Tab');
      await expect(panel.getByRole('status')).toHaveText('Saved');
      await panel.getByLabel('Your quiet hours start', { exact: true }).selectOption('0');
      await panel.getByLabel('Your quiet hours end', { exact: true }).selectOption('0');
      await panel.getByLabel('Claim submissions', { exact: true }).selectOption('digest');
      await panel.getByLabel('Reminders', { exact: true }).selectOption('digest');
      await expect(panel.getByRole('status')).toHaveText('Saved');
      await page.reload();
      await expect(zone).toHaveValue('Australia/Brisbane');
      await expect(panel.getByLabel('Claim submissions', { exact: true })).toHaveValue('digest');
      await expect(panel.getByLabel('Reminders', { exact: true })).toHaveValue('digest');
      await expect(panel.getByLabel('Your quiet hours start', { exact: true })).toHaveValue('0');
      await expect(panel.getByLabel('Your quiet hours end', { exact: true })).toHaveValue('0');
      await capture('saved-preferences');

      // A real approval produces a personal delivery through the ordinary claim API.
      let claim = await h.post('claims', { title: 'Client workshop supplies' }, team.sam);
      claim = await h.post(`claims/${claim.id}/items`, { version: claim.version, kind: 'receipt', date: '2026-10-27', merchant: 'Workshop stationery', amount: '24.00', explanation: 'Original receipt lost after the client workshop', allocations: [{ category: team.c.office }] }, team.sam);
      claim = await h.post(`claims/${claim.id}/submit`, { version: claim.version }, team.sam);
      await h.post(`claims/${claim.id}/decision`, { version: claim.version, revision: claim.revision, decision: 'approved', acknowledge: true }, team.priya);
      const personal = await h.get('settings/notifications', team.sam);
      assert.ok(personal.deliveries.some(delivery => delivery.kind === 'immediate'), 'approval records a delivery for the claimant');
      await page.reload();
      await expect(zone).toHaveValue('Australia/Brisbane');
      await panel.getByText('Email delivery history', { exact: true }).click();
      await expect(panel.locator('.ruled-list li')).toHaveCount(personal.deliveries.length);
      await expect(panel.locator('.ruled-list')).toContainText('Immediate email');
      await capture('delivery-history');

      // Every preference participates in the normal keyboard order.
      const fields = panel.locator('input, select');
      await fields.first().focus();
      for (let i = 0; i < await fields.count(); i++) {
        await expect(fields.nth(i)).toBeFocused();
        await page.keyboard.press('Tab');
      }
      assert.deepEqual(await panel.evaluate(section => {
        const issues = [], walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode, element = node.parentElement;
          if (node.textContent.trim() && element.checkVisibility() && parseFloat(getComputedStyle(element).fontSize) < 13) issues.push(node.textContent.trim());
        }
        for (const element of [section, ...section.querySelectorAll('*')]) {
          const style = getComputedStyle(element);
          if (parseFloat(style.borderRadius) > 0) {
            const borders = ['Top', 'Right', 'Bottom', 'Left'].map(side => parseFloat(style[`border${side}Width`]) > 0);
            if (borders.some(Boolean) && !borders.every(Boolean)) issues.push(`One-sided rounded border: ${element.tagName}`);
          }
        }
        return issues;
      }), [], 'notification settings meet readable text and border rules');
      assert.ok(transport.forwarded.some(request => request.method === 'POST' && request.path.endsWith('/settings/notifications')));
      assert.deepEqual(transport.unexpected, []);
      assert.deepEqual(errors, []);
      if (width === 1440) {
        const auditor = await h.person(['auditor','harbourfinch.example'].join('@'), { auditor: true });
        const split = auditor.indexOf('=');
        await context.addCookies([{ name: auditor.slice(0, split), value: auditor.slice(split + 1), url: h.origin, httpOnly: true, sameSite: 'Lax' }]);
        await page.reload();
        await expect(zone).toHaveValue('Australia/Sydney');
        await panel.getByText('Email delivery history', { exact: true }).click();
        await expect(panel.locator('.ruled-list li')).toHaveCount(0);
        await capture('auditor-personal-settings');
      }
    } finally { await context?.close(); await h.close(); }
  }
} finally { await browser.close(); }
console.log('Personal notifications browser proof passed at 1440 and 390');
