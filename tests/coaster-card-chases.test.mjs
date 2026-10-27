import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, receipt } from './harness.mjs';
import { apiPath, cardChaseFixture } from './card-chase-kit.mjs';

// ScheduledController.scheduledTime is fixed by the fixture; authentication keeps its ordinary live session clock.

test('Posted card evidence sends three distinct seven-day mail steps from posting, even below the receipt threshold, and closes on native attachment', async () => {
  const h = await harness();
  try {
    const f = await cardChaseFixture(h), initial = await f.detail(), item = initial.items[0];
    assert.equal(item.amount_minor, 1200);
    assert.equal(item.receipt_id, null);
    assert.deepEqual(initial.exceptions.filter(e => e.code === 'missing-receipt'), [], 'ordinary threshold receipt reminder does not apply');
    // Discovery starts a day after posting. A discovery-based clock would miss this first step.
    assert.deepEqual(await f.tick('2026-06-02', 11), [], '06:17 Central is quiet');
    await Promise.all([f.tick('2026-06-02'), f.tick('2026-06-02')]);
    assert.equal((await f.reminders()).length, 1, 'overlapping first ticks reserve one step from posting');
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
    const submitted = await h.post(`claims/${f.id}/submit`, { version: (await f.detail()).claim.version }, f.sam);
    const approved = await h.post(`claims/${f.id}/decision`, { version: submitted.version, revision: submitted.revision, decision: 'approved', acknowledge: true }, f.priya);
    const frozen = await f.detail();
    const file = { version: approved.version, item: item.id, ...(await receipt('officeworks')) };
    await h.post(`claims/${f.id}/receipts`, file, f.alex, 403);
    await h.post(`claims/${f.id}/receipts`, { ...file, version: submitted.version }, f.sam, 409);
    const attempts = await Promise.all([h.send(`/api/coaster/claims/${f.id}/receipts`, file, f.sam), h.send(`/api/coaster/claims/${f.id}/receipts`, file, f.sam)]);
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409], 'one concurrent upload fills the missing receipt');
    const completed = await f.detail();
    assert.equal(completed.receipts.length, 1);
    const finance = await h.get(`claims/${f.id}`, f.morgan);
    assert.equal(finance.items[0].receipt_id, completed.items[0].receipt_id);
    const download = await h.mf.dispatchFetch(`${h.origin}/api/coaster/receipts/${completed.items[0].receipt_id}`, { headers: { cookie: f.morgan } });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from(file.base64, 'base64'));
    assert.equal(completed.claim.status, 'approved');
    assert.equal(completed.claim.total_minor, 0);
    assert.deepEqual(completed.revisions, frozen.revisions, 'late evidence never rewrites the approved revision');
    assert.deepEqual(completed.decisions, frozen.decisions);
    assert.equal(completed.revisions[0].snapshot.items[0].receipt_id, null);
    assert.equal(completed.items[0].amount_minor, 1200);
    assert.ok(completed.events.some(e => e.action === 'receipt-added' && e.detail.afterSubmission === 1));
    await h.post(`claims/${f.id}/receipts`, { ...file, version: completed.claim.version }, f.sam, 409);
    await h.post(apiPath('settings', 'reminders'), { days: '1,3,5,6', quietFrom: '20', quietUntil: '8', escalateAfter: '' }, f.morgan);
    assert.ok((await f.detail()).items[0].receipt_id);
    for (const day of ['2026-06-09', '2026-06-15']) assert.deepEqual(await f.tick(day), []);
    assert.equal((await f.reminders()).length, 3);
    assert.equal((await f.detail()).items[0].card_charge_id, item.card_charge_id, 'source charge stays linked');
  } finally { await h.close(); }
});

test('A posted card chase remains open for missing memo or configured fields and closes only on native evidence completion', async () => {
  // Field labels are user data, including names also present on Object.prototype.
  for (const [kind, field] of [['memo', 'Client'], ['field', 'Client'], ['policy-field', 'Client'], ['field', 'constructor'], ['policy-field', 'toString']]) {
    const h = await harness();
    try {
      const f = await cardChaseFixture(h, { memo: kind === 'memo' ? '' : 'Client supplies', required: kind === 'field', field });
      if (kind === 'policy-field') await h.post('policy', { rules: [{ kind: 'required-field', category: f.category, field }] }, f.morgan);
      await f.attach();
      if (kind === 'memo') await h.post(apiPath('settings', 'reminders'), { days: '1,3,5', quietFrom: '20', quietUntil: '8', escalateAfter: '1' }, f.morgan);
      // First discovery at seven days must recover all three configured steps, rather than just the latest.
      assert.equal((await f.tick('2026-06-08')).length, 3, `${kind} ${field} still needs evidence despite its receipt`);
      assert.deepEqual((await f.reminders()).map(e => e.detail.step), [1, 2, 3]);
      assert.deepEqual(await f.tick('2026-06-08'), []);
      if (kind === 'memo') {
        for (const day of ['2026-06-09', '2026-06-10']) { await f.tick(day); await f.tick(day); }
        const escalations = (await f.detail()).events.filter(e => e.action === 'escalated' && e.detail.item.startsWith('card-evidence:'));
        assert.deepEqual(escalations.map(e => [e.detail.level, e.detail.to, e.detail.businessDays, e.detail.mail]),
          [[1, ['priya@harbourfinch.example'], 6, 'accepted'], [2, ['jordan@harbourfinch.example', 'morgan@harbourfinch.example'], 7, 'accepted']]);
        const mails = h.messages.filter(m => m.subject === 'Escalated: Complete card expense evidence');
        assert.deepEqual(mails.map(m => m.to), [['priya@harbourfinch.example'], ['jordan@harbourfinch.example', 'morgan@harbourfinch.example']]);
      }
      await f.edit(kind === 'memo' ? { description: 'Reviewed client supplies' } : { fields: { [field]: 'Synthetic client' } });
      const i = (await f.detail()).items[0];
      assert.ok(i.receipt_id);
      assert.equal(kind === 'memo' ? i.description : i.fields[field], kind === 'memo' ? 'Reviewed client supplies' : 'Synthetic client');
      // A fourth configured step makes closure observable even after all earlier steps have been sent.
      await h.post(apiPath('settings', 'reminders'), { days: '1,3,5,6', quietFrom: '20', quietUntil: '8', escalateAfter: '' }, f.morgan);
      assert.deepEqual(await f.tick('2026-06-09'), [], `${kind} resolution closes the chase`);
      assert.equal((await f.reminders()).length, 3);
      if (kind === 'memo') {
        await f.tick('2026-06-15');
        assert.equal(h.messages.filter(m => m.subject === 'Escalated: Complete card expense evidence').length, 2, 'completed evidence stops escalation too');
      }
    } finally { await h.close(); }
  }
});
