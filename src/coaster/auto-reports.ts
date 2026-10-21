import { policyConfiguration } from './policy-configuration';
import { all, authority, commit, need } from './session';
import { needRow, rowAuthority } from './permissions';
import { event, ruleEvent } from './events';
import { business, requireBusiness, type Business } from './settings';
import { localDate } from './reports';
import { localHour } from './reminders';
import { isBusinessDay } from './business-days';
import { claimItems, claimState, claimTotal, insertClaim, loadClaim, saveItem, submitScheduled, uploadReceipt, type Claim } from './claims';
import { categories } from './items';
import { findExceptions, missingFields, repeatedInClaim } from './exceptions';
import { moveItems } from './holds';
import { linkableRequest } from './requests';
import { isoDate, now, requireThat, uid, type Actor, type Data } from './types';
import type { Bindings } from '../auth.server';

/** Automatic reports and scheduled submission (AUTO-001). Card-statement reports join with FEED-005. */
const SCHEDULES = ['daily', 'weekly', 'twice-monthly', 'monthly'];
/** The name scheduled submissions are recorded under. */
export const SCHEDULE = 'schedule';
/** Scheduled submission runs at the first hourly run at or after this hour (business time zone). */
const SUBMIT_HOUR = 9;

/** The owner sets how often automatic reports submit, or turns it off. */
export async function saveAutoSubmit(db: D1Database, actor: Actor, b: Data) {
  needRow(actor, 'settings');
  requireThat(actor.kind === 'person', 'Only a person changes scheduled submission', 403);
  await requireBusiness(db);
  const schedule = b.schedule === undefined || b.schedule === null || b.schedule === '' ? null : String(b.schedule);
  requireThat(schedule === null || SCHEDULES.includes(schedule), 'Submit daily, weekly, twice monthly or monthly, or turn it off');
  await commit(db, rowAuthority(actor, 'settings'), [db.prepare('UPDATE c_business SET auto_submit=?,updated_at=? WHERE id=1').bind(schedule, now()), event(db, actor, 'auto-submit-set', {}, { schedule })]);
  return { schedule };
}

/** An expense added without choosing a claim goes into the employee's open automatic report: the one for the approved
 * spend request (trip) it is linked to, otherwise the one for its expense date's calendar month; one is opened when none is. */
export async function addExpense(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'employee');
  requireThat(actor.kind === 'person', 'Agents prepare proposals; the employee adds expenses', 403);
  const settings = await requireBusiness(db), date = isoDate(b.date, 'Expense date');
  const request = await linkableRequest(db, actor.email, b.request);
  const key = request ? `trip:${request}` : `month:${date.slice(0, 7)}`;
  const title = request ? (await db.prepare('SELECT title FROM c_requests WHERE id=?').bind(request).first<{ title: string }>())!.title : `Expenses · ${date.slice(0, 7)}`;
  let id = (await db.prepare("SELECT id FROM c_claims WHERE employee_email=? AND auto_key=? AND status='draft' ORDER BY number DESC LIMIT 1").bind(actor.email, key).first<{ id: string }>())?.id;
  if (!id) {
    id = uid();
    await commit(db, authority(actor, 'employee'), [insertClaim(db, id, actor.email, title, settings.currency, null), db.prepare('UPDATE c_claims SET auto_key=? WHERE id=?').bind(key, id), event(db, actor, 'claim-created', { claim: id }, { title, automatic: key })]);
  }
  let claim = await loadClaim(db, id), receipt: string | null = null;
  if (b.receiptFile) ({ claim, receipt } = await uploadReceipt(db, actor, id, { ...b.receiptFile, version: claim.version }));
  return saveItem(db, actor, id, { ...b, receiptFile: undefined, item: undefined, version: claim.version, receipt });
}

const next = (day: string) => new Date(Date.parse(day + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
const firstBusinessDayFrom = (day: string) => { while (!isBusinessDay(day)) day = next(day); return day; };
/** Daily is every US business day; weekly the first business day of each Monday-to-Sunday week; monthly the first business
 * day of the month; twice monthly that and the first business day on or after the 16th. */
export function scheduledOn(day: string, schedule: NonNullable<Business['auto_submit']>) {
  if (schedule === 'daily') return isBusinessDay(day);
  const monday = new Date(Date.parse(day + 'T00:00:00Z') - ((new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
  if (schedule === 'weekly') return firstBusinessDayFrom(monday) === day;
  const month = firstBusinessDayFrom(day.slice(0, 8) + '01') === day;
  return schedule === 'monthly' ? month : month || firstBusinessDayFrom(day.slice(0, 8) + '16') === day;
}

/** Why an expense cannot go yet: an unexplained policy exception, a blank required field or a repeat on the claim. */
function incomplete(claim: Claim, items: Data[], exceptions: Data[], known: Awaited<ReturnType<typeof categories>>) {
  const repeated = new Set(repeatedInClaim(claim.employee_email, items as never).map(i => i.id));
  return items.map(item => ({ item, reasons: [
    ...exceptions.filter(e => e.item === item.id && (e.hard || !item.explanation)).map(e => e.message),
    ...missingFields([item as never], known).map(f => `Fill in ${f}`),
    ...(repeated.has(item.id) ? ['Appears twice on this report'] : []),
  ] })).filter(x => x.reasons.length);
}

/** On a scheduled day at or after 9:00 (business time zone), once: each automatic report's complete expenses are
 * submitted to the employee's approver, recorded as "schedule"; incomplete ones move to a new automatic report for the
 * same month or trip, where FOLLOWUP-001 keeps reminding about them. Claims built by hand are never submitted for anyone. */
export async function runAutoSubmit(env: Bindings, at: Date) {
  const db = env.DB, settings = await business(db);
  if (!settings?.auto_submit) return;
  const day = localDate(at.toISOString(), settings.timezone);
  if (localHour(at, settings.timezone) < SUBMIT_HOUR || !scheduledOn(day, settings.auto_submit)) return;
  if (!await db.prepare('INSERT INTO c_auto_runs(day,ran_at) VALUES(?,?) ON CONFLICT DO NOTHING RETURNING day').bind(day, at.toISOString()).first()) return;
  const { categories: known } = await policyConfiguration(db, settings, await categories(db));
  const drafts = (await db.prepare("SELECT * FROM c_claims WHERE status='draft' AND auto_key IS NOT NULL ORDER BY number").all<Claim & { auto_key: string }>()).results;
  for (const claim of drafts) {
    const items = await claimItems(db, claim.id);
    if (!items.length) continue;
    const held = incomplete(claim, items, await findExceptions(db, claim, items, settings, known), known);
    if (held.length === items.length) continue;
    if (held.length) {
      const rest = uid();
      await commit(db, all({ sql: '1', params: [] }, claimState(claim.id, claim.version, ['draft'])), [
        insertClaim(db, rest, claim.employee_email, claim.title, claim.currency, null), db.prepare('UPDATE c_claims SET auto_key=? WHERE id=?').bind(claim.auto_key, rest),
        ...moveItems(db, held.map(h => h.item), claim.id, rest), claimTotal(db, rest), claimTotal(db, claim.id),
        ruleEvent(db, SCHEDULE, 'auto-report-split', { claim: claim.id }, { heldClaim: rest, held: held.map(h => ({ item: h.item.id, merchant: h.item.merchant, reasons: h.reasons })) }),
        ruleEvent(db, SCHEDULE, 'claim-created', { claim: rest }, { title: claim.title, automatic: claim.auto_key, from: claim.id }),
      ]);
    }
    try { await submitScheduled(db, claim.id, SCHEDULE, env.COASTER_RECEIPTS); }
    catch (error) { await ruleEvent(db, SCHEDULE, 'auto-submit-failed', { claim: claim.id }, { reason: (error as Error).message }).run(); }
  }
}
