import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { setup, n } from './automatic-coding-quality.mjs';
import { codingCorpus, prepare, confirm } from './agent-coding-fixture.mjs';

test('Employee confirms reviewed coding on every statement fixture with measured saved allocations and dimensions', async () => {
  const h = await harness(); try { const result = await codingCorpus(h); console.log(JSON.stringify(result.summary)); } finally { await h.close(); }
});

test('Coding confirmation refuses foreign delegated stale disputed submitted and repeated requests without writes', async () => {
  const h = await harness();
  try {
    const t = await setup(h);
    await t.statement([{ id: n(8500), merchant: n(8501), date: '2026-10-15', amount: '12.34' }]);
    const claim = (await h.get('statements', t.finance)).charges[0].claim_id;
    await t.rule(n(8501), t.fields(1));
    let p = await prepare(h, t.sam, claim);
    const snapshot = async () => (await h.db.prepare("SELECT json_object('claims',(SELECT json_group_array(json_object('id',id,'version',version,'status',status)) FROM c_claims),'items',(SELECT json_group_array(json_object('id',id,'coding',coding)) FROM c_items),'allocations',(SELECT json_group_array(json_object('item',item_id,'category',category_id,'amount',amount_minor)) FROM c_allocations),'events',(SELECT COUNT(*) FROM c_events),'feedback',(SELECT COUNT(*) FROM c_auto_coding_feedback),'suggestions',(SELECT COUNT(*) FROM c_auto_coding_suggestions),'contexts',(SELECT json_group_array(values_json||human_fields||version) FROM c_auto_coding_contexts),'proposals',(SELECT json_group_array(status) FROM c_proposals)) AS value").first()).value;
    let before = await snapshot();
    await confirm(h, t.alex, p, 403);
    await h.post('delegates', { delegate: t.alexEmail, level: 'full' }, t.sam);
    before = await snapshot();
    assert.equal((await h.send(`/api/coaster/proposals/${p.id}/apply-coding`, { confirm: true, fingerprint: p.payload.codingApplication.fingerprint }, t.alex, { 'x-coaster-acting-for': t.samEmail })).status, 403);
    const key = await h.post('agent-keys', { label: n(8502) }, t.sam);
    before = await snapshot();
    assert.equal((await h.send(`/api/coaster/proposals/${p.id}/apply-coding`, { confirm: true, fingerprint: p.payload.codingApplication.fingerprint }, '', { authorization: `Bearer ${key.token}` })).status, 401);
    await h.post(`proposals/${p.id}/apply-coding`, { fingerprint: p.payload.codingApplication.fingerprint }, t.sam, 409);
    assert.equal(await snapshot(), before);
    const rule = (await h.get(['coding', 'automatic', 'rules'].join('/'), t.finance)).rules[0];
    await t.rule(n(8501), t.fields(2), 'finance', t.finance, { id: rule.id });
    before = await snapshot(); await confirm(h, t.sam, p, 409); assert.equal(await snapshot(), before);
    p = await prepare(h, t.sam, claim);
    let catalog = await h.get('coding'); await h.post(['coding', 'values'].join('/'), { version: catalog.version, id: t.values.class[2], name: n(8503) });
    before = await snapshot(); await confirm(h, t.sam, p, 409); assert.equal(await snapshot(), before);
    p = await prepare(h, t.sam, claim);
    const applied = await confirm(h, t.sam, p);
    assert.equal(applied.claim.status, 'draft');
    before = await snapshot(); await confirm(h, t.sam, p, 409); assert.equal(await snapshot(), before);
    // A person's explicit override remains protected, and a disagreement stops the whole plan.
    const detail = await h.get(`claims/${claim}`, t.sam), suggestion = detail.items[0].codingSuggestions.at(-1);
    await h.post(`${['coding','automatic','suggestions'].join('/')}/${suggestion.id}/decision`, { action: 'override', claimVersion: detail.claim.version, values: t.fields(1) }, t.sam, 409);
    // Create fresh pending advice through ordinary import, then override it through its native door.
    await t.statement([{ id: n(8504), merchant: n(8501), date: '2026-11-15', amount: '4.32' }]);
    const nextClaim = (await h.get('statements', t.finance)).charges.find(c => c.posted_on === '2026-11-15').claim_id;
    let next = await h.get(`claims/${nextClaim}`, t.sam);
    await h.post(`${['coding','automatic','suggestions'].join('/')}/${next.items[0].codingSuggestions[0].id}/decision`, { action: 'override', claimVersion: next.claim.version, values: t.fields(1) }, t.sam);
    const stopped = await prepare(h, t.sam, nextClaim); assert.equal(stopped.payload.stopped, true);
    before = await snapshot(); await confirm(h, t.sam, stopped, 409); assert.equal(await snapshot(), before);
    p = await prepare(h, t.sam, claim);
    await h.post(`claims/${claim}/title`, { version: applied.claim.version, title: n(8505) }, t.sam);
    before = await snapshot(); await confirm(h, t.sam, p, 409); assert.equal(await snapshot(), before);
    // New dimension advice must not flatten a person's category split or replace an explicit dimension.
    let split = await h.post('claims', { title: n(8510) }, t.sam);
    split = await h.post(`claims/${split.id}/items`, { version: split.version, kind: 'receipt', date: '2026-10-16', merchant: n(8511), amount: '12.34', allocations: [{ category: t.cats[0].id, amount: '5.00', costCentre: 'North' }, { category: t.cats[1].id, amount: '7.34', costCentre: 'South' }], coding: { [t.dimensions.class]: t.values.class[0] } }, t.sam);
    await t.rule(n(8511), t.fields(2));
    const splitBefore = await h.get(`claims/${split.id}`, t.sam), splitPlan = await prepare(h, t.sam, split.id);
    await confirm(h, t.sam, splitPlan);
    const splitAfter = await h.get(`claims/${split.id}`, t.sam);
    assert.deepEqual(splitAfter.items[0].allocations, splitBefore.items[0].allocations, 'category splits, cost centres and amounts remain the human choice');
    assert.equal(splitAfter.items[0].coding[t.dimensions.class], t.values.class[0], 'explicit dimension stays protected');
    assert.equal(splitAfter.items[0].coding[t.dimensions.project], t.values.project[2], 'only the unentered dimension is confirmed');
    p = await prepare(h, t.sam, claim);
    const current = (await h.get(`claims/${claim}`, t.sam)).claim;
    await h.post(`claims/${claim}/submit`, { version: current.version }, t.sam);
    before = await snapshot(); await confirm(h, t.sam, p, 409); assert.equal(await snapshot(), before);
    const submitted = (await h.get(`claims/${claim}`, t.sam)).claim;
    await h.post(`claims/${claim}/decision`, { version: submitted.version, revision: submitted.revision, decision: 'returned', reason: n(8514) }, t.manager);
    const returnedPlan = await prepare(h, t.sam, claim);
    assert.equal(returnedPlan.payload.codingApplication, null, 'returned claims never regain first-draft application authority');
    before = await snapshot(); await confirm(h, t.sam, returnedPlan, 409); assert.equal(await snapshot(), before);
    await h.post(`proposals/${returnedPlan.id}/accept`, {}, t.sam);
    for (const owned of (await h.get('state', t.sam)).claims.filter(c => c.employee_email === t.samEmail)) {
      const pending = owned.status === 'submitted' ? owned : await h.post(`claims/${owned.id}/submit`, { version: owned.version }, t.sam);
      await h.post(`claims/${owned.id}/decision`, { version: pending.version, revision: pending.revision, decision: 'rejected', reason: n(8512) }, t.manager);
    }
    await h.post(['settings','members'].join('/'), { email: t.samEmail, name: n(8513), employee: true, active: false });
    await h.post(['settings','members','erase'].join('/'), { email: t.samEmail });
    const erased = await h.db.prepare('SELECT COUNT(*) AS n FROM c_proposals WHERE for_email=?').bind(t.samEmail).first(); assert.equal(erased.n, 0);
    const history = (await h.db.prepare('SELECT * FROM c_events ORDER BY seq').all()).results;
    const replay = await h.send(`/api/coaster/proposals/${p.id}/apply-coding`, { confirm: true, fingerprint: p.payload.codingApplication.fingerprint }, t.sam);
    assert.ok([401, 403].includes(replay.status), 'an erased identity cannot replay a captured confirmation');
    await confirm(h, h.owner, p, 403);
    assert.deepEqual((await h.db.prepare('SELECT * FROM c_events ORDER BY seq').all()).results, history);
  } finally { await h.close(); }
});


test('Native coding confirmation fences withdrawn authority and coding inputs at both transaction guards', async () => {
  let barrier;
  const h = await harness({ d1Barrier: () => barrier ? barrier() : new Response('ok') });
  try {
    const t = await setup(h);
    await t.statement([{ id: n(8600), merchant: n(8601), date: '2026-10-15', amount: '12.34' }]);
    const id = (await h.get('statements', t.finance)).charges[0].claim_id;
    await t.rule(n(8601), t.fields(1));
    // Every refusal is compared against the whole affected public record and immutable history.
    const state = async () => ({ detail: await h.get(`claims/${id}`, t.sam), events: (await h.db.prepare('SELECT * FROM c_events ORDER BY seq').all()).results, contexts: (await h.db.prepare('SELECT * FROM c_auto_coding_contexts ORDER BY target_id').all()).results, proposals: (await h.db.prepare('SELECT * FROM c_proposals ORDER BY id').all()).results });
    for (const [table, assignment, where, params] of [
      ['c_auto_coding_epoch', 'version=version+1', 'id=1', []],
      ['c_coding_version', 'version=version+1', 'id=1', []],
      ['c_auto_coding_contexts', 'version=version+1', "target_kind='item'", []],
      ['c_claims', 'version=version+1', 'id=?', [id]],
    ]) {
      const p = await prepare(h, t.sam, id);
      let expected;
      barrier = async () => { barrier = undefined; await h.db.prepare(`UPDATE ${table} SET ${assignment} WHERE ${where}`).bind(...params).run(); expected = await state(); return new Response('ok'); };
      await confirm(h, t.sam, p, 409);
      assert.deepEqual(await state(), expected, `pre-commit ${table} change permits no application writes`);
    }
    const p = await prepare(h, t.sam, id), before = await state();
    for (const body of [
      'UPDATE c_auto_coding_epoch SET version=version+1 WHERE id=1;',
      'UPDATE c_coding_version SET version=version+1 WHERE id=1;',
      'UPDATE c_auto_coding_contexts SET version=version+1;',
      'UPDATE c_claims SET revision=1;',
      'UPDATE oa_sessions SET revoked_at=1;',
    ]) {
      // Simulate authority or input withdrawal after the writes start, inside real SQLite.
      await h.db.prepare(`CREATE TRIGGER synthetic_coding_withdrawal AFTER UPDATE ON c_proposals WHEN NEW.status='accepted' BEGIN ${body} END`).run();
      try { await confirm(h, t.sam, p, 409); } finally { await h.db.prepare('DROP TRIGGER synthetic_coding_withdrawal').run(); }
      assert.deepEqual(await state(), before, 'post-commit guard rolls back every coding, proposal and history write');
    }
    barrier = async () => { barrier = undefined; await h.db.prepare('UPDATE c_members SET active=0 WHERE email=?').bind(t.samEmail).run(); return new Response('ok'); };
    await confirm(h, t.sam, p, 409);
    assert.deepEqual((await h.db.prepare('SELECT * FROM c_events ORDER BY seq').all()).results, before.events);
    assert.equal((await h.send(`/api/coaster/proposals/${p.id}/apply-coding`, { confirm: true, fingerprint: p.payload.codingApplication.fingerprint }, t.sam)).status, 403);
  } finally { await h.close(); }
});
