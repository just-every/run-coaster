import { canSee, loadClaim } from '../claims';
import { rolesFrom } from '../session';
import { operatorMail } from '../../mail.server.mjs';
import type { Bindings } from '../../auth.server';
import { business } from '../settings';
import { openItems } from '../reminders';
import { localDate } from '../reports';
import { isBusinessDay } from '../business-days';
import { uid, type Data } from '../types';

export const hourIn = (at: Date, zone: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(at));
export const isQuiet = (hour: number, from: number, until: number) => from === until ? false : from > until ? hour >= from || hour < until : hour >= from && hour < until;

/** Re-resolve current membership and claim authority. A queued link never grants access to a private draft. */
async function authorized(db: D1Database, row: Data, tasks: Set<string>) {
  const member = await db.prepare(`SELECT m.*,o.role AS operator_role FROM oa_operators o LEFT JOIN c_members m ON m.email=lower(o.email) AND m.active=1 WHERE lower(o.email)=? AND o.status='active'`).bind(row.recipient).first<Data>();
  if (!member || (member.operator_role !== 'owner' && !member.email)) return false;
  const roles = rolesFrom(member,member.operator_role === 'owner');
  const claim = await db.prepare('SELECT * FROM c_claims WHERE id=?').bind(row.claim_id).first<Data>();
  if (!claim) return false;
  if (row.kind === 'reminder') return tasks.has(`${row.task_key}\n${row.recipient}`) && canSee({ kind: 'person', email: row.recipient, name: member.name, roles },await loadClaim(db,row.claim_id));
  if (row.kind === 'decision' || row.kind === 'return') return claim.employee_email === row.recipient && claim.status !== 'draft';
  if (claim.status !== 'submitted' || claim.revision !== row.revision || claim.employee_email === row.recipient) return false;
  const workflow = await db.prepare("SELECT role FROM c_workflow_tasks WHERE kind='claim' AND record_id=? AND revision=? AND email=? AND status='waiting'").bind(claim.id,claim.revision,row.recipient).first<{role:string}>();
  return workflow ? roles.owner || member[`is_${workflow.role}`] === 1 : claim.approver_email === row.recipient && roles.manager;
}

/** Reserve a message before crossing the mail edge. Unknown or failed attempts are retained, never automatically replayed. */
export async function deliverNotifications(env: Bindings, at: Date, immediateOnly = false) {
  const db = env.DB, settings = await business(db);
  if (!settings) return;
  const tasks = new Set((await openItems(db, settings)).map(t => `${t.key}\n${t.person}`));
  const pending = (await db.prepare(`SELECT e.*,p.timezone,p.quiet_from,p.quiet_until FROM c_notification_events e JOIN c_notification_preferences p ON p.recipient=e.recipient WHERE e.delivery_id IS NULL AND e.cancelled_at IS NULL ORDER BY e.created_at,e.id`).all<Data>()).results;
  const groups = new Map<string, Data[]>();
  for (const row of pending) {
    if (row.created_at > at.toISOString()) continue;
    // Restores carry domain people but no native accounts. Wait for fresh sign-in without changing the pending identity.
    const awaitingSignIn = await db.prepare("SELECT 1 FROM c_members m WHERE m.email=? AND m.active=1 AND NOT EXISTS(SELECT 1 FROM oa_operators o WHERE lower(o.email)=m.email AND o.status IN ('active','inactive'))").bind(row.recipient).first();
    if (awaitingSignIn) continue;
    if (!await authorized(db,row,tasks)) {
      await db.prepare('UPDATE c_notification_events SET cancelled_at=? WHERE id=? AND delivery_id IS NULL').bind(at.toISOString(),row.id).run();
      continue;
    }
    const hour = hourIn(at,row.timezone), day = localDate(at.toISOString(),row.timezone);
    if (isQuiet(hour,row.quiet_from,row.quiet_until)) continue;
    if (row.kind === 'reminder' && !isBusinessDay(day)) continue;
    let digestDay = day;
    if (row.mode === 'digest') {
      if (immediateOnly) continue;
      if (hour < 9) {
        // A 09:00 digest whose quiet period ends next morning retains the preceding day's identity and cutoff.
        if (!isQuiet(9,row.quiet_from,row.quiet_until) || row.quiet_until >= 9) continue;
        digestDay = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0,10);
      }
      const createdDay = localDate(row.created_at,row.timezone);
      if (createdDay > digestDay || (createdDay === digestDay && row.kind !== 'reminder' && hourIn(new Date(row.created_at),row.timezone) >= 9)) continue;
    }
    const bucket = row.mode === 'digest' ? `digest:${digestDay}` : `immediate:${row.id}`;
    const key = `${row.recipient}\n${bucket}`;
    groups.set(key,[...(groups.get(key) ?? []),row]);
  }
  for (const [key, rows] of groups) {
    const [recipient,bucket] = key.split('\n'), id = uid(), kind = rows[0].mode;
    // A unique personal date permits exactly one digest attempt, including concurrent or repeated hourly runs.
    await db.batch([
      db.prepare("INSERT INTO c_notification_deliveries(id,recipient,kind,bucket,status,attempted_at,event_count) VALUES(?,?,?,?,'attempting',?,?) ON CONFLICT DO NOTHING").bind(id,recipient,kind,bucket,at.toISOString(),rows.length),
      ...rows.map(row => db.prepare('UPDATE c_notification_events SET delivery_id=? WHERE id=? AND delivery_id IS NULL AND cancelled_at IS NULL AND EXISTS(SELECT 1 FROM c_notification_deliveries WHERE id=?)').bind(id,row.id,id)),
    ]);
    if (!await db.prepare('SELECT 1 FROM c_notification_deliveries WHERE id=?').bind(id).first()) continue;
    // Check immediately before egress as well as before reservation; revoked work is never included in the message.
    const currentTasks = new Set((await openItems(db,settings)).map(t => `${t.key}\n${t.person}`));
    const allowed: Data[] = [];
    for (const row of rows) if (await authorized(db,row,currentTasks)) allowed.push(row);
    if (!allowed.length) {
      await db.prepare("UPDATE c_notification_deliveries SET status='failed',provider_status='authority changed' WHERE id=?").bind(id).run();
      continue;
    }
    const lines = [];
    for (const row of allowed) {
      const claim = await db.prepare('SELECT number FROM c_claims WHERE id=?').bind(row.claim_id).first<{number:number}>();
      lines.push(`${row.kind === 'submission' ? 'Submission to review' : row.kind === 'return' ? 'Claim returned' : row.kind === 'decision' ? 'Claim decision' : 'Reminder'} · CL-${String(claim!.number).padStart(4,'0')}\n${env.AUTH_ORIGIN}/app#/claims/${encodeURIComponent(row.claim_id)}`);
    }
    const text = lines.join('\n\n'), mail = operatorMail(env);
    let status = 'unconfigured', provider = 'mail not set up';
    if (mail) {
      try {
        const result = await mail.send({ deliveryId: `notification-${id}`, from: env.MAIL_FROM ?? '', to: [recipient], subject: kind === 'digest' ? 'Your Coaster daily digest' : 'Coaster notification', text, html: `<p>${text.replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`).replace(/\n/g,'<br>')}</p>`, headers: {} });
        provider = result.status;
        status = result.status === 'accepted' ? 'accepted' : 'failed';
      } catch { status = 'failed'; provider = 'mail request failed; acceptance unknown'; }
    }
    await db.prepare('UPDATE c_notification_deliveries SET status=?,provider_status=?,event_count=? WHERE id=?').bind(status,provider,allowed.length,id).run();
  }
}
