import { amount, type Actor } from '../../types';
import { chooseCardMatch } from '../card-matching';
import { MATCH_NOTICE } from '../match-notice';
import { ownOriginal, originalStill, latestReading } from './access';
import { safePrefill } from './normalize';
import { currentSettings, settingsStill } from './settings';
import type { Fields } from './model';

/** A self-granted standing choice applies only to safe fields on a newly completed private reading. */
export async function applyReadingMatchDefault(db: D1Database, actor: Actor, id: string) {
  const choice = await db.prepare('SELECT version,enabled FROM c_receipt_reading_match_defaults WHERE employee_email=? ORDER BY version DESC LIMIT 1').bind(actor.email).first<{ version: number; enabled: number }>();
  if (!choice?.enabled) return;
  const [receipt, latest, settings] = await Promise.all([ownOriginal(db, actor, id), latestReading(db, id), currentSettings(db)]);
  if (!settings?.enabled || !latest || !['read', 'corrected'].includes(latest.kind)) return;
  const fields = safePrefill(JSON.parse(latest.fields_json) as Fields);
  if (!fields.merchant || !fields.date || !fields.total || !fields.currency || amount(fields.total, 'Total') <= 0) return;
  const exists = await db.prepare(`SELECT 1 WHERE EXISTS(SELECT 1 FROM c_capture_cash_drafts WHERE receipt_id=?) OR EXISTS(SELECT 1 FROM c_items i JOIN c_receipts r ON r.id=i.receipt_id WHERE r.capture_receipt_id=?) OR EXISTS(SELECT 1 FROM c_capture_lifecycle WHERE receipt_id=? AND kind IN ('discarded','merged','match-details','match-withdrawn'))`).bind(id, id, id).first();
  if (exists) return;
  await chooseCardMatch(db, actor, id, { expectedSequence: receipt.lifecycle_sequence, enabled: true, merchant: fields.merchant, date: fields.date, total: fields.total, currency: fields.currency, last4: fields.last4 ?? '', notice: MATCH_NOTICE }, [
    originalStill(actor, receipt, receipt.lifecycle_sequence, latest.sequence), settingsStill(settings.version),
    { sql: '(SELECT MAX(version) FROM c_receipt_reading_match_defaults WHERE employee_email=?)=? AND EXISTS(SELECT 1 FROM c_receipt_reading_match_defaults WHERE employee_email=? AND version=? AND enabled=1)', params: [actor.email, choice.version, actor.email, choice.version] },
  ]);
}
