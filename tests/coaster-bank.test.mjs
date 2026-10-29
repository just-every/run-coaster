
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
    // Reconnect, replace the bank, notify the existing contact and hold money
    // until the configured cooling-off period expires.
    edge.fetch=fetch_;
    await h.post('bank/providers/connect',{provider:'plaid',clientId:edge.clientId,secret:edge.secret,consent:true});
    await h.post('bank/hold-period',{days:3},t.finance);
    const sent=h.messages.length,changed=await addInstant(h,edge,t.employee,'1111');
    assert.equal(changed.account.held,true);
    assert.ok(h.messages.slice(sent).some(m=>m.to.includes(t.memberEmail)&&m.text.includes('1111')&&m.text.includes('0000')));
    await h.post(`batches/${t.batch.id}/release`,{version:t.batch.version},h.owner,409);
    assert.equal((await h.get(`batches/${t.batch.id}`)).batch.released_at,null);
    await (await h.mf.getWorker()).scheduled({scheduledTime:new Date(Date.parse(changed.account.holdUntil)+86400000),cron:'17 * * * *'});
    assert.equal((await h.get('bank',t.employee)).account.held,false);
    assert.ok((await bankLines(h)).some(l=>l.action==='bank-hold-released'));
  } finally { await h.close(); }
});
