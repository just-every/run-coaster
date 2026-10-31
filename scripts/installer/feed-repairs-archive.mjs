import { PortabilityError } from '@runeditrun/rer/modules/portability';
import { deadline, hasCalendar } from '../../src/coaster/feeds/calendar.mjs';

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const json = value => { try { return JSON.parse(value); } catch { return null; } };
/** A history line's detail holds exactly these fields with these values. */
const exactly = (detail, fields) => !!detail && Object.keys(detail).length === Object.keys(fields).length && Object.entries(fields).every(([key, value]) => JSON.stringify(detail[key]) === JSON.stringify(value));

/** Every repair task cites a recorded miss of its feed and calendar; a resolution cites the validated delivery of that exact date.
 * Each proposal, decision, task and resolution has exactly one history line, written by the person its record names and
 * holding exactly its record's details, and no repair history line stands without its record. */
export async function validateFeedRepairArchive(read) {
  const check = value => { if (!value) throw new PortabilityError('coaster_feed_repairs',409); };
  const [feeds,health,deliveries,proposals,tasks,resolutions,events] = await Promise.all(['c_program_feeds','c_program_health','c_program_deliveries','c_feed_repair_proposals','c_feed_repair_tasks','c_feed_repair_resolutions','c_events'].map(read));
  const lines = events.filter(e => typeof e.action === 'string' && e.action.startsWith('feed-repair-')), attested = new Set();
  const named = (action, key, id) => lines.filter(e => e.action === action && json(e.detail)?.[key] === id);
  const attest = (found, actor, fields) => {
    check(found.length === 1 && found[0].actor_email === actor && found[0].claim_id == null && found[0].batch_id == null && exactly(json(found[0].detail), fields));
    attested.add(found[0]);
  };
  const missed = (f, date, seq) => health.some(h => h.seq === seq && h.feed_id === f.id && h.delivery_date === date && h.kind === 'missed' && Date.parse(h.at) >= deadline(f, date));
  for (const p of proposals) {
    const f = feeds.find(f => f.id === p.feed_id), evidence = json(p.evidence);
    check(f && hasCalendar(f) && Number.isSafeInteger(p.feed_version) && p.feed_version > 0 && p.feed_version <= f.version && typeof p.for_email === 'string' && p.for_email && p.agent_label === 'Feed repair agent' && /^[0-9a-f]{64}$/.test(p.stamp) && timestamp(p.created_at));
    check(['proposed','accepted','declined','superseded'].includes(p.status) && (p.status === 'proposed' ? p.decided_by === null && p.decided_at === null : p.decided_by === p.for_email && timestamp(p.decided_at)));
    check(evidence && ['missing-delivery','recorded-failure'].includes(evidence.cause) && Array.isArray(evidence.findings) && evidence.findings.length > 0 && evidence.findings.length <= 31 && new Set(evidence.findings.map(x => x.date)).size === evidence.findings.length);
    for (const x of evidence.findings) check(validDate(x?.date) && x.deadline === new Date(deadline(f, x.date)).toISOString() && missed(f, x.date, x.health?.seq));
    // A proposal that replaced the person's pending one names it; that one was superseded by them at this proposal's creation.
    const proposed = named('feed-repair-proposed', 'proposal', p.id), supersedes = json(proposed[0]?.detail)?.supersedes ?? null, earlier = proposals.find(s => s.id === supersedes);
    check(supersedes === null || earlier && earlier.status === 'superseded' && earlier.feed_id === p.feed_id && earlier.for_email === p.for_email && earlier.decided_at === p.created_at);
    attest(proposed, p.for_email, { proposal: p.id, agent: p.agent_label, feed: p.feed_id, dates: evidence.findings.map(x => x.date), cause: evidence.cause, supersedes });
    if (p.status === 'declined') attest(named('feed-repair-proposal-declined', 'proposal', p.id), p.decided_by, { proposal: p.id, preparedBy: p.agent_label, feed: p.feed_id });
    if (p.status === 'superseded') {
      const closed = named('feed-repair-proposal-superseded', 'proposal', p.id);
      check(closed.length + lines.filter(e => e.action === 'feed-repair-proposed' && json(e.detail)?.supersedes === p.id).length === 1);
      if (closed.length) attest(closed, p.decided_by, { proposal: p.id, agent: p.agent_label, feed: p.feed_id });
    }
    const own = tasks.filter(t => t.proposal_id === p.id);
    check(p.status === 'accepted' ? own.length === evidence.findings.length : own.length === 0);
  }
  check(new Set(proposals.filter(p => p.status === 'proposed').map(p => p.feed_id+'|'+p.for_email)).size === proposals.filter(p => p.status === 'proposed').length);
  check(new Set(tasks.map(t => t.seq)).size === tasks.length && new Set(tasks.map(t => t.id)).size === tasks.length && new Set(tasks.map(t => t.feed_id+'|'+t.delivery_date)).size === tasks.length);
  for (const t of tasks) {
    const f = feeds.find(f => f.id === t.feed_id), p = proposals.find(p => p.id === t.proposal_id), finding = json(p?.evidence)?.findings?.find(x => x.date === t.delivery_date);
    check(f && p && finding && Number.isSafeInteger(t.seq) && t.seq > 0 && p.feed_id === t.feed_id && p.feed_version === t.feed_version && p.status === 'accepted' && t.assignee === p.for_email && t.agent_label === p.agent_label && t.opened_at === p.decided_at);
    check(t.cause === json(p.evidence).cause && t.deadline === finding.deadline && t.missed_seq === finding.health.seq && missed(f, t.delivery_date, t.missed_seq));
    attest(named('feed-repair-task-opened', 'task', t.id), t.assignee, { task: t.id, proposal: p.id, preparedBy: p.agent_label, feed: t.feed_id, date: t.delivery_date, deadline: t.deadline, health: t.missed_seq, cause: t.cause });
  }
  check(new Set(resolutions.map(r => r.seq)).size === resolutions.length);
  for (const r of resolutions) {
    const t = tasks.find(t => t.id === r.task_id), d = deliveries.find(d => d.id === r.delivery_id);
    check(t && d && Number.isSafeInteger(r.seq) && r.seq > 0 && r.resolved_by === t.assignee && timestamp(r.resolved_at) && Date.parse(r.resolved_at) >= Date.parse(t.opened_at) && d.feed_id === t.feed_id && d.coverage_date === t.delivery_date);
    check(health.some(h => h.seq === r.covered_seq && h.feed_id === t.feed_id && h.delivery_date === t.delivery_date && h.kind === 'covered' && h.delivery_id === d.id));
    attest(named('feed-repair-task-resolved', 'task', t.id), r.resolved_by, { task: t.id, preparedBy: t.agent_label, feed: t.feed_id, date: t.delivery_date, delivery: d.id, health: r.covered_seq });
  }
  check(lines.every(e => attested.has(e)));
}
