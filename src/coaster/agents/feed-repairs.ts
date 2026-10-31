import { all, commit, sha256Hex, type Sql } from '../session';
import { event } from '../events';
import { now, requireThat, uid, type Actor, type Data } from '../types';
import { connectionAuthority, feed, feedState, type Feed } from '../feeds/model';
import { coverageDates } from '../feeds/health';
import { feedDate, hasCalendar } from '../feeds/calendar.mjs';

const AGENT = 'Feed repair agent', LIMIT = 31;
type Cause = 'missing-delivery' | 'recorded-failure';
type Finding = { date: string; deadline: string; health: { seq: number; at: string }; report: string };
const and = (parts: Sql[]): Sql => ({ sql: parts.map(p => `(${p.sql})`).join(' AND '), params: parts.flatMap(p => p.params) });

/** The exact source a repair stands on: the feed at its version and recorded error state, each cited missed line, and
 * still no validated delivery for its date. Both commit guards read it again; dates bind as one JSON value. */
function source(id: string, version: number, cause: Cause, findings: Finding[]): Sql {
  return and([feedState(id, version), { sql: `EXISTS(SELECT 1 FROM c_program_feeds WHERE id=? AND last_error IS ${cause === 'recorded-failure' ? 'NOT ' : ''}NULL)`, params: [id] },
    { sql: "NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM c_program_health h WHERE h.seq=json_extract(j.value,'$[1]') AND h.feed_id=? AND h.delivery_date=json_extract(j.value,'$[0]') AND h.kind='missed') OR EXISTS(SELECT 1 FROM c_program_health h WHERE h.feed_id=? AND h.delivery_date=json_extract(j.value,'$[0]') AND h.kind='covered') OR EXISTS(SELECT 1 FROM c_program_deliveries d WHERE d.feed_id=? AND d.coverage_date=json_extract(j.value,'$[0]')))", params: [JSON.stringify(findings.map(x => [x.date, x.health.seq])), id, id, id] }]);
}
const open = (id: string): Sql => ({ sql: "EXISTS(SELECT 1 FROM c_feed_repair_proposals WHERE id=? AND status='proposed')", params: [id] });

/** Recorded health and validated deliveries only. Unknown coverage stays unverified, a missing file is never zero spend
 * and a missing file is not evidence that sign-in failed; only dates with a numbered missed line can be proposed. */
export async function analyseFeed(db: D1Database, f: Feed, at = new Date()) {
  const unverifiedDeliveries = (await db.prepare('SELECT COUNT(*) AS n FROM c_program_deliveries WHERE feed_id=? AND coverage_date IS NULL').bind(f.id).first<{ n: number }>())!.n;
  const common = { feed: { id: f.id, issuer: f.issuer, version: f.version, enabled: !!f.enabled, deliveryTime: f.delivery_time, deliveryTimezone: f.delivery_timezone, graceMinutes: f.grace_minutes }, lastPollAt: f.last_success_at, error: f.last_error, unverifiedDeliveries, spend: 'unknown', action: { label: 'Review connection settings', href: '/app#/settings', automatic: false } };
  if (!hasCalendar(f)) return { ...common, coverage: 'unverified', cause: null, failure: null, findings: [] as Finding[], tracked: [] as Data[], awaiting: [] as Data[], counts: {}, deferred: 0, stamp: null, note: 'No delivery calendar is configured: coverage stays unverified, no date is treated as zero spend and no repair task can be proposed.' };
  const dates = await coverageDates(db, f, f.expected_from!, feedDate(at, f.delivery_timezone!), at);
  const missed = (await db.prepare("SELECT seq,delivery_date,at FROM c_program_health WHERE feed_id=? AND kind='missed'").bind(f.id).all<Data>()).results;
  const tasks = (await db.prepare('SELECT seq,id,delivery_date FROM c_feed_repair_tasks WHERE feed_id=?').bind(f.id).all<Data>()).results;
  const cause: Cause = f.last_error ? 'recorded-failure' : 'missing-delivery';
  const failure = f.last_error ? await db.prepare("SELECT seq,at,json_extract(detail,'$.reason') AS reason FROM c_events WHERE action='program-feed-sync-failed' AND json_extract(detail,'$.feed')=? ORDER BY seq DESC LIMIT 1").bind(f.id).first<Data>() : null;
  const findings: Finding[] = [], tracked: Data[] = [], awaiting: Data[] = [];
  for (const d of dates.filter(d => d.status === 'uncovered')) {
    const task = tasks.find(t => t.delivery_date === d.date), line = missed.find(m => m.delivery_date === d.date);
    if (task) tracked.push({ date: d.date, task: task.id, seq: task.seq });
    else if (!line) awaiting.push({ date: d.date, deadline: d.deadline });
    else findings.push({ date: d.date, deadline: d.deadline, health: { seq: line.seq, at: line.at }, report: `/api/coaster/reports/feed-coverage?from=${d.date}&to=${d.date}` });
  }
  // One proposal opens at most a month of dates; later dates are proposed once these are handled.
  const counts = Object.fromEntries(['covered', 'uncovered', 'pending', 'inactive'].map(status => [status, dates.filter(d => d.status === status).length])), deferred = Math.max(0, findings.length - LIMIT);
  findings.splice(LIMIT);
  return { ...common, coverage: 'source-period-only', cause, failure, findings, tracked, awaiting, counts, deferred,
    stamp: await sha256Hex(JSON.stringify([f.id, f.version, cause, findings.map(x => [x.date, x.deadline, x.health.seq])])),
    note: cause === 'recorded-failure' ? 'The latest scheduled run recorded an error, so Coaster cannot tell whether the issuer delivered these dates. Review the connection settings yourself; nothing reconnects automatically.' : 'The last successful directory poll found no validated delivery for these dates. A missing file does not show that sign-in or authentication failed.' };
}

const proposalView = (p: Data) => ({ id: p.id, feed: p.feed_id, feedVersion: p.feed_version, forEmail: p.for_email, agent: p.agent_label, status: p.status, createdAt: p.created_at, decidedBy: p.decided_by, decidedAt: p.decided_at, evidence: JSON.parse(p.evidence) });
const proposalRow = (db: D1Database, id: string) => db.prepare('SELECT * FROM c_feed_repair_proposals WHERE id=?').bind(id).first<Data>();
async function taskRows(db: D1Database, where: string, params: unknown[]) {
  return (await db.prepare(`SELECT t.*,r.seq AS resolution_seq,r.covered_seq,r.delivery_id,r.resolved_by,r.resolved_at,d.name AS delivery_name,d.issuer_sequence FROM c_feed_repair_tasks t LEFT JOIN c_feed_repair_resolutions r ON r.task_id=t.id LEFT JOIN c_program_deliveries d ON d.id=r.delivery_id WHERE ${where} ORDER BY t.seq LIMIT 500`).bind(...params).all<Data>()).results.map(t => ({
    seq: t.seq, id: t.id, feed: t.feed_id, feedVersion: t.feed_version, date: t.delivery_date, deadline: t.deadline, health: t.missed_seq, cause: t.cause, proposal: t.proposal_id, assignee: t.assignee, agent: t.agent_label, openedAt: t.opened_at,
    status: t.resolution_seq ? 'resolved' : 'open', resolution: t.resolution_seq ? { seq: t.resolution_seq, health: t.covered_seq, delivery: t.delivery_id, file: t.delivery_name, sequence: t.issuer_sequence, by: t.resolved_by, at: t.resolved_at } : null }));
}
async function mine(db: D1Database, actor: Actor, id: string) {
  const p = await proposalRow(db, id);
  requireThat(p, 'Repair proposal not found', 404);
  requireThat(p.for_email === actor.email, 'This repair proposal was prepared for someone else', 403);
  requireThat(p.status === 'proposed', 'This repair proposal was already decided', 409);
  return p;
}

/** Proposals the person's own analyses prepared and every feed's repair tasks, under the program-feed connection row. */
export async function feedRepairs(db: D1Database, actor: Actor) {
  connectionAuthority(actor);
  const proposals = (await db.prepare('SELECT * FROM c_feed_repair_proposals WHERE for_email=? ORDER BY created_at DESC,id LIMIT 50').bind(actor.email).all<Data>()).results;
  return { agent: AGENT, proposals: proposals.map(proposalView), tasks: await taskRows(db, '1=1', []) };
}

/** On-demand analysis for the signed-in person who may connect program feeds. The agent keeps one pending proposal per
 * feed for them: unchanged evidence returns it again and changed evidence supersedes it. */
export async function prepareFeedRepair(db: D1Database, actor: Actor, id: string) {
  const auth = connectionAuthority(actor), f = await feed(db, id);
  requireThat(f, 'Program feed not found', 404);
  requireThat(f.enabled, 'Repair tasks need a connected program feed; nothing was prepared', 409);
  const analysis = await analyseFeed(db, f);
  const pending = await db.prepare("SELECT * FROM c_feed_repair_proposals WHERE feed_id=? AND for_email=? AND status='proposed'").bind(f.id, actor.email).first<Data>();
  if (!analysis.stamp || pending?.stamp === analysis.stamp) return { analysis, proposal: pending ? proposalView(pending) : null };
  if (!pending && !analysis.findings.length) return { analysis, proposal: null };
  const at = now(), proposal = uid(), { stamp, ...evidence } = analysis, state = source(f.id, f.version, analysis.cause, analysis.findings);
  const writes = pending ? [db.prepare("UPDATE c_feed_repair_proposals SET status='superseded',decided_by=?,decided_at=? WHERE id=?").bind(actor.email, at, pending.id)] : [];
  if (analysis.findings.length) writes.push(
    db.prepare("INSERT INTO c_feed_repair_proposals(id,feed_id,feed_version,for_email,agent_label,evidence,stamp,status,created_at) VALUES(?,?,?,?,?,?,?,'proposed',?)").bind(proposal, f.id, f.version, actor.email, AGENT, JSON.stringify(evidence), stamp, at),
    event(db, actor, 'feed-repair-proposed', {}, { proposal, agent: AGENT, feed: f.id, dates: analysis.findings.map(x => x.date), cause: analysis.cause, supersedes: pending?.id ?? null }));
  else writes.push(event(db, actor, 'feed-repair-proposal-superseded', {}, { proposal: pending!.id, agent: AGENT, feed: f.id }));
  const condition = all(auth, state, pending ? open(pending.id) : { sql: "NOT EXISTS(SELECT 1 FROM c_feed_repair_proposals WHERE feed_id=? AND for_email=? AND status='proposed')", params: [f.id, actor.email] });
  condition.after = all(auth, state);
  await commit(db, condition, writes);
  return { analysis, proposal: analysis.findings.length ? proposalView((await proposalRow(db, proposal))!) : null };
}

/** Explicit native confirmation by the person the proposal was prepared for opens one task per feed and date. Person
 * decisions name the agent as `preparedBy`, so history shows them on the app channel and the preparation on the agent's. */
export async function confirmFeedRepair(db: D1Database, actor: Actor, id: string, body: Data) {
  const auth = connectionAuthority(actor), p = await mine(db, actor, id);
  requireThat(body.consent === true, 'Confirm opening these repair tasks for yourself');
  const f = await feed(db, p.feed_id);
  requireThat(f?.enabled && f.version === p.feed_version, 'The program feed changed; prepare a new repair proposal', 409);
  requireThat((await analyseFeed(db, f)).stamp === p.stamp, 'Delivery evidence changed since this proposal was prepared; prepare a new repair proposal', 409);
  const evidence = JSON.parse(p.evidence) as { cause: Cause; findings: Finding[] }, at = now();
  const writes = [db.prepare("UPDATE c_feed_repair_proposals SET status='accepted',decided_by=?,decided_at=? WHERE id=?").bind(actor.email, at, p.id)];
  for (const x of evidence.findings) {
    const task = uid();
    writes.push(db.prepare('INSERT INTO c_feed_repair_tasks(id,feed_id,feed_version,delivery_date,deadline,missed_seq,cause,proposal_id,assignee,agent_label,opened_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(task, f.id, p.feed_version, x.date, x.deadline, x.health.seq, evidence.cause, p.id, actor.email, p.agent_label, at),
      event(db, actor, 'feed-repair-task-opened', {}, { task, proposal: p.id, preparedBy: p.agent_label, feed: f.id, date: x.date, deadline: x.deadline, health: x.health.seq, cause: evidence.cause }));
  }
  const state = source(f.id, p.feed_version, evidence.cause, evidence.findings);
  const condition = all(auth, open(p.id), state, { sql: "NOT EXISTS(SELECT 1 FROM c_feed_repair_tasks t JOIN json_each(?) j ON t.delivery_date=json_extract(j.value,'$[0]') WHERE t.feed_id=?)", params: [JSON.stringify(evidence.findings.map(x => [x.date])), f.id] });
  condition.after = all(auth, state);
  await commit(db, condition, writes);
  return { proposal: proposalView((await proposalRow(db, p.id))!), tasks: await taskRows(db, 't.proposal_id=?', [p.id]) };
}

export async function declineFeedRepair(db: D1Database, actor: Actor, id: string) {
  const auth = connectionAuthority(actor), p = await mine(db, actor, id);
  await commit(db, all(auth, open(p.id)), [
    db.prepare("UPDATE c_feed_repair_proposals SET status='declined',decided_by=?,decided_at=? WHERE id=?").bind(actor.email, now(), p.id),
    event(db, actor, 'feed-repair-proposal-declined', {}, { proposal: p.id, preparedBy: p.agent_label, feed: p.feed_id }),
  ]);
  return { proposal: proposalView((await proposalRow(db, p.id))!) };
}

/** Only the assignee resolves, and only once a validated delivery of the same feed version covers the task's exact date. */
export async function resolveFeedRepair(db: D1Database, actor: Actor, id: string) {
  const auth = connectionAuthority(actor), [task] = await taskRows(db, 't.id=?', [id]);
  requireThat(task, 'Repair task not found', 404);
  requireThat(task.assignee === actor.email, 'Only the person this repair task is assigned to can resolve it', 403);
  requireThat(task.status === 'open', 'This repair task is already resolved', 409);
  const f = await feed(db, task.feed);
  requireThat(f?.enabled && f.version === task.feedVersion, 'The program feed changed; this task cannot be resolved from its evidence', 409);
  const covered = await db.prepare("SELECT h.seq,h.delivery_id FROM c_program_health h JOIN c_program_deliveries d ON d.id=h.delivery_id AND d.feed_id=h.feed_id AND d.coverage_date=h.delivery_date WHERE h.feed_id=? AND h.delivery_date=? AND h.kind='covered'").bind(task.feed, task.date).first<Data>();
  requireThat(covered, `No validated delivery covers ${task.date} yet; the repair task stays open`, 409);
  const state = and([feedState(task.feed, task.feedVersion), { sql: "EXISTS(SELECT 1 FROM c_program_health h JOIN c_program_deliveries d ON d.id=h.delivery_id AND d.feed_id=h.feed_id AND d.coverage_date=h.delivery_date WHERE h.seq=? AND h.feed_id=? AND h.delivery_date=? AND h.kind='covered' AND h.delivery_id=?)", params: [covered.seq, task.feed, task.date, covered.delivery_id] }]);
  const condition = all(auth, { sql: 'NOT EXISTS(SELECT 1 FROM c_feed_repair_resolutions WHERE task_id=?)', params: [task.id] }, state);
  condition.after = all(auth, state);
  await commit(db, condition, [
    db.prepare('INSERT INTO c_feed_repair_resolutions(task_id,covered_seq,delivery_id,resolved_by,resolved_at) VALUES(?,?,?,?,?)').bind(task.id, covered.seq, covered.delivery_id, actor.email, now()),
    event(db, actor, 'feed-repair-task-resolved', {}, { task: task.id, preparedBy: task.agent, feed: task.feed, date: task.date, delivery: covered.delivery_id, health: covered.seq }),
  ]);
  return { task: (await taskRows(db, 't.id=?', [task.id]))[0] };
}
