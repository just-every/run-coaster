import { uid } from '../types';

/** Reminder cadence remains finance-owned; this records only the resulting personal delivery obligation. */
export function queueReminder(db: D1Database, recipient: string, claim: string, key: string, step: number, at: Date) {
  const id = `reminder-${key}-${step}`;
  return db.prepare(`INSERT INTO c_notification_events(id,event_id,recipient,claim_id,revision,kind,mode,created_at,task_key)
    SELECT ?,?,p.recipient,c.id,c.revision,'reminder',p.reminder,?,? FROM c_notification_preferences p JOIN c_claims c ON c.id=?
    WHERE p.recipient=? ON CONFLICT DO NOTHING`).bind(uid(),id,at.toISOString(),key,claim,recipient);
}
