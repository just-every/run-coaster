// Real CLI export and restore over the exact D1 state written by the production Worker, for PAY-002's bank details: a sealed provider
// token and the last four travel, nothing that could ask a provider for anything does, history is identical after restore, and an erasure
// removes the token from the next archive. Run through the owning heavy slot after committing the candidate: node tests/bank-archive.mjs
import assert from 'node:assert/strict';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fresh, command } from './browser-runtime.mjs';
import { records, rows, tampered } from './browser-archive.mjs';
import { harness } from './harness.mjs';
import { addInstant, addMicrodeposits, bankFixture, BANK_NUMBERS, connectBank } from './fixtures/bank.mjs';

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/bank-proof');
await mkdir(evidence, { recursive: true });
const tableRows = (archive, table) => rows(archive).filter(item => item.table === table).map(item => item.row);
const numbered = events => [...events].sort((a, b) => a.seq - b.seq);

async function roundTrip(stage) {
  const roots = [];
  let h;
  try {
    const [source, destination] = await Promise.all([fresh(), fresh()]);
    roots.push(source, destination);
    await Promise.all(roots.map(root => command(root, ['install'])));
    const edge = bankFixture();
    h = await harness({ persistencePath: join(source, '.wrangler/state/v3'), databaseId: 'local-foundation-only', plaidEdge: request => edge.fetch(request), stripeEdge: request => edge.fetch(request) });
    const people = {};
    for (const name of ['sam', 'morgan', 'dana']) people[name] = await h.person(`${name}@harbourfinch.example`, { employee: true, ...(name === 'morgan' ? { finance: true } : {}) });
    await connectBank(h, edge);
    await addInstant(h, edge, people.sam, '0000');
    await addInstant(h, edge, people.sam, '1111');
    const pending = await addMicrodeposits(h, edge, people.morgan, '6789');
    await h.post('bank/verify', { id: pending.account.id, amounts: [32, 45] }, people.morgan);
    await addInstant(h, edge, people.dana, '4321');
    const departed = await h.db.prepare('SELECT token_sealed FROM c_bank_accounts WHERE member_email=?').bind('dana@harbourfinch.example').first();
    if (stage === 'erased') {
      await h.post('settings/members', { email: 'dana@harbourfinch.example', name: 'dana', employee: true, active: false });
      await h.post('settings/members/erase', { email: 'dana@harbourfinch.example' });
    }
    const accounts = (await h.db.prepare('SELECT * FROM c_bank_accounts ORDER BY id').all()).results;
    const history = (await h.db.prepare('SELECT * FROM c_events ORDER BY seq').all()).results;
    assert.deepEqual(accounts.map(a => a.state).sort(), stage === 'erased' ? ['active', 'active', 'replaced'] : ['active', 'active', 'active', 'replaced']);
    await h.close(); h = undefined;

    await command(source, ['export', '--output', 'exports/bank.rer']);
    const archive = join(source, 'exports/bank.rer'), exported = await records(archive), encoded = JSON.stringify(exported);
    assert.deepEqual(tableRows(exported, 'c_bank_accounts').sort((a, b) => a.id < b.id ? -1 : 1), accounts, 'CLI exports the exact bank rows');
    assert.deepEqual(numbered(tableRows(exported, 'c_events')), history, 'CLI exports every numbered history line unchanged');
    assert.equal(tableRows(exported, 'c_bank_providers').length, 0, 'provider credentials are excluded');
    assert.ok(!exported[0].tables.some(entry => entry.name === 'c_bank_providers'), 'excluded provider credentials have no restore schema');
    for (const secret of [...BANK_NUMBERS, edge.secret, edge.stripeKey, 'synthetic-coaster-access', 'synthetic-coaster-pm']) assert.ok(!encoded.includes(secret), `${secret} is not in the archive`);
    for (const account of tableRows(exported, 'c_bank_accounts')) {
      assert.ok(/^\d{4}$/.test(account.last4) && (account.state === 'replaced' ? account.token_sealed === null : /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(account.token_sealed)), 'only a sealed token and the last four');
    }
    if (stage === 'erased') {
      assert.ok(!encoded.includes(departed.token_sealed) && !encoded.includes('dana@harbourfinch.example'), 'the erased person’s token and address are gone from the next archive');
      assert.ok(!tableRows(exported, 'c_bank_accounts').some(a => a.last4 === '4321'));
    } else assert.ok(encoded.includes(departed.token_sealed), 'before the erasure the sealed token travels');

    await command(destination, ['export', '--output', 'exports/empty-before.rer']);
    const empty = rows(await records(join(destination, 'exports/empty-before.rer')));
    const invalid = await tampered(archive, 'c_bank_accounts', row => { row.last4 = '12ab'; }, row => row.state === 'active');
    await writeFile(join(destination, 'exports/invalid-bank.rer'), invalid, { mode: 0o600 });
    assert.match(await command(destination, ['import', '--input', 'exports/invalid-bank.rer', '--yes'], { expected: 4 }), /coaster_bank|last4|CHECK/, 'a re-sealed archive with a bad last four is refused');
    const forged = await tampered(archive, 'c_bank_accounts', row => { row.state = 'active'; }, row => row.state === 'replaced');
    await writeFile(join(destination, 'exports/forged-bank.rer'), forged, { mode: 0o600 });
    await command(destination, ['import', '--input', 'exports/forged-bank.rer', '--yes'], { expected: 4 });
    await command(destination, ['export', '--output', 'exports/empty-after.rer']);
    assert.deepEqual(rows(await records(join(destination, 'exports/empty-after.rer'))), empty, 'refused bank archives write no portable data');

    await copyFile(archive, join(destination, 'exports/bank.rer'));
    await command(destination, ['import', '--input', 'exports/bank.rer', '--yes']);
    await command(destination, ['export', '--output', 'exports/restored-bank.rer']);
    const restored = await records(join(destination, 'exports/restored-bank.rer'));
    assert.deepEqual(rows(restored), rows(exported), 'every portable row survives export, import and export unchanged');
    assert.deepEqual(numbered(tableRows(restored, 'c_events')), history, 'exact bank history lines survive restore in order');
    assert.deepEqual(tableRows(restored, 'c_bank_accounts'), tableRows(exported, 'c_bank_accounts'), 'accounts and holds are identical after restore');
    await Promise.all([copyFile(archive, join(evidence, `bank-${stage}.rer`)), copyFile(join(destination, 'exports/restored-bank.rer'), join(evidence, `bank-${stage}-restored.rer`))]);
    console.log(`Bank ${stage} real CLI archive round trip passed`);
  } finally {
    await h?.close();
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  }
}

for (const stage of ['present', 'erased']) await roundTrip(stage);
