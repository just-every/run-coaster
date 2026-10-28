import { PortabilityError } from '@runeditrun/rer/modules/portability';

/** Pending work and attempted deliveries retain their identities; restoring must never turn an attempt back into pending mail. */
export async function validateNotificationArchive(read) {
  const [preferences, events, deliveries, history, claims, revisions, reminders] = await Promise.all([
    'c_notification_preferences', 'c_notification_events', 'c_notification_deliveries', 'c_events', 'c_claims', 'c_revisions', 'c_reminders',
  ].map(read));
  const check = ok => { if (!ok) throw new PortabilityError('coaster_notification', 409); };
  const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const text = value => typeof value === 'string' && value.length > 0;
  const mode = value => ['immediate', 'digest'].includes(value);
  const unique = (list, key) => check(new Set(list.map(key)).size === list.length);
  unique(preferences, p => p.recipient);
  unique(events, e => e.id);
  unique(events, e => JSON.stringify([e.event_id, e.recipient]));
  unique(deliveries, d => d.id);
  unique(deliveries, d => JSON.stringify([d.recipient, d.bucket]));
  for (const p of preferences) {
    check(text(p.recipient) && text(p.timezone) && p.timezone.length <= 100 && date(p.updated_at));
    try { new Intl.DateTimeFormat('en', { timeZone: p.timezone }).format(); } catch { check(false); }
    check([p.quiet_from, p.quiet_until].every(h => Number.isInteger(h) && h >= 0 && h <= 23));
    check([p.submission, p.decision, p.returned, p.reminder].every(mode));
  }
  const actions = {
    submission: ['claim-submitted', 'claim-resubmitted', 'claim-step-approved'],
    decision: ['claim-approved', 'claim-rejected'],
    return: ['claim-returned'],
  };
  for (const e of events) {
    const claim = claims.find(c => c.id === e.claim_id), source = history.find(h => h.id === e.event_id);
    const expired = !claim && history.some(h => h.claim_id === e.claim_id && h.action === 'claim-expired');
    check(text(e.id) && text(e.recipient) && mode(e.mode) && date(e.created_at));
    check(['submission', 'decision', 'return', 'reminder'].includes(e.kind));
    check(Number.isInteger(e.revision) && e.revision >= 0 && (claim ? e.revision <= claim.revision : expired));
    if (e.kind === 'reminder') check(text(e.task_key));
    else check(e.id === `${e.event_id}:${e.recipient}` && e.task_key === null);
    // Expiry removes the claim and its financial evidence, but retains deduplication identities.
    if (expired) check(e.delivery_id !== null || e.cancelled_at !== null);
    else if (e.kind !== 'reminder') {
      check(source && source.claim_id === e.claim_id && actions[e.kind]?.includes(source.action));
      check(e.created_at === source.at);
      check(revisions.some(r => r.claim_id === e.claim_id && r.revision === e.revision));
      if (['decision', 'return'].includes(e.kind)) check(e.recipient === claim.employee_email);
    } else {
      check(text(e.task_key) && reminders.some(r => r.key === e.task_key && r.person === e.recipient && r.sent_at === e.created_at && e.event_id === `reminder-${r.key}-${r.step}`));
    }
    check(e.cancelled_at === null || date(e.cancelled_at));
    check(e.delivery_id === null || deliveries.some(d => d.id === e.delivery_id && d.recipient === e.recipient && d.kind === e.mode));
    check(e.delivery_id === null || e.cancelled_at === null);
  }
  for (const d of deliveries) {
    const own = events.filter(e => e.delivery_id === d.id);
    check(text(d.id) && text(d.recipient) && text(d.bucket) && mode(d.kind) && date(d.attempted_at));
    check(['attempting', 'accepted', 'failed', 'unconfigured'].includes(d.status));
    check(d.provider_status === null || typeof d.provider_status === 'string');
    check(d.kind === 'immediate' ? own.length === 1 && d.bucket === `immediate:${own[0].id}` : /^digest:\d{4}-\d{2}-\d{2}$/.test(d.bucket) && date(`${d.bucket.slice(7)}T00:00:00.000Z`));
    check(Number.isInteger(d.event_count) && d.event_count > 0 && own.length >= d.event_count);
  }
}
