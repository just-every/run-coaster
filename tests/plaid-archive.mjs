// Real CLI export and restore of financial facts written through the production Plaid API.
// Run after committing the candidate, through the owning heavy slot: node tests/plaid-archive.mjs
import assert from 'node:assert/strict';
import { copyFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fresh, command } from './browser-runtime.mjs';
import { records, rows, tampered } from './browser-archive.mjs';
import { harness } from './harness.mjs';
import { plaidTransaction, plaidConfig } from './fixtures/plaid.mjs';
import { plaidSetup, page } from './plaid-sync.mjs';

const tableRows = (archive, table) => rows(archive).filter(item => item.table === table).map(item => item.row);
const orderKey = row => JSON.stringify(Object.keys(row).sort().map(key => [key,row[key]]));
const ordered = values => [...values].sort((left,right)=>orderKey(left).localeCompare(orderKey(right)));
const numbered = events => [...events].sort((left, right) => left.seq - right.seq);
const financialTables = ['c_plaid_sync_state', 'c_plaid_assignments', 'c_plaid_transactions', 'c_plaid_changes', 'c_plaid_sources', 'c_plaid_costs', 'c_card_charges', 'c_card_charge_aliases', 'c_claims', 'c_items', 'c_allocations'];
const roots = [];
let h;
try {
  roots.push(...await Promise.all([fresh(), fresh()]));
  const [source, destination] = roots;
  await Promise.all(roots.map(root => command(root, ['install'])));
  const t = await plaidSetup({ persistencePath: join(source, '.wrangler/state/v3'), databaseId: 'local-foundation-only' });
  h = t.h;
  const { edge } = t, company = await t.connect(), personal = await t.connect('personal', t.employee, 'synthetic-coaster-401');
  const companyPath = `plaid/connections/${company.id}`, personalPath = `plaid/connections/${personal.id}`;
  await h.post(companyPath + '/assign', { account: company.accounts[0].id, employee: t.email, category: t.category });
  await h.post(personalPath + '/assign', { account: personal.accounts[0].id, employee: t.email, category: t.category }, t.employee);

  const posted = plaidTransaction({ transaction_id: 'synthetic-coaster-402' });
  const pending = plaidTransaction({ transaction_id: 'synthetic-coaster-403', merchant_name: 'Synthetic Coaster Supplies', pending: true, amount: 17.25 });
  const credit = plaidTransaction({ transaction_id: 'synthetic-coaster-404', amount: -3 });
  edge.pages.push(page([posted, pending, credit]));
  assert.equal((await h.post(companyPath + '/sync', {})).expenses, 1);
  let transactions = (await h.get(companyPath + '/transactions')).transactions;
  assert.equal(transactions.find(row => row.transaction_id === pending.transaction_id).status, 'pending');
  const companyItem = transactions.find(row => row.transaction_id === posted.transaction_id).item_id;
  let item = await h.db.prepare('SELECT * FROM c_items WHERE id=?').bind(companyItem).first();
  assert.ok(item.card_charge_id);
  assert.equal((await h.get(`claims/${item.claim_id}`, t.employee)).claim.total_minor, 0, 'company purchases never reimburse the cardholder');
  const posting = { ...pending, transaction_id: 'synthetic-coaster-405', pending_transaction_id: pending.transaction_id, pending: false };
  edge.pages.push(page([], [], [pending.transaction_id], 'synthetic-coaster-cursor-2', true), page([posting], [], [], 'synthetic-coaster-cursor-3'));
  assert.equal((await h.post(companyPath + '/sync', {})).expenses, 1);
  const purchase = plaidTransaction({ transaction_id: 'synthetic-coaster-406', amount: 11.75, merchant_name: 'Synthetic Coaster Travel' });
  edge.pages.push(page([purchase]));
  assert.equal((await h.post(personalPath + '/sync', {}, t.employee)).expenses, 1);
  const personalTransaction = (await h.get(personalPath + '/transactions', t.employee)).transactions[0];
  item = await h.db.prepare('SELECT * FROM c_items WHERE id=?').bind(personalTransaction.item_id).first();
  assert.equal(item.card_charge_id, null);
  assert.equal(item.amount_minor, 1175);
  assert.equal((await h.get(`claims/${item.claim_id}`, t.employee)).claim.total_minor, 1175, 'only the native personal purchase is reimbursable');
  const beforeReplay = (await h.db.prepare('SELECT * FROM c_items ORDER BY id').all()).results;
  for (const [path, cookie, added, cursor] of [[companyPath, h.owner, [posted, posting], 'synthetic-coaster-cursor-3'], [personalPath, t.employee, [purchase], 'synthetic-coaster-cursor-1']]) {
    edge.pages.push(page(added, [], [], cursor));
    assert.equal((await h.post(path + '/sync', {}, cookie)).expenses, 0);
  }
  assert.deepEqual((await h.db.prepare('SELECT * FROM c_items ORDER BY id').all()).results, beforeReplay, 'replayed provider pages create no second financial expense');
  edge.pages.push(page([], [{ ...posted, amount: posted.amount + 1 }], [], 'synthetic-coaster-cursor-4'));
  await h.post(companyPath + '/sync', {});
  transactions = (await h.get(companyPath + '/transactions')).transactions;
  assert.equal(transactions.find(row => row.transaction_id === posted.transaction_id).status, 'review');
  assert.deepEqual((await h.db.prepare('SELECT * FROM c_items ORDER BY id').all()).results, beforeReplay, 'provider corrections preserve the original expense facts');

  const snapshot = new Map(await Promise.all(financialTables.map(async table => {
    const result = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
    return [table, ordered(result.map(row => table === 'c_plaid_sources' ? { ...row, bytes: { blob: Buffer.from(row.bytes).toString('base64') } } : row))];
  })));
  assert.equal(snapshot.get('c_plaid_sources').length, 3, 'only posted original expenses retain a financial source');
  const history = (await h.db.prepare('SELECT * FROM c_events ORDER BY seq').all()).results;
  const syncHistory = (await h.get('history')).lines.filter(event => event.action === 'plaid-synced');
  assert.ok(syncHistory.length && syncHistory.every((event, index) => event.actor_email && event.channel === 'app' && event.at && (!index || event.seq > syncHistory[index - 1].seq)));
  const custody = (await h.db.prepare('SELECT credentials_sealed FROM c_plaid_connections').all()).results.map(row => row.credentials_sealed);
  await h.close(); h = undefined;

  await command(source, ['export', '--output', 'exports/plaid.rer']);
  const archive = join(source, 'exports/plaid.rer'), exported = await records(archive);
  for (const [table, expected] of snapshot) assert.deepEqual(ordered(tableRows(exported, table)), expected, `CLI exports exact native ${table} financial records`);
  assert.deepEqual(numbered(tableRows(exported, 'c_events')), history, 'numbered native provenance and history export unchanged');
  const encoded = JSON.stringify(exported);
  for (const secret of [plaidConfig.secret, ...custody, 'synthetic-coaster-access-']) assert.ok(!encoded.includes(secret), 'Plaid execution custody stays in the original installation');
  for (const table of ['c_plaid_settings', 'c_plaid_links', 'c_plaid_connections', 'c_card_sources']) assert.equal(tableRows(exported, table).length, 0, 'execution tables and derived views have no portable data');
  for (const source of tableRows(exported, 'c_plaid_sources')) assert.ok(!Buffer.from(source.bytes.blob, 'base64').toString('utf8').includes(t.email), 'original provider facts exclude employee identity');

  await command(destination, ['export', '--output', 'exports/empty-before.rer']);
  const empty = rows(await records(join(destination, 'exports/empty-before.rer')));
  const corrupted = await tampered(archive, 'c_plaid_sources', row => {
    const value = JSON.parse(Buffer.from(row.bytes.blob, 'base64').toString('utf8'));
    value.amount_minor += 1;
    row.bytes = { blob: Buffer.from(JSON.stringify(value)).toString('base64') };
  });
  await writeFile(join(destination, 'exports/invalid-plaid.rer'), corrupted, { mode: 0o600 });
  const refusal = await command(destination, ['import', '--input', 'exports/invalid-plaid.rer', '--yes'], { expected: 4 });
  assert.match(refusal, /coaster_plaid_source_bytes/, 'staged validation detects corrupt original bytes after archive transport hashes are re-sealed');
  await command(destination, ['export', '--output', 'exports/empty-after.rer']);
  assert.deepEqual(rows(await records(join(destination, 'exports/empty-after.rer'))), empty, 'a refused archive writes no destination financial data');

  await copyFile(archive, join(destination, 'exports/plaid.rer'));
  await command(destination, ['import', '--input', 'exports/plaid.rer', '--yes']);
  await command(destination, ['export', '--output', 'exports/restored-plaid.rer']);
  const restored = await records(join(destination, 'exports/restored-plaid.rer'));
  assert.deepEqual(rows(restored), rows(exported), 'all financial records round trip through the real CLI byte for byte');
  assert.deepEqual(numbered(tableRows(restored, 'c_events')), history, 'restoration preserves exact numbered history');
  for (const [table, expected] of snapshot) assert.deepEqual(ordered(tableRows(restored, table)), expected, `restore preserves ${table}, including original costs and provider revisions`);
  h = await harness({ existingDatabase: true, persistencePath: join(destination, '.wrangler/state/v3'), databaseId: 'local-foundation-only', plaidEdge: request => edge.fetch(request) });
  assert.deepEqual((await h.get('plaid/connections')).connections, []);
  assert.equal((await h.get('plaid/settings')).configured, false);
  assert.deepEqual((await h.get('history')).lines.filter(event => event.action === 'plaid-synced'), syncHistory, 'the native history door retains every original sync line');
  const requests = edge.calls.length;
  for (const connection of [company, personal]) await h.post(`plaid/connections/${connection.id}/sync`, {}, h.owner, 404);
  assert.equal(edge.calls.length, requests, 'restored cursor and financial history authorize zero provider calls');
  console.log('Plaid native financial export and restore passed with preserved originals, numbered sync history and inert restored authority');
} finally {
  await h?.close();
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
}
