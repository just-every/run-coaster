import { all, authority, commit } from './session';
import { event, ruleEvent } from './events';
import { business, requireBusiness } from './settings';
import { spendLines } from './spend';
import { localDate } from './reports';
import { parseCsv } from './imports/csv';
import { operatorMail } from '../mail.server.mjs';
import type { Bindings } from '../auth.server';
import type { ClaimItem, PolicyException } from './exceptions';
import { amount, decimal, email, now, requireThat, text, uid, type Actor, type Data } from './types';

/** Budgets with threshold alerts (REPORT-004). Departments (ADMIN-001), projects and tags (CODE-001) and card charges
 * (FEED-004) become budget scopes when those clauses ship. */
export type Budget = { id: string; version: number; name: string; scope: 'entity' | 'category' | 'cost-centre'; scope_key: string; per_member: number; period: 'monthly' | 'quarterly' | 'yearly'; amount_minor: number; owner_email: string; thresholds: number[]; policy_rule: number; alert_amounts: number; set_by: string; set_at: string };
const SCOPES = ['entity', 'category', 'cost-centre'], PERIODS = ['monthly', 'quarterly', 'yearly'];

/** The period holding a date (YYYY-MM, YYYY-Qn or YYYY) and its first and last day. */
export function periodOf(day: string, period: Budget['period']) {
  const y = day.slice(0, 4), m = Number(day.slice(5, 7));
  if (period === 'yearly') return { key: y, from: `${y}-01-01`, to: `${y}-12-31` };
  const [first, last] = period === 'monthly' ? [m, m] : [Math.floor((m - 1) / 3) * 3 + 1, Math.floor((m - 1) / 3) * 3 + 3];
  const end = new Date(Date.UTC(Number(y), last, 0)).toISOString().slice(0, 10);
  return { key: period === 'monthly' ? day.slice(0, 7) : `${y}-Q${Math.ceil(m / 3)}`, from: `${y}-${String(first).padStart(2, '0')}-01`, to: end };
}

/** Current version of every budget not retired. */
export async function budgets(db: D1Database): Promise<Budget[]> {
  const { results } = await db.prepare('SELECT b.* FROM c_budgets b WHERE b.version=(SELECT MAX(version) FROM c_budgets x WHERE x.id=b.id) AND b.retired=0 ORDER BY b.name').all<Data>();
  return results.map(b => ({ ...b, thresholds: JSON.parse(b.thresholds) }) as Budget);
}

const inScope = (b: Budget, l: Data) => b.scope === 'entity' || (b.scope === 'category' ? l.category === b.scope_key : l.costCentre === b.scope_key);

/** A budget's actual for one period: submitted (pending) and approved spend by expense date, per member when it is per member. */
export async function actual(db: D1Database, b: Budget, day: string) {
  const p = periodOf(day, b.period), lines = (await spendLines(db, p.from, p.to)).filter(l => inScope(b, l));
  const sum = (ls: Data[]) => ({ approvedMinor: ls.filter(l => l.status === 'approved').reduce((n, l) => n + l.amountMinor, 0), pendingMinor: ls.filter(l => l.status === 'pending').reduce((n, l) => n + l.amountMinor, 0) });
  const view = (ls: Data[], member?: string) => { const s = sum(ls), total = s.approvedMinor + s.pendingMinor; return { member, ...s, actualMinor: total, budgetMinor: b.amount_minor, remainingMinor: b.amount_minor - total, percent: Math.round(total * 1000 / b.amount_minor) / 10 }; };
  return { period_key: p.key, period_from: p.from, period_to: p.to, ...(b.per_member ? { members: [...new Set(lines.map(l => l.employee))].sort().map(m => view(lines.filter(l => l.employee === m), m)) } : view(lines)) };
}

function budgetInput(b: Data, members: Set<string>, categories: Set<string>) {
  const scope = String(b.scope ?? 'entity');
  requireThat(SCOPES.includes(scope), 'A budget covers the whole business, a category or a cost centre');
  const scopeKey = scope === 'entity' ? '' : text(b.scopeKey, scope === 'category' ? 'Category' : 'Cost centre', 100);
  requireThat(scope !== 'category' || categories.has(scopeKey), 'Choose one of your categories');
  const period = String(b.period ?? '');
  requireThat(PERIODS.includes(period), 'A budget is monthly, quarterly or yearly');
  const owner = email(b.owner, 'Budget owner');
  requireThat(members.has(owner), 'The budget owner must be an active member');
  const thresholds = (Array.isArray(b.thresholds) ? b.thresholds : String(b.thresholds ?? '80, 100').split(',')).map(x => Number(String(x).trim()));
  requireThat(thresholds.length >= 1 && thresholds.length <= 4 && thresholds.every((t, i) => Number.isInteger(t) && t >= 1 && t <= 200 && (i === 0 || t > thresholds[i - 1])), 'Alerts take one to four rising percentages, such as 80, 100');
  const flag = (v: unknown) => v === true || v === 'true' || v === 'on' || v === 'yes' || v === '1';
  return { name: text(b.name, 'Budget name', 100), scope, scopeKey, period, amountMinor: amount(b.amount, 'Budget amount'), owner, thresholds, perMember: flag(b.perMember), policyRule: flag(b.policyRule), alertAmounts: flag(b.alertAmounts) };
}

async function context(db: D1Database) {
  const members = new Set((await db.prepare('SELECT email FROM c_members WHERE active=1').all<{ email: string }>()).results.map(r => r.email));
  const categories = new Set((await db.prepare('SELECT id FROM c_categories').all<{ id: string }>()).results.map(r => r.id));
  return { members, categories };
}
const insert = (db: D1Database, id: string, version: number, v: ReturnType<typeof budgetInput>, by: string) => db.prepare('INSERT INTO c_budgets(id,version,name,scope,scope_key,per_member,period,amount_minor,owner_email,thresholds,policy_rule,alert_amounts,set_by,set_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, version, v.name, v.scope, v.scopeKey, v.perMember ? 1 : 0, v.period, v.amountMinor, v.owner, JSON.stringify(v.thresholds), v.policyRule ? 1 : 0, v.alertAmounts ? 1 : 0, by, now());
/** Only the owner may let a budget's alerts carry amounts; by default they name the percentage and period only. */
const amountsAllowed = (actor: Actor, v: ReturnType<typeof budgetInput>) => requireThat(!v.alertAmounts || actor.roles.owner, 'Only the owner can let budget alerts carry amounts', 403);
const setter = (actor: Actor) => { requireThat(actor.roles.finance || actor.roles.owner, 'Finance or owner access required', 403); requireThat(actor.kind === 'person', 'Only a person sets budgets', 403); return authority(actor, actor.roles.owner ? 'owner' : 'finance'); };

/** The owner or finance sets a budget; changing one saves its next version, and earlier versions stay. */
export async function saveBudget(db: D1Database, actor: Actor, b: Data) {
  const guard = setter(actor);
  await requireBusiness(db);
  const ctx = await context(db), v = budgetInput(b, ctx.members, ctx.categories);
  amountsAllowed(actor, v);
  const id = typeof b.id === 'string' && b.id ? b.id : uid();
  const version = ((await db.prepare('SELECT MAX(version) AS n FROM c_budgets WHERE id=?').bind(id).first<{ n: number | null }>())?.n ?? 0) + 1;
  requireThat(!b.id || version > 1, 'Budget not found', 404);
  await commit(db, all(guard, { sql: 'NOT EXISTS(SELECT 1 FROM c_budgets WHERE id=? AND version>=?)', params: [id, version] }), [insert(db, id, version, v, actor.delegate?.email ?? actor.email), event(db, actor, 'budget-saved', {}, { budget: id, version, ...v })]);
  return budgetReport(db, actor);
}

/** Budgets from a CSV with columns name, scope, scopeKey, period, amount, owner, thresholds, perMember, policyRule, alertAmounts; every row must be valid or none is saved. */
export async function importBudgets(db: D1Database, actor: Actor, b: Data) {
  const guard = setter(actor);
  await requireBusiness(db);
  requireThat(typeof b.csv === 'string' && b.csv.length > 0 && b.csv.length <= 200_000, 'Choose the budgets CSV');
  const { rows } = parseCsv(b.csv), ctx = await context(db), by = actor.delegate?.email ?? actor.email;
  requireThat(rows.length >= 1 && rows.length <= 200, 'Import one to 200 budgets');
  const parsed = rows.map((r, i) => { try { return budgetInput(r, ctx.members, ctx.categories); } catch (e) { throw Object.assign(e as Error, { message: `Row ${i + 2}: ${(e as Error).message}` }); } });
  parsed.forEach(v => amountsAllowed(actor, v));
  await commit(db, guard, [...parsed.map(v => insert(db, uid(), 1, v, by)), event(db, actor, 'budgets-imported', {}, { budgets: parsed.length })]);
  return budgetReport(db, actor);
}

/** Every budget's actual for the period holding `day` (today by default), for finance, auditors, the owner and each budget's owner. */
export async function budgetReport(db: D1Database, actor: Actor, day?: string) {
  const settings = await requireBusiness(db), all = await budgets(db);
  const reader = actor.roles.finance || actor.roles.auditor || actor.roles.owner;
  const mine = all.filter(b => reader || b.owner_email === actor.email);
  requireThat(reader || mine.length, 'Finance, auditor, owner or budget owner access required', 403);
  const on = day ?? localDate(new Date().toISOString(), settings.timezone);
  return Promise.all(mine.map(async b => ({ ...b, ...(await actual(db, b, on)) })));
}

/** With a budget's policy rule on, an expense whose spend would take the budget past its amount for its period (counting
 * every other submitted claim and this claim's earlier expenses in order) is a soft exception the approver sees. */
export async function overBudget(db: D1Database, claim: { id: string; employee_email: string }, items: ClaimItem[]): Promise<PolicyException[]> {
  const ruled = (await budgets(db)).filter(b => b.policy_rule), found: PolicyException[] = [];
  for (const b of ruled) {
    const used = new Map<string, number>();
    for (const item of items) {
      const p = periodOf(item.spent_on, b.period), parts = item.allocations.filter(a => inScope(b, { category: a.category_id, costCentre: a.cost_centre ?? '' }));
      const amountMinor = parts.reduce((n, a) => n + a.amount_minor, 0);
      if (!amountMinor) continue;
      if (!used.has(p.key)) used.set(p.key, (await spendLines(db, p.from, p.to)).filter(l => l.claim !== claim.id && inScope(b, l) && (!b.per_member || l.employee === claim.employee_email)).reduce((n, l) => n + l.amountMinor, 0));
      const total = used.get(p.key)! + amountMinor;
      used.set(p.key, total);
      if (total > b.amount_minor) found.push({ item: item.id, code: 'over-budget', message: `Over the ${b.name} budget of ${decimal(b.amount_minor)} for ${p.key}${b.per_member ? ' a person' : ''}` });
    }
  }
  return found;
}

/** The hourly run: each budget's current period (business time zone) alerts its owner and finance once per threshold
 * crossed, per member for a per-member budget; crossing several at once sends only the highest. */
export async function runBudgets(env: Bindings, at: Date) {
  const db = env.DB, settings = await business(db);
  if (!settings) return;
  const day = localDate(at.toISOString(), settings.timezone), mail = operatorMail(env);
  const finance = (await db.prepare('SELECT email FROM c_members WHERE active=1 AND is_finance=1 ORDER BY email').all<{ email: string }>()).results.map(r => r.email);
  for (const b of await budgets(db)) {
    const result: Data = await actual(db, b, day);
    for (const row of (result.members ?? [result]) as Data[]) {
      const crossed = b.thresholds.filter(t => row.actualMinor * 100 >= b.amount_minor * t);
      if (!crossed.length) continue;
      const member = row.member ?? '', done = (await db.prepare('SELECT MAX(threshold) AS t FROM c_budget_alerts WHERE budget_id=? AND period=? AND member=?').bind(b.id, result.period_key, member).first<{ t: number | null }>())?.t ?? 0;
      const top = crossed.at(-1)!;
      if (done >= top) continue;
      const to = [...new Set([b.owner_email, ...finance])];
      const claimed = await db.prepare('INSERT INTO c_budget_alerts(budget_id,period,member,threshold,recipients,sent_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING budget_id').bind(b.id, result.period_key, member, top, JSON.stringify(to), at.toISOString()).first();
      if (!claimed) continue;
      const link = `${env.AUTH_ORIGIN}/app#/settings`, amounts = b.alert_amounts ? ` (${settings.currency} ${decimal(row.actualMinor)} of ${settings.currency} ${decimal(b.amount_minor)})` : '', words = `${b.name}${member ? ` for ${member}` : ''} has reached ${top}% of its budget${amounts} for ${result.period_key}. See it in Coaster under Settings, Budgets: ${link}`;
      const sent = mail ? await mail.send({ deliveryId: `budget-${b.id}-${result.period_key}-${member}-${top}`, from: env.MAIL_FROM ?? '', to, subject: `Budget alert: ${b.name} at ${top}%`, text: words, html: `<p>${words.replace(link, '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)}<a href="${link}">${link}</a></p>`, headers: {} }) : null;
      await ruleEvent(db, 'budget', 'budget-alert', {}, { budget: b.id, name: b.name, period: result.period_key, member: member || null, threshold: top, to, mail: sent?.status ?? 'mail not set up' }).run();
    }
  }
}
