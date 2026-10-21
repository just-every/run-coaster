import { all, authority, commit, need } from './session';
import { event, ruleEvent } from './events';
import { business, requireBusiness } from './settings';
import { periodOf } from './budgets';
import { localDate } from './reports';
import { claimTotal, insertClaim, insertItem, submitScheduled } from './claims';
import { money } from './exceptions';
import type { ItemInput } from './items';
import type { Bindings } from '../auth.server';
import { amount, email, isoDate, now, optionalText, requireThat, text, uid, type Actor, type Data } from './types';
import { can, needRow, rowAuthority } from './permissions';

/** Recurring expenses and stipends (CLAIM-009). Finance sets allowances for one person or everyone: a fixed stipend the
 * hourly run pays each period without a receipt, or a cap expenses are claimed against with receipts. Employees set
 * their own recurring expenses, which open a draft each period asking for the receipt. An allowance can be set for one
 * person, one department (ADMIN-001) or everyone. */
export type Allowance = { id: string; name: string; type: 'stipend' | 'cap'; member_email: string | null; department_id: string | null; category_id: string | null; period: Period; amount_minor: number; tax: 'accountable' | 'taxable' | null; starts_on: string; set_by: string; set_at: string; stopped_by: string | null; stopped_at: string | null };
type Period = 'monthly' | 'quarterly' | 'yearly';
const PERIODS = ['monthly', 'quarterly', 'yearly'];
/** Whoever the hourly run writes as: stipend and recurring claims are created and submitted under this name. */
export const SCHEDULE = 'allowance';

const today = async (db: D1Database) => localDate(new Date().toISOString(), (await requireBusiness(db)).timezone);
const setter = (actor: Actor) => { needRow(actor, 'policy'); requireThat(actor.kind === 'person', 'Only a person sets allowances', 403); return rowAuthority(actor, 'policy'); };
const period = (v: unknown) => { requireThat(PERIODS.includes(String(v)), 'An allowance is monthly, quarterly or yearly'); return String(v) as Period; };
async function activeCategory(db: D1Database, id: unknown) {
  requireThat(typeof id === 'string' && await db.prepare('SELECT 1 FROM c_categories WHERE id=? AND active=1').bind(id).first(), 'Choose an active category');
  return id as string;
}

/** Finance or the owner sets a stipend or a cap for one employee, one department, or every employee when none is named. */
export async function saveAllowance(db: D1Database, actor: Actor, b: Data) {
  const guard = setter(actor);
  const type = String(b.type);
  requireThat(type === 'stipend' || type === 'cap', 'An allowance is a stipend or a cap');
  let member: string | null = null;
  if (b.member) {
    member = email(b.member, 'Employee');
    requireThat(await db.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_employee=1').bind(member).first(), 'The employee must be an active member with the employee role');
  }
  let department: string | null = null;
  if (b.department) {
    requireThat(!member, 'Set an allowance for one person or for a department, not both');
    department = text(b.department, 'Department', 64);
    requireThat(await db.prepare('SELECT 1 FROM c_departments WHERE id=? AND active=1').bind(department).first(), 'Choose an active department');
  }
  const tax = type === 'stipend' ? String(b.tax ?? '') : null;
  requireThat(tax === null || tax === 'accountable' || tax === 'taxable', 'A stipend is paid under an accountable plan or as taxable pay');
  const v = { name: text(b.name, 'Allowance name', 100), type, member, department, category: type === 'stipend' || b.category ? await activeCategory(db, b.category) : null, period: period(b.period), amountMinor: amount(b.amount, 'Amount'), tax, startsOn: b.startsOn ? isoDate(b.startsOn, 'Starts on') : await today(db) };
  const id = uid();
  await commit(db, guard, [
    db.prepare('INSERT INTO c_allowances(id,name,type,member_email,department_id,category_id,period,amount_minor,tax,starts_on,set_by,set_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, v.name, v.type, v.member, v.department, v.category, v.period, v.amountMinor, v.tax, v.startsOn, actor.delegate?.email ?? actor.email, now()),
    event(db, actor, 'allowance-set', {}, { allowance: id, ...v }),
  ]);
  return allowancesFor(db, actor);
}

/** Stopping an allowance ends it from now: no later stipend is paid and no expense is claimed against it. */
export async function stopAllowance(db: D1Database, actor: Actor, id: string) {
  const guard = setter(actor);
  const found = await db.prepare('SELECT name FROM c_allowances WHERE id=? AND stopped_at IS NULL').bind(id).first<{ name: string }>();
  requireThat(found, 'Allowance not found or already stopped', 404);
  await commit(db, all(guard, { sql: 'EXISTS(SELECT 1 FROM c_allowances WHERE id=? AND stopped_at IS NULL)', params: [id] }), [
    db.prepare('UPDATE c_allowances SET stopped_by=?,stopped_at=? WHERE id=?').bind(actor.delegate?.email ?? actor.email, now(), id),
    event(db, actor, 'allowance-stopped', {}, { allowance: id, name: found.name }),
  ]);
  return allowancesFor(db, actor);
}

/** An employee sets a recurring expense of their own (a monthly software subscription). */
export async function saveRecurring(db: D1Database, actor: Actor, b: Data) {
  need(actor, 'employee');
  requireThat(actor.kind === 'person', 'Only the employee sets their recurring expenses', 403);
  const v = { merchant: text(b.merchant, 'Merchant', 200), description: optionalText(b.description, 'Description', 500), category: await activeCategory(db, b.category), period: period(b.period), amountMinor: amount(b.amount, 'Amount'), startsOn: b.startsOn ? isoDate(b.startsOn, 'Starts on') : await today(db) };
  const id = uid();
  await commit(db, authority(actor, 'employee'), [
    db.prepare('INSERT INTO c_recurring(id,member_email,merchant,description,category_id,period,amount_minor,starts_on,set_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id, actor.email, v.merchant, v.description, v.category, v.period, v.amountMinor, v.startsOn, now()),
    event(db, actor, 'recurring-set', {}, { recurring: id, ...v }),
  ]);
  return allowancesFor(db, actor);
}

export async function stopRecurring(db: D1Database, actor: Actor, id: string) {
  requireThat(actor.kind === 'person', 'Only the employee stops their recurring expenses', 403);
  const found = await db.prepare('SELECT merchant FROM c_recurring WHERE id=? AND member_email=? AND stopped_at IS NULL').bind(id, actor.email).first<{ merchant: string }>();
  requireThat(found, 'Recurring expense not found or already stopped', 404);
  await commit(db, authority(actor, 'employee'), [db.prepare('UPDATE c_recurring SET stopped_at=? WHERE id=?').bind(now(), id), event(db, actor, 'recurring-stopped', {}, { recurring: id, merchant: found.merchant })]);
  return allowancesFor(db, actor);
}

/** What a person has already claimed against a cap in one period: every expense against it on their claims that are not
 * rejected (drafts included), other than the expense being saved. */
async function claimedAgainst(db: D1Database, allowance: string, employee: string, from: string, to: string, except: string | null) {
  return (await db.prepare("SELECT COALESCE(SUM(i.amount_minor),0) AS n FROM c_items i JOIN c_claims c ON c.id=i.claim_id WHERE i.allowance_id=? AND c.employee_email=? AND i.spent_on BETWEEN ? AND ? AND c.status<>'rejected' AND i.id<>?").bind(allowance, employee, from, to, except ?? '').first<{ n: number }>())!.n;
}

/** A purchase claimed against a cap is reimbursed up to what is left of it for the expense date's period, taken when the
 * expense is saved. Above that, the expense keeps the receipt's amount as claimed and is reimbursed only what is left: the
 * excess comes off its last categorized part first, its sales tax stays, and it is flagged as an exception (over-allowance). */
export async function capToAllowance(db: D1Database, employee: string, item: ItemInput, allowanceId: unknown, itemId: string | null): Promise<ItemInput> {
  requireThat(item.kind === 'receipt', 'Only a purchase with its receipt is claimed against an allowance');
  requireThat(typeof allowanceId === 'string', 'Allowance not found', 404);
  const cap = await db.prepare("SELECT * FROM c_allowances WHERE id=?1 AND type='cap' AND stopped_at IS NULL AND (member_email IS NULL OR member_email=?2) AND (department_id IS NULL OR department_id=(SELECT department_id FROM c_members WHERE email=?2))").bind(allowanceId, employee).first<Allowance>();
  requireThat(cap, 'That allowance does not apply to you', 404);
  requireThat(item.spent_on >= cap.starts_on, `${cap.name} starts on ${cap.starts_on}`);
  const p = periodOf(item.spent_on, cap.period), left = cap.amount_minor - await claimedAgainst(db, cap.id, employee, p.from, p.to, itemId);
  const currency = (await requireBusiness(db)).currency;
  requireThat(left > 0, `Nothing is left of ${cap.name} for ${p.key}`);
  if (item.amount_minor <= left) return { ...item, allowance_id: cap.id, claimed_minor: null };
  requireThat(left > item.sales_tax_minor, `Only ${money(left, currency)} is left of ${cap.name} for ${p.key}, which does not cover this expense's sales tax`);
  let excess = item.amount_minor - left;
  const parts = [...item.allocations];
  for (let i = parts.length - 1; i >= 0 && excess > 0; i--) { const cut = Math.min(excess, parts[i].amount_minor); parts[i] = { ...parts[i], amount_minor: parts[i].amount_minor - cut }; excess -= cut; }
  return { ...item, amount_minor: left, claimed_minor: item.amount_minor, allowance_id: cap.id, allocations: parts.filter(a => a.amount_minor > 0) };
}

/** The exception a capped expense raises, naming what was claimed, what was left and what is not reimbursed. */
export async function overAllowance(db: D1Database, item: { allowance_id?: string | null; claimed_minor?: number | null; amount_minor: number; spent_on: string }, currency: string) {
  if (!item.allowance_id || !item.claimed_minor) return null;
  const cap = await db.prepare('SELECT name,period FROM c_allowances WHERE id=?').bind(item.allowance_id).first<{ name: string; period: Period }>();
  return `Claimed ${money(item.claimed_minor, currency)} against ${cap?.name ?? 'an allowance'}; only ${money(item.amount_minor, currency)} was left for ${cap ? periodOf(item.spent_on, cap.period).key : 'its period'}, so ${money(item.claimed_minor - item.amount_minor, currency)} is not reimbursed`;
}

/** Each allowance that applies to this person with what is left of it in the period holding `on` (today by default); finance, auditors and the owner also
 * see every allowance, and everyone sees their own recurring expenses. */
export async function allowancesFor(db: D1Database, actor: Actor, on?: string) {
  const settings = await business(db);
  if (!settings) return { mine: [], all: [], recurring: [] };
  const day = on ? isoDate(on, 'Day') : localDate(new Date().toISOString(), settings.timezone);
  const { results } = await db.prepare('SELECT a.*, c.name AS category_name FROM c_allowances a LEFT JOIN c_categories c ON c.id=a.category_id ORDER BY a.stopped_at IS NOT NULL, a.name').all<Allowance & { category_name: string | null }>();
  const person = actor.roles.employee ? await db.prepare('SELECT department_id FROM c_members WHERE email=? AND active=1 AND is_employee=1').bind(actor.email).first<{ department_id: string | null }>() : null, employee = !!person;
  const mine = await Promise.all(results.filter(a => employee && !a.stopped_at && (a.member_email === null || a.member_email === actor.email) && (a.department_id === null || a.department_id === person!.department_id)).map(async a => {
    const p = periodOf(day, a.period);
    if (a.type === 'stipend') return { ...a, period_key: p.key, paid_this_period: !!await db.prepare('SELECT 1 FROM c_allowance_runs WHERE source_id=? AND member_email=? AND period=?').bind(a.id, actor.email, p.key).first() };
    const used = await claimedAgainst(db, a.id, actor.email, p.from, p.to, null);
    return { ...a, period_key: p.key, claimed_minor: used, remaining_minor: Math.max(0, a.amount_minor - used) };
  }));
  const recurring = (await db.prepare('SELECT r.*, c.name AS category_name FROM c_recurring r JOIN c_categories c ON c.id=r.category_id WHERE r.member_email=? ORDER BY r.stopped_at IS NOT NULL, r.merchant').bind(actor.email).all()).results;
  return { mine, all: can(actor, 'readAll') ? results : [], recurring };
}

/** Claim the period for one source and person and write its claim, all or nothing: a second run finds the period taken. */
async function openPeriod(db: D1Database, source: string, member: string, key: string, title: string, currency: string, item: ItemInput, history: [string, Data]) {
  const claimId = uid(), itemId = uid();
  try {
    await db.batch([
      insertClaim(db, claimId, member, title, currency, null),
      db.prepare('INSERT INTO c_allowance_runs(source_id,member_email,period,claim_id,created_at) VALUES(?,?,?,?,?)').bind(source, member, key, claimId, now()),
      ...insertItem(db, claimId, itemId, 0, item, null), claimTotal(db, claimId),
      ruleEvent(db, SCHEDULE, history[0], { claim: claimId }, { ...history[1], item: itemId, period: key, employee: member, amountMinor: item.amount_minor }),
    ]);
    return claimId;
  } catch (error) {
    if (String((error as Error)?.message).includes('c_allowance_runs')) return null;
    throw error;
  }
}

const later = (a: string, b: string) => a > b ? a : b;
const label = (p: Period) => p === 'monthly' ? 'Monthly' : p === 'quarterly' ? 'Quarterly' : 'Yearly';

/** The hourly run (business time zone): for each live stipend, every active employee it covers gets one claim for the
 * current period, dated the period's first day (or the start day, when later) and submitted to their approver like any
 * claim; a deactivated employee gets none. Each live recurring expense of an active employee opens one draft for the
 * current period with the receipt requested. Periods before the run first saw a source are not back-filled. */
export async function runAllowances(env: Bindings, at: Date) {
  const db = env.DB, settings = await business(db);
  if (!settings) return;
  const day = localDate(at.toISOString(), settings.timezone);
  const stipends = (await db.prepare("SELECT * FROM c_allowances WHERE type='stipend' AND stopped_at IS NULL AND starts_on<=?").bind(day).all<Allowance>()).results;
  for (const s of stipends) {
    const p = periodOf(day, s.period), people = (await db.prepare('SELECT email FROM c_members WHERE active=1 AND is_employee=1 AND (?1 IS NULL OR email=?1) AND (?2 IS NULL OR department_id=?2) ORDER BY email').bind(s.member_email, s.department_id).all<{ email: string }>()).results;
    for (const { email: member } of people) {
      const item: ItemInput = { kind: 'stipend', spent_on: later(p.from, s.starts_on), merchant: s.name, description: `${label(s.period)} stipend for ${p.key} · ${s.tax === 'taxable' ? 'taxable pay' : 'accountable plan'}`, amount_minor: s.amount_minor, distance_hundredths: null, days: null, rate_thousandths: null, explanation: `Stipend set by finance (${s.name})`, allocations: [{ category_id: s.category_id!, cost_centre: '', amount_minor: s.amount_minor }], sales_tax_minor: 0, sales_tax_account: '', sales_tax_code: '', allowance_id: s.id };
      const claimId = await openPeriod(db, s.id, member, p.key, `${s.name} · ${p.key}`, settings.currency, item, ['stipend-created', { allowance: s.id, tax: s.tax }]);
      if (!claimId) continue;
      try { await submitScheduled(db, claimId, SCHEDULE); }
      catch (error) { await ruleEvent(db, SCHEDULE, 'stipend-not-submitted', { claim: claimId }, { reason: (error as Error).message }).run(); }
    }
  }
  const recurring = (await db.prepare('SELECT r.* FROM c_recurring r JOIN c_members m ON m.email=r.member_email AND m.active=1 AND m.is_employee=1 WHERE r.stopped_at IS NULL AND r.starts_on<=?').bind(day).all<Data>()).results;
  for (const r of recurring) {
    const p = periodOf(day, r.period);
    const item: ItemInput = { kind: 'receipt', spent_on: later(p.from, r.starts_on), merchant: r.merchant, description: `${r.description ? r.description + ' · ' : ''}${label(r.period)} recurring expense: receipt requested`, amount_minor: r.amount_minor, distance_hundredths: null, days: null, rate_thousandths: null, explanation: '', allocations: [{ category_id: r.category_id, cost_centre: '', amount_minor: r.amount_minor }], sales_tax_minor: 0, sales_tax_account: '', sales_tax_code: '' };
    await openPeriod(db, r.id, r.member_email, p.key, `${r.merchant} · ${p.key}`, settings.currency, item, ['recurring-created', { recurring: r.id }]);
  }
}
