import { all, authority, commit, need, type Sql } from '../session';
import { event, ruleEvent } from '../events';
import { insertClaim } from '../claims';
import { requireBusiness } from '../settings';
import { Fault, now, requireThat, uid, type Actor, type Data } from '../types';

const DAY = 86_400_000;
export const CASH_DRAFT_ACTOR = 'automation: cash-draft window';
// No attachment capability exists yet. Every inbox original is unattached; terminal originals and reserved drafts are excluded.
const eligible = `FROM c_capture_receipts r JOIN c_members m ON m.email=r.owner_email AND m.active=1 AND m.is_employee=1
 WHERE r.uploaded_at<=? AND NOT EXISTS(SELECT 1 FROM c_capture_lifecycle l WHERE l.receipt_id=r.id)
 AND NOT EXISTS(SELECT 1 FROM c_capture_cash_drafts d WHERE d.receipt_id=r.id)`;
const cutoff = (at: string, days: number) => new Date(Date.parse(at) - days * DAY).toISOString();
function finance(actor: Actor) {
  need(actor, 'finance');
  requireThat(actor.kind === 'person', 'A native finance sign-in is required to set the cash-draft window', 403);
}
function daysInput(value: unknown) {
  requireThat(value === null || Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 90, 'Choose 1–90 days, or null to turn the window off');
  return value as number | null;
}
export async function cashWindow(db: D1Database, actor: Actor) {
  finance(actor);
  return db.prepare('SELECT days,version FROM c_capture_window WHERE id=1').first();
}
export async function previewCashWindow(db: D1Database, actor: Actor, b: Data) {
  finance(actor);
  requireThat(Object.keys(b).every(k => k === 'days'), 'Only days is accepted');
  const days = daysInput(b.days), at = now();
  const { version } = (await cashWindow(db, actor)) as { version: number };
  const count = days === null ? 0 : (await db.prepare(`SELECT COUNT(*) AS n ${eligible}`).bind(cutoff(at, days)).first<{ n: number }>())!.n;
  return { days, version, count, asOf: at };
}
export async function saveCashWindow(db: D1Database, actor: Actor, b: Data) {
  finance(actor);
  requireThat(Object.keys(b).every(k => ['days','version','count','asOf'].includes(k)), 'Only days, version, count and asOf are accepted');
  const days = daysInput(b.days);
  requireThat(Number.isSafeInteger(b.version) && b.version >= 0 && Number.isSafeInteger(b.count) && b.count >= 0, 'Preview and confirm the older receipt count first');
  requireThat(typeof b.asOf === 'string' && Number.isFinite(Date.parse(b.asOf)) && new Date(b.asOf).toISOString() === b.asOf
    && Date.parse(b.asOf) <= Date.now() && Date.now() - Date.parse(b.asOf) <= 10 * 60_000, 'Preview expired; review the older receipt count again', 409);
  requireThat(days !== null || b.count === 0, 'An off window has no pending drafts');
  const state: Sql = { sql: `EXISTS(SELECT 1 FROM c_capture_window WHERE id=1 AND version=?)${days === null ? '' : ` AND (SELECT COUNT(*) ${eligible})=?`}`,
    params: days === null ? [b.version] : [b.version, cutoff(b.asOf, days), b.count] };
  await commit(db, all(authority(actor, 'finance'), state), [
    db.prepare('UPDATE c_capture_window SET days=?,version=version+1 WHERE id=1').bind(days),
    event(db, actor, 'cash-draft-window-set', {}, { days, confirmedOlderCount: b.count }),
  ]);
  return cashWindow(db, actor);
}
/** At most 25 originals per hourly delivery. Each guarded transaction reserves one original and creates one empty
 * native draft claim plus a dated needs-details preparation record. No guessed amount, attachment or submission. */
export async function runCashDrafts(db: D1Database, at: Date) {
  const settings = await db.prepare('SELECT days,version FROM c_capture_window WHERE id=1').first<{ days: number | null; version: number }>();
  if (!settings?.days) return;
  const business = await requireBusiness(db), before = cutoff(at.toISOString(), settings.days);
  const receipts = (await db.prepare(`SELECT r.id,r.owner_email,r.uploaded_at ${eligible} ORDER BY r.uploaded_at,r.id LIMIT 25`).bind(before).all<{ id: string; owner_email: string; uploaded_at: string }>()).results;
  for (const receipt of receipts) {
    const id = uid();
    const live: Sql = { sql: `EXISTS(SELECT 1 FROM c_capture_window WHERE id=1 AND days=? AND version=?) AND EXISTS(SELECT 1 ${eligible} AND r.id=?)`, params: [settings.days, settings.version, before, receipt.id] };
    try {
      await commit(db, all({ sql: '1', params: [] }, live), [
        insertClaim(db, id, receipt.owner_email, 'Cash receipt · needs details', business.currency, null),
        db.prepare('INSERT INTO c_capture_cash_drafts(receipt_id,claim_id,expense_date,created_at) VALUES(?,?,?,?)').bind(receipt.id, id, receipt.uploaded_at.slice(0,10), at.toISOString()),
        // No original id, filename or private metadata is copied into global history.
        ruleEvent(db, CASH_DRAFT_ACTOR, 'cash-draft-created', { claim: id }, { state: 'needs-details' }),
      ]);
    } catch (error) {
      // A concurrent delivery, disposition, deactivation or finance change invalidates this candidate atomically.
      if (!(error instanceof Fault && error.status === 409)) throw error;
    }
  }
}
