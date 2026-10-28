// Real CLI export and restore proof for native entities, submitted evidence and consolidated reports.
import assert from 'node:assert/strict';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fresh, command } from './browser-runtime.mjs';
import { records, rows, tampered } from './browser-archive.mjs';
import { harness } from './harness.mjs';
import { entityScenario, entityRates } from './entity-kit.mjs';

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/entity-proof');
const tableRows = (archive, table) => rows(archive).filter(item => item.kind === 'row' && item.table === table).map(item => item.row);
const tables = ['c_entities', 'c_entity_members', 'c_categories', 'c_policies', 'c_policy_configurations',
  'c_approval_workflows', 'c_claims', 'c_revisions', 'c_entity_reports', 'c_batches', 'c_batch_claims'];
const roots = [];
let h;
try {
  await mkdir(evidence, { recursive: true });
  const source = await fresh(); roots.push(source);
  const destination = await fresh(); roots.push(destination);
  for (const root of roots) await command(root, ['install']);
  h = await harness({ fxRates:entityRates,persistencePath: join(source, '.wrangler/state/v3'), databaseId: 'local-foundation-only' });
  await entityScenario(h);
  const expected = {};
  for (const table of tables) expected[table] = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
  assert.ok(expected.c_claims.some(claim => claim.entity_id === 'primary' && claim.currency === 'USD'));
  assert.ok(expected.c_claims.some(claim => claim.entity_id !== 'primary' && claim.currency === 'CAD'));
  assert.ok(expected.c_revisions.some(revision => JSON.parse(revision.snapshot).entity?.id !== 'primary'
    && JSON.parse(revision.snapshot).entity?.currency === 'CAD'), 'a submitted Canadian revision carries frozen entity evidence');
  assert.ok(expected.c_entity_reports.length > 0, 'the public reporting door persisted a consolidated report');
  await h.close(); h = undefined;

  await command(source, ['export', '--output', 'exports/entities.rer']);
  const archive = join(source, 'exports/entities.rer'), exported = await records(archive);
  const byIdentity = values => [...values].sort((a, b) => JSON.stringify(a,Object.keys(a).sort()).localeCompare(JSON.stringify(b,Object.keys(b).sort())));
  for (const table of tables) assert.deepEqual(byIdentity(tableRows(exported, table)), byIdentity(expected[table]), `${table} exports exact native rows`);

  await command(destination, ['export', '--output', 'exports/empty-before.rer']);
  const empty = rows(await records(join(destination, 'exports/empty-before.rer')));
  // Re-seal every archive hash: the staged entity validator must catch this ownership change.
  const invalid = await tampered(archive, 'c_claims', row => { row.entity_id = 'primary'; }, row => row.entity_id !== 'primary');
  await writeFile(join(destination, 'exports/cross-entity.rer'), invalid, { mode: 0o600 });
  assert.match(await command(destination, ['import', '--input', 'exports/cross-entity.rer', '--yes'], { expected: 4 }), /coaster_entity/);
  await command(destination, ['export', '--output', 'exports/empty-after.rer']);
  assert.deepEqual(rows(await records(join(destination, 'exports/empty-after.rer'))), empty, 'refused entity ownership writes no portable row or object');

  await copyFile(archive, join(destination, 'exports/entities.rer'));
  await command(destination, ['import', '--input', 'exports/entities.rer', '--yes']);
  await command(destination, ['export', '--output', 'exports/entities-restored.rer']);
  const restoredPath = join(destination, 'exports/entities-restored.rer'), restored = await records(restoredPath);
  assert.deepEqual(rows(restored), rows(exported), 'every portable row and receipt object survives restore unchanged');
  for (const table of tables) assert.deepEqual(tableRows(restored, table), tableRows(exported, table), `${table} survives restore exactly`);

  h = await harness({ existingDatabase: true, persistencePath: join(destination, '.wrangler/state/v3'), databaseId: 'local-foundation-only' });
  for (const report of expected.c_entity_reports) assert.deepEqual(await h.get(`spend/consolidated/${report.id}`), JSON.parse(report.snapshot), 'restored report is readable through its native public door');
  await h.close(); h = undefined;
  await copyFile(archive, join(evidence, 'entities.rer'));
  await copyFile(restoredPath, join(evidence, 'entities-restored.rer'));
  console.log('Native entities real CLI archive round trip and staged ownership refusal passed');
} finally {
  await h?.close();
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
}
