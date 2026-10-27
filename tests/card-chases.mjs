import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { apiPath, cardChaseFixture } from './card-chase-kit.mjs';

// ScheduledController.scheduledTime is fixed by the fixture; authentication keeps its ordinary live session clock.

export async function proveCardEvidenceReminders() {
  const h = await harness();
  try {
    const f = await cardChaseFixture(h), initial = await f.detail(), item = initial.items[0];
    assert.equal(item.amount_minor, 1200);
    assert.equal(item.receipt_id, null);
    assert.deepEqual(initial.exceptions.filter(e => e.code === 'missing-receipt'), [], 'ordinary threshold receipt reminder does not apply');
    // Discovery starts a day after posting. A discovery-based clock would miss this first step.
    assert.deepEqual(await f.tick('2026-06-02', 11), [], '06:17 Central is quiet');
    assert.equal((await f.tick('2026-06-02')).length, 1, 'first business day since posting');
    assert.deepEqual(await f.tick('2026-06-02'), [], 'replayed tick sends no duplicate');
    assert.deepEqual(await f.tick('2026-06-03'), [], 'no step at two business days');
    assert.equal((await f.tick('2026-06-04')).length, 1);
    assert.deepEqual(await f.tick('2026-06-06'), [], 'weekend stays quiet');
    assert.equal((await f.tick('2026-06-08')).length, 1, 'seven calendar days after posting');
    assert.deepEqual((await f.reminders()).map(e => [e.actor_email, e.detail.step, e.detail.businessDays, e.detail.postedOn, e.detail.mail]),
      [['reminder', 1, 1, '2026-06-01', 'accepted'], ['reminder', 2, 3, '2026-06-01', 'accepted'], ['reminder', 3, 5, '2026-06-01', 'accepted']]);
    const deliveries = h.outbound.filter(r => r.url === 'https://api.resend.com/emails' && JSON.parse(r.body).subject === 'Reminder: Complete card expense evidence');
    assert.equal(deliveries.length, 3);
    assert.equal(new Set(deliveries.map(r => r.headers['idempotency-key'])).size, 3);
    for (const d of deliveries) {
      assert.deepEqual(JSON.parse(d.body).to, ['sam@harbourfinch.example']);
      assert.ok(JSON.parse(d.body).text.endsWith(`/app#/claims/${f.id}`));
    }
    await f.attach();
    await h.post(apiPath('settings', 'reminders'), { days: '1,3,5,6', quietFrom: '20', quietUntil: '8', escalateAfter: '' }, f.morgan);
    assert.ok((await f.detail()).items[0].receipt_id);
    for (const day of ['2026-06-09', '2026-06-15']) assert.deepEqual(await f.tick(day), []);
    assert.equal((await f.reminders()).length, 3);
    assert.equal((await f.detail()).items[0].card_charge_id, item.card_charge_id, 'source charge stays linked');
  } finally { await h.close(); }
}

export async function proveCardEvidenceCompletion() {
  for (const kind of ['memo', 'field', 'policy-field']) {
    const h = await harness();
    try {
      const f = await cardChaseFixture(h, { memo: kind === 'memo' ? '' : 'Client supplies', required: kind === 'field' });
      if (kind === 'policy-field') await h.post('policy', { rules: [{ kind: 'required-field', category: f.category, field: 'Client' }] }, f.morgan);
      await f.attach();
      // First discovery at seven days must recover all three configured steps, rather than just the latest.
      assert.equal((await f.tick('2026-06-08')).length, 3, `${kind} still needs evidence despite its receipt`);
      assert.deepEqual((await f.reminders()).map(e => e.detail.step), [1, 2, 3]);
      assert.deepEqual(await f.tick('2026-06-08'), []);
      await f.edit(kind === 'memo' ? { description: 'Reviewed client supplies' } : { fields: { Client: 'Synthetic client' } });
      const i = (await f.detail()).items[0];
      assert.ok(i.receipt_id);
      assert.equal(kind === 'memo' ? i.description : i.fields.Client, kind === 'memo' ? 'Reviewed client supplies' : 'Synthetic client');
      // A fourth configured step makes closure observable even after all earlier steps have been sent.
      await h.post(apiPath('settings', 'reminders'), { days: '1,3,5,6', quietFrom: '20', quietUntil: '8', escalateAfter: '' }, f.morgan);
      assert.deepEqual(await f.tick('2026-06-09'), [], `${kind} resolution closes the chase`);
      assert.equal((await f.reminders()).length, 3);
    } finally { await h.close(); }
  }
}


export async function proveCardEvidenceEscalations() {
  const h = await harness();
  try {
    const f = await cardChaseFixture(h);
    await h.post(apiPath('settings', 'business'), { name: 'Harbour & Finch Studio', currency: 'USD', timezone: ['America', 'Chicago'].join('/'), receiptThreshold: '10.00' });
    await h.post(apiPath('settings', 'reminders'), { days: '1,3,5', quietFrom: '20', quietUntil: '8', escalateAfter: '2' }, f.morgan);
    const item = (await f.detail()).items[0];
    assert.equal(item.amount_minor, 1200);
    const escalations = async () => (await f.detail()).events.filter(e => e.action === 'escalated');
    const card = events => events.filter(e => e.detail.item.startsWith('card-evidence:'));
    const draft = events => events.filter(e => e.detail.item.startsWith('unsubmitted:'));
    // Discover on posting day so both independent tasks share the same clock origin.
    for (const day of ['2026-06-01', '2026-06-02', '2026-06-04', '2026-06-08']) await f.tick(day);
    assert.deepEqual((await f.reminders()).map(e => e.detail.step), [1, 2, 3]);
    assert.deepEqual(await escalations(), [], 'no escalation before the last reminder plus the gap');
    const expected = [
      [1, ['priya@harbourfinch.example'], 7],
      [2, ['jordan@harbourfinch.example', 'morgan@harbourfinch.example'], 9],
    ];
    const snapshots = [];
    for (const day of ['2026-06-10', '2026-06-12']) {
      await f.tick(day);
      const events = await escalations();
      snapshots.push(events);
      assert.deepEqual(await f.tick(day), []);
      assert.equal((await escalations()).length, events.length, 'replayed tick never duplicates either escalation');
    }
    assert.equal(card(await escalations()).length, 2, 'three reminders must be followed by two missing-receipt escalations');
    for (const [index, events] of snapshots.entries()) {
      const projection = rows => rows.map(e => [e.detail.level, e.detail.to, e.detail.businessDays]);
      assert.deepEqual(projection(draft(events)), expected.slice(0, index + 1), 'unsubmitted claim still escalates independently');
      assert.deepEqual(projection(card(events)), expected.slice(0, index + 1), 'missing card receipt escalates to manager then finance');
    }
    const deliveries = h.outbound.filter(r => r.url === 'https://api.resend.com/emails' && JSON.parse(r.body).subject === 'Escalated: Complete card expense evidence');
    assert.deepEqual(deliveries.map(d => JSON.parse(d.body).to), expected.map(row => row[1]));
    assert.equal(new Set(deliveries.map(d => d.headers['idempotency-key'])).size, 2);
    assert.equal((await f.reminders()).length, 3);
    await f.attach();
    await f.tick('2026-06-16');
    assert.equal(card(await escalations()).length, 2, 'receipt completion stops the evidence escalation');
    assert.equal((await f.reminders()).length, 3);
  } finally { await h.close(); }
}

if (process.argv.includes('--prove-card-chases')) {
  await proveCardEvidenceReminders();
  await proveCardEvidenceCompletion();
  await proveCardEvidenceEscalations();
  console.log('Posted evidence reminders, completion and escalation passed');
}
