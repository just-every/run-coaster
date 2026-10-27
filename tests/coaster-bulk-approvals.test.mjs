import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { bulkClaims, entry } from './bulk-approval-kit.mjs';

const path = ['approvals', 'bulk'].join('/');

test('Bulk decisions require per-claim review and exceptions, refuse stale or unauthorized claims unchanged, and record three exact revisions', async () => {
  const h = await harness();
  try {
    const { team: t, claims, create } = await bulkClaims(h);
    const earlier = await create('Resubmitted expense');
    const returned = await h.post(`claims/${earlier.id}/decision`, { revision: earlier.revision, version: earlier.version, decision: 'returned', reason: 'Review again' }, t.priya);
    const current = await h.post(`claims/${earlier.id}/submit`, { version: returned.version }, t.sam);
    assert.equal(current.revision, 2);
    const currentBefore = await h.get(`claims/${current.id}`, t.sam);
    const before = await Promise.all(claims.map(c => h.get(`claims/${c.id}`, t.sam)));
    assert.deepEqual(before.map(d => d.exceptions.map(x => x.code).sort()), Array(3).fill(['missing-receipt', 'over-limit']));
    const missing = await h.post(path, { claims: claims.map((c, i) => entry(c, i === 0 ? { reviewed: false } : { acknowledge: false })) }, t.priya);
    assert.deepEqual(missing.results.map(r => [r.approved, r.status]), [[false, 409], [false, 409], [false, 409]]);
    assert.deepEqual(await Promise.all(claims.map(c => h.get(`claims/${c.id}`, t.sam))), before, 'unreviewed and unacknowledged claims have no writes');
    const stale = await h.post(path, { claims: [entry(claims[0], { version: claims[0].version - 1 }), entry(current, { revision: earlier.revision })] }, t.priya);
    assert.deepEqual(stale.results.map(r => [r.approved, r.status]), [[false, 409], [false, 409]]);
    assert.deepEqual(await h.get(`claims/${current.id}`, t.sam), currentBefore, 'a genuine earlier submitted revision is refused unchanged even with the current version');
    const wrongApprover = await h.post(path, { claims: claims.map(entry) }, t.jordan);
    assert.deepEqual(wrongApprover.results.map(r => [r.approved, r.status]), [[false, 403], [false, 403], [false, 403]]);
    const finance = await h.post(path, { claims: [entry(claims[0])] }, t.morgan);
    assert.deepEqual(finance.results.map(r => [r.approved, r.status]), [[false, 403]]);
    for (const roles of [{ employee: true }, { admin: true }, { cardAdmin: true }, { auditor: true }, { bookkeeper: true }]) {
      const person = await h.person(`synthetic-coaster-${Object.keys(roles)[0].toLowerCase()}@harbourfinch.example`, roles);
      await h.post(path, { claims: claims.map(entry) }, person, 403);
    }
    const foreign = await h.send('/api/coaster/' + path, { claims: claims.map(entry) }, t.priya, { origin: 'https://foreign.example' });
    assert.equal(foreign.status, 403);
    assert.deepEqual(await Promise.all(claims.map(c => h.get(`claims/${c.id}`, t.sam))), before, 'all stale and role refusals leave claims, decisions, revisions and history identical');
    const result = await h.post(path, { claims: claims.map(entry) }, t.priya);
    assert.deepEqual(result.results.map(r => [r.id, r.revision, r.approved, r.claimStatus]), claims.map(c => [c.id, 1, true, 'approved']));
    for (const c of claims) {
      const d = await h.get(`claims/${c.id}`, t.sam);
      assert.equal(d.claim.status, 'approved');
      assert.deepEqual(d.decisions.map(x => [x.revision, x.decision, x.actor_email, x.exceptions.length]), [[1, 'approved', 'priya@harbourfinch.example', 2]]);
      const event = d.events.find(x => x.action === 'claim-approved');
      assert.deepEqual([event.detail.channel, event.detail.bulkId, event.detail.revision, event.detail.exceptionsAcknowledged], ['bulk', result.bulkId, 1, 2]);
    }
    const history = (await h.get('history?q=' + result.bulkId)).lines;
    assert.deepEqual(history.map(line => [line.claim.id, line.channel, line.detail.revision]), claims.map(c => [c.id, 'bulk', 1]), 'public numbered audit history exposes the bulk channel on all three exact revisions');
    const after = await Promise.all(claims.map(c => h.get(`claims/${c.id}`, t.sam)));
    const replay = await h.post(path, { claims: claims.map(entry) }, t.priya);
    assert.ok(replay.results.every(r => !r.approved && r.status === 409));
    assert.deepEqual(await Promise.all(claims.map(c => h.get(`claims/${c.id}`, t.sam))), after, 'replay cannot add decisions');
  } finally { await h.close(); }
});

test('Bulk approval preserves workflow stages, mixed results, live delegation and self-approval refusal', async () => {
  const h = await harness();
  try {
    const { team: t, create } = await bulkClaims(h);
    await h.post(['settings', 'approval-workflow'].join('/'), { version: 0, rules: [{ label: 'Finance after manager', condition: { kind: 'amount', value: '1.00' }, stages: [[{ kind: 'finance', email: 'morgan@harbourfinch.example' }]] }] });
    const c = await create('Workflow claim');
    const first = await h.post(path, { claims: [entry(c)] }, t.priya);
    assert.deepEqual(first.results.map(r => [r.approved, r.claimStatus]), [[true, 'submitted']]);
    let d = await h.get(`claims/${c.id}`, t.sam);
    assert.equal(d.claim.approver_email, 'morgan@harbourfinch.example');
    const completed = await h.post(path, { claims: [entry(c), entry(d.claim)] }, t.morgan, 400);
    assert.match(completed.error, /once/);
    const wrong = await h.post(path, { claims: [entry(d.claim)] }, t.priya);
    assert.deepEqual(wrong.results.map(r => [r.approved, r.status]), [[false, 403]]);
    assert.deepEqual(await h.get(`claims/${c.id}`, t.sam), d);
    await h.post('delegates', { delegate: 'alex@harbourfinch.example', level: 'submit' }, t.morgan);
    assert.equal((await h.send('/api/coaster/' + path, { claims: [entry(d.claim)] }, t.alex, { 'x-coaster-acting-for': 'morgan@harbourfinch.example' })).status, 403);
    assert.deepEqual(await h.get(`claims/${c.id}`, t.sam), d);
    const grant = await h.post('delegates', { delegate: 'alex@harbourfinch.example', level: 'full' }, t.morgan);
    const delegated = await h.send('/api/coaster/' + path, { claims: [entry(c), entry(d.claim, { id: 'missing-claim' })] }, t.alex, { 'x-coaster-acting-for': 'morgan@harbourfinch.example' });
    assert.equal(delegated.status, 200);
    assert.deepEqual(delegated.value.results.map(r => [r.approved, r.status]), [[false, 409], [false, 404]]);
    const final = await h.send('/api/coaster/' + path, { claims: [entry(d.claim), entry(d.claim, { id: 'missing-claim' })] }, t.alex, { 'x-coaster-acting-for': 'morgan@harbourfinch.example' });
    assert.equal(final.status, 200);
    assert.deepEqual(final.value.results.map(r => r.approved), [true, false]);
    assert.equal(final.value.results[0].claimStatus, 'approved');
    d = await h.get(`claims/${c.id}`, t.sam);
    assert.deepEqual(d.decisions.map(x => [x.actor_email, x.revision]), [['priya@harbourfinch.example', 1], ['alex@harbourfinch.example', 1]]);
    assert.deepEqual(d.events.filter(x => x.action.includes('approved')).map(x => x.detail.channel), ['bulk', 'bulk']);
    await h.post('settings/members', { email: 'priya@harbourfinch.example', name: 'priya', employee: true, manager: true, approver: 'jordan@harbourfinch.example' });
    const ownManager = await create('Manager own expense', t.priya);
    const ownManagerBefore = await h.get(`claims/${ownManager.id}`, t.priya);
    const selfResult = await h.post(path, { claims: [entry(ownManager)] }, t.priya);
    assert.deepEqual(selfResult.results.map(r => [r.approved, r.status]), [[false, 403]]);
    assert.deepEqual(await h.get(`claims/${ownManager.id}`, t.priya), ownManagerBefore);
    const own = await create('Delegate own expense', t.alex);
    const ownBefore = await h.get(`claims/${own.id}`, t.alex);
    const ownResult = await h.send('/api/coaster/' + path, { claims: [entry(own)] }, t.alex, { 'x-coaster-acting-for': 'morgan@harbourfinch.example' });
    assert.equal(ownResult.status, 200);
    assert.deepEqual(ownResult.value.results.map(r => [r.approved, r.status]), [[false, 403]]);
    assert.deepEqual(await h.get(`claims/${own.id}`, t.alex), ownBefore);
    await h.post(`delegates/${grant.id}/revoke`, {}, t.morgan);
    assert.equal((await h.send('/api/coaster/' + path, { claims: [entry(own)] }, t.alex, { 'x-coaster-acting-for': 'morgan@harbourfinch.example' })).status, 403);
  } finally { await h.close(); }
});
