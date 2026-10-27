// Real CLI export and restore over the exact D1 state written by the production Worker.
// Run through the owning heavy slot after committing the candidate: node tests/payroll-archive.mjs
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fresh, command } from './browser-runtime.mjs';
import { records, rows, tampered } from './browser-archive.mjs';
import { harness } from './harness.mjs';
import { gustoFixture } from './fixtures/payroll.mjs';
import { payrollBatch, connectFixture } from './payroll-kit.mjs';

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/payroll-proof');
await mkdir(evidence, { recursive: true });
const tableRows = (archive, table) => rows(archive).filter(item => item.table === table).map(item => item.row);
const numbered = events => [...events].sort((a, b) => a.seq - b.seq);

async function roundTrip(stage) {
  const roots = [];
  let h;
  try {
    const [source, destination] = await Promise.all([fresh(), fresh()]);
    roots.push(source, destination);
    for(const root of roots){
      await promisify(execFile)('git',['config','user.name','Run Edit Run fleet'],{cwd:root});
      await promisify(execFile)('git',['config','user.email','synthetic-coaster-130'],{cwd:root});
    }
    await Promise.all(roots.map(root => command(root, ['install'])));
    const edge = gustoFixture();
    // portability-worker.mjs uses getPlatformProxy with this versioned directory;
    // wrangler.jsonc declares the same local D1 identifier. Dispose before CLI access.
    h = await harness({ persistencePath: join(source, '.wrangler/state/v3'), databaseId: 'local-foundation-only', gustoEdge: request => edge.fetch(request) });
    const t = await payrollBatch(h);
    await connectFixture(h, edge, t.memberEmail);
    const batch = await h.post(`batches/${t.batch.id}/release`, { version: t.batch.version });
    const path = `batches/${batch.id}/payroll`;
    await h.post(path, { version: batch.version, payroll: edge.payrollId, consent: true });
    assert.equal((await h.get(path)).handoff.status, 'sent');
    assert.equal((await h.post(path + '/confirm', {})).confirmed, false);
    if (stage === 'confirmed') {
      edge.payroll = { ...edge.payroll, processed: true, processing_request: { status: 'submit_success' } };
      assert.equal((await h.post(path + '/confirm', {})).confirmed, true);
    }
    const handoff = await h.db.prepare('SELECT * FROM c_payroll_handoffs WHERE batch_id=?').bind(batch.id).first();
    const history = (await h.db.prepare('SELECT * FROM c_events ORDER BY seq').all()).results;
    const connection = await h.db.prepare('SELECT token_sealed FROM c_gusto_connection WHERE id=1').first();
    assert.equal(handoff.status, stage);
    assert.ok(history.length && history.every((event, i) => Number.isSafeInteger(event.seq) && event.seq > 0 && (!i || event.seq > history[i - 1].seq)), 'native actions have strictly numbered history');
    assert.equal(edge.writes.length, 1, 'preparation and confirmation do not duplicate the provider write');
    await h.close(); h = undefined;

    await command(source, ['export', '--output', 'exports/payroll.rer']);
    const archive = join(source, 'exports/payroll.rer'), exported = await records(archive);
    assert.deepEqual(tableRows(exported, 'c_payroll_handoffs'), [handoff], 'CLI exports the exact native financial handoff, including its pending state and expected provider lines');
    assert.deepEqual(numbered(tableRows(exported, 'c_events')), history, 'CLI exports every numbered native history line unchanged');
    assert.equal(tableRows(exported, 'c_batches').find(row => row.id === batch.id).status, stage === 'confirmed' ? 'reimbursed' : 'approved');
    for (const claim of tableRows(exported, 'c_claims').filter(row => t.claims.includes(row.id))) assert.equal(claim.status, stage === 'confirmed' ? 'reimbursed' : 'batched');
    for (const table of ['c_gusto_connection', 'c_gusto_employees']) {
      assert.equal(tableRows(exported, table).length, 0, 'connection credentials and employee mappings are excluded');
      assert.ok(!exported[0].tables.some(entry => entry.name === table), 'excluded payroll authority has no restore schema');
    }
    const encoded = JSON.stringify(exported);
    assert.ok(!encoded.includes('synthetic-coaster-120') && !encoded.includes(connection.token_sealed), 'neither plain nor sealed connection token travels');

    await command(destination, ['export', '--output', 'exports/empty-before.rer']);
    const empty = rows(await records(join(destination, 'exports/empty-before.rer')));
    const invalid = stage === 'sent'
      ? await tampered(archive, 'c_payroll_handoffs', row => { const lines = JSON.parse(row.lines); lines[0].reimbursementMinor += 1; row.lines = JSON.stringify(lines); })
      : await tampered(archive, 'c_payroll_handoffs', row => { row.payroll_uuid = 'synthetic-coaster-999'; });
    await writeFile(join(destination, 'exports/invalid-payroll.rer'), invalid, { mode: 0o600 });
    const refusal = await command(destination, ['import', '--input', 'exports/invalid-payroll.rer', '--yes'], { expected: 4 });
    assert.match(refusal, /coaster_payroll/, 'the real staged payroll validator refuses a re-sealed inconsistent handoff');
    await command(destination, ['export', '--output', 'exports/empty-after.rer']);
    assert.deepEqual(rows(await records(join(destination, 'exports/empty-after.rer'))), empty, 'refused payroll archive writes no portable destination data');

    await copyFile(archive, join(destination, 'exports/payroll.rer'));
    await command(destination, ['import', '--input', 'exports/payroll.rer', '--yes']);
    await command(destination, ['export', '--output', 'exports/restored-payroll.rer']);
    const restored = await records(join(destination, 'exports/restored-payroll.rer'));
    assert.deepEqual(rows(restored), rows(exported), 'every portable row survives the real CLI export → import → export unchanged');
    assert.deepEqual(numbered(tableRows(restored, 'c_events')), history, 'exact history sequence, provenance and details survive restore');
    assert.deepEqual(tableRows(restored, 'c_payroll_handoffs'), [handoff], `${stage} financial evidence survives without provider authority`);
    h = await harness({persistencePath:join(destination,'.wrangler/state/v3'),databaseId:'local-foundation-only',initialized:true,gustoEdge:request=>edge.fetch(request)});
    const beforeExecution=await h.db.prepare('SELECT * FROM c_payroll_handoffs').first();
    const calls=h.outbound.length;
    await h.post(path,{version:batch.version,payroll:edge.payrollId,consent:true},h.owner,409);
    await h.post(path+'/confirm',{},h.owner,409);
    assert.equal(h.outbound.length,calls,'restored evidence cannot contact the provider without a newly authorized connection');
    assert.deepEqual(await h.db.prepare('SELECT * FROM c_payroll_handoffs').first(),beforeExecution,'refused restored HTTP execution preserves the exact financial evidence');
    assert.equal((await h.get(['payroll','gusto'].join('/'))).connection,null);
    await h.close();h=undefined;
    await Promise.all([
      copyFile(archive, join(evidence, `payroll-${stage}.rer`)),
      copyFile(join(destination, 'exports/restored-payroll.rer'), join(evidence, `payroll-${stage}-restored.rer`)),
    ]);
    console.log(`Payroll ${stage} real CLI archive round trip passed`);
  } finally {
    await h?.close();
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  }
}

for (const stage of ['sent', 'confirmed']) await roundTrip(stage);
