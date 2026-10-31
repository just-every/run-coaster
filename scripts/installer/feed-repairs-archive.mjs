import { PortabilityError } from '@runeditrun/rer/modules/portability';
import { deadline, hasCalendar } from '../../src/coaster/feeds/calendar.mjs';

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const json = value => { try { return JSON.parse(value); } catch { return null; } };

/** Every repair task cites a recorded miss of its feed and calendar; a resolution cites the validated delivery of that exact date. */
export async function validateFeedRepairArchive(read) {
  const check = value => { if (!value) throw new PortabilityError('coaster_feed_repairs',409); };
  const [feeds,health,deliveries,proposals,tasks,resolutions,events] = await Promise.all(['c_program_feeds','c_program_health','c_program_deliveries','c_feed_repair_proposals','c_feed_repair_tasks','c_feed_repair_resolutions','c_events'].map(read));
  const history = (action, key, id) => events.some(e => e.action === action && json(e.detail)?.[key] === id);
  const missed = (f, date, seq) => health.some(h => h.seq === seq && h.feed_id === f.id && h.delivery_date === date && h.kind === 'missed' && Date.parse(h.at) >= deadline(f, date));
  for (const p of proposals) {
    const f = feeds.find(f => f.id === p.feed_id), evidence = json(p.evidence);
    check(f && hasCalendar(f) && Number.isSafeInteger(p.feed_version) && p.feed_version > 0 && p.feed_version <= f.version && typeof p.for_email === 'string' && p.for_email && p.agent_label === 'Feed repair agent' && /^[0-9a-f]{64}$/.test(p.stamp) && timestamp(p.created_at));
    check(['proposed','accepted','declined','superseded'].includes(p.status) && (p.status === 'proposed' ? p.decided_by === null && p.decided_at === null : p.decided_by === p.for_email && timestamp(p.decided_at)));
    check(evidence && ['missing-delivery','recorded-failure'].includes(evidence.cause) && Array.isArray(evidence.findings) && evidence.findings.length > 0 && evidence.findings.length <= 31 && new Set(evidence.findings.map(x => x.date)).size === evidence.findings.length);
    for (const x of evidence.findings) check(validDate(x?.date) && x.deadline === new Date(deadline(f, x.date)).toISOString() && missed(f, x.date, x.health?.seq));
    check(history('feed-repair-proposed', 'proposal', p.id));
    const own = tasks.filter(t => t.proposal_id === p.id);
    check(p.status === 'accepted' ? own.length === evidence.findings.length && history('feed-repair-task-opened', 'proposal', p.id) : own.length === 0);
  }
  check(new Set(proposals.filter(p => p.status === 'proposed').map(p => p.feed_id+'|'+p.for_email)).size === proposals.filter(p => p.status === 'proposed').length);
  check(new Set(tasks.map(t => t.seq)).size === tasks.length && new Set(tasks.map(t => t.id)).size === tasks.length && new Set(tasks.map(t => t.feed_id+'|'+t.delivery_date)).size === tasks.length);
  for (const t of tasks) {
    const f = feeds.find(f => f.id === t.feed_id), p = proposals.find(p => p.id === t.proposal_id), finding = json(p?.evidence)?.findings?.find(x => x.date === t.delivery_date);
    check(f && p && finding && Number.isSafeInteger(t.seq) && t.seq > 0 && p.feed_id === t.feed_id && p.feed_version === t.feed_version && p.status === 'accepted' && t.assignee === p.for_email && t.agent_label === p.agent_label && t.opened_at === p.decided_at);
    check(t.cause === json(p.evidence).cause && t.deadline === finding.deadline && t.missed_seq === finding.health.seq && missed(f, t.delivery_date, t.missed_seq) && history('feed-repair-task-opened', 'task', t.id));
  }
  check(new Set(resolutions.map(r => r.seq)).size === resolutions.length);
  for (const r of resolutions) {
    const t = tasks.find(t => t.id === r.task_id), d = deliveries.find(d => d.id === r.delivery_id);
    check(t && d && Number.isSafeInteger(r.seq) && r.seq > 0 && r.resolved_by === t.assignee && timestamp(r.resolved_at) && Date.parse(r.resolved_at) >= Date.parse(t.opened_at) && d.feed_id === t.feed_id && d.coverage_date === t.delivery_date);
    check(health.some(h => h.seq === r.covered_seq && h.feed_id === t.feed_id && h.delivery_date === t.delivery_date && h.kind === 'covered' && h.delivery_id === d.id) && history('feed-repair-task-resolved', 'task', t.id));
  }
}
