import assert from 'node:assert/strict';
import { plaidSetup, page } from './plaid-sync.mjs';
import { plaidTransaction } from './fixtures/plaid.mjs';

/** One first-month business flow: complete pages, partial database failure, explicit replay and exact custody. */
export async function largePlaidJourney() {
  const t = await plaidSetup(), { h, edge } = t;
  try {
    const financeAddress = ['synthetic-coaster-82000', 'example.test'].join('@');
    const finance = await h.person(financeAddress, { employee: true, finance: true });
    const connection = await t.connect(), base = `plaid/connections/${connection.id}`;
    await h.post(base + '/assign', { account: connection.accounts[0].id, employee: t.email, category: t.category });
    const purchases = Array.from({ length: 189 }, (_, index) => plaidTransaction({
      transaction_id: `synthetic-coaster-${80000 + index}`,
      merchant_name: ['Harbour Grocer', 'Cedar Hardware', 'Willow Books', 'Seaside Parking', 'Valley Stationery'][index % 5],
      amount: (350 + index * 13) / 100,
      date: `2026-10-${String(index % 28 + 1).padStart(2, '0')}`,
      authorized_date: `2026-10-${String(index % 28 + 1).padStart(2, '0')}`,
    }));
    const pending = plaidTransaction({ transaction_id: 'synthetic-coaster-80190', pending: true, amount: 19.75 });
    const posted = plaidTransaction({ transaction_id: 'synthetic-coaster-80191', pending_transaction_id: pending.transaction_id, amount: 20.25 });
    const cancelled = plaidTransaction({ transaction_id: 'synthetic-coaster-80192', amount: 81.25 });
    const pages = () => [
      page([...purchases.slice(0, 68), pending, cancelled], [], [], 'synthetic-coaster-large-1', true),
      page(purchases.slice(68, 135), [], [pending.transaction_id], 'synthetic-coaster-large-2', true),
      page([...purchases.slice(135), posted], [], [cancelled.transaction_id], 'synthetic-coaster-large-3'),
    ];
    const originalFetch = edge.fetch.bind(edge);
    let failPage = 2, seen = 0;
    edge.fetch = async request => {
      if (new URL(request.url).pathname === '/transactions/sync' && ++seen === failPage) return Response.json({ error_code: 'SYNTHETIC_COASTER_FAILURE' }, { status: 500 });
      return originalFetch(request);
    };
    edge.pages.push(...pages());
    await h.post(base + '/sync', {}, h.owner, 502);
    assert.equal(seen, 2, 'a later provider failure is never retried automatically');
    for (const table of ['c_plaid_transactions', 'c_plaid_sources', 'c_items', 'c_plaid_sync_state']) {
      assert.equal((await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 0, 'incomplete pages commit no financial facts or final cursor');
    }

    let revoke = true;
    edge.pages.splice(0, edge.pages.length, ...pages());
    edge.fetch = async request => {
      const response = await originalFetch(request);
      if (new URL(request.url).pathname === '/transactions/sync' && revoke) {
        revoke = false;
        await h.post('settings/members', { email: financeAddress, name: 'Synthetic Coaster finance', employee: true, finance: false, active: true });
      }
      return response;
    };
    const beforeRevoked = edge.calls.filter(c => c.path === '/transactions/sync').length;
    await h.post(base + '/sync', {}, finance, 409);
    assert.equal(edge.calls.filter(c => c.path === '/transactions/sync').length - beforeRevoked, 1, 'current revoked authority refuses the next physical request');
    for (const table of ['c_plaid_transactions', 'c_plaid_sources', 'c_items', 'c_plaid_sync_state']) assert.equal((await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 0);
    edge.fetch = originalFetch;

    // Fault only the real SQLite edge after one complete financial batch is durable.
    await h.db.prepare(`CREATE TRIGGER synthetic_coaster_interrupt BEFORE INSERT ON c_plaid_sources
      WHEN NEW.transaction_id='synthetic-coaster-80025' BEGIN SELECT RAISE(ABORT,'Synthetic Coaster interrupted financial batch'); END`).run();
    edge.pages.splice(0, edge.pages.length, ...pages());
    await h.post(base + '/sync', {}, h.owner, 503);
    const interrupted = await h.db.prepare('SELECT * FROM c_plaid_sync_state WHERE connection_id=?').bind(connection.id).first();
    assert.equal(interrupted.cursor, ''); assert.equal(interrupted.in_progress, 1);
    assert.equal(interrupted.attempt_id, null);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_plaid_sources').first()).n, 25);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_items').first()).n, 25);
    const partial=(await h.get('state',t.employee)).claims[0];
    const held=await h.post(`claims/${partial.id}/submit`,{version:partial.version},t.employee,409);assert.match(held.error,/Plaid.*reconciliation/,'partial financial imports cannot submit while their starting cursor is incomplete');
    await h.db.prepare('DROP TRIGGER synthetic_coaster_interrupt').run();

    edge.pages.splice(0, edge.pages.length, ...pages());
    assert.equal((await h.post(base + '/sync', {})).expenses, 165, 'explicit replay reuses the first durable batch');
    const expected = Array.from({ length: 189 }, (_, index) => [`synthetic-coaster-${80000 + index}`, 350 + index * 13]);
    expected.push(['synthetic-coaster-80191', 2025]);
    const actual = (await h.db.prepare(`SELECT t.transaction_id,i.amount_minor FROM c_plaid_transactions t
      JOIN c_items i ON i.id=t.item_id WHERE t.connection_id=? ORDER BY t.transaction_id`).bind(connection.id).all()).results;
    assert.deepEqual(actual.map(row => [row.transaction_id, row.amount_minor]), expected);
    const sources = (await h.db.prepare('SELECT transaction_id,bytes FROM c_plaid_sources ORDER BY transaction_id').all()).results;
    assert.deepEqual(sources.map(row => row.transaction_id), expected.map(row => row[0]));
    assert.deepEqual(sources.map(row => JSON.parse(Buffer.from(row.bytes).toString('utf8')).amount_minor), expected.map(row => row[1]));
    const details = await Promise.all((await h.get('state', t.employee)).claims.map(claim => h.get(`claims/${claim.id}`, t.employee)));
    assert.equal(details.reduce((sum, detail) => sum + detail.items.length, 0), 190);
    assert.ok(details.every(detail => detail.items.length <= 100 && detail.claim.total_minor === 0));
    assert.ok(details.flatMap(detail => detail.items).every(item => item.card_charge_id && item.receipt_id === null));
    const facts = (await h.get(base + '/transactions')).transactions;
    assert.equal(facts.find(row => row.transaction_id === pending.transaction_id).status, 'removed');
    assert.equal(facts.find(row => row.transaction_id === cancelled.transaction_id).status, 'removed');
    const complete = await h.db.prepare('SELECT * FROM c_plaid_sync_state WHERE connection_id=?').bind(connection.id).first();
    assert.equal(complete.cursor, 'synthetic-coaster-large-3'); assert.equal(complete.in_progress, 0);
    edge.pages.push(...pages());
    assert.equal((await h.post(base + '/sync', {})).expenses, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_items').first()).n, 190);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_plaid_sources').first()).n, 190);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_card_charges').first()).n, 190);
  } finally { await h.close(); }
}
