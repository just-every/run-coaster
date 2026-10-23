import { commit, authority, need, notDeactivated } from './session';
import { event, ruleEvent } from './events';
import { business } from './settings';
import { REPORTS, isReport, localDate, reportCsv, runReport } from './reports';
import { businessDayOfMonth } from './business-days';
import { operatorMail } from '../mail.server.mjs';
import type { Bindings } from '../auth.server';
import { email, now, requireThat, uid, type Actor, type Data } from './types';

export const CADENCES = { 'last-business-day': 'Last US business day of each month, month to date', 'first-business-day': 'First US business day of each month, for the month before' } as const;
/** Deliveries go out on the first hourly run at or after this hour in the business time zone. */
const SEND_HOUR = 8;

const owner = "EXISTS(SELECT 1 FROM oa_operators o WHERE lower(o.email)=? AND o.role='owner' AND o.status='active')";
/** Only people who may run reports receive them: active finance members and auditors whose sign-in account is not
 * deactivated, and the owner. Each delivery checks its recipients again just before it is sent. */
const readsReports = async (db: D1Database, address: string) => !!await db.prepare(`SELECT 1 WHERE EXISTS(SELECT 1 FROM c_members WHERE email=? AND active=1 AND (is_finance=1 OR is_auditor=1) AND ${notDeactivated('c_members.email')}) OR ${owner}`).bind(address, address).first();

export async function reportSchedules(db: D1Database) {
  const { results } = await db.prepare('SELECT s.*,(SELECT MAX(delivered_at) FROM c_report_deliveries d WHERE d.schedule_id=s.id) AS last_delivered_at FROM c_report_schedules s ORDER BY s.created_at').all<Data>();
  return results.map(s => ({ ...s, recipients: JSON.parse(s.recipients) }) as Data);
}

/** Finance or the owner schedules a report for chosen readers; only the owner may opt a schedule in to sending the figures. */
export async function scheduleReport(db: D1Database, actor: Actor, b: Data) {
  requireThat(actor.roles.finance || actor.roles.owner, 'Finance or owner access required', 403);
  requireThat(actor.kind === 'person', 'Only a person schedules a report', 403);
  requireThat(isReport(b.report), 'Choose a report');
  requireThat(Object.hasOwn(CADENCES, b.cadence), 'Choose when to send it');
  const recipients = [...new Set((Array.isArray(b.recipients) ? b.recipients : String(b.recipients ?? '').split(',')).map(x => String(x).trim()).filter(Boolean).map(x => email(x, 'Recipient')))];
  requireThat(recipients.length >= 1 && recipients.length <= 20, 'Name one to 20 recipients');
  for (const address of recipients) requireThat(await readsReports(db, address), `${address} cannot receive reports: only finance, auditors and the owner do`);
  const figures = b.includeFigures === true || b.includeFigures === 'true' || b.includeFigures === 'on';
  requireThat(!figures || actor.roles.owner, 'Only the owner can send report figures by email', 403);
  const id = uid();
  await commit(db, authority(actor, actor.roles.owner ? 'owner' : 'finance'), [
    db.prepare('INSERT INTO c_report_schedules(id,report,cadence,recipients,include_figures,created_by,created_at) VALUES(?,?,?,?,?,?,?)').bind(id, b.report, b.cadence, JSON.stringify(recipients), figures ? 1 : 0, actor.delegate?.email ?? actor.email, now()),
    event(db, actor, 'report-scheduled', {}, { schedule: id, report: b.report, cadence: b.cadence, recipients, includeFigures: figures }),
  ]);
  return reportSchedules(db);
}

export async function stopReportSchedule(db: D1Database, actor: Actor, id: string) {
  requireThat(actor.roles.finance || actor.roles.owner, 'Finance or owner access required', 403);
  const schedule = await db.prepare('SELECT id,report FROM c_report_schedules WHERE id=? AND stopped_at IS NULL').bind(id).first<Data>();
  requireThat(schedule, 'Schedule not found', 404);
  await commit(db, authority(actor, actor.roles.owner ? 'owner' : 'finance'), [
    db.prepare('UPDATE c_report_schedules SET stopped_by=?,stopped_at=? WHERE id=? AND stopped_at IS NULL').bind(actor.delegate?.email ?? actor.email, now(), id),
    event(db, actor, 'report-schedule-stopped', {}, { schedule: id, report: schedule.report }),
  ]);
  return reportSchedules(db);
}

const localHour = (at: Date, timezone: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(at));

/** The hourly run: every running schedule whose day it is in the business time zone sends once for its period, from
 * 08:00. The delivery row claims the period before the mail goes, so a period is never sent twice. */
export async function deliverReports(env: Bindings, at: Date) {
  const db = env.DB, settings = await business(db);
  if (!settings || localHour(at, settings.timezone) < SEND_HOUR) return;
  const day = localDate(at.toISOString(), settings.timezone);
  for (const schedule of (await reportSchedules(db)).filter(s => !s.stopped_at)) {
    const first = schedule.cadence === 'first-business-day';
    if (businessDayOfMonth(day, first ? 'first' : 'last') !== day) continue;
    const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)) - 1, utc = (d: number, n: number) => new Date(Date.UTC(y, d, n)).toISOString().slice(0, 10);
    const [from, to] = first ? [utc(m - 1, 1), utc(m, 0)] : [utc(m, 1), day];
    const recipients: string[] = [];
    for (const address of schedule.recipients) if (await readsReports(db, address)) recipients.push(address);
    const claimed = await db.prepare('INSERT INTO c_report_deliveries(schedule_id,period_from,period_to,delivered_at,recipients) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING schedule_id').bind(schedule.id, from, to, at.toISOString(), JSON.stringify(recipients)).first();
    if (!claimed) continue;
    // By default the mail carries the report's name, period and a link that needs a Coaster sign-in; the figures go
    // as a CSV attachment only on a schedule the owner opted in.
    const title = REPORTS[schedule.report as keyof typeof REPORTS], link = `${env.AUTH_ORIGIN}/api/coaster/reports/${schedule.report}?from=${from}&to=${to}&format=csv`;
    const figures = schedule.include_figures === 1, words = `${title} for ${settings.name}, ${from} to ${to}, is ready. ${figures ? 'The figures are attached as CSV; s' : 'S'}ign in to Coaster to download it: ${link}`;
    const attachments = figures ? [{ filename: `coaster-${schedule.report}-${from}-to-${to}.csv`, contentType: 'text/csv', content: new TextEncoder().encode(reportCsv(await runReport(db, settings, schedule.report, from, to, day))) }] : undefined;
    const mail = operatorMail(env);
    const sent = recipients.length && mail ? await mail.send({ deliveryId: `${schedule.id}-${from}`, from: env.MAIL_FROM ?? '', to: recipients, subject: `${title}: ${from} to ${to}`, text: words, ...(attachments ? { attachments } : {}), html: `<p>${words.replace(link, '')}<a href="${link.replaceAll('&', '&amp;')}">${link.replaceAll('&', '&amp;')}</a></p>`, headers: {} }) : null;
    await ruleEvent(db, 'report schedule', 'report-delivered', {}, { schedule: schedule.id, report: schedule.report, from, to, recipients, figures, mail: !recipients.length ? 'no recipient can read reports' : sent?.status ?? 'mail not set up' }).run();
  }
}
