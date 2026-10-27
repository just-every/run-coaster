import { commit, all, type Sql } from '../session';
import { ruleEvent } from '../events';
import { requireThat } from '../types';

/** The name the hourly run writes a hold's release under. */
export const BANK_HOLD = 'bank hold';
/** A hold stands from a bank detail change until the hourly run releases it after the cooling-off period. */
const HELD = "a.state='active' AND a.hold_until IS NOT NULL AND a.hold_released_at IS NULL";

export type Held = { email: string; name: string; hold_until: string };
export const heldAmong = async (db: D1Database, emails: string[]) => emails.length
  ? (await db.prepare(`SELECT m.email,m.name,a.hold_until FROM c_bank_accounts a JOIN c_members m ON m.email=a.member_email WHERE ${HELD} AND a.member_email IN (SELECT value FROM json_each(?)) ORDER BY m.name`).bind(JSON.stringify(emails)).all<Held>()).results
  : [];
const refusal = (h: Held) => `Payments to ${h.name} are held until ${h.hold_until.slice(0, 16).replace('T', ' ')} UTC after a change of bank details`;
/** Nothing is batched, released, paid or handed to payroll for a person whose bank details just changed (PAY-002). */
export const requireNotHeld = async (db: D1Database, emails: string[]) => {
  const [first] = await heldAmong(db, emails);
  requireThat(!first, first ? refusal(first) : '', 409);
};
export async function requireBatchNotHeld(db: D1Database, batch: string) {
  const people = (await db.prepare('SELECT DISTINCT c.employee_email AS email FROM c_batch_claims bc JOIN c_claims c ON c.id=bc.claim_id WHERE bc.batch_id=?').bind(batch).all<{ email: string }>()).results;
  await requireNotHeld(db, people.map(p => p.email));
}
/** The same condition for the write itself, so a change made while a release is in flight stops it. */
export const batchNotHeld = (batch: string): Sql => ({ sql: `NOT EXISTS(SELECT 1 FROM c_batch_claims bc JOIN c_claims c ON c.id=bc.claim_id JOIN c_bank_accounts a ON a.member_email=c.employee_email WHERE bc.batch_id=? AND ${HELD})`, params: [batch] });

/** The hourly run: a hold whose cooling-off period has passed is released and the release is recorded. */
export async function runBankHolds(db: D1Database, at: Date) {
  const due = (await db.prepare('SELECT a.id,a.hold_until FROM c_bank_accounts a WHERE a.state=\'active\' AND a.hold_until IS NOT NULL AND a.hold_released_at IS NULL AND a.hold_until<=? ORDER BY a.hold_until').bind(at.toISOString()).all<{ id: string; hold_until: string }>()).results;
  for (const hold of due)
    await commit(db, all({ sql: '1', params: [] }, { sql: 'EXISTS(SELECT 1 FROM c_bank_accounts WHERE id=? AND state=\'active\' AND hold_released_at IS NULL)', params: [hold.id] }), [
      db.prepare('UPDATE c_bank_accounts SET hold_released_at=? WHERE id=?').bind(at.toISOString(), hold.id),
      ruleEvent(db, BANK_HOLD, 'bank-hold-released', {}, { account: hold.id, holdUntil: hold.hold_until }),
    ]);
}
