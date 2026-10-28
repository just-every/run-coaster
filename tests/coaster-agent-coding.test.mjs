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
    await h.post(`coding/automatic/suggestions/${suggestion.id}/decision`, { action: 'override', claimVersion: detail.claim.version, values: t.fields(1) }, t.sam, 409);
    // Create fresh pending advice through ordinary import, then override it through its native door.
    await t.statement([{ id: n(8504), merchant: n(8501), date: '2026-11-15', amount: '4.32' }]);
    const nextClaim = (await h.get('statements', t.finance)).charges.find(c => c.posted_on === '2026-11-15').claim_id;
    let next = await h.get(`claims/${nextClaim}`, t.sam);
    await h.post(`coding/automatic/suggestions/${next.items[0].codingSuggestions[0].id}/decision`, { action: 'override', claimVersion: next.claim.version, values: t.fields(1) }, t.sam);
    const stopped = await prepare(h, t.sam, nextClaim); assert.equal(stopped.payload.stopped, true);
    before = await snapshot(); await confirm(h, t.sam, stopped, 409); assert.equal(await snapshot(), before);
    p = await prepare(h, t.sam, claim);
    await h.post(`claims/${claim}/title`, { version: applied.claim.version, title: n(8505) }, t.sam);
    before = await snapshot(); await confirm(h, t.sam, p, 409); assert.equal(await snapshot(), before);
    p = await prepare(h, t.sam, claim);
    const current = (await h.get(`claims/${claim}`, t.sam)).claim;
    await h.post(`claims/${claim}/submit`, { version: current.version }, t.sam);
    before = await snapshot(); await confirm(h, t.sam, p, 409); assert.equal(await snapshot(), before);
  } finally { await h.close(); }
});
