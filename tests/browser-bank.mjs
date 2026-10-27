// Standalone production-screen proof for PAY-002. The two verification providers are the only fake network edge: their browser scripts
// are replaced by small stand-ins that hand the App what Plaid Link and Stripe.js would, and their servers are the bank fixture.
// Run through the owning heavy slot: node tests/browser-bank.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { harness } from './harness.mjs';
import { bankFixture, connectBank } from './fixtures/bank.mjs';
import { payrollBrowserRuntime, noOverflow, tooltipProof } from './payroll-browser-runtime.mjs';

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/bank-proof');
await mkdir(evidence, { recursive: true });
const attach = await payrollBrowserRuntime();
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] });
const shots = [];
const PLAID_STAND_IN = "window.Plaid={create:c=>({open:()=>{const l=window.__link;setTimeout(()=>c.onSuccess(l.publicToken,{accounts:[{id:l.accountId}]}),30)}})}";
const STRIPE_STAND_IN = "window.Stripe=()=>({collectBankAccountForSetup:async o=>{await window.__collect(o.clientSecret.replace(/-secret$/,''));return{}},confirmUsBankAccountSetup:async()=>({})})";

async function journey(width) {
  const edge = bankFixture(), h = await harness({ plaidEdge: r => edge.fetch(r), stripeEdge: r => edge.fetch(r) });
  const contexts = [];
  try {
    await h.post(['settings', 'business'].join('/'), { name: 'Harbour and Finch Studio', currency: 'USD', timezone: 'UTC', receiptThreshold: '' });
    const sam = await h.person('sam@harbourfinch.example', { employee: true }), morgan = await h.person('morgan@harbourfinch.example', { employee: true, finance: true });
    const open = async cookie => {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
      contexts.push(context);
      const transport = await attach(context, { ...h, owner: cookie }), page = await context.newPage(), failures = [];
      page.on('pageerror', error => failures.push(error.message));
      await context.route('https://cdn.plaid.com/**', route => route.fulfill({ status: 200, contentType: ['text', 'javascript'].join('/'), body: PLAID_STAND_IN }));
      await context.route('https://js.stripe.com/**', route => route.fulfill({ status: 200, contentType: ['text', 'javascript'].join('/'), body: STRIPE_STAND_IN }));
      await page.exposeFunction('__collect', id => edge.collect(id, '6789'));
      return { page, transport, failures };
    };
    const capture = async (page, name, section) => {
      await page.evaluate(() => document.fonts.ready);
      await section.scrollIntoViewIfNeeded();
      await noOverflow(page);
      const path = join(evidence, `${width}-${name}.png`);
      await section.screenshot({ path });
      shots.push(path);
    };
    const submit = async (page, scope, label, path) => {
      const response = page.waitForResponse(reply => reply.url() === h.origin + '/api/coaster/' + path && reply.request().method() === 'POST');
      await scope.getByRole('button', { name: label, exact: true }).click();
      const reply = await response;
      assert.equal(reply.status(), 200, `${path}: ${await reply.text()}`);
      return reply.json();
    };
    // Every icon-only control on a screen carries a tooltip.
    const iconOnly = async page => {
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('button, a, summary')].filter(e => !e.textContent.trim() && !e.getAttribute('data-tooltip')).map(e => e.outerHTML.slice(0, 80))), [], 'every icon-only control has a tooltip');
      for (const control of await page.locator('[data-tooltip]').all()) if (await control.isVisible()) await tooltipProof(page, control);
    };

    // The owner connects both providers in their own session.
    const owner = await open(h.owner);
    await owner.page.goto(h.origin + '/app#/settings');
    const providers = owner.page.locator('section[aria-label="Bank verification providers"]');
    await providers.getByLabel('Plaid client ID', { exact: true }).fill(edge.clientId);
    await providers.getByLabel('Plaid sandbox secret', { exact: true }).fill(edge.secret);
    await providers.getByRole('checkbox', { name: /authorize Plaid/ }).check();
    await submit(owner.page, providers, 'Connect Plaid sandbox', ['bank', 'providers', 'connect'].join('/'));
    await expect(providers.getByText('Plaid sandbox is connected.')).toBeVisible();
    await providers.getByLabel('Stripe test secret key', { exact: true }).fill(edge.stripeKey);
    await providers.getByLabel('Stripe test publishable key', { exact: true }).fill(edge.publishableKey);
    await providers.getByRole('checkbox', { name: /authorize Stripe/ }).check();
    await submit(owner.page, providers, 'Connect Stripe test mode', ['bank', 'providers', 'connect'].join('/'));
    await expect(providers.getByText('Stripe test mode is connected.')).toBeVisible();
    await capture(owner.page, 'providers', providers);
    assert.ok(!JSON.stringify(await h.get(['bank', 'providers'].join('/'))).includes(edge.secret), 'credentials are never read back');

    // An employee adds an account by micro-deposits, verifies it, then changes it by instant verification.
    const employee = await open(sam);
    await employee.page.goto(h.origin + '/app#/settings');
    const mine = employee.page.locator('section[aria-label="Your bank account"]');
    await expect(mine.getByText('No bank account yet')).toBeVisible();
    await expect(employee.page.locator('section[aria-label="Employee bank details"]')).toHaveCount(0);
    await capture(employee.page, 'none', mine);
    await mine.getByRole('button', { name: 'Add with micro-deposits', exact: true }).click();
    await expect(mine.getByText('Waiting for deposits')).toBeVisible();
    await capture(employee.page, 'pending', mine);
    await mine.getByLabel('First deposit (cents)', { exact: true }).fill('31');
    await mine.getByLabel('Second deposit (cents)', { exact: true }).fill('45');
    await mine.getByRole('button', { name: 'Verify deposits', exact: true }).click();
    await expect(mine.getByRole('alert')).toBeVisible();
    await mine.getByLabel('First deposit (cents)', { exact: true }).fill('32');
    await submit(employee.page, mine, 'Verify deposits', ['bank', 'verify'].join('/'));
    await expect(mine.getByText(/Stripe bank account · ends 6789 · verified by micro-deposits/)).toBeVisible();
    await expect(mine.getByText('Payments held')).toHaveCount(0);
    await capture(employee.page, 'verified', mine);
    const link = edge.link('0000');
    await employee.page.evaluate(l => { window.__link = l; }, link);
    await mine.getByRole('button', { name: 'Change with instant verification', exact: true }).click();
    await expect(mine.getByText(/Plaid bank account · ends 0000 · verified instantly/)).toBeVisible();
    await expect(mine.getByText('Payments held')).toBeVisible();
    await capture(employee.page, 'changed-held', mine);
    assert.equal(h.messages.filter(m => m.to.includes('sam@harbourfinch.example') && /bank account was changed/.test(m.subject)).length, 1, 'the address on record is told');
    await iconOnly(employee.page);

    // Finance reads status and last four for everyone and sets the cooling-off period.
    const finance = await open(morgan);
    await finance.page.goto(h.origin + '/app#/settings');
    const people = finance.page.locator('section[aria-label="Employee bank details"]');
    const row = people.getByRole('row', { name: /sam/ });
    await expect(row).toContainText('Verified');
    await expect(row).toContainText('ends 0000');
    await expect(row).toContainText('Held until');
    await people.getByLabel('Hold payments after a bank change (days)', { exact: true }).fill('3');
    await submit(finance.page, people, 'Save cooling-off period', ['bank', 'hold-period'].join('/'));
    await expect(people.getByText('Cooling-off period saved.')).toBeVisible();
    assert.equal((await h.get(['bank', 'people'].join('/'), morgan)).holdDays, 3);
    await expect(finance.page.locator('section[aria-label="Bank verification providers"]')).toHaveCount(0);
    await capture(finance.page, 'finance-view', people);
    await iconOnly(finance.page);
    for (const { failures, transport } of [owner, employee, finance]) {
      assert.deepEqual(failures, [], 'production App has no browser exceptions');
      assert.deepEqual(transport.unexpected, [], 'the browser contacts no external origin the stand-ins do not serve');
    }
    for (const path of [['bank', 'providers', 'connect'].join('/'), ['bank', 'start'].join('/'), ['bank', 'complete'].join('/'), ['bank', 'verify'].join('/'), ['bank', 'hold-period'].join('/')])
      assert.ok([owner, employee, finance].some(c => c.transport.forwarded.some(request => request.method === 'POST' && request.path === '/api/coaster/' + path)), `${path} crossed real HTTP into the production Worker`);
    console.log(`Bank details production UI journey passed at ${width}px`);
  } finally { for (const context of contexts) await context.close(); await h.close(); }
}

try {
  for (const width of [1440, 390]) await journey(width);
  console.log(JSON.stringify({ screenshots: shots }));
} finally { await browser.close(); }
