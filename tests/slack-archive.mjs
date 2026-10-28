import assert from 'node:assert/strict';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fresh, command } from './browser-runtime.mjs';
import { records, rows, tampered } from './browser-archive.mjs';
import { agency, harness } from './harness.mjs';
import { pendingEmailQuestionClaim } from './fixtures/email-question-claim.mjs';
import { connectSlack, deliverSlack, linkSlack, slackFixture } from './fixtures/slack.mjs';

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/slack-proof');
const localTables = ['c_slack_connection', 'c_slack_links', 'c_slack_challenges', 'c_slack_threads'];
const sam = ['sam', 'harbourfinch.example'].join('@');
const tableRows = (archive, table) => rows(archive).filter(r => r.table === table).map(r => r.row);
const numbered = events => [...events].sort((a, b) => a.seq - b.seq);
const sourceIds = value => Object.entries(value).flatMap(([key, cell]) => cell && typeof cell === 'object' ? sourceIds(cell) : ['team_id', 'api_app_id', 'event_id', 'channel', 'thread_ts', 'user', 'ts'].includes(key) && typeof cell === 'string' ? [cell] : []);

await mkdir(evidence, { recursive: true });
const roots = [];
let h;
try {
  const [source, destination] = await Promise.all([fresh(), fresh()]);
  roots.push(source, destination);
  for (const root of roots) await command(root, ['install']);
  const edge = slackFixture();
  h = await harness({ persistencePath: join(source, '.wrangler/state/v3'), databaseId: 'local-foundation-only', slackEdge: request => edge.fetch(request) });
  const team = await agency(h);
  await connectSlack(h, edge);
  await linkSlack(h, edge, team.sam);
  let claim = await pendingEmailQuestionClaim(h, team, 'Archive Slack answer');
  const asked = await h.post(`claims/${claim.id}/comments`, { body: 'Which client was this for?', asks: sam }, team.priya);
  assert.equal(asked.slack, 'sent');
  const incoming = edge.reply();
  const delivered = await deliverSlack(h, edge, incoming);
  assert.equal(delivered.status, 200);
  assert.equal(delivered.value.accepted, true);
  const answered = await h.get(`claims/${claim.id}`, team.priya);
  assert.equal(answered.claim.status, 'submitted', 'a chat answer preserves the pending native decision');
  const nativeComments = (await h.db.prepare('SELECT * FROM c_comments ORDER BY id').all()).results;
  const answer = nativeComments.find(c => c.parent_id === asked.comment && c.author_email === sam);
  assert.ok(answer && answer.body.length > 0 && answer.asks_email === null, 'the signed answer is an ordinary attributed reply');
  claim = await h.post(`claims/${claim.id}/decision`, { version: claim.version, revision: claim.revision, decision: 'approved', acknowledge: true }, team.priya);
  assert.equal(claim.status, 'approved');
  let pending = await h.post('claims',{title:'Unanswered Slack archive question'},team.sam);
  pending=await h.post(`claims/${pending.id}/items`,{version:pending.version,kind:'receipt',date:'2026-05-22',merchant:'Client office visit',amount:'31.00',explanation:'Original receipt unavailable',allocations:[{category:team.c.meals}]},team.sam);
  pending=await h.post(`claims/${pending.id}/submit`,{version:pending.version},team.sam);
  assert.equal((await h.post(`claims/${pending.id}/comments`, { body: 'Which office?', asks: sam }, team.priya)).slack, 'sent');
  const pendingEvent = edge.reply();
  const departedAddress=['synthetic-coaster-departed','harbourfinch.example'].join('@');
  const departed=await h.person(departedAddress,{employee:true},['priya','harbourfinch.example'].join('@'));
  await linkSlack(h,edge,departed,'USYNTHETIC2');
  let departedClaim=await h.post('claims',{title:'Departed member client visit'},departed);
  departedClaim=await h.post(`claims/${departedClaim.id}/items`,{version:departedClaim.version,kind:'receipt',date:'2026-05-23',merchant:'Former client visit',amount:'22.50',explanation:'Receipt unavailable',allocations:[{category:team.c.meals}]},departed);
  departedClaim=await h.post(`claims/${departedClaim.id}/submit`,{version:departedClaim.version},departed);
  await h.post(`claims/${departedClaim.id}/comments`,{body:'Which client was this for?',asks:departedAddress},team.priya);
  const erasedAnswer='Erased member private answer';
  assert.equal((await deliverSlack(h,edge,edge.reply({event:{user:'USYNTHETIC2',text:erasedAnswer}}))).status,200);
  await h.post(`claims/${departedClaim.id}/decision`,{version:departedClaim.version,revision:departedClaim.revision,decision:'rejected',reason:'Cancelled visit',acknowledge:true},team.priya);
  await h.post('settings/members',{email:departedAddress,name:'synthetic-coaster-departed',employee:true,active:false});
  await h.post('settings/members/erase',{email:departedAddress});
  await h.post(['chat', 'slack', 'link', 'start'].join('/'), { user: edge.user, consent: true }, team.sam);
  for (const table of localTables) assert.ok((await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n > 0, 'the source contains live local execution state');
  const history = (await h.db.prepare('SELECT * FROM c_events ORDER BY seq').all()).results;
  assert.ok(history.some(e => e.action === 'question-answered' && JSON.parse(e.detail).comment === answer.id));
  await assert.rejects(() => h.db.prepare('UPDATE c_events SET detail=? WHERE id=?').bind('{}', history[0].id).run(), /permanent/);
  await assert.rejects(() => h.db.prepare('DELETE FROM c_events WHERE id=?').bind(history[0].id).run(), /permanent/);
  const comments = (await h.db.prepare('SELECT * FROM c_comments ORDER BY id').all()).results;
  const digests = (await h.db.prepare('SELECT * FROM c_slack_answers ORDER BY digest').all()).results;
  assert.equal(digests.length, 2);
  assert.equal(digests.filter(row=>row.comment_id===null).length,1,'erasure retains only the departed reply’s opaque replay digest');
  await h.close(); h = undefined;

  await command(source, ['export', '--output', './exports/slack.rer']);
  const archive = join(source, './exports/slack.rer'), exported = await records(archive), encoded = JSON.stringify(exported);
  assert.deepEqual(tableRows(exported, 'c_comments').sort((a, b) => a.id.localeCompare(b.id)), [...comments].sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(numbered(tableRows(exported, 'c_events')), history, 'numbered evidence is exported unchanged');
  assert.deepEqual(tableRows(exported, 'c_slack_answers'), digests);
  assert.deepEqual(Object.keys(digests[0]).sort(), ['comment_id', 'digest']);
  assert.match(digests[0].digest, /^[a-f0-9]{64}$/);
  for (const table of localTables) {
    assert.equal(tableRows(exported, table).length, 0);
    assert.ok(!exported[0].tables.some(t => t.name === table), 'local Slack authority has no restore schema');
  }
  for (const value of [edge.secret, edge.token, edge.team, edge.app, edge.user, ...sourceIds(incoming), ...sourceIds(pendingEvent)]) assert.ok(!encoded.includes(value), 'provider credentials and source identifiers stay out of the archive');
  assert.ok(!encoded.includes(JSON.stringify(incoming)), 'raw provider payload is absent');
  assert.ok(!encoded.includes(erasedAnswer)&&!encoded.includes(departedAddress),'the next CLI archive contains neither the erased answer nor its copied history text');
  assert.ok(encoded.includes(answer.body), 'ordinary answer evidence remains portable');

  await command(destination, ['export', '--output', './exports/empty.rer']);
  const empty = rows(await records(join(destination, './exports/empty.rer')));
  for (const [name, change] of [
    ['digest', row => { row.digest = 'g'.repeat(64); }],
    ['comment', row => { row.comment_id = 'synthetic-missing-comment'; }],
  ]) {
    await writeFile(join(destination, './exports/invalid-slack.rer'), await tampered(archive, 'c_slack_answers', change), { mode: 0o600 });
    assert.match(await command(destination, ['import', '--input', './exports/invalid-slack.rer', '--yes'], { expected: 4 }), /coaster_slack_evidence/, `invalid ${name} evidence is refused`);
  }
  await command(destination, ['export', '--output', './exports/unchanged.rer']);
  assert.deepEqual(rows(await records(join(destination, './exports/unchanged.rer'))), empty, 'refused imports write no portable data');
  await copyFile(archive, join(destination, './exports/slack.rer'));
  await command(destination, ['import', '--input', './exports/slack.rer', '--yes']);
  await command(destination, ['export', '--output', './exports/restored-slack.rer']);
  const restored = await records(join(destination, './exports/restored-slack.rer'));
  assert.deepEqual(rows(restored), rows(exported), 'all portable rows survive the real CLI round trip exactly');
  assert.deepEqual(numbered(tableRows(restored, 'c_events')), history);
  await Promise.all([copyFile(archive, join(evidence, 'slack.rer')), copyFile(join(destination, './exports/restored-slack.rer'), join(evidence, 'slack-restored.rer'))]);

  h = await harness({ existingDatabase: true, persistencePath: join(destination, '.wrangler/state/v3'), databaseId: 'local-foundation-only', slackEdge: request => edge.fetch(request), bindings: { SESSION_SECRET: 'synthetic-coaster-restored-slack-installation-secret' } });
  const restoredSam = await h.person(sam, { employee: true });
  const restoredClaim = await h.get(`claims/${claim.id}`, restoredSam);
  assert.equal(restoredClaim.claim.status, 'approved');
  assert.equal(restoredClaim.comments.find(c => c.id === answer.id)?.body, answer.body);
  const status = await h.get(['chat', 'slack'].join('/'), restoredSam);
  assert.equal(status.connected, false);
  assert.equal(status.linked, false);
  for (const table of localTables) assert.equal((await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 0);
  const refused = await deliverSlack(h, edge, pendingEvent);
  assert.equal(refused.status, 403);
  assert.match(JSON.stringify(refused.value), /Slack is not connected/);
  const unsent = await h.post(`claims/${pending.id}/comments`, { body: 'Please clarify the office in Coaster', asks: sam });
  assert.equal(unsent.slack, 'not linked');
  await h.post(['chat', 'slack', 'link', 'start'].join('/'), { user: edge.user, consent: true }, restoredSam, 409);
  assert.ok(!h.outbound.some(r => new URL(r.url).hostname === 'slack.com'), 'restored evidence causes no provider request');
  assert.deepEqual((await h.db.prepare('SELECT * FROM c_slack_answers ORDER BY digest').all()).results, digests, 'rejected delivery leaves opaque evidence untouched');
  console.log('Slack native evidence survived exact CLI restore with local execution authority absent');
} finally {
  await h?.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
}
