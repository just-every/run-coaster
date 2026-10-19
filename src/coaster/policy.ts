import { all, authority, commit, need } from './session';
import { event } from './events';
import { localDay } from './delegation';
import { captureConfiguration, type Configuration } from './policy-configuration';
import type { Category } from './items';
import { amount, isoDate, now, requireThat, text, type Actor, type Data } from './types';

/** Versioned policy rules (POLICY-001). A version is the whole rule set, in effect from its day (business time zone)
 * until a later version takes effect. Each rule is soft (explain, and the approver acknowledges, COA-004) or hard (the
 * claim cannot be submitted). */
export type Rule =
  | { kind: 'daily-limit' | 'trip-limit' | 'monthly-limit' | 'per-expense-limit' | 'attendee-limit'; category: string; limit_minor: number; hard: boolean }
  | { kind: 'blocked-merchant'; merchant: string; hard: boolean }
  | { kind: 'deadline'; days: number; hard: boolean }
  | { kind: 'blocked-category' | 'approval-required'; category: string; hard: boolean }
  | { kind: 'weekend' | 'holiday'; hard: boolean }
  | { kind: 'receipt-threshold'; limit_minor: number; hard: boolean }
  | { kind: 'required-field'; category: string; field: string; hard: boolean };
export type Policy = { version: number; effective_from: string; rules: Rule[]; configuration: Configuration; published_by: string; published_at: string };

const parse = (p: Data): Policy => ({ ...p, rules: JSON.parse(p.rules), configuration: JSON.parse(p.configuration) } as Policy);

export async function policies(db: D1Database): Promise<Policy[]> {
  return (await db.prepare('SELECT p.*,c.configuration FROM c_policies p JOIN c_policy_configurations c ON c.version=p.version ORDER BY p.version DESC').all<Data>()).results.map(parse);
}
/** The version in effect on a day: the newest one whose effective day has come. */
export async function policyOn(db: D1Database, day: string): Promise<Policy | null> {
  const found = await db.prepare('SELECT p.*,c.configuration FROM c_policies p JOIN c_policy_configurations c ON c.version=p.version WHERE p.effective_from<=? ORDER BY p.version DESC LIMIT 1').bind(day).first<Data>();
  return found ? parse(found) : null;
}

function rule(r: Data, known: Category[]): Rule {
  const hard = r.hard === true || r.hard === 'true' || r.hard === 'on';
  if (['daily-limit', 'trip-limit', 'monthly-limit', 'per-expense-limit', 'attendee-limit', 'blocked-category', 'approval-required', 'required-field'].includes(r.kind)) {
    const category = known.find(c => c.id === r.category && c.active === 1);
    requireThat(category, 'Choose an active category');
    if (r.kind === 'required-field') return { kind: r.kind, category: category.id, field: text(r.field, 'Required field', 60), hard };
    return ['blocked-category', 'approval-required'].includes(r.kind) ? { kind: r.kind, category: category.id, hard } as Rule : { kind: r.kind, category: category.id, limit_minor: amount(r.limit, 'Category limit'), hard } as Rule;
  }
  if (r.kind === 'receipt-threshold') return { kind: r.kind, limit_minor: amount(r.limit, 'Receipt threshold'), hard };
  if (r.kind === 'weekend' || r.kind === 'holiday') return { kind: r.kind, hard };
  if (r.kind === 'blocked-merchant') return { kind: 'blocked-merchant', merchant: text(r.merchant, 'Blocked merchant', 200), hard };
  if (r.kind === 'deadline') {
    const days = Number(r.days);
    requireThat(Number.isInteger(days) && days >= 1 && days <= 3650, 'Submit within a whole number of days from 1 to 3650');
    return { kind: 'deadline', days, hard };
  }
  requireThat(false, 'Choose a supported policy rule');
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
    captureConfiguration(db, version),
    event(db, actor, 'policy-published', {}, { version, effectiveFrom: from, rules: rules.length }),
  ]);
  return policies(db);
}
