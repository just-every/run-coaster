import { all, commit, type Sql } from '../session';
import { ruleEvent } from '../events';
import { isoDate, requireThat, type Data } from '../types';
import { nextDay } from '../audit';
import { deadline, deliveryPeriod, expectedAt, feedDate, hasCalendar } from './calendar.mjs';
export { deliveryPeriod } from './calendar.mjs';
import { feedState, type Feed } from './model';

export function calendarInput(body: Data) {
  if (!body.deliveryTime && !body.deliveryTimezone && body.graceMinutes == null && !body.expectedFrom) return { time: null, zone: null, grace: null, from: null };
  requireThat(typeof body.deliveryTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.deliveryTime), 'Give the daily delivery time as HH:MM');
  requireThat(typeof body.deliveryTimezone === 'string' && body.deliveryTimezone.length <= 100, 'Choose an IANA delivery time zone');
  try { new Intl.DateTimeFormat('en', { timeZone: body.deliveryTimezone }); } catch { requireThat(false, 'Choose an IANA delivery time zone'); }
  requireThat(Number.isSafeInteger(body.graceMinutes) && body.graceMinutes >= 0 && body.graceMinutes <= 1440, 'Give a grace period from zero to 1440 minutes');
  const first=isoDate(body.expectedFrom,'First expected delivery date');
  requireThat(Math.abs(Date.parse(first)-Date.now())<=366*86_400_000,'Choose a first expected delivery date within one year of today');
  return { time: body.deliveryTime as string, zone: body.deliveryTimezone as string, grace: body.graceMinutes as number, from: first };
}

export async function coverageDates(db: D1Database, f: Feed, from: string, to: string, at: Date) {
  const deliveries = (await db.prepare('SELECT id,name,coverage_date,received_at FROM c_program_deliveries WHERE feed_id=? AND coverage_date>=? AND coverage_date<=? AND received_at<=? ORDER BY received_at,id').bind(f.id, from, to, at.toISOString()).all<Data>()).results;
  const rows: Data[] = [];
  const stopped = f.disconnected_at ? Date.parse(f.disconnected_at) : Infinity;
  for (let date = from; date <= to; date = nextDay(date)) {
    const file = deliveries.find(d => d.coverage_date === date);
    const due = hasCalendar(f) ? deadline(f, date) : null;
    const status = !hasCalendar(f) || date < f.expected_from! ? 'unverified' : file ? 'covered' : due! > stopped ? 'inactive' : due! <= at.getTime() ? 'uncovered' : 'pending';
    rows.push({ date, status, deadline: due === null ? null : new Date(due).toISOString(), file: file?.name ?? null, delivery: file?.id ?? null });
  }
  return rows;
}

export async function feedHealth(db: D1Database, f: Feed, at = new Date()) {
  const last = await db.prepare('SELECT name,received_at,coverage_date FROM c_program_deliveries WHERE feed_id=? ORDER BY received_at DESC,id DESC LIMIT 1').bind(f.id).first<Data>();
  const history = (await db.prepare('SELECT * FROM c_program_health WHERE feed_id=? ORDER BY seq').bind(f.id).all()).results;
  if (!hasCalendar(f)) return { lastPollAt: f.last_success_at, lastFile: last, nextExpected: null, missedDates: [], coverage: 'unverified', history };
  const today = feedDate(at, f.delivery_timezone!);
  const dates = await coverageDates(db, f, f.expected_from!, today, at);
  let next = today < f.expected_from! ? f.expected_from! : today;
  if (expectedAt(next, f.delivery_time!, f.delivery_timezone!) <= at.getTime() || dates.some(d=>d.date===next && d.status==='covered')) next = nextDay(next);
  return { lastPollAt: f.last_success_at, lastFile: last, nextExpected: f.enabled ? { date: next, at: new Date(expectedAt(next, f.delivery_time!, f.delivery_timezone!)).toISOString(), deadline: new Date(deadline(f, next)).toISOString() } : null, missedDates: dates.filter(d => d.status === 'uncovered').map(d => d.date), coverage: 'source-period-only', history };
}

export function coverageWrites(db: D1Database, f: Feed, date: string, delivery: string, at: Date) {
  return [
    db.prepare("INSERT INTO c_program_health(feed_id,delivery_date,kind,delivery_id,at) VALUES(?,?,'covered',?,?)").bind(f.id, date, delivery, at.toISOString()),
    ruleEvent(db, 'automation: program feed', 'program-feed-date-covered', {}, { feed: f.id, date, delivery, channel: 'schedule' }),
  ];
}

/** Record each newly missed date once, even across tick replay; authority is fenced at both transaction boundaries. */
export async function recordMisses(db: D1Database, f: Feed, at: Date, guard: Sql = feedState(f.id, f.version)) {
  if (!hasCalendar(f)) return;
  const dates = await coverageDates(db, f, f.expected_from!, feedDate(at, f.delivery_timezone!), at);
  const known = new Set((await db.prepare("SELECT delivery_date FROM c_program_health WHERE feed_id=? AND kind='missed'").bind(f.id).all<{delivery_date:string}>()).results.map(r => r.delivery_date));
  for (const row of dates.filter(row => row.status === 'uncovered' && !known.has(row.date))) {
    const absent: Sql = { sql: "NOT EXISTS(SELECT 1 FROM c_program_health WHERE feed_id=? AND delivery_date=? AND kind='missed') AND NOT EXISTS(SELECT 1 FROM c_program_deliveries WHERE feed_id=? AND coverage_date=?)", params: [f.id, row.date, f.id, row.date] };
    await commit(db, all(guard, absent), [db.prepare("INSERT INTO c_program_health(feed_id,delivery_date,kind,delivery_id,at) VALUES(?,?,'missed',NULL,?)").bind(f.id, row.date, at.toISOString()), ruleEvent(db, 'automation: program feed', 'program-feed-date-missed', {}, { feed: f.id, date: row.date, deadline: row.deadline, channel: 'schedule' })]);
  }
}
