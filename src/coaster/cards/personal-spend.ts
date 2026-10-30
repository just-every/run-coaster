import { loadClaim } from '../claims';
import { event } from '../events';
import { authority, commit, need, sha256Hex, type Sql } from '../session';
import { now, requireThat, uid, type Actor, type Data } from '../types';

export const personalSourceKey = (transaction: string) => sha256Hex(transaction);

// Disclosure follows the charged expense in a submitted snapshot, never a sibling report's status.
// Undo and reimport retain the same transaction identity even when the expense and charge ids change.
const sourceCharges = 'SELECT id,transaction_key FROM c_card_charges UNION ALL SELECT id,transaction_key FROM c_card_charge_undo_history';
export const personalHistoryVisible = `(e.action<>'card-charge-marked-personal' OR e.actor_email=? OR EXISTS(
  SELECT 1 FROM c_card_personal_spend p
  JOIN (${sourceCharges}) original ON original.id=p.charge_id
  JOIN (${sourceCharges}) shared ON shared.transaction_key=original.transaction_key
  JOIN c_revisions r JOIN json_each(r.snapshot,'$.items') item
  WHERE p.event_id=e.id AND json_extract(item.value,'$.card_charge_id')=shared.id
))`;

/** Undo removes an expense, never its obligation. Reimport must retain its original debtor and exact amount. */
export async function personalReimportGuard(db: D1Database, transaction: string, card: string, employee: string, amount: number, currency: string): Promise<Sql> {
  const key = await personalSourceKey(transaction);
  const condition = { sql: 'NOT EXISTS(SELECT 1 FROM c_card_personal_spend WHERE source_key=? AND (card_id<>? OR employee_email<>? OR amount_minor<>? OR currency<>?))', params: [key, card, employee, amount, currency] };
  requireThat(await db.prepare(`SELECT 1 WHERE ${condition.sql}`).bind(...condition.params).first(), 'This source charge has a retained personal obligation; its cardholder and amount cannot change on reimport', 409);
  return condition;
}

/** Only the cardholder's own native session may create a personal debt; no delegate or execution credential gains it. */
function ownSession(actor: Actor) {
  requireThat(actor.kind === 'person' && !actor.delegate && !actor.publicCredential, 'Use your own native sign-in to record personal spend', 403);
  need(actor, 'employee');
}

export async function personalSpend(db: D1Database, actor: Actor) {
  ownSession(actor);
  const rows = (await db.prepare('SELECT p.*,(SELECT seq FROM c_events e WHERE e.id=p.event_id) AS sequence FROM c_card_personal_spend p WHERE p.employee_email=? ORDER BY p.marked_at,p.id').bind(actor.email).all<Data>()).results;
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.outstanding_minor);
  return { charges: rows, balances: [...totals].map(([currency, outstandingMinor]) => ({ currency, outstandingMinor })), settlement: 'unpaid' };
}

export async function markPersonalSpend(db: D1Database, actor: Actor, id: string, b: Data) {
  ownSession(actor);
  const claim = await loadClaim(db, id);
  requireThat(claim.employee_email === actor.email, 'Only the cardholder may mark their own charge personal', 403);
  requireThat(claim.status === 'draft' && claim.revision === 0 && !await db.prepare('SELECT 1 FROM c_revisions WHERE claim_id=?').bind(id).first(), 'Only a never-submitted draft can be classified', 409);
  requireThat(b.version === claim.version, 'This claim changed; reload before trying again', 409);
  requireThat(b.confirm === true, 'Confirm that you owe the company the full posted amount');
  requireThat(typeof b.item === 'string' && typeof b.charge === 'string', 'Select a posted company-card charge');
  const charge = await db.prepare('SELECT ch.* FROM c_card_charges ch JOIN c_items i ON i.id=ch.item_id AND i.card_charge_id=ch.id WHERE ch.id=? AND i.id=? AND i.claim_id=? AND ch.employee_email=?').bind(b.charge, b.item, id, actor.email).first<Data>();
  requireThat(charge, 'This posted company-card charge is outside your draft', 409);
  const source = await personalSourceKey(charge.transaction_key);
  requireThat(!await db.prepare('SELECT 1 FROM c_card_personal_spend WHERE source_key=?').bind(source).first(), 'This source charge is already personal; its unpaid balance is retained', 409);
  const record = uid(), at = now();
  const history = event(db, actor, 'card-charge-marked-personal', { claim: id }, { personalSpend: record, charge: charge.id, sourceKey: source, amountMinor: charge.amount_minor, outstandingMinor: charge.amount_minor, currency: charge.currency, liability: 'company', channel: 'app' });
  // Both guards recheck authority, ownership, exact source facts and claim version. The second expects only our own version increment.
  const auth = authority(actor, 'employee');
  const state = (version: number): Sql => ({ sql: `(${auth.sql}) AND EXISTS(SELECT 1 FROM c_claims c JOIN c_items i ON i.claim_id=c.id JOIN c_card_charges ch ON ch.id=i.card_charge_id AND ch.item_id=i.id WHERE c.id=? AND c.employee_email=? AND c.status='draft' AND c.revision=0 AND c.version=? AND NOT EXISTS(SELECT 1 FROM c_revisions WHERE claim_id=c.id) AND i.id=? AND ch.id=? AND ch.employee_email=? AND ch.transaction_key=? AND ch.card_id=? AND ch.amount_minor=? AND ch.currency=?)`, params: [...auth.params, id, actor.email, version, b.item, charge.id, actor.email, charge.transaction_key, charge.card_id, charge.amount_minor, charge.currency] });
  const before = state(claim.version), after = state(claim.version + 1);
  before.sql += ' AND NOT EXISTS(SELECT 1 FROM c_card_personal_spend WHERE source_key=?)'; before.params.push(source);
  after.sql += ' AND EXISTS(SELECT 1 FROM c_card_personal_spend WHERE id=? AND source_key=? AND employee_email=? AND outstanding_minor=?)'; after.params.push(record, source, actor.email, charge.amount_minor);
  await commit(db, { ...before, after }, [
    history,
    db.prepare("INSERT INTO c_card_personal_spend(id,source_key,charge_id,card_id,employee_email,claim_id,item_id,claim_version,liability,classification,amount_minor,outstanding_minor,currency,event_id,actor_email,channel,marked_at) VALUES(?,?,?,?,?,?,?,?,'company','personal',?,?,?,?,?,'app',?)").bind(record, source, charge.id, charge.card_id, actor.email, id, b.item, claim.version, charge.amount_minor, charge.amount_minor, charge.currency, (history as unknown as { params: unknown[] }).params[0], actor.email, at),
    db.prepare('UPDATE c_claims SET version=version+1,updated_at=? WHERE id=?').bind(at, id),
  ]);
  return personalSpend(db, actor);
}
