import { ruleEvent } from './events';
import { chainFor, stepRecipients } from './escalation-chains';
import type { Business } from './settings';
import type { Bindings } from '../auth.server';
import type { MailSender } from '../modules/operator-auth/index.mjs';

export type Owed = { key: string; person: string; claim: string; title: string; action: string };

/** The business days at which an item escalates, or none when finance turned escalation off: an approval once it passes
 * the service level, anything else once its reminder sequence is exhausted plus the gap; finance follows after the gap. */
export function escalationDays(settings: Business, key: string) {
  if (settings.escalation_days === null) return [];
  const first = key.startsWith('decision:') ? settings.service_level_days + 1 : settings.reminder_days.at(-1)! + settings.escalation_days;
  return [first, first + settings.escalation_days];
}

/** Escalates one open item to the owing person's approving manager, then to finance (everyone in finance but the person);
 * with no active manager it goes to finance once. Each escalation is sent once and is a history line on the claim. */
export async function escalate(env: Bindings, settings: Business, mail: MailSender | undefined, item: Owed, age: number, at: Date) {
  const db = env.DB, due = escalationDays(settings, item.key).filter(d => d <= age).length;
  if (!due) return;
  const manager = (await db.prepare('SELECT m.approver_email AS email FROM c_members m JOIN c_members a ON a.email=m.approver_email AND a.active=1 WHERE m.email=?').bind(item.person).first<{ email: string }>())?.email;
  // Finance's chain for the person's department (or the default chain) replaces the approving manager then finance.
  const chain = await chainFor(db, item.person), level = chain ? Math.min(due, chain.steps.length) : manager ? due : 1;
  const done = (await db.prepare('SELECT MAX(level) AS n FROM c_escalations WHERE key=?').bind(item.key).first<{ n: number | null }>())?.n ?? 0;
  if (done >= level) return;
  const finance = (await db.prepare('SELECT email FROM c_members WHERE active=1 AND is_finance=1 AND email<>? ORDER BY email').bind(item.person).all<{ email: string }>()).results.map(r => r.email);
  const step = chain?.steps[level - 1], named = step ? await stepRecipients(db, item.person, step) : [];
  const to = chain ? (named.length ? named : finance) : level === 1 && manager ? [manager] : finance;
  const claimed = await db.prepare('INSERT INTO c_escalations(key,level,recipients,sent_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING RETURNING key').bind(item.key, level, JSON.stringify(to), at.toISOString()).first();
  if (!claimed) return;
  const link = `${env.AUTH_ORIGIN}/app#/claims/${item.claim}`;
  const words = `${item.person} has not done this for ${age} business days: ${item.action} “${item.title}”. Open it in Coaster: ${link}`;
  const sent = to.length && mail ? await mail.send({ deliveryId: `escalation-${item.key}-${level}`, from: env.MAIL_FROM ?? '', to, subject: `Escalated: ${item.action}`, text: words, html: `<p>${words.replace(link, '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)}<a href="${link}">${link}</a></p>`, headers: {} }) : null;
  await ruleEvent(db, 'escalation', 'escalated', { claim: item.claim }, { item: item.key.startsWith('receipt-question:')?'private-employee-task':item.key, level, to, ...(chain ? { chain: { department: chain.department_id || null, version: chain.version, step: step!.kind } } : {}), owedBy: item.person, businessDays: age, mail: !to.length ? 'nobody to escalate to' : sent?.status ?? 'mail not set up' }).run();
}
