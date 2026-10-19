import { authority, commit, need } from './session';
import { event } from './events';
import { claimNumber, loadClaim } from './claims';
import { requireBusiness } from './settings';
import { localDate } from './reports';
import { requireThat, now, text, type Actor, type Data } from './types';

/** IRS accountable-plan windows (CLAIM-008): an expense is substantiated within 60 days of the spend; excess returns
 * within 120 days are CLAIM-004's, with cash advances. */
export const SUBSTANTIATION_DAYS = 60;

const days = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000);

/** Finance's accountable-plan view: every expense an employee filed (receipt, mileage, per diem; stipends are Coaster's
 * own) more than 60 days after its spend date, counted in calendar days from the spend date to the business-time-zone day
 * of the first submission that carried it, on claims not rejected; and every expense finance marked non-accountable. */
export async function accountablePlan(db: D1Database, actor: Actor) {
  requireThat(actor.roles.finance || actor.roles.auditor, 'Finance or auditor access required', 403);
  const { timezone } = await requireBusiness(db);
  const { results } = await db.prepare(`SELECT i.id AS item, i.claim_id, c.number, c.employee_email, c.status, i.kind, i.merchant, i.spent_on, i.amount_minor,
      (SELECT MIN(r.submitted_at) FROM c_revisions r, json_each(r.snapshot, '$.items') e WHERE r.claim_id=i.claim_id AND json_extract(e.value, '$.id')=i.id) AS filed_at,
      n.marked_by, n.marked_at, n.reason
    FROM c_items i JOIN c_claims c ON c.id=i.claim_id LEFT JOIN c_nonaccountable n ON n.item_id=i.id
    WHERE c.status<>'rejected' ORDER BY c.number, i.position`).all<Data>();
  const rows = results.filter(r => r.filed_at || r.marked_by).map(r => {
    const filedOn = r.filed_at ? localDate(r.filed_at, timezone) : null, late = filedOn ? days(r.spent_on, filedOn) : null;
    return { claim: claimNumber(r.number), claimId: r.claim_id, item: r.item, employee: r.employee_email, status: r.status, merchant: r.merchant, spentOn: r.spent_on, amountMinor: r.amount_minor, filedOn, daysAfterSpend: late,
      lapsed: r.kind !== 'stipend' && late !== null && late > SUBSTANTIATION_DAYS, nonAccountable: r.marked_by ? { by: r.marked_by, at: r.marked_at, reason: r.reason } : null };
  });
  return { substantiationDays: SUBSTANTIATION_DAYS, lapsed: rows.filter(r => r.lapsed), nonAccountable: rows.filter(r => r.nonAccountable) };
}

/** Finance marks one expense non-accountable (reimbursed as taxable pay) or clears the mark, with a reason, until its claim
 * is in a reviewed batch; the paid amount never changes, only how the files label it. */
export async function markNonAccountable(db: D1Database, actor: Actor, claimId: string, itemId: string, b: Data) {
  need(actor, 'finance');
  requireThat(actor.kind === 'person', 'Only a person in finance decides accountable-plan treatment', 403);
  const claim = await loadClaim(db, claimId);
  const item = await db.prepare('SELECT id,merchant,amount_minor FROM c_items WHERE id=? AND claim_id=?').bind(itemId, claimId).first<{ id: string; merchant: string; amount_minor: number }>();
  requireThat(item, 'Expense not found', 404);
  const open = "EXISTS(SELECT 1 FROM c_claims c LEFT JOIN c_batches b ON b.id=c.batch_id WHERE c.id=? AND c.status IN ('submitted','approved','batched') AND (c.batch_id IS NULL OR b.status='draft'))";
  requireThat(await db.prepare(`SELECT ${open} AS ok`).bind(claimId).first<{ ok: number }>().then(r => r?.ok), 'Only a submitted or approved claim not yet in a reviewed batch can change its accountable-plan treatment', 409);
  const mark = b.nonAccountable !== false && b.nonAccountable !== 'false', reason = text(b.reason, 'Reason', 500), at = now();
  await commit(db, { sql: `(${authority(actor, 'finance').sql}) AND ${open}`, params: [...authority(actor, 'finance').params, claimId], after: authority(actor, 'finance') }, [
    mark ? db.prepare('INSERT INTO c_nonaccountable(item_id,claim_id,marked_by,marked_at,reason) VALUES(?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET marked_by=excluded.marked_by,marked_at=excluded.marked_at,reason=excluded.reason').bind(item.id, claimId, actor.email, at, reason)
      : db.prepare('DELETE FROM c_nonaccountable WHERE item_id=?').bind(item.id),
    event(db, actor, mark ? 'expense-non-accountable' : 'expense-accountable', { claim: claimId }, { item: item.id, merchant: item.merchant, amountMinor: item.amount_minor, claim: claimNumber(claim.number), reason }),
  ]);
  return accountablePlan(db, actor);
}
