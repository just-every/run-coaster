import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { agency, harness } from './harness.mjs';
import { pendingEmailQuestionClaim } from './fixtures/email-question-claim.mjs';
import { deliverSlack, slackFixture } from './fixtures/slack.mjs';
import { noOverflow, payrollBrowserRuntime, tooltipProof } from './payroll-browser-runtime.mjs';

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/slack-proof');
await mkdir(evidence, { recursive: true });
const attach = await payrollBrowserRuntime();
const regressions = [];
const employee = ['sam', 'harbourfinch.example'].join('@');
const question = 'Which client was this dinner for?';
const answer = 'Harbour Bank, the pitch team';
const browser = await chromium.launch({
  headless: true,
  ...(process.env.COASTER_CHROMIUM ? { executablePath: process.env.COASTER_CHROMIUM } : {}),
  args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'],
});
try {
  for (const width of [1440, 390]) {
    const edge = slackFixture();
    const h = await harness({ slackEdge: request => edge.fetch(request) });
    let context;
    try {
      const team = await agency(h);
      context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
      const transport = await attach(context, h);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const signIn = async cookie => {
        const split = cookie.indexOf('=');
        assert.ok(split > 0);
        await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: h.origin, httpOnly: true, sameSite: 'Lax' }]);
      };
      const capture = async (name, region) => {
        await page.evaluate(() => document.fonts.ready);
        await noOverflow(page);
        const small = await region.evaluate(element => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), result = [];
          while (walker.nextNode()) {
            const node = walker.currentNode, parent = node.parentElement;
            if (!node.textContent.trim() || parent.closest('.visually-hidden, svg, script, style') || !parent.checkVisibility()) continue;
            const size = parseFloat(getComputedStyle(parent).fontSize);
            if (size < 13) result.push({ text: node.textContent.trim(), size });
          }
          return result;
        });
        if (small.length) regressions.push({ width, screen: name, small });
        const path = join(evidence, `${width}-${name}.png`);
        await region.screenshot({ path });
        console.log(path);
      };

      await page.goto(h.origin + '/app#/settings');
      const slack = page.getByRole('region', { name: 'Slack questions and replies', exact: true });
      await expect(slack.getByText('No Slack workspace connected.', { exact: true })).toBeVisible();
      for (const control of await page.locator('[data-tooltip]:visible').all()) await tooltipProof(page, control);
      await capture('slack-connection-consent', slack);
      await slack.getByLabel('Slack bot token', { exact: true }).fill(edge.token);
      await slack.getByLabel('Slack signing secret', { exact: true }).fill(edge.secret);
      await slack.getByLabel('I authorize this workspace and app to send claim questions to linked employees and receive their signed thread replies', { exact: true }).check();
      await slack.getByRole('button', { name: 'Connect Slack', exact: true }).click();
      await expect(slack.getByRole('button', { name: 'Disconnect Slack', exact: true })).toBeVisible();
      assert.equal((await h.get('chat/slack')).connected, true);
      await capture('slack-connected', slack);

      await signIn(team.sam);
      await page.reload();
      await expect(slack.getByLabel('Your Slack member ID', { exact: true })).toBeVisible();
      await expect(slack.getByRole('button', { name: 'Disconnect Slack', exact: true })).toHaveCount(0);
      await capture('slack-self-link-consent', slack);
      await slack.getByLabel('Your Slack member ID', { exact: true }).fill(edge.user);
      await slack.getByLabel('I consent to receive private claim questions in Slack and share my answers with claim readers', { exact: true }).check();
      await slack.getByRole('button', { name: 'Send Slack verification code', exact: true }).click();
      await expect(slack.getByText(`Verification code sent privately to ${edge.user}. Enter it below.`, { exact: true })).toBeVisible();
      await capture('slack-verification', slack);
      const code = edge.messages.at(-1)?.text.match(/code: ([a-f0-9]+)/)?.[1];
      assert.ok(code, 'verification reaches the synthetic private Slack message');
      await slack.getByLabel('Code from your Slack direct message', { exact: true }).fill(code);
      await slack.getByRole('button', { name: 'Confirm my Slack account', exact: true }).click();
      await expect(slack.getByRole('button', { name: 'Unlink my Slack account', exact: true })).toBeVisible();
      assert.equal((await h.get('chat/slack', team.sam)).linked, true);
      await capture('slack-self-linked', slack);

      const claim = await pendingEmailQuestionClaim(h, team, `Client dinner Slack question ${width}`);
      const before = await h.get(`claims/${claim.id}`, team.priya);
      await signIn(team.priya);
      await page.goto(h.origin + `/app#/approvals/${claim.id}`);
      await page.reload();
      const comments = page.getByRole('region', { name: 'Comments', exact: true });
      await comments.getByLabel('Comment or question', { exact: true }).fill(question);
      await comments.getByLabel('About', { exact: true }).selectOption(before.items[0].id);
      await comments.getByLabel('Ask', { exact: true }).selectOption(employee);
      await comments.getByRole('button', { name: 'Add comment', exact: true }).click();
      await expect(comments.getByText('Open question', { exact: true })).toBeVisible();
      await expect(comments.getByText(question, { exact: true })).toBeVisible();
      const asked = await h.get(`claims/${claim.id}`, team.priya);
      const thread = asked.comments.find(comment => comment.body === question && !comment.parent_id);
      assert.ok(thread);
      assert.equal(thread.item_id, before.items[0].id);
      assert.ok(edge.messages.at(-1).text.includes(question));
      assert.equal(asked.claim.status, 'submitted');
      assert.deepEqual(asked.revisions, before.revisions);
      await capture('slack-question-open', page.locator('.detail'));

      const delivered = await deliverSlack(h, edge, edge.reply({ event: { text: answer } }));
      assert.equal(delivered.status, 200);
      assert.equal(delivered.value.accepted, true);
      await page.reload();
      await expect(comments.getByText('Answered', { exact: true })).toBeVisible();
      await expect(comments.getByText(answer, { exact: true })).toBeVisible();
      await expect(comments.getByText('Open question', { exact: true })).toHaveCount(0);
      const answered = await h.get(`claims/${claim.id}`, team.priya);
      assert.equal(answered.claim.status, 'submitted');
      assert.equal(answered.claim.revision, before.claim.revision);
      assert.deepEqual(answered.revisions, before.revisions);
      assert.deepEqual(answered.items, before.items);
      assert.equal(answered.comments.find(comment => comment.id === thread.id).open, false);
      const reply = answered.comments.find(comment => comment.parent_id === thread.id);
      assert.equal(reply.author_email, employee);
      assert.equal(reply.body, answer);
      await capture('slack-question-answered', page.locator('.detail'));

      const acknowledge = page.getByLabel(/I reviewed the .*policy exception/);
      if (await acknowledge.count()) await acknowledge.check();
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect.poll(async () => (await h.get(`claims/${claim.id}`, team.priya)).claim.status).toBe('approved');
      await page.goto(h.origin + `/app#/approvals/${claim.id}`);
      await expect(comments.getByText('Answered', { exact: true })).toBeVisible();
      await expect(comments.getByText(answer, { exact: true })).toBeVisible();
      const approved = await h.get(`claims/${claim.id}`, team.priya);
      assert.equal(approved.claim.revision, before.claim.revision);
      assert.deepEqual(approved.revisions, before.revisions);
      assert.deepEqual(approved.items, before.items);
      assert.deepEqual(approved.decisions.map(decision => decision.revision), [before.claim.revision]);
      await capture('slack-answer-approved', page.locator('.detail'));
      for (const path of ['/api/coaster/chat/slack/connect', '/api/coaster/chat/slack/link/start', '/api/coaster/chat/slack/link/confirm', `/api/coaster/claims/${claim.id}/comments`, `/api/coaster/claims/${claim.id}/decision`]) {
        assert.ok(transport.forwarded.some(request => request.method === 'POST' && request.path === path), 'native browser mutation reached the Worker');
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(transport.unexpected, []);
      console.log(`Slack answer browser proof passed at ${width}px`);
    } finally {
      await context?.close();
      await h.close();
    }
  }
} finally {
  await browser.close();
}
assert.deepEqual(regressions, [], 'visible Slack journey text is at least 13px');
