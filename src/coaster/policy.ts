import { all, authority, commit, need } from './session';
import { event } from './events';
import { localDay } from './delegation';
import { money, type ClaimItem, type PolicyException } from './exceptions';
import type { Business } from './settings';
import type { Category } from './items';
import { amount, isoDate, now, requireThat, text, type Actor, type Data } from './types';

/** Versioned policy rules (POLICY-001). A version is the whole rule set, in effect from its day (business time zone)
 * until a later version takes effect. Each rule is soft (explain, and the approver acknowledges, COA-004) or hard (the
 * claim cannot be submitted). */
export type Rule =
  | { kind: 'daily-limit'; category: string; limit_minor: number; hard: boolean }
  | { kind: 'blocked-merchant'; merchant: string; hard: boolean }
  | { kind: 'deadline'; days: number; hard: boolean };
export type Policy = { version: number; effective_from: string; rules: Rule[]; published_by: string; published_at: string };

const normal = (merchant: string) => merchant.trim().toLowerCase().replace(/\s+/g, ' ');
const parse = (p: Data): Policy => ({ ...p, rules: JSON.parse(p.rules) } as Policy);

export async function policies(db: D1Database): Promise<Policy[]> {
  return (await db.prepare('SELECT * FROM c_policies ORDER BY version DESC').all<Data>()).results.map(parse);
}
/** The version in effect on a day: the newest one whose effective day has come. */
export async function policyOn(db: D1Database, day: string): Promise<Policy | null> {
  const found = await db.prepare('SELECT * FROM c_policies WHERE effective_from<=? ORDER BY version DESC LIMIT 1').bind(day).first<Data>();
  return found ? parse(found) : null;
}

function rule(r: Data, known: Category[]): Rule {
  const hard = r.hard === true || r.hard === 'true' || r.hard === 'on';
  if (r.kind === 'daily-limit') {
    const category = known.find(c => c.id === r.category && c.active === 1);
    requireThat(category, 'Choose an active category for the daily limit');
    return { kind: 'daily-limit', category: category.id, limit_minor: amount(r.limit, 'Daily limit'), hard };
  }
  if (r.kind === 'blocked-merchant') return { kind: 'blocked-merchant', merchant: text(r.merchant, 'Blocked merchant', 200), hard };
  if (r.kind === 'deadline') {
    const days = Number(r.days);
    requireThat(Number.isInteger(days) && days >= 1 && days <= 3650, 'Submit within a whole number of days from 1 to 3650');
    return { kind: 'deadline', days, hard };
  }
  requireThat(false, 'Choose a daily limit, a blocked merchant or a submission deadline');
}

/** Finance (or the owner) publishes the next version, in effect from today or a later day. */
export async function publishPolicy(db: D1Database, actor: Actor, b: Data, known: Category[], timezone: string) {
  need(actor, 'finance');
  const today = localDay(timezone), from = b.effectiveFrom ? isoDate(b.effectiveFrom, 'Effective from') : today;
  requireThat(from >= today, 'A new version takes effect today or on a later day');
  requireThat(Array.isArray(b.rules) && b.rules.length <= 50, 'Publish at most 50 rules');
  const rules = (b.rules as Data[]).map(r => rule(r, known));
  requireThat(rules.filter(r => r.kind === 'deadline').length <= 1, 'Set one submission deadline');
  const latest = (await db.prepare('SELECT MAX(version) AS v FROM c_policies').first<{ v: number | null }>())?.v ?? 0, version = latest + 1;
  await commit(db, all(authority(actor, 'finance'), { sql: 'NOT EXISTS(SELECT 1 FROM c_policies WHERE version>=?)', params: [version] }), [
    db.prepare('INSERT INTO c_policies(version,effective_from,rules,published_by,published_at) VALUES(?,?,?,?,?)').bind(version, from, JSON.stringify(rules), actor.delegate?.email ?? actor.email, now()),
    event(db, actor, 'policy-published', {}, { version, effectiveFrom: from, rules: rules.length }),
  ]);
  return policies(db);
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000);

/** The exceptions the version in effect today raises for a claim's current expenses, each naming that version. A daily
 * limit counts the employee's whole spend in its category on that expense date, across this claim and their other claims
 * that are not rejected, and flags every expense of this claim that day in that category; a blocked merchant matches the
 * merchant name ignoring case and spacing; the deadline counts calendar days from the expense date to today, so an
 * expense exactly that many days old is still in time. */
export async function policyExceptions(db: D1Database, claim: { id: string; employee_email: string }, items: ClaimItem[], business: Business, known: Category[]): Promise<PolicyException[]> {
  const today = localDay(business.timezone), policy = await policyOn(db, today);
  if (!policy) return [];
  const found: PolicyException[] = [], v = `policy v${policy.version}`, names = new Map(known.map(c => [c.id, c.name]));
  for (const r of policy.rules) {
    if (r.kind === 'blocked-merchant') for (const item of items.filter(i => normal(i.merchant) === normal(r.merchant)))
      found.push({ item: item.id, code: 'blocked-merchant', message: `${item.merchant} is a blocked merchant (${v})`, policy: policy.version, hard: r.hard });
    if (r.kind === 'deadline') for (const item of items.filter(i => daysBetween(i.spent_on, today) > r.days))
      found.push({ item: item.id, code: 'past-deadline', message: `Spent on ${item.spent_on}, more than ${r.days} days before submission (${v})`, policy: policy.version, hard: r.hard });
    if (r.kind === 'daily-limit') for (const day of new Set(items.map(i => i.spent_on))) {
      const here = items.filter(i => i.spent_on === day && i.allocations.some(a => a.category_id === r.category));
      if (!here.length) continue;
      const mine = here.reduce((n, i) => n + i.allocations.filter(a => a.category_id === r.category).reduce((m, a) => m + a.amount_minor, 0), 0);
      const other = await db.prepare("SELECT COALESCE(SUM(a.amount_minor),0) AS n FROM c_allocations a JOIN c_items i ON i.id=a.item_id JOIN c_claims c ON c.id=i.claim_id WHERE c.employee_email=? AND c.id<>? AND c.status<>'rejected' AND i.spent_on=? AND a.category_id=?").bind(claim.employee_email, claim.id, day, r.category).first<{ n: number }>();
      const total = mine + (other?.n ?? 0);
      if (total > r.limit_minor) for (const item of here)
        found.push({ item: item.id, code: 'over-daily-limit', message: `${names.get(r.category) ?? 'This category'} on ${day} totals ${money(total, business.currency)}, over the daily limit of ${money(r.limit_minor, business.currency)} (${v})`, policy: policy.version, hard: r.hard });
    }
  }
  return found;
}
