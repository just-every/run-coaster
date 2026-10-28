import { authority, commit } from '../session';
import { business } from '../settings';
import { event } from '../events';
import { now, requireThat, type Actor, type Data } from '../types';

export type Preferences = { timezone: string; quietFrom: number; quietUntil: number; submission: string; decision: string; return: string; reminder: string; enabled: boolean };
const self = (actor: Actor, input: Data = {}) => {
  requireThat(actor.kind === 'person' && !actor.delegate && !actor.publicCredential, 'Notification preferences belong to the signed-in person', 403);
  requireThat(!Object.keys(input).some(k => !['timezone','quietFrom','quietUntil','submission','decision','return','reminder'].includes(k)), 'Only your own notification preferences can be changed', 403);
};
export async function notificationPreferences(db: D1Database, actor: Actor) {
  self(actor);
  const row = await db.prepare('SELECT * FROM c_notification_preferences WHERE recipient=?').bind(actor.email).first<Data>();
  const b = await business(db);
  const preferences: Preferences = row ? { timezone: row.timezone, quietFrom: row.quiet_from, quietUntil: row.quiet_until, submission: row.submission, decision: row.decision, return: row.returned, reminder: row.reminder, enabled: true } : { timezone: b?.timezone ?? 'UTC', quietFrom: b?.quiet_from ?? 20, quietUntil: b?.quiet_until ?? 8, submission: 'immediate', decision: 'immediate', return: 'immediate', reminder: 'immediate', enabled: false };
  const deliveries = (await db.prepare('SELECT id,kind,status,attempted_at AS attemptedAt,provider_status AS providerStatus,event_count AS eventCount FROM c_notification_deliveries WHERE recipient=? ORDER BY attempted_at DESC,id LIMIT 20').bind(actor.email).all()).results;
  return { preferences, deliveries };
}
export async function saveNotificationPreferences(db: D1Database, actor: Actor, input: Data) {
  self(actor,input);
  const timezone = String(input.timezone ?? '').trim();
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { requireThat(false, 'Choose a valid IANA time zone'); }
  requireThat(timezone.length > 0 && timezone.length <= 100 && !/^[+-]/.test(timezone), 'Choose a valid IANA time zone');
  const hour = (n: unknown) => { requireThat(typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 23, 'Quiet hours must be whole hours from 0 to 23'); return n; };
  const from = hour(input.quietFrom), until = hour(input.quietUntil);
  for (const kind of ['submission','decision','return','reminder']) requireThat(['immediate','digest'].includes(input[kind]), 'Choose immediate email or daily digest for each event');
  await commit(db, authority(actor), [
    db.prepare('INSERT INTO c_notification_preferences(recipient,timezone,quiet_from,quiet_until,submission,decision,returned,reminder,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(recipient) DO UPDATE SET timezone=excluded.timezone,quiet_from=excluded.quiet_from,quiet_until=excluded.quiet_until,submission=excluded.submission,decision=excluded.decision,returned=excluded.returned,reminder=excluded.reminder,updated_at=excluded.updated_at').bind(actor.email,timezone,from,until,input.submission,input.decision,input.return,input.reminder,now()),
    event(db, actor, 'notification-preferences-set', {}, { timezone, quietFrom: from, quietUntil: until, submission: input.submission, decision: input.decision, return: input.return, reminder: input.reminder }),
  ]);
  return notificationPreferences(db,actor);
}
