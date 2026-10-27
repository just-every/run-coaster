// PAY-002 employee bank details through the public HTTP API with real native sessions, workerd and D1. Only the two verification
// providers (and the mail transport) are faked, at the network edge; they hold the full account numbers, as the real ones do.
import { gustoFixture } from './fixtures/payroll.mjs';
import { connectFixture } from './payroll-kit.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { payrollBatch } from './payroll-kit.mjs';
import { addInstant, addMicrodeposits, bankFixture, BANK_NUMBERS, connectBank, everything } from './fixtures/bank.mjs';

const options = edge => ({ plaidEdge: r => edge.fetch(r), stripeEdge: r => edge.fetch(r) });
const staleSession = async (h, email, minutes) => {
  const session = await h.db.prepare('SELECT s.id,s.created_at FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id WHERE lower(o.email)=?').bind(email).first();
  await h.db.prepare('UPDATE oa_sessions SET created_at=? WHERE id=?').bind(Date.now() - minutes * 60000, session.id).run();
  return () => h.db.prepare('UPDATE oa_sessions SET created_at=? WHERE id=?').bind(session.created_at, session.id).run();
};
const bankLines = async h => (await h.get('history')).lines.filter(e => e.action.startsWith('bank-'));

test('Employees add a bank account by instant verification and another by micro-deposits, and Coaster keeps only sealed tokens and the last four', async () => {
  const edge = bankFixture(), h = await harness(options(edge));
  try {
    const t = await payrollBatch(h), admin = await h.person('synthetic-coaster-230@example.invalid', { admin: true });
    for (const cookie of [t.employee, t.manager, t.finance, admin]) await h.post(['bank', 'providers', 'connect'].join('/'), { provider: 'plaid', clientId: edge.clientId, secret: edge.secret, consent: true }, cookie, 403);
    await h.post(['bank', 'providers', 'connect'].join('/'), { provider: 'plaid', clientId: edge.clientId, secret: edge.secret }, h.owner, 400);
    edge.live = true;
    await h.post(['bank', 'providers', 'connect'].join('/'), { provider: 'stripe', secretKey: edge.stripeKey, publishableKey: edge.publishableKey, consent: true }, h.owner, 409);
    edge.live = false;
    await h.post(['bank', 'start'].join('/'), { provider: 'plaid' }, t.employee, 409);
    await connectBank(h, edge);
    assert.deepEqual((await h.get('bank', t.employee)).providers, { plaid: true, stripe: true });

    // A bank change needs a sign-in from the last ten minutes.
    const ownerRestore = await staleSession(h, 'owner@harbourfinch.example', 11);
    await h.post(['bank', 'providers', 'disconnect'].join('/'), { provider: 'plaid' }, h.owner, 401);
    await ownerRestore();
    const restore = await staleSession(h, t.memberEmail, 11);
    await h.post(['bank', 'start'].join('/'), { provider: 'plaid' }, t.employee, 401);
    await h.post(['bank', 'complete'].join('/'), { provider: 'plaid', ...edge.link('2222') }, t.employee, 401);
    await restore();

    const unverified = edge.link('9999', { item: { auth_method: 'AUTOMATED_MICRODEPOSITS' } });
    await h.post(['bank', 'complete'].join('/'), { provider: 'plaid', ...unverified }, t.employee, 409);
    assert.equal(edge.removed.length, 1, 'unverified Plaid items are removed');
    assert.equal((await h.get('bank', t.employee)).account, null);
    const instant = await addInstant(h, edge, t.employee, '0000');
    assert.deepEqual([instant.status, instant.account.method, instant.account.last4, instant.account.held, instant.notified], ['active', 'instant', '0000', false, null], 'a first account is added without a hold or a notice');
    const pending = await addMicrodeposits(h, edge, t.finance, '6789');
    assert.equal(pending.status, 'pending');
    assert.equal((await h.get('bank', t.finance)).account, null, 'a pending account pays nothing');
    const financeRestore = await staleSession(h, 'morgan@harbourfinch.example', 11);
    await h.post(['bank', 'verify'].join('/'), { id: pending.account.id, amounts: [32, 45] }, t.finance, 401);
    await financeRestore();
    await h.post(['bank', 'verify'].join('/'), { id: pending.account.id, amounts: [31, 45] }, t.finance, 409);
    assert.equal((await h.post(['bank', 'refresh'].join('/'), { id: pending.account.id }, t.finance)).status, 'pending');
    await h.post(['bank', 'verify'].join('/'), { id: pending.account.id, amounts: [32, 45] }, t.employee, 404);
    const verified = await h.post(['bank', 'verify'].join('/'), { id: pending.account.id, amounts: [32, 45] }, t.finance);
    assert.deepEqual([verified.status, verified.account.method, verified.account.last4], ['active', 'microdeposit', '6789']);
    await h.post(['bank', 'complete'].join('/'), { provider: 'stripe', setupIntent: pending.start.setupIntent }, t.finance, 409);

    // Only tokens and the last four are held: the full numbers never reach Coaster, and tokens are sealed.
    const labelProbe = edge.link('2468', { account: { name: BANK_NUMBERS[0] }, item: { institution_name: BANK_NUMBERS[1] } });
    await h.post(['bank', 'complete'].join('/'), { provider: 'plaid', ...labelProbe }, t.manager);
    const stored = await everything(h), outbound = JSON.stringify(h.outbound.map(r => r.body));
    for (const number of BANK_NUMBERS) assert.ok(!stored.includes(number) && !outbound.includes(number), 'no account or routing number is stored or sent');
    for (const secret of ['synthetic-coaster-access', 'synthetic-coaster-pm', 'synthetic-coaster-intent', 'synthetic-coaster-public', edge.secret, edge.stripeKey]) assert.ok(!stored.includes(secret), `${secret} is not stored in the clear`);
    const rows = (await h.db.prepare('SELECT * FROM c_bank_accounts ORDER BY created_at').all()).results;
    assert.deepEqual(rows.map(r => [r.state, r.method, r.last4]), [['active', 'instant', '0000'], ['active', 'microdeposit', '6789'], ['active', 'instant', '2468']]);
    assert.ok(rows.every(r => /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(r.token_sealed)), 'each token is sealed');
    assert.ok(!JSON.stringify(await h.get('bank', t.employee)).includes('token'), 'no read returns a token');
    assert.deepEqual((await bankLines(h)).map(l => l.action), ['bank-provider-connected', 'bank-provider-connected', 'bank-account-added', 'bank-account-pending', 'bank-account-added', 'bank-account-added']);
    const next = edge.link('1357'), fetch_ = edge.fetch;
    edge.fetch = async request => {
      const result = await fetch_(request);
      if (new URL(request.url).pathname === '/item/public_token/exchange') await h.post(['bank', 'providers', 'disconnect'].join('/'), { provider: 'plaid' });
      return result;
    };
    const reads = edge.calls.filter(c => c.path === '/accounts/get').length;
    await h.post(['bank', 'complete'].join('/'), { provider: 'plaid', ...next }, t.employee, 409);
    assert.equal(edge.calls.filter(c => c.path === '/accounts/get').length, reads, 'disconnect prevents the next physical provider request');
    assert.equal((await h.get('bank', t.employee)).account.last4, '0000', 'withdrawn authority cannot change the saved account');
    edge.fetch = fetch_;
    await h.post(['bank', 'providers', 'connect'].join('/'), { provider: 'plaid', clientId: edge.clientId, secret: edge.secret, consent: true });
    edge.fetch = async request => {
      const result = await fetch_(request);
      if (new URL(request.url).pathname === '/accounts/get') await h.post(['bank', 'providers', 'disconnect'].join('/'), { provider: 'plaid' });
      return result;
    };
    await h.post(['bank', 'complete'].join('/'), { provider: 'plaid', ...edge.link('9753') }, t.employee, 409);
    assert.equal((await h.get('bank', t.employee)).account.last4, '0000', 'disconnect before commit prevents saving a new account');
    await assert.rejects(h.db.prepare("UPDATE c_bank_accounts SET last4='1234'").run(), /immutable/);
    await assert.rejects(h.db.prepare('DELETE FROM c_bank_accounts').run(), /immutable/);
  } finally { await h.close(); }
});

test('Changing the account tells the address on record, holds payments for the cooling-off period and releases them after it, in numbered history', async () => {
  const edge = bankFixture(), gusto = gustoFixture(), h = await harness({ ...options(edge), gustoEdge: r => gusto.fetch(r) });
  try {
    const t = await payrollBatch(h);
    await connectFixture(h, gusto, t.memberEmail);
    const initiallyReleased = await h.post(`batches/${t.batch.id}/release`, { version: t.batch.version });
    const category = (await h.post(['settings', 'categories'].join('/'), { name: 'Travel', accountCode: '6200', taxCode: 'NONE' })).id;
    const approvedClaim = async merchant => {
      let claim = await h.post('claims', { title: merchant }, t.employee);
      claim = await h.post(`claims/${claim.id}/items`, { version: claim.version, kind: 'receipt', date: '2026-04-11', merchant, amount: '8.00', allocations: [{ category }], explanation: 'Synthetic acceptance expense' }, t.employee);
      claim = await h.post(`claims/${claim.id}/submit`, { version: claim.version }, t.employee);
      return h.post(`claims/${claim.id}/decision`, { version: claim.version, revision: claim.revision, decision: 'approved', acknowledge: true }, t.manager);
    };
    const releaseClaim = await approvedClaim('Station taxi');
    let heldBatch = await h.post('batches', { claims: [releaseClaim.id] }, t.finance);
    heldBatch = await h.post(`batches/${heldBatch.id}/approve`, { version: heldBatch.version, expectedTotal: 800 }, t.finance);
    await connectBank(h, edge);
    await addInstant(h, edge, t.employee, '0000');
    for (const days of [0, 31, 1.5]) await h.post(['bank', 'hold-period'].join('/'), { days }, t.finance, 400);
    await h.post(['bank', 'hold-period'].join('/'), { days: 3 }, t.employee, 403);
    await h.post(['bank', 'hold-period'].join('/'), { days: 3 }, t.finance);
    const sent = h.messages.length, changed = await addInstant(h, edge, t.employee, '1111');
    assert.deepEqual([changed.account.last4, changed.account.holdDays, changed.account.held, changed.notified], ['1111', 3, true, 'accepted']);
    assert.equal(Date.parse(changed.account.holdUntil) - Date.parse(changed.account.verifiedAt), 3 * 86_400_000);
    const notice = h.messages.slice(sent).filter(m => m.to.includes(t.memberEmail));
    assert.equal(notice.length, 1);
    assert.ok(/ends 1111/.test(notice[0].text) && /ended 0000/.test(notice[0].text) && notice[0].text.includes(changed.account.holdUntil.slice(0, 16).replace('T', ' ')), 'the notice names both accounts by last four and when the hold ends');
    assert.equal((await h.db.prepare("SELECT token_sealed FROM c_bank_accounts WHERE state='replaced'").first()).token_sealed, null, 'the replaced account keeps no token');

    const lines = await bankLines(h), start = lines.findIndex(l => l.action === 'bank-account-changed');
    assert.deepEqual(lines.slice(start, start + 3).map(l => l.action), ['bank-account-changed', 'bank-hold-started', 'bank-notice-sent']);
    assert.ok(lines.every((l, i) => !i || l.seq > lines[i - 1].seq) && lines.slice(start, start + 3).every(l => l.actor_email === t.memberEmail && l.channel === 'app'));
    assert.equal(lines[start + 2].detail.to, t.memberEmail);
    assert.ok(!JSON.stringify(lines).match(/\b(0000|1111)\b/), 'history lines carry no last four');

    await h.post(['bank', 'hold-period'].join('/'), { days: 1 }, t.finance);
    const changedAgain = await addInstant(h, edge, t.employee, '2222');
    assert.equal(changedAgain.account.holdUntil, changed.account.holdUntil, 'another bank change cannot shorten an outstanding cooling-off hold');

    // The reviewed batch holding their claims cannot be released, paid or handed to payroll while the hold stands.
    const batchId = t.batch.id, version = initiallyReleased.version;
    const heldPayment = await h.send(`/api/coaster/batches/${batchId}/paid`, { version, reference: 'synthetic-coaster-240', paidOn: '2026-10-27' }, t.finance);
    assert.equal(heldPayment.status, 409);
    assert.match(heldPayment.value.error, /Payments to sam are held until/);
    const heldPayroll = await h.send(`/api/coaster/batches/${batchId}/payroll`, { version, payroll: gusto.payrollId, consent: true }, h.owner);
    assert.equal(heldPayroll.status, 409);
    assert.match(heldPayroll.value.error, /Payments to sam are held until/);
    assert.equal(gusto.writes.length, 0);
    assert.equal((await h.get(`batches/${batchId}/payroll`)).handoff, null);
    const refused = await h.send(`/api/coaster/batches/${heldBatch.id}/release`, { version: heldBatch.version }, h.owner);
    assert.equal(refused.status, 409);
    assert.match(refused.value.error, /Payments to sam are held until/);
    assert.equal((await h.get(`batches/${heldBatch.id}`)).batch.released_at, null);
    await h.post(`batches/${batchId}/paid`, { version, reference: 'synthetic-coaster-240', paidOn: '2026-10-27' }, t.finance, 409);
    assert.ok((await h.get(`batches/${batchId}`)).batch.released_at);
    // A new batch holding the held person's claim is refused too, and goes through once the hold is released.
    const claim = await approvedClaim('City taxi');
    const second = await h.send('/api/coaster/batches', { claims: [claim.id] }, t.finance);
    assert.equal(second.status, 409);
    assert.match(second.value.error, /Payments to sam are held until/);
    const hold = await h.db.prepare("SELECT hold_until FROM c_bank_accounts WHERE state='active' AND member_email=?").bind(t.memberEmail).first();
    const worker = await h.mf.getWorker();
    await worker.scheduled({ scheduledTime: new Date(Date.parse(hold.hold_until) - 3_600_000), cron: '17 * * * *' });
    assert.equal((await h.get('bank', t.employee)).account.held, true, 'the hold stands until the period has passed');
    await h.post(`batches/${batchId}/release`, { version }, h.owner, 409);
    const payAt = new Date(Date.parse(hold.hold_until) + 86_400_000);
    payAt.setUTCHours(9, 17, 0, 0);
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    await h.post(['settings', 'payment-controls'].join('/'), { payWeekday: weekdays[payAt.getUTCDay()] });
    await worker.scheduled({ scheduledTime: payAt, cron: '17 * * * *' });
    const scheduled = await h.db.prepare('SELECT batch_id FROM c_pay_runs WHERE day=?').bind(payAt.toISOString().slice(0, 10)).first();
    assert.ok(scheduled?.batch_id, 'the first eligible payday includes the claim after releasing its expired hold');
    assert.equal((await h.get(`claims/${claim.id}`, t.employee)).claim.batch_id, scheduled.batch_id);
    assert.equal((await h.get('bank', t.employee)).account.held, false, 'the hourly run releases it after the period');
    const released = (await bankLines(h)).at(-1);
    assert.deepEqual([released.action, released.actor_email, released.channel], ['bank-hold-released', 'bank hold', 'schedule']);
    await h.post(`batches/${heldBatch.id}/release`, { version: heldBatch.version }, h.owner);
    const out = initiallyReleased;
    await h.post(`batches/${batchId}/paid`, { version: out.version, reference: 'synthetic-coaster-241', paidOn: '2026-10-27' }, t.finance);
    await worker.scheduled({ scheduledTime: new Date(Date.parse(hold.hold_until) + 7_200_000), cron: '17 * * * *' });
    assert.equal((await bankLines(h)).filter(l => l.action === 'bank-hold-released').length, 1, 'a hold is released once');
  } finally { await h.close(); }
});

test('Bank details are read by the owner and finance and by each person for their own only, refused to every delegate, and erased with the person', async () => {
  const edge = bankFixture(), h = await harness(options(edge));
  try {
    const t = await payrollBatch(h), domain = '@example.invalid';
    const roles = { Admin: { admin: true }, 'Card admin': { cardAdmin: true }, Approver: { manager: true }, Auditor: { auditor: true }, Bookkeeper: { bookkeeper: true } }, who = {};
    for (const [name, flags] of Object.entries(roles)) who[name] = await h.person(`synthetic-coaster-25${Object.keys(who).length}${domain}`, flags);
    await connectBank(h, edge);
    await addInstant(h, edge, t.employee, '0000');
    const before = (await h.db.prepare('SELECT COUNT(*) AS n FROM c_bank_accounts').first()).n;
    for (const [name, cookie] of Object.entries(who)) {
      await h.get(['bank', 'people'].join('/'), cookie, 403);
      await h.post(['bank', 'hold-period'].join('/'), { days: 5 }, cookie, 403);
    }
    await h.get(['bank', 'people'].join('/'), t.employee, 403);
    for (const name of ['Auditor', 'Bookkeeper']) await h.get('bank', who[name], 403);
    for (const name of ['Admin', 'Card admin', 'Approver']) assert.equal((await h.get('bank', who[name])).account, null, 'a person with a submit row sees their own record only');
    for (const cookie of [h.owner, t.finance]) {
      const people = (await h.get(['bank', 'people'].join('/'), cookie)).people, sam = people.find(p => p.email === t.memberEmail);
      assert.deepEqual([sam.status, sam.account.last4, sam.account.method], ['verified', '0000', 'instant']);
      assert.ok(!JSON.stringify(people).includes('token') && people.some(p => p.status === 'none'));
    }
    assert.equal((await h.get('bank', t.employee)).account.last4, '0000');

    // Delegates: whoever they act for, every bank handler refuses them with no write.
    await h.post(['settings', 'members'].join('/'), { email: 'owner@harbourfinch.example', name: 'Rose', employee: true });
    await h.post('delegates', { delegate: 'morgan@harbourfinch.example', level: 'full' }, t.employee);
    await h.post('delegates', { delegate: 'morgan@harbourfinch.example', level: 'full', grantor: 'owner@harbourfinch.example' });
    for (const grantor of [t.memberEmail, 'owner@harbourfinch.example']) {
      const acting = { 'x-coaster-acting-for': grantor };
      for (const path of ['bank', ['bank', 'people'].join('/'), ['bank', 'providers'].join('/')]) assert.equal((await h.send('/api/coaster/' + path, undefined, t.finance, acting)).status, 403, `${path} for ${grantor}`);
      for (const [path, body] of [[['bank', 'providers', 'connect'].join('/'), { provider: 'plaid' }], [['bank', 'start'].join('/'), { provider: 'plaid' }], [['bank', 'complete'].join('/'), { provider: 'plaid', publicToken: 'x', accountId: 'y' }], [['bank', 'verify'].join('/'), {}], [['bank', 'refresh'].join('/'), {}], [['bank', 'cancel'].join('/'), {}], [['bank', 'hold-period'].join('/'), { days: 4 }], [['bank', 'providers', 'disconnect'].join('/'), { provider: 'plaid' }]])
        assert.equal((await h.send('/api/coaster/' + path, body, t.finance, acting)).status, 403, `${path} for ${grantor}`);
    }
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_bank_accounts').first()).n, before);
    const key = await h.post('agent-keys', { label: 'Synthetic bank refusal' }, t.finance);
    assert.equal((await h.send('/api/coaster/bank', undefined, '', { authorization: `Bearer ${key.token}` })).status, 401, 'even a valid agent key reaches no native bank door');

    // Bank lines are as permanent as every other history line.
    const lines = await bankLines(h);
    for (const method of ['PUT', 'PATCH', 'DELETE']) assert.notEqual((await h.mf.dispatchFetch(h.origin + '/api/coaster/history/' + lines[0].id, { method, headers: { cookie: h.owner, origin: h.origin, 'content-type': ['application', 'json'].join('/') }, body: '{}' })).status, 200);
    await assert.rejects(h.db.prepare("UPDATE c_events SET action='changed' WHERE action LIKE 'bank-%'").run(), /history is permanent/);
    await assert.rejects(h.db.prepare("DELETE FROM c_events WHERE action LIKE 'bank-%'").run(), /history is permanent/);

    // A departed employee's bank token and last four go in the erasure; the history line stays under their opaque label.
    const departed = 'dana@harbourfinch.example', cookie = await h.person(departed, { employee: true }, 'priya@harbourfinch.example');
    await addInstant(h, edge, cookie, '4321');
    const sealed = (await h.db.prepare('SELECT token_sealed FROM c_bank_accounts WHERE member_email=?').bind(departed).first()).token_sealed;
    assert.ok((await everything(h)).includes(sealed));
    await h.post(['settings', 'members'].join('/'), { email: departed, name: 'Dana', employee: true, active: false });
    const erased = await h.post(['settings', 'members', 'erase'].join('/'), { email: departed });
    assert.equal(erased.removed.bankAccounts, 1);
    const after = await everything(h);
    assert.ok(!after.includes(sealed) && !after.includes(departed), 'neither the sealed token nor the address remains anywhere');
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM c_bank_accounts WHERE last4='4321'").first()).n, 0, 'nor the last four');
    const kept = (await bankLines(h)).find(l => l.action === 'bank-account-added' && l.actor_email === erased.retained.subject);
    assert.ok(kept, 'their history line stays under the opaque subject');
  } finally { await h.close(); }
});


test('Restored bank evidence can be replaced after explicit provider reconnection without the old installation secret', async () => {
  const edge = bankFixture();
  let h;
  try {
    h = await harness(options(edge));
    const employee = await h.person('synthetic-coaster-270@example.invalid', { employee: true });
    await connectBank(h, edge);
    await addInstant(h, edge, employee, '1234');
    await h.post(['bank', 'providers', 'disconnect'].join('/'), { provider: 'plaid' });
    await h.post(['bank', 'providers', 'disconnect'].join('/'), { provider: 'stripe' });
    const saved = await h.db.prepare('SELECT * FROM c_bank_accounts').first();
    await h.close(); h = undefined;
    h = await harness({ ...options(edge), bindings: { SESSION_SECRET: 'synthetic-coaster-restored-installation-secret' } });
    const restored = await h.person('synthetic-coaster-270@example.invalid', { employee: true });
    await h.db.prepare(`INSERT INTO c_bank_accounts(${Object.keys(saved).join(',')}) VALUES(${Object.keys(saved).map(() => '?').join(',')})`).bind(...Object.values(saved)).run();
    await h.post(['bank', 'start'].join('/'), { provider: 'plaid' }, restored, 409);
    await connectBank(h, edge);
    const changed = await addInstant(h, edge, restored, '5678');
    assert.deepEqual([changed.account.last4, changed.account.held, changed.notified], ['5678', true, 'accepted']);
    const old = await h.db.prepare("SELECT state,token_sealed FROM c_bank_accounts WHERE last4='1234'").first();
    assert.deepEqual(old, { state: 'replaced', token_sealed: null });
    assert.equal(h.messages.filter(m => /bank account was changed/.test(m.subject)).length, 1);
  } finally { await h?.close(); }
});

test('A committed bank replacement sends and records the previous-contact notice even if its native session is then revoked', async () => {
  const edge = bankFixture(); let h, revoke = false;
  h = await harness({ ...options(edge), d1Barrier: async () => {
    if (revoke) {
      revoke = false;
      await h.db.prepare("UPDATE oa_sessions SET revoked_at=? WHERE operator_id IN (SELECT id FROM oa_operators WHERE email=?)").bind(Date.now(), 'synthetic-coaster-271@example.invalid').run();
    }
    return new Response('ok');
  } });
  try {
    const employee = await h.person('synthetic-coaster-271@example.invalid', { employee: true });
    await connectBank(h, edge);
    await addInstant(h, edge, employee, '1234');
    revoke = true;
    const changed = await addInstant(h, edge, employee, '5678');
    assert.equal(changed.notified, 'accepted');
    assert.equal(changed.account.held, true);
    const notices = h.messages.filter(m => /bank account was changed/.test(m.subject));
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0].to, ['synthetic-coaster-271@example.invalid']);
    const history = await bankLines(h);
    assert.equal(history.at(-1).action, 'bank-notice-sent');
    assert.equal(history.at(-1).detail.status, 'accepted');
    await h.get('bank', employee, 401);
  } finally { await h.close(); }
});
