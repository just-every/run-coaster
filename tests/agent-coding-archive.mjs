// Real CLI export and restore of employee-confirmed coding and its numbered agent attribution.
import assert from 'node:assert/strict';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { harness } from './harness.mjs';
import { fresh, command } from './browser-runtime.mjs';
import { records, rows } from './browser-archive.mjs';
import { codingCorpus, confirm } from './agent-coding-fixture.mjs';

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/agent-coding-proof');
const roots = []; let h;
try {
  await mkdir(evidence, { recursive: true });
  const source = await fresh(), destination = await fresh(); roots.push(source, destination);
  await Promise.all(roots.map(root => command(root, ['install'])));
  h = await harness({ persistencePath: join(source, '.wrangler/state/v3'), databaseId: 'local-foundation-only' });
  const result = await codingCorpus(h);
  const events = (await h.db.prepare('SELECT * FROM c_events ORDER BY seq').all()).results;
  const applied = events.filter(e => e.action === 'agent-coding-applied');
  assert.ok(applied.length > 0);
  assert.ok(applied.every(e => Number.isInteger(e.seq) && e.actor_email === result.t.samEmail && JSON.parse(e.detail).agent === 'Expense preparation agent' && JSON.parse(e.detail).changes.length));
  for (const event of applied) {
    for (const method of ['PUT', 'DELETE']) {
      const response = await h.mf.dispatchFetch(`${h.origin}/api/coaster/history/${event.id}`, { method, headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/json' }, ...(method === 'PUT' ? { body: JSON.stringify({ action: 'changed' }) } : {}) });
      assert.equal(response.status, 404);
    }
    await assert.rejects(h.db.prepare('UPDATE c_events SET action=? WHERE id=?').bind('changed', event.id).run(), /permanent|immutable|history/i);
    await assert.rejects(h.db.prepare('DELETE FROM c_events WHERE id=?').bind(event.id).run(), /permanent|immutable|history/i);
  }
  assert.deepEqual((await h.db.prepare('SELECT * FROM c_events ORDER BY seq').all()).results, events);
  await h.close(); h = undefined;
  await command(source, ['export', '--output', './exports/agent-coding.rer']);
  const archive = join(source, 'exports/agent-coding.rer'), exported = await records(archive);
  const tableRows = (input, table) => rows(input).filter(r => r.table === table).map(r => r.row);
  assert.deepEqual(tableRows(exported, 'c_events').sort((a, b) => a.seq - b.seq), events);
  await mkdir(join(destination, 'exports'), { recursive: true });
  await copyFile(archive, join(destination, 'exports/agent-coding.rer'));
  await command(destination, ['import', '--input', './exports/agent-coding.rer', '--yes']);
  await command(destination, ['export', '--output', './exports/agent-coding-restored.rer']);
  const restored = await records(join(destination, 'exports/agent-coding-restored.rer'));
  assert.deepEqual(rows(restored), rows(exported), 'all source facts, originals, allocations, dimensions, contexts, proposals and history restore exactly');
  h = await harness({ existingDatabase: true, persistencePath: join(destination, '.wrangler/state/v3'), databaseId: 'local-foundation-only' });
  const cookie = await h.person(result.t.samEmail, { employee: true }, result.t.managerEmail);
  for (const proposal of result.proposals) await confirm(h, cookie, proposal, 409);
  assert.deepEqual((await h.db.prepare('SELECT * FROM c_events WHERE action=? ORDER BY seq').bind('agent-coding-applied').all()).results, applied, 'restored confirmations cannot be replayed');
  await copyFile(archive, join(evidence, 'agent-coding.rer'));
  console.log(JSON.stringify({ ...result.summary, numberedAgentHistory: applied.length, editDeleteRefused: true, exactCliRestore: true, restoredReplayRefused: true }));
} finally { await h?.close(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); }
