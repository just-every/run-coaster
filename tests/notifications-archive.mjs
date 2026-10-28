// NOTIFY-001: the real CLI preserves pending mail and durable delivery identities across installations.
// Run after committing the candidate, through the owning heavy slot: node tests/notifications-archive.mjs
import assert from 'node:assert/strict';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fresh, command } from './browser-runtime.mjs';
import { records, rows, tampered } from './browser-archive.mjs';
import { agency, harness } from './harness.mjs';

const tables = ['c_notification_preferences', 'c_notification_events', 'c_notification_deliveries'];
const ordered = list => [...list].sort((a, b) => String(a.id ?? a.recipient).localeCompare(String(b.id ?? b.recipient)));
const archived = (archive, table) => ordered(rows(archive).filter(r => r.table === table).map(r => r.row));
const snapshot = async h => Object.fromEntries(await Promise.all(tables.map(async table => [table, ordered((await h.db.prepare(`SELECT * FROM ${table}`).all()).results)])));
const address = name => name + '@' + 'harbourfinch.example';
const at = '2027-06-02T10:17:00.000Z';
const prefs = submission => ({ timezone: 'UTC', quietFrom: 0, quietUntil: 0, submission, decision: 'immediate', return: 'immediate', reminder: 'digest' });
const scheduled = async h => { await (await h.mf.getWorker()).scheduled({ scheduledTime: new Date(at), cron: '17 * * * *' }); };
const roots = [];
let h;
try {
  const [source, destination] = await Promise.all([fresh(), fresh()]);
  roots.push(source, destination);
  await Promise.all(roots.map(root => command(root, ['install'])));
  h = await harness({ persistencePath: join(source, '.wrangler/state/v3'), databaseId: 'local-foundation-only', clock: Date.parse('2027-06-02T08:17:00.000Z') });
  const team = await agency(h);
  await h.post('settings/notifications', prefs('immediate'), team.priya);
  await h.post('settings/notifications', prefs('digest'), team.sam);
  const create = async title => {
    let claim = await h.post('claims', { title }, team.sam);
    claim = await h.post(`claims/${claim.id}/items`, { version: claim.version, kind: 'receipt', date: '2027-06-02', merchant: title, amount: '10.00', explanation: 'Client workshop expense; original receipt lost', allocations: [{ category: team.c.office }] }, team.sam);
    return h.post(`claims/${claim.id}/submit`, { version: claim.version }, team.sam);
  };
  let first = await create('Delivered before move');
  await scheduled(h);
  first = await h.post(`claims/${first.id}/decision`, { version: first.version, revision: first.revision, decision: 'approved', acknowledge: true }, team.priya);
  await scheduled(h);
  await h.post('settings/notifications', prefs('digest'), team.priya);
  const pending = await create('Pending across move');
  const before = await snapshot(h);
  const delivered = before.c_notification_deliveries;
  assert.ok(delivered.length >= 2 && delivered.every(d => d.status === 'accepted'), 'ordinary submission and decision mail have accepted durable jobs');
  assert.ok(before.c_notification_events.some(e => e.claim_id === pending.id && e.delivery_id === null && e.cancelled_at === null), 'a real submission remains pending at export');
  await h.close(); h = undefined;

  await command(source, ['export', '--output', './exports/notifications.rer']);
  const archive = join(source, 'exports/notifications.rer'), exported = await records(archive);
  for (const table of tables) assert.deepEqual(archived(exported, table), before[table], `CLI exports exact ${table}`);
  await command(destination, ['export', '--output', './exports/empty-before.rer']);
  const empty = rows(await records(join(destination, 'exports/empty-before.rer')));
  // Re-seal semantic corruption so refusal comes from staged domain checks, before destination writes.
  const corruptions = [
    ['recipient', 'c_notification_events', row => { row.recipient = address('unrelated'); }, row => row.delivery_id !== null],
    ['missing-delivery', 'c_notification_events', row => { row.delivery_id = 'missing-notification-delivery'; }],
    ['job-count', 'c_notification_deliveries', row => { row.event_count += 1; }],
    ['timezone', 'c_notification_preferences', row => { row.timezone = 'Invalid/Zone'; }],
  ];
  for (const [name, table, change, pick] of corruptions) {
    await writeFile(join(destination, 'exports/invalid-notifications.rer'), await tampered(archive, table, change, pick), { mode: 0o600 });
    const log = await command(destination, ['import', '--input', './exports/invalid-notifications.rer', '--yes'], { expected: 4 });
    assert.match(log, /coaster_notification/, `refuse ${name}`);
    assert.ok(!log.includes(address('unrelated')), 'refusal reveals no staged recipient');
  }
  await command(destination, ['export', '--output', './exports/empty-after.rer']);
  assert.deepEqual(rows(await records(join(destination, 'exports/empty-after.rer'))), empty, 'refused archives write no portable data');
  await copyFile(archive, join(destination, 'exports/notifications.rer'));
  await command(destination, ['import', '--input', './exports/notifications.rer', '--yes']);
  await command(destination, ['export', '--output', './exports/restored-notifications.rer']);
  const restored = await records(join(destination, 'exports/restored-notifications.rer'));
  assert.deepEqual(rows(restored), rows(exported), 'every portable row survives the real CLI round trip');
  for (const table of tables) assert.deepEqual(archived(restored, table), before[table], `restore preserves exact ${table}`);
  const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/notification-proof');
  await mkdir(evidence, { recursive: true });
  await Promise.all([copyFile(archive, join(evidence, 'notifications.rer')), copyFile(join(destination, 'exports/restored-notifications.rer'), join(evidence, 'notifications-restored.rer'))]);

  h = await harness({ existingDatabase: true, persistencePath: join(destination, '.wrangler/state/v3'), databaseId: 'local-foundation-only', clock: Date.parse('2027-06-02T08:17:00.000Z') });
  const mailBefore = h.messages.length;
  await scheduled(h);
  assert.equal(h.messages.length, mailBefore, 'restore grants no notification delivery before recipient native sign-in');
  assert.deepEqual(await snapshot(h), before, 'unauthenticated recipients retain exact pending and delivered identities');
  const priya = await h.person(address('priya'), { employee: true, manager: true });
  const sam = await h.person(address('sam'), { employee: true }, address('priya'));
  assert.deepEqual((await h.get('settings/notifications', priya)).preferences, { ...prefs('digest'), enabled: true }, 'native sign-in exposes the preserved personal settings');
  const mailAfterLogin = h.messages.length;
  await scheduled(h);
  const after = await snapshot(h);
  for (const original of delivered) assert.deepEqual(after.c_notification_deliveries.find(d => d.id === original.id), original, 'historical jobs never reset on restore or sign-in');
  const deliveredPending = after.c_notification_events.find(e => e.claim_id === pending.id);
  assert.ok(deliveredPending.delivery_id, 'native sign-in permits the previously pending digest');
  assert.equal(h.messages.length - mailAfterLogin, 1, 'only the pending digest sends after native sign-in');
  await scheduled(h);
  assert.deepEqual(await snapshot(h), after, 'a repeated scheduled run preserves all delivery identities');
  assert.equal(h.messages.length - mailAfterLogin, 1, 'a repeated run never resends historical or restored mail');
  assert.ok((await h.get('settings/notifications', sam)).deliveries.length, 'the employee can read restored decision delivery status');
  console.log('Notification real CLI archive round trip, staged refusal and native re-sign-in delivery passed');
} finally {
  await h?.close();
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
}
