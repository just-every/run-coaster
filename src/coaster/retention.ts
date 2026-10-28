import { all, authority, commit, need, sha256Hex } from './session';
import { event, ruleEvent } from './events';
import { business, requireBusiness } from './settings';
import { localDate } from './reports';
import { claimNumber } from './claims';
import type { Bindings } from '../auth.server';
import { email, isoDate, now, requireThat, text, uid, type Actor, type Data } from './types';

/** Record retention and legal hold (RETAIN-001). */
export type Hold = { id: string; scope: 'person' | 'business' | 'period'; member_email: string | null; from_day: string | null; to_day: string | null; reason: string; placed_by: string; placed_at: string; released_by: string | null; released_at: string | null };
type Unit = { claims: { id: string; number: number; employee_email: string; status: string; updated_at: string }[]; batch: string | null };
/** Who expiry proposals are recorded under. */
const RETENTION = 'retention';
const ownerOnly = (actor: Actor) => { need(actor, 'owner'); requireThat(actor.kind === 'person', 'Only the owner acts on retention', 403); return authority(actor, 'owner'); };

export async function saveRetention(db: D1Database, actor: Actor, b: Data) {
  const guard = ownerOnly(actor);
  await requireBusiness(db);
  const years = Number(b.years);
  requireThat(Number.isInteger(years) && years >= 1 && years <= 30, 'Keep records for a whole number of years from 1 to 30');
  await commit(db, guard, [db.prepare('UPDATE c_business SET retention_years=?,updated_at=? WHERE id=1').bind(years, now()), event(db, actor, 'retention-set', {}, { years })]);
  return retention(db, actor);
}

export const liveHolds = async (db: D1Database) => (await db.prepare('SELECT * FROM c_legal_holds WHERE released_at IS NULL ORDER BY placed_at').all<Hold>()).results;

/** The owner places a hold on one person, the whole business or an inclusive range of expense dates, with a reason. */
export async function placeHold(db: D1Database, actor: Actor, b: Data) {
  const guard = ownerOnly(actor);
  const scope = String(b.scope);
  requireThat(['person', 'business', 'period'].includes(scope), 'Hold one person, the whole business or a period');
  const member = scope === 'person' ? email(b.member, 'Person') : null;
  const from = scope === 'period' ? isoDate(b.from, 'From') : null, to = scope === 'period' ? isoDate(b.to, 'To') : null;
  requireThat(!from || from <= to!, 'The period must end on or after it starts');
  const id = uid(), reason = text(b.reason, 'Reason', 500);
  await commit(db, guard, [
    db.prepare('INSERT INTO c_legal_holds(id,scope,member_email,from_day,to_day,reason,placed_by,placed_at) VALUES(?,?,?,?,?,?,?,?)').bind(id, scope, member, from, to, reason, actor.email, now()),
    event(db, actor, 'legal-hold-placed', {}, { hold: id, scope, member, from, to, reason }),
  ]);
  return retention(db, actor);
}

export async function releaseHold(db: D1Database, actor: Actor, id: string) {
  const guard = ownerOnly(actor);
  requireThat(await db.prepare('SELECT 1 FROM c_legal_holds WHERE id=? AND released_at IS NULL').bind(id).first(), 'Legal hold not found or already released', 404);
  await commit(db, all(guard, { sql: 'EXISTS(SELECT 1 FROM c_legal_holds WHERE id=? AND released_at IS NULL)', params: [id] }), [
    db.prepare('UPDATE c_legal_holds SET released_by=?,released_at=? WHERE id=?').bind(actor.email, now(), id),
    event(db, actor, 'legal-hold-released', {}, { hold: id }),
  ]);
  return retention(db, actor);
}

/** The live hold that covers any of these claims, if one does: the business, one of their people, or a period holding
 * one of their expense dates. A hold on a person also blocks ERASURE-001 for them. */
export async function holdOn(db: D1Database, claims: { id: string; employee_email: string }[], holds?: Hold[]) {
  for (const h of holds ?? await liveHolds(db)) {
    if (h.scope === 'business') return h;
    if (h.scope === 'person' && claims.some(c => c.employee_email === h.member_email)) return h;
    if (h.scope === 'period' && claims.length && await db.prepare('SELECT 1 FROM c_items i WHERE i.claim_id IN (SELECT value FROM json_each(?)) AND i.spent_on BETWEEN ? AND ?').bind(JSON.stringify(claims.map(c => c.id)), h.from_day, h.to_day).first()) return h;
  }
  return null;
}

/** Paid and rejected claims whose last change (when they were paid or rejected) is at least the retention period before
 * `day`: a rejected claim on its own, a paid claim with every claim of its reimbursement batch, which must all be past it.
 * Open, approved and unpaid claims never expire. */
async function expiring(db: D1Database, years: number, day: string, timezone: string): Promise<Unit[]> {
  const cutoff = `${Number(day.slice(0, 4)) - years}${day.slice(4)}`;
  const rows = (await db.prepare("SELECT id,number,employee_email,status,updated_at,batch_id FROM c_claims WHERE status IN ('reimbursed','rejected') ORDER BY number").all<Unit['claims'][number] & { batch_id: string | null }>()).results;
  const past = (c: { updated_at: string }) => localDate(c.updated_at, timezone) <= cutoff;
  const units: Unit[] = rows.filter(c => c.status === 'rejected' && past(c)).map(c => ({ claims: [c], batch: null }));
  for (const batch of new Set(rows.filter(c => c.status === 'reimbursed').map(c => c.batch_id!))) {
    const members = (await db.prepare('SELECT id,number,employee_email,status,updated_at FROM c_claims WHERE batch_id=? ORDER BY number').bind(batch).all<Unit['claims'][number]>()).results;
    if (members.every(c => c.status === 'reimbursed' && past(c))) units.push({ claims: members, batch });
  }
  return units;
}

/** The hourly run proposes every unit past retention and not under a legal hold, when no proposal is waiting. */
export async function runRetention(env: Bindings, at: Date) {
  const db = env.DB, settings = await business(db);
  if (!settings || await db.prepare("SELECT 1 FROM c_expiry_proposals WHERE status='proposed'").first()) return;
  const holds = await liveHolds(db), units: Unit[] = [];
  for (const unit of await expiring(db, settings.retention_years, localDate(at.toISOString(), settings.timezone), settings.timezone)) if (!await holdOn(db, unit.claims, holds)) units.push(unit);
  if (!units.length) return;
  const id = uid();
  await db.batch([
    db.prepare("INSERT INTO c_expiry_proposals(id,proposed_at,retention_years,claims,status) VALUES(?,?,?,?,'proposed')").bind(id, at.toISOString(), settings.retention_years, JSON.stringify(units.map(u => ({ batch: u.batch, claims: u.claims.map(c => ({ id: c.id, number: c.number, updated_at: c.updated_at })) })))),
    ruleEvent(db, RETENTION, 'expiry-proposed', {}, { proposal: id, claims: units.flatMap(u => u.claims.map(c => claimNumber(c.number))), retentionYears: settings.retention_years }),
  ]);
}

/** The owner confirms a proposal. Each unit still exactly as proposed and not under a hold is removed in one transaction:
 * the claim, its expenses, receipt bytes, revisions, decisions, comments, reviews, samples, reminders and history lines,
 * and a paid unit's batch; one "claim-expired" line per claim and the receipt stay. Anything changed or held is skipped. */
export async function confirmExpiry(db: D1Database, actor: Actor, id: string) {
  const guard = ownerOnly(actor);
  const proposal = await db.prepare("SELECT * FROM c_expiry_proposals WHERE id=? AND status='proposed'").bind(id).first<Data>();
  requireThat(proposal, 'Expiry proposal not found or already confirmed', 404);
  const at = now(), holds = await liveHolds(db), expired: Data[] = [], skipped: Data[] = [], writes: D1PreparedStatement[] = [];
  for (const unit of JSON.parse(proposal.claims) as { batch: string | null; claims: { id: string; number: number; updated_at: string }[] }[]) {
    const ids = unit.claims.map(c => c.id), list = JSON.stringify(ids);
    const current = (await db.prepare('SELECT id,number,employee_email,status,updated_at,total_minor FROM c_claims WHERE id IN (SELECT value FROM json_each(?)) ORDER BY number').bind(list).all<Data>()).results;
    const unchanged = current.length === ids.length && unit.claims.every(c => current.some(x => x.id === c.id && x.updated_at === c.updated_at));
    const hold = unchanged ? await holdOn(db, current as Unit['claims'], holds) : null;
    if (!unchanged || hold) { skipped.push(...unit.claims.map(c => ({ claim: claimNumber(c.number), reason: hold ? `legal hold: ${hold.reason}` : 'changed since it was proposed' }))); continue; }
    const items = (await db.prepare('SELECT i.claim_id,i.spent_on,r.sha256 FROM c_items i LEFT JOIN c_receipts r ON r.id=i.receipt_id WHERE i.claim_id IN (SELECT value FROM json_each(?))').bind(list).all<Data>()).results;
    const keys = (await db.prepare('SELECT k.key,c.number FROM c_reimbursement_keys k JOIN c_claims c ON c.id=k.claim_id WHERE k.claim_id IN (SELECT value FROM json_each(?))').bind(list).all<{ key: string; number: number }>()).results;
    const targets = unit.batch ? [...ids, unit.batch] : ids, inClaims = 'IN (SELECT value FROM json_each(?))';
    writes.push(
      ...targets.map(t => db.prepare('INSERT INTO c_expiring(target) VALUES(?)').bind(t)),
      db.prepare("DELETE FROM c_entity_reports WHERE EXISTS(SELECT 1 FROM json_each(snapshot,'$.lines') l JOIN json_each(?) chosen ON chosen.value=json_extract(l.value,'$.claim'))").bind(list),
      ...await Promise.all(keys.map(async k => db.prepare('INSERT INTO c_expired_keys(key_sha256,claim_number,expired_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').bind(await sha256Hex(k.key), k.number, at))),
      // A cash advance keeps what its removed claim drew down (CLAIM-004).
      db.prepare(`UPDATE c_advances SET kept_applied_minor=(SELECT CASE WHEN c.status='reimbursed' THEN MIN(c_advances.amount_minor-c_advances.returned_minor,c.total_minor) ELSE 0 END FROM c_claims c WHERE c.id=c_advances.claim_id) WHERE claim_id ${inClaims}`).bind(list),
      db.prepare(`DELETE FROM c_auto_coding_feedback WHERE suggestion_id IN (SELECT s.id FROM c_auto_coding_suggestions s JOIN c_items i ON i.id=s.target_id WHERE s.target_kind='item' AND i.claim_id ${inClaims})`).bind(list),
      ...['c_auto_coding_suggestions','c_auto_coding_observations','c_auto_coding_contexts'].map(table=>db.prepare(`DELETE FROM ${table} WHERE target_kind='item' AND target_id IN (SELECT id FROM c_items WHERE claim_id ${inClaims})`).bind(list)),
      db.prepare(`DELETE FROM c_escalations WHERE key IN (SELECT key FROM c_reminder_items WHERE claim_id ${inClaims})`).bind(list),
      db.prepare(`DELETE FROM c_reminders WHERE key IN (SELECT key FROM c_reminder_items WHERE claim_id ${inClaims})`).bind(list),
      db.prepare(`DELETE FROM c_workflow_tasks WHERE kind='claim' AND record_id ${inClaims}`).bind(list),
      ...['c_reminder_items', 'c_exception_reviews', 'c_audit_samples', 'c_decisions', 'c_revisions', 'c_reimbursement_keys', 'c_batch_claims', 'c_allowance_runs', 'c_nonaccountable'].map(t => db.prepare(`DELETE FROM ${t} WHERE claim_id ${inClaims}`).bind(list)),
      db.prepare(`DELETE FROM c_comments WHERE claim_id ${inClaims} AND parent_id IS NOT NULL`).bind(list),
      ...['c_comments', 'c_items', 'c_receipts', 'c_events'].map(t => db.prepare(`DELETE FROM ${t} WHERE claim_id ${inClaims}`).bind(list)),
      ...(unit.batch ? [db.prepare('DELETE FROM c_events WHERE batch_id=?').bind(unit.batch)] : []),
      db.prepare(`DELETE FROM c_claims WHERE id ${inClaims}`).bind(list),
      ...(unit.batch ? [db.prepare('DELETE FROM c_payroll_handoffs WHERE batch_id=?').bind(unit.batch), db.prepare('DELETE FROM c_batches WHERE id=?').bind(unit.batch)] : []),
    );
    for (const c of current) {
      const own = items.filter(i => i.claim_id === c.id), dates = own.map(i => i.spent_on).sort();
      const line = { claim: claimNumber(c.number), status: c.status, totalMinor: c.total_minor, expenseDates: dates.length ? { from: dates[0], to: dates.at(-1) } : null, receiptSha256: own.map(i => i.sha256).filter(Boolean) };
      expired.push(line);
      writes.push(ruleEvent(db, RETENTION, 'claim-expired', { claim: c.id }, { ...line, proposal: id, confirmedBy: actor.email, retentionYears: proposal.retention_years }));
    }
  }
  const receipt = { proposal: id, confirmedBy: actor.email, confirmedAt: at, retentionYears: proposal.retention_years, expired, skipped };
  await commit(db, all(guard, { sql: "EXISTS(SELECT 1 FROM c_expiry_proposals WHERE id=? AND status='proposed')", params: [id] }), [
    ...writes, db.prepare('DELETE FROM c_expiring'),
    db.prepare("UPDATE c_expiry_proposals SET status='confirmed',confirmed_by=?,confirmed_at=?,receipt=? WHERE id=?").bind(actor.email, at, JSON.stringify(receipt), id),
    event(db, actor, 'expiry-confirmed', {}, { proposal: id, expired: expired.length, skipped: skipped.length }),
  ]);
  return receipt;
}

/** The retention period, live and released holds, the waiting proposal and every expiry receipt: for the owner and auditors. */
export async function retention(db: D1Database, actor: Actor) {
  requireThat(actor.roles.owner || actor.roles.auditor, 'Owner or auditor access required', 403);
  const settings = await requireBusiness(db);
  const proposals = (await db.prepare('SELECT * FROM c_expiry_proposals ORDER BY proposed_at DESC').all<Data>()).results.map(p => ({ ...p, claims: JSON.parse(p.claims), receipt: p.receipt ? JSON.parse(p.receipt) : null }) as Data);
  return { years: settings.retention_years, holds: (await db.prepare('SELECT * FROM c_legal_holds ORDER BY placed_at DESC').all<Hold>()).results, proposal: proposals.find(p => p.status === 'proposed') ?? null, receipts: proposals.filter(p => p.status === 'confirmed').map(p => p.receipt) };
}
