// Standalone production-screen proof. The provider fixture is the only fake network edge.
// Run through the owning heavy slot: node tests/browser-payroll.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { harness } from './harness.mjs';
import { gustoFixture } from './fixtures/payroll.mjs';
import { payrollBatch } from './payroll-kit.mjs';
import { noOverflow, payrollBrowserRuntime, tooltipProof } from './payroll-browser-runtime.mjs';

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/payroll-proof');
await mkdir(evidence, { recursive: true });
const attach = await payrollBrowserRuntime();
const browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
const shots = [];

async function journey(width) {
  const edge = gustoFixture(), h = await harness({ gustoEdge: request => edge.fetch(request) });
  let context;
  try {
    const t = await payrollBatch(h);
    context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    const transport = await attach(context, h), page = await context.newPage(), failures = [];
    page.on('pageerror', error => failures.push(error.message));
    const capture = async (name, section) => {
      await page.evaluate(() => document.fonts.ready);
      await section.scrollIntoViewIfNeeded();
      await noOverflow(page);
      const path = join(evidence, `${width}-${name}.png`);
      await section.screenshot({ path });
      shots.push(path);
      const screen = join(evidence, `${width}-${name}-screen.png`);
      await page.screenshot({ path: screen, fullPage: true });
      shots.push(screen);
    };
    const submit = async (scope, label, path) => {
      const response = page.waitForResponse(reply => reply.url() === h.origin + '/api/coaster/' + path && reply.request().method() === 'POST');
      await scope.getByRole('button', { name: label, exact: true }).click();
      const reply = await response;
      assert.equal(reply.status(), 200, `${path}: ${await reply.text()}`);
      return reply.json();
    };
    await page.goto(h.origin + '/app#/settings');
    const settings = page.locator('section[aria-label="Gusto sandbox payroll"]');
    await expect(settings.getByRole('button', { name: 'Connect Gusto sandbox', exact: true })).toBeVisible();
    await settings.getByLabel('Sandbox company UUID', { exact: true }).fill(edge.company);
    await settings.getByLabel('Sandbox access token', { exact: true }).fill('synthetic-coaster-120');
    await settings.getByRole('checkbox', { name: /I authorize reading/ }).check();
    const connectionPath = ['payroll', 'gusto'].join('/');
    await submit(settings, 'Connect Gusto sandbox', connectionPath + '/connect');
    await expect(settings.getByLabel('Coaster person', { exact: true })).toBeVisible();
    await settings.getByLabel('Coaster person', { exact: true }).selectOption(t.memberEmail);
    await settings.getByLabel('Gusto employee', { exact: true }).selectOption(edge.employee);
    await submit(settings, 'Map payroll employee', connectionPath + '/employees');
    await expect(settings.locator('.ruled-list li')).toContainText('Sam Taylor');
    assert.deepEqual((await h.get(connectionPath)).mappings.map(mapping => [mapping.email, mapping.employee_uuid]), [[t.memberEmail, edge.employee]]);
    await capture('connected', settings);

    const batch = await h.post(`batches/${t.batch.id}/release`, { version: t.batch.version });
    await page.goto(h.origin + '/app#/batches/' + batch.id);
    const panel = page.locator('.batch-detail'), payroll = panel.locator('section[aria-label="Gusto sandbox payroll"]');
    await expect(payroll.getByRole('button', { name: 'Send to Gusto sandbox', exact: true })).toBeVisible();
    const amounts = payroll.getByRole('table', { name: 'Payroll amounts to review' }).locator('tbody tr');
    await expect(amounts).toHaveCount(1);
    assert.deepEqual(await amounts.first().locator('td').allTextContents(), ['sam', '$10.00', '$12.00'], 'real approved expense and taxable stipend retain their payroll split');
    await tooltipProof(page, panel.getByRole('link', { name: 'Back to batches', exact: true }));
    const account = page.locator('.account-menu summary');
    if (width < 1024) await tooltipProof(page, account);
    else await expect(account).toBeHidden();
    await capture('split-review', payroll);

    await payroll.getByLabel('Sandbox payroll', { exact: true }).selectOption(edge.payrollId);
    await payroll.getByRole('checkbox', { name: /I reviewed these employee mappings/ }).check();
    edge.uncalculated = true;
    await submit(payroll, 'Send to Gusto sandbox', `batches/${batch.id}/payroll`);
    await expect(payroll.getByRole('button', { name: 'Confirm provider payment', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Record payment', exact: true })).toHaveCount(0);
    assert.equal(edge.writes.length, 1, 'the UI sends exactly one preparation update to Gusto');
    assert.equal((await h.get(`batches/${batch.id}`)).batch.status, 'approved');
    for (const id of t.claims) assert.equal((await h.get(`claims/${id}`, t.employee)).claim.status, 'batched');
    await capture('sent-unpaid', payroll);
    const pending = await submit(payroll, 'Confirm provider payment', `batches/${batch.id}/payroll/confirm`);
    assert.equal(pending.confirmed, false, 'unprocessed provider run does not mark claims paid');
    await expect(payroll.getByRole('button', { name: 'Confirm provider payment', exact: true })).toBeEnabled();
    assert.equal((await h.get(`batches/${batch.id}`)).batch.status, 'approved');

    edge.uncalculated = false;
    edge.payroll = { ...edge.payroll, processed: true, processing_request: { status: 'submit_success' } };
    assert.equal((await submit(payroll, 'Confirm provider payment', `batches/${batch.id}/payroll/confirm`)).confirmed, true);
    await expect(payroll.locator('.chip')).toContainText('Provider confirmed');
    await expect(payroll.getByRole('button', { name: 'Confirm provider payment', exact: true })).toHaveCount(0);
    for (const id of t.claims) assert.equal((await h.get(`claims/${id}`, t.employee)).claim.status, 'reimbursed');
    assert.equal((await h.get(`batches/${batch.id}`)).batch.paid_reference, `Gusto ${edge.payrollId}`);
    assert.equal(edge.writes.length, 1, 'confirmation never retransmits the payroll amounts');
    await capture('provider-confirmed', payroll);
    assert.deepEqual(failures, [], 'production App has no browser exceptions');
    assert.deepEqual(transport.unexpected, [], 'the browser never contacts an external origin');
    for (const path of [connectionPath + '/connect', connectionPath + '/employees', `batches/${batch.id}/payroll`, `batches/${batch.id}/payroll/confirm`])
      assert.ok(transport.forwarded.some(request => request.method === 'POST' && request.path === '/api/coaster/' + path), `${path} crossed real HTTP into the production Worker`);
    console.log(`Payroll production UI journey passed at ${width}px`);
  } finally { await context?.close(); await h.close(); }
}

try {
  for (const width of [1440, 390]) await journey(width);
  console.log(JSON.stringify({ screenshots: shots }));
} finally { await browser.close(); }
