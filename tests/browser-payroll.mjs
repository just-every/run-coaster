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
    const signInAgain = async email => {
      const requested = await h.send('/auth/magic-link', { email, returnTo: '/app' }, '', { 'CF-Connecting-IP': '192.0.2.120' });
      assert.equal(requested.status, 202, 'ordinary native sign-in accepts the request');
      const message = h.messages.findLast(message => message.to.includes(email));
      assert.ok(message, 'the fixture mail edge receives the actual sign-in link');
      const link = message.text.match(/http:\/\/[^\s]+\/auth\/confirm\?token=[^\s]+/)?.[0];
      assert.ok(link, 'the sign-in message contains a confirmation link');
      const confirmation = await context.newPage();
      try {
        await confirmation.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.120' });
        await confirmation.goto(link);
        const confirmed = confirmation.waitForResponse(reply => new URL(reply.url()).pathname === '/auth/confirm' && reply.request().method() === 'POST');
        await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
        assert.equal((await confirmed).status(), 303, 'the real confirmation creates a new native session');
        await confirmation.waitForURL(h.origin + '/app');
      } finally { await confirmation.close(); }
      const cookie = (await context.cookies(h.origin)).find(cookie => cookie.name === h.owner.slice(0, h.owner.indexOf('=')));
      assert.ok(cookie, 'native confirmation installs the session cookie');
      const header = cookie.name + '=' + cookie.value;
      const signedIn = await h.send('/auth/session', undefined, header);
      assert.equal(signedIn.status, 200);
      assert.equal(signedIn.value.kind, 'native');
      assert.equal(signedIn.value.operator.email, email);
      return { cookie: header, session: signedIn.value };
    };
    await page.goto(h.origin + '/app#/settings');
    const settings = page.locator('section[aria-label="Gusto sandbox payroll"]');
    await expect(settings.getByRole('button', { name: 'Connect Gusto sandbox', exact: true })).toBeVisible();
    await settings.getByLabel('Sandbox company UUID', { exact: true }).fill(edge.company);
    await settings.getByLabel('Sandbox access token', { exact: true }).fill('synthetic-coaster-120');
    await settings.getByRole('checkbox', { name: /I authorize reading/ }).check();
    const connectionPath = ['payroll', 'gusto'].join('/');
    const originalSession = await h.send('/auth/session', undefined, h.owner);
    assert.equal(originalSession.status, 200);
    assert.equal(originalSession.value.kind, 'native');
    await h.db.prepare('UPDATE oa_sessions SET created_at=? WHERE id=?').bind(Date.now() - 11 * 60000, originalSession.value.id).run();
    assert.equal((await h.send('/auth/session', undefined, h.owner)).status, 200, 'the stale native session remains valid');
    const providerRequests = h.outbound.filter(request => new URL(request.url).hostname === 'api.gusto-demo.com').length;
    const refused = page.waitForResponse(reply => reply.url() === h.origin + '/api/coaster/' + connectionPath + '/connect' && reply.request().method() === 'POST');
    await settings.getByRole('button', { name: 'Connect Gusto sandbox', exact: true }).click();
    const rejection = await refused;
    assert.equal(rejection.status(), 401);
    const refusal = (await rejection.json()).error;
    assert.match(refusal, /sign in again.*10 minutes/i);
    await expect(settings.getByRole('alert')).toHaveText(refusal);
    assert.equal((await h.get(connectionPath)).connection, null, 'stale consent creates no payroll connection');
    assert.equal(h.outbound.filter(request => new URL(request.url).hostname === 'api.gusto-demo.com').length, providerRequests, 'stale consent makes no provider request');
    await expect(settings.getByLabel('Sandbox company UUID', { exact: true })).toHaveValue(edge.company);
    await expect(settings.getByRole('checkbox', { name: /I authorize reading/ })).toBeChecked();
    await capture('stale-sign-in', settings);
    const fresh = await signInAgain(originalSession.value.operator.email);
    assert.notEqual(fresh.session.id, originalSession.value.id, 'retry uses a newly confirmed session');
    await submit(settings, 'Connect Gusto sandbox', connectionPath + '/connect');
    await expect(settings.getByLabel('Coaster person', { exact: true })).toBeVisible();
    assert.equal((await h.get(connectionPath)).connection.company_uuid, edge.company);
    await capture('fresh-sign-in-connected', settings);
    await settings.getByLabel('Coaster person', { exact: true }).selectOption(t.memberEmail);
    await settings.getByLabel('Gusto employee', { exact: true }).selectOption(edge.employee);
    await submit(settings, 'Map payroll employee', connectionPath + '/employees');
    await expect(settings.locator('.ruled-list li')).toContainText('Sam Taylor');
    assert.deepEqual((await h.get(connectionPath)).mappings.map(mapping => [mapping.email, mapping.employee_uuid]), [[t.memberEmail, edge.employee]]);
    await capture('connected', settings);

    const batch = await h.post(`batches/${t.batch.id}/release`, { version: t.batch.version }, fresh.cookie);
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
