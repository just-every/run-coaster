import { authority, commit } from './session';
import { event, ruleEvent } from './events';
import { business, requireBusiness, type Business } from './settings';
import { claimNumber } from './claims';
import { localDate } from './reports';
import { businessDaysBetween, isBusinessDay } from './business-days';
import { operatorMail } from '../mail.server.mjs';
import { escalate } from './escalations';
import type { Bindings } from '../auth.server';
import { now, requireThat, type Actor, type Data } from './types';

/** One open item a person owes, keyed so that a new revision, approver or edit starts its own reminder sequence. */
type Open = { key: string; person: string; claim: string; number: number; title: string; action: string };

/** Everything someone owes today: receipts a draft still needs, unsubmitted claims, held claims (APPROVE-005), open
 * questions (APPROVE-006) and claims waiting for their approver. Anything resolved simply stops being open. */
export async function openItems(db: D1Database, settings: Business): Promise<Open[]> {
  const [receipts, unsubmitted, held, questions, decisions] = await db.batch([
    db.prepare("SELECT i.id,i.merchant,c.id AS claim,c.number,c.title,c.employee_email FROM c_items i JOIN c_claims c ON c.id=i.claim_id WHERE c.status IN ('draft','returned') AND i.kind='receipt' AND i.receipt_id IS NULL AND (i.amount_minor>? OR EXISTS(SELECT 1 FROM c_allocations a JOIN c_categories g ON g.id=a.category_id WHERE a.item_id=i.id AND g.receipt_always=1))").bind(settings.receipt_threshold_minor),
    db.prepare("SELECT id,number,title,employee_email,revision FROM c_claims c WHERE status IN ('draft','returned') AND NOT (held_from IS NOT NULL AND revision=0) AND EXISTS(SELECT 1 FROM c_items i WHERE i.claim_id=c.id)"),
    db.prepare("SELECT id,number,title,employee_email FROM c_claims WHERE held_from IS NOT NULL AND status='returned' AND revision=0"),
    db.prepare('SELECT q.id,q.asks_email,c.id AS claim,c.number,c.title FROM c_comments q JOIN c_claims c ON c.id=q.claim_id WHERE q.asks_email IS NOT NULL AND NOT EXISTS(SELECT 1 FROM c_comments r WHERE r.parent_id=q.id AND (r.author_email=q.asks_email OR r.on_behalf_of=q.asks_email))'),
    db.prepare("SELECT id,number,title,approver_email,revision FROM c_claims WHERE status='submitted' AND approver_email IS NOT NULL"),
  ]);
  const rows = (r: D1Result) => r.results as Data[];
  return [
    ...rows(receipts).map(r => ({ key: `receipt:${r.id}`, person: r.employee_email, claim: r.claim, number: r.number, title: r.title, action: `Attach the receipt for ${r.merchant}` })),
    ...rows(unsubmitted).map(r => ({ key: `unsubmitted:${r.id}:${r.revision}`, person: r.employee_email, claim: r.id, number: r.number, title: r.title, action: `Submit ${claimNumber(r.number)}` })),
    ...rows(held).map(r => ({ key: `held:${r.id}`, person: r.employee_email, claim: r.id, number: r.number, title: r.title, action: `Answer the hold on ${claimNumber(r.number)}` })),
    ...rows(questions).map(r => ({ key: `question:${r.id}`, person: r.asks_email, claim: r.claim, number: r.number, title: r.title, action: `Answer the question on ${claimNumber(r.number)}` })),
    ...rows(decisions).map(r => ({ key: `decision:${r.id}:${r.revision}:${r.approver_email}`, person: r.approver_email, claim: r.id, number: r.number, title: r.title, action: `Decide ${claimNumber(r.number)}` })),
  ];
}

/** Finance sets after how many business days an open item is chased (up to five rising steps), the quiet hours, the
 * approval service level and the escalation gap (FOLLOWUP-002; empty turns escalation off). */
export async function saveReminderSettings(db: D1Database, actor: Actor, b: Data) {
  requireThat(actor.roles.finance || actor.roles.owner, 'Finance or owner access required', 403);
  requireThat(actor.kind === 'person', 'Only a person changes reminders', 403);
  await requireBusiness(db);
  const days = String(b.days ?? '').split(',').map(x => x.trim()).filter(Boolean).map(Number);
  requireThat(days.length >= 1 && days.length <= 5 && days.every((d, i) => Number.isInteger(d) && d >= 1 && d <= 60 && (i === 0 || d > days[i - 1])), 'Reminders take one to five rising whole numbers of business days from 1 to 60, such as 2, 5, 10');
  const hour = (v: unknown, label: string) => { const n = Number(v); requireThat(String(v ?? '').trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 23, `${label} must be an hour from 0 to 23`); return n; };
  const quietFrom = hour(b.quietFrom, 'Quiet from'), quietUntil = hour(b.quietUntil, 'Quiet until');
  const span = (v: unknown, label: string) => { const n = Number(v); requireThat(Number.isInteger(n) && n >= 1 && n <= 30, `${label} must be a whole number of business days from 1 to 30`); return n; };
  const serviceLevel = b.serviceLevel === undefined ? 3 : span(b.serviceLevel, 'Approval service level');
  const escalateAfter = b.escalateAfter === undefined ? 2 : String(b.escalateAfter).trim() === '' ? null : span(b.escalateAfter, 'Escalate after');
  await commit(db, authority(actor, actor.roles.owner ? 'owner' : 'finance'), [
    db.prepare('UPDATE c_business SET reminder_days=?,quiet_from=?,quiet_until=?,service_level_days=?,escalation_days=?,updated_at=? WHERE id=1').bind(JSON.stringify(days), quietFrom, quietUntil, serviceLevel, escalateAfter, now()),
    event(db, actor, 'reminders-set', {}, { days, quietFrom, quietUntil, serviceLevel, escalateAfter }),
  ]);
  return { days, quietFrom, quietUntil, serviceLevel, escalateAfter };
}

const localHour = (at: Date, timezone: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(at));
/** Quiet hours run from `from` to `until` and may wrap midnight; equal hours mean none. */
const quiet = (hour: number, from: number, until: number) => from === until ? false : from > until ? hour >= from || hour < until : hour >= from && hour < until;

/** The hourly run: every open item is noted when first seen; on a US business day outside quiet hours (business time
 * zone), an item whose business days since then reach the next step is reminded once for that step, by email. */
export async function runReminders(env: Bindings, at: Date) {
  const db = env.DB, settings = await business(db);
  if (!settings) return;
  const items = await openItems(db, settings);
  if (items.length) await db.batch(items.map(i => db.prepare('INSERT INTO c_reminder_items(key,person,claim_id,first_seen_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').bind(i.key, i.person, i.claim, at.toISOString())));
  const today = localDate(at.toISOString(), settings.timezone);
  if (!isBusinessDay(today) || quiet(localHour(at, settings.timezone), settings.quiet_from, settings.quiet_until)) return;
  const seen = new Map((await db.prepare('SELECT r.key,r.first_seen_at,(SELECT MAX(step) FROM c_reminders s WHERE s.key=r.key) AS sent FROM c_reminder_items r').all<Data>()).results.map(r => [r.key, r]));
  const mail = operatorMail(env);
  for (const item of items) {
    const record = seen.get(item.key)!, age = businessDaysBetween(localDate(record.first_seen_at, settings.timezone), today);
    await remind(env, mail, item, age, settings.reminder_days.filter(d => d <= age).length, record.sent ?? 0, at);
    await escalate(env, settings, mail, item, age, at);
  }
}

/** Sends the item's reminder for this step once; a step already sent (or none due) sends nothing. */
async function remind(env: Bindings, mail: ReturnType<typeof operatorMail>, item: Open, age: number, step: number, sentStep: number, at: Date) {
  const db = env.DB;
  if (!step || sentStep >= step) return;
  const claimed = await db.prepare('INSERT INTO c_reminders(key,step,person,sent_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING RETURNING key').bind(item.key, step, item.person, at.toISOString()).first();
  if (!claimed) return;
  const link = `${env.AUTH_ORIGIN}/app#/claims/${item.claim}`;
  const words = `${item.action} “${item.title}”: it has waited ${age} business ${age === 1 ? 'day' : 'days'}. Open it in Coaster: ${link}`;
  const sent = mail ? await mail.send({ deliveryId: `reminder-${item.key}-${step}`, from: env.MAIL_FROM ?? '', to: [item.person], subject: `Reminder: ${item.action}`, text: words, html: `<p>${words.replace(link, '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)}<a href="${link}">${link}</a></p>`, headers: {} }) : null;
  await ruleEvent(db, 'reminder', 'reminder-sent', { claim: item.claim }, { item: item.key, step, to: item.person, businessDays: age, mail: sent?.status ?? 'mail not set up' }).run();
}
