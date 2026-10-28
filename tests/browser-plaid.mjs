// Production Settings and native HTTP, with fixtures only at Plaid's network edges.
// Run through the owning heavy slot: node tests/browser-plaid.mjs --run
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { harness } from './harness.mjs';
import { plaidConfig, plaidFixture, plaidTransaction } from './fixtures/plaid.mjs';
import { noOverflow, payrollBrowserRuntime } from './payroll-browser-runtime.mjs';

const cdn = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
const linkFixture = `window.Plaid = { create(options) {
  if (!options.token.startsWith('synthetic-coaster-link-')) throw new Error('Invalid synthetic Link token');
  const dialog = document.createElement('dialog');
  const label = document.createElement('p'); label.textContent = 'Synthetic card ending 1008'; dialog.append(label);
  const button = document.createElement('button'); button.textContent = 'Choose synthetic card';
  button.addEventListener('click', () => { dialog.close(); options.onSuccess('synthetic-coaster-330', {accounts:[{id:'synthetic-coaster-203'}]}); });
  dialog.append(button);
  return { open() { document.body.append(dialog); dialog.showModal(); }, destroy() { dialog.remove(); } };
} };`;

export async function plaidBrowserJourney({ widths = [1440, 390], evidence = process.env.COASTER_EVIDENCE ?? '.cache/plaid-proof' } = {}) {
  const destination = resolve(evidence), shots = [];
  await mkdir(destination, { recursive: true });
  const attach = await payrollBrowserRuntime();
  const browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
  try {
    for (const width of widths) {
      const edge = plaidFixture(), h = await harness({ clock: Date.now(), plaidEdge: request => edge.fetch(request) });
      let context;
      try {
        await h.post('settings/business', { name: 'Synthetic Coaster', currency: 'USD', timezone: 'UTC', receiptThreshold: '' });
        const email = ['synthetic-coaster-331', 'example.test'].join('@');
        const employee = await h.person(email, { employee: true });
        await h.post('settings/members', { email, name: 'Jordan Rivera', employee: true, active: true });
        const category = await h.post('settings/categories', { name: 'Office supplies', accountCode: '6500', taxCode: 'NONE' });
        context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
        const transport = await attach(context, h);
        await context.route(cdn, route => route.fulfill({ status: 200, contentType: 'text/javascript', body: linkFixture }));
        const page = await context.newPage(), failures = [];
        page.on('pageerror', error => failures.push(error.message));
        const section = page.getByRole('region', { name: 'Plaid transaction feeds', exact: true });
        const capture = async name => {
          await page.evaluate(() => document.fonts.ready);
          await section.scrollIntoViewIfNeeded(); await noOverflow(page);
          const detail = join(destination, `${width}-${name}-detail.png`), screen = join(destination, `${width}-${name}-screen.png`);
          await section.screenshot({ path: detail }); await page.screenshot({ path: screen, fullPage: true });
          shots.push(detail, screen);
        };
        const submit = async (label, path, scope = section) => {
          const response = page.waitForResponse(reply => reply.url() === h.origin + '/api/coaster/' + path && reply.request().method() === 'POST');
          await scope.getByRole('button', { name: label, exact: true }).click();
          const reply = await response;
          assert.equal(reply.status(), 200, `${path}: ${await reply.text()}`);
          return reply.json();
        };
        await page.goto(h.origin + '/app#/settings');
        await section.locator('summary').filter({ hasText: /^Configure Plaid sandbox$/ }).click();
        await section.getByLabel('Feed Plaid client ID', { exact: true }).fill(plaidConfig.clientId);
        await section.getByLabel('Feed Plaid sandbox secret', { exact: true }).fill(plaidConfig.secret);
        await section.getByLabel('Estimated USD per account each month', { exact: true }).fill(plaidConfig.accountMonthly);
        await section.getByLabel('Monthly feed cap in USD', { exact: true }).fill(plaidConfig.monthlyCap);
        await section.getByRole('checkbox', { name: 'I authorize this Plaid sandbox application and these estimated costs', exact: true }).check();
        const configuration = await submit('Configure Plaid sandbox', 'plaid/settings');
        assert.equal(configuration.accountMonthlyMinor, Number(plaidConfig.accountMonthly) * 100);
        await expect(section.getByLabel('Feed Plaid sandbox secret', { exact: true })).toHaveValue('');
        const costs = section.getByLabel('Plaid estimated costs', { exact: true });
        await expect(costs).toContainText('$' + (configuration.accountMonthlyMinor / 100).toFixed(2));
        await capture('configured-costs');

        await section.locator('summary').filter({ hasText: /^Connect a transaction feed$/ }).click();
        await section.getByLabel('Feed scope', { exact: true }).selectOption('company');
        await section.getByRole('button', { name: 'Open Plaid Link', exact: true }).click();
        await expect(section.getByRole('alert')).toBeVisible();
        assert.equal(edge.calls.length, 0, 'no provider request before explicit Link consent');
        await section.getByRole('checkbox', { name: /I authorize sharing selected accounts/ }).check();
        const exchange = page.waitForResponse(reply => reply.url() === h.origin + '/api/coaster/plaid/exchange' && reply.request().method() === 'POST');
        await section.getByRole('button', { name: 'Open Plaid Link', exact: true }).click();
        await page.getByRole('button', { name: 'Choose synthetic card', exact: true }).click();
        const exchanged = await exchange;
        assert.equal(exchanged.status(), 200, await exchanged.text());
        const connection = await exchanged.json(), path = `plaid/connections/${connection.id}`;
        const account = section.getByLabel('Feed account ending 1008', { exact: true });
        await account.getByText('Assign this account', { exact: true }).click();
        await account.getByLabel('Feed employee', { exact: true }).selectOption(email);
        await account.getByLabel('Feed expense category', { exact: true }).selectOption(category.id);
        await submit('Assign feed account', path + '/assign', account);
        await expect(account).toContainText('Jordan Rivera');
        const connected = await h.get('plaid/connections');
        assert.deepEqual(connected.connections[0].assignments.map(value => [value.account, value.employee, value.category]), [[connection.accounts[0].id, email, category.id]]);
        assert.equal(connected.costs.monthToDateMinor, configuration.accountMonthlyMinor);
        await expect(costs).toContainText('$' + (connected.costs.monthToDateMinor / 100).toFixed(2));
        await capture('assigned');

        const pending = plaidTransaction({ transaction_id: 'synthetic-coaster-332', merchant_name: 'Harbour Cafe', name: 'Harbour Cafe', amount: 8.75, pending: true });
        const posted = plaidTransaction();
        const removed = plaidTransaction({ transaction_id: 'synthetic-coaster-333', merchant_name: 'Harbour Parking', name: 'Harbour Parking', amount: 12, pending: true });
        const secondPosted = plaidTransaction({ transaction_id: 'synthetic-coaster-336', merchant_name: 'Harbour Books', name: 'Harbour Books', amount: 19 });
        edge.pages.push({ added: [pending, posted, removed, secondPosted], modified: [], removed: [], next_cursor: 'synthetic-coaster-334', has_more: false });
        const synced = await submit('Sync feed transactions', path + '/sync');
        assert.equal(synced.added, 4); assert.equal(synced.expenses, 2, 'only posted transactions create expenses');
        await expect(section.getByRole('status').filter({ hasText: 'Sync complete' })).toContainText(`${synced.expenses} expenses created`);
        await section.getByText('Transaction details', { exact: true }).click();
        const transactions = section.getByRole('list', { name: 'Plaid transactions', exact: true });
        await expect(transactions.getByRole('listitem').filter({ hasText: pending.merchant_name })).toContainText('Pending');
        await expect(transactions.getByRole('listitem').filter({ hasText: posted.merchant_name })).toContainText('Posted');
        const claims = (await h.get('state', employee)).claims;
        const expenseLists = await Promise.all(claims.map(claim => h.get(`claims/${claim.id}`, employee)));
        const expenses = expenseLists.flatMap(detail => detail.items);
        assert.ok(expenses.some(item => item.merchant === posted.merchant_name && item.amount_minor === Math.round(posted.amount * 100)), 'UI sync creates a native employee expense');
        assert.ok(!expenses.some(item => item.merchant === pending.merchant_name));
        await capture('pending-posted');

        edge.pages.push({ added: [], modified: [plaidTransaction({ amount: 43.50 })], removed: [{ transaction_id: removed.transaction_id }], next_cursor: 'synthetic-coaster-335', has_more: false });
        const reconciled = await submit('Sync feed transactions', path + '/sync');
        assert.equal(reconciled.modified, 1); assert.equal(reconciled.removed, 1);
        await expect(transactions.getByRole('listitem').filter({ hasText: removed.merchant_name })).toContainText('Removed');
        await expect(transactions.getByRole('listitem').filter({ hasText: posted.merchant_name })).toContainText('Needs review');
        await expect(transactions.getByRole('listitem').filter({ hasText: posted.merchant_name })).toContainText('$43.50');
        const originalClaim = expenseLists.find(detail => detail.items.some(item => item.merchant === posted.merchant_name));
        const retained = (await h.get(`claims/${originalClaim.claim.id}`, employee)).items.find(item => item.merchant === posted.merchant_name);
        assert.equal(retained.amount_minor, Math.round(posted.amount * 100), 'provider correction retains the financial expense for review');
        await capture('removed-reconciled');

        await section.getByText('Disconnect this feed', { exact: true }).click();
        await section.getByRole('checkbox', { name: 'I confirm this feed must stop future imports', exact: true }).check();
        await submit('Disconnect Plaid feed', path + '/disconnect');
        await expect(section.getByText('No Plaid feeds connected', { exact: true })).toBeVisible();
        const disconnected = await h.get('plaid/connections');
        assert.equal(disconnected.connections.length, 0); assert.equal(edge.items.size, 0);
        assert.equal(disconnected.costs.monthToDateMinor, connected.costs.monthToDateMinor, 'disconnect retains cost estimates');
        await capture('disconnected');
        assert.deepEqual(failures, [], 'production UI has no browser exceptions');
        assert.deepEqual(transport.unexpected, [], 'only the declared Plaid script uses a browser network fixture');
        for (const route of ['plaid/settings', 'plaid/link', 'plaid/exchange', path + '/assign', path + '/sync', path + '/disconnect'])
          assert.ok(transport.forwarded.some(request => request.method === 'POST' && request.path === '/api/coaster/' + route), `${route} crossed native HTTP`);
      } finally { await context?.close(); await h.close(); }
    }
  } finally { await browser.close(); }
  return { screenshots: shots };
}

if (process.argv.includes('--run') && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(JSON.stringify(await plaidBrowserJourney()));
