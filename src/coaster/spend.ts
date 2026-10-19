import { commit, authority } from './session';
import { event } from './events';
import { business } from './settings';
import { claimNumber } from './claims';
import { isoDate, now, requireThat, text, uid, type Actor, type Data } from './types';

/** Spend analytics (REPORT-001). Departments (ADMIN-001), projects (CODE-001), cards (FEED-004) and budgets (REPORT-004)
 * join these groupings when those clauses ship. */
export const GROUPINGS = { employee: 'Employee', category: 'Category', merchant: 'Merchant', 'cost-centre': 'Cost centre', month: 'Month' } as const;
type By = keyof typeof GROUPINGS;
const isBy = (v: unknown): v is By => typeof v === 'string' && Object.hasOwn(GROUPINGS, v);

/** Finance, auditors and the owner see everyone's spend; a manager sees only the people whose approving manager they are. */
function scope(actor: Actor) {
  if (actor.roles.finance || actor.roles.auditor || actor.roles.owner) return { sql: '', params: [] as unknown[] };
  requireThat(actor.roles.manager, 'Finance, auditor, owner or manager access required', 403);
  return { sql: ' AND c.employee_email IN (SELECT email FROM c_members WHERE approver_email=?)', params: [actor.email] };
}

/** One line per category split of each expense on the current revision of every submitted, approved, batched or
 * reimbursed claim, plus its sales tax as its own line, so every grouping adds up to the same total. */
async function lines(db: D1Database, actor: Actor, from: string, to: string) {
  const s = scope(actor);
  const { results } = await db.prepare(`SELECT c.id,c.number,c.employee_email,c.status,r.snapshot,m.name AS employee_name FROM c_claims c JOIN c_revisions r ON r.claim_id=c.id AND r.revision=c.revision LEFT JOIN c_members m ON m.email=c.employee_email WHERE c.status IN ('submitted','approved','batched','reimbursed')${s.sql} ORDER BY c.number`).bind(...s.params).all<Data>();
  const out: Data[] = [];
  for (const c of results) for (const item of JSON.parse(c.snapshot).items as Data[]) {
    if (item.spent_on < from || item.spent_on > to) continue;
    const base = { claim: c.id, number: claimNumber(c.number), employee: c.employee_email, employeeName: c.employee_name ?? c.employee_email, status: c.status === 'submitted' ? 'pending' : 'approved', item: item.id, date: item.spent_on, merchant: item.merchant, receipt: item.receipt?.id ?? null };
    for (const part of item.allocations as Data[]) out.push({ ...base, category: part.category_id, categoryName: part.category_name, costCentre: part.cost_centre ?? '', amountMinor: part.amount_minor });
    if (item.sales_tax_minor) out.push({ ...base, category: 'sales-tax', categoryName: 'Sales tax', costCentre: '', amountMinor: item.sales_tax_minor });
  }
  return out;
}

const keyOf = (by: By, l: Data): [string, string] => by === 'employee' ? [l.employee, l.employeeName] : by === 'category' ? [l.category, l.categoryName] : by === 'merchant' ? [l.merchant.trim().toLowerCase(), l.merchant.trim()] : by === 'cost-centre' ? [l.costCentre, l.costCentre || 'No cost centre'] : [l.date.slice(0, 7), l.date.slice(0, 7)];

/** Spend for expense dates in the period (both ends inclusive), grouped one way, approved and pending apart; with `key`,
 * the lines of that one group, each with its receipt to open. A saved view (`view`) reopens its own query. */
export async function spend(db: D1Database, actor: Actor, query: Record<string, string>) {
  scope(actor);
  const settings = await business(db);
  requireThat(settings, 'The owner has not set up the business yet', 409);
  let q: Record<string, string> = query;
  if (query.view) {
    const saved = await db.prepare('SELECT query FROM c_spend_views WHERE id=? AND owner_email=?').bind(query.view, actor.email).first<{ query: string }>();
    requireThat(saved, 'Saved view not found', 404);
    q = { ...JSON.parse(saved.query), ...(query.key ? { key: query.key } : {}) };
  }
  requireThat(isBy(q.by), 'Choose how to group spend', 400);
  const from = isoDate(q.from, 'From'), to = isoDate(q.to, 'Until');
  requireThat(to >= from, 'The period must end on or after it starts');
  const all = await lines(db, actor, from, to), by = q.by;
  if (q.key !== undefined) {
    const picked = all.filter(l => keyOf(by, l)[0] === q.key);
    return { by, from, to, key: q.key, currency: settings.currency, lines: picked.map(l => ({ ...l, receiptLink: l.receipt ? `/api/coaster/receipts/${l.receipt}` : null })), totalMinor: picked.reduce((n, l) => n + l.amountMinor, 0) };
  }
  const groups = new Map<string, Data>();
  for (const l of all) {
    const [key, label] = keyOf(by, l), g = groups.get(key) ?? { key, label, totalMinor: 0, approvedMinor: 0, pendingMinor: 0, expenses: new Set<string>() };
    g.totalMinor += l.amountMinor; g[l.status === 'pending' ? 'pendingMinor' : 'approvedMinor'] += l.amountMinor; g.expenses.add(l.item);
    groups.set(key, g);
  }
  const rows = [...groups.values()].map(g => ({ ...g, expenses: g.expenses.size }) as Data).sort((a, b) => by === 'month' ? a.key.localeCompare(b.key) : b.totalMinor - a.totalMinor || a.label.localeCompare(b.label));
  return { by, from, to, currency: settings.currency, groups: rows, totalMinor: all.reduce((n, l) => n + l.amountMinor, 0), views: await spendViews(db, actor) };
}

export async function spendViews(db: D1Database, actor: Actor) {
  return (await db.prepare('SELECT id,name,query,created_at FROM c_spend_views WHERE owner_email=? ORDER BY name').bind(actor.email).all<Data>()).results.map(v => ({ ...v, query: JSON.parse(v.query) }));
}

/** Anyone who can see spend saves a grouping and period under a name for themselves, and reopens it later. */
export async function saveSpendView(db: D1Database, actor: Actor, b: Data) {
  scope(actor);
  requireThat(actor.kind === 'person', 'Only a person saves a view', 403);
  const name = text(b.name, 'View name', 80);
  requireThat(isBy(b.by), 'Choose how to group spend');
  const query = { by: b.by, from: isoDate(b.from, 'From'), to: isoDate(b.to, 'Until') };
  requireThat(query.to >= query.from, 'The period must end on or after it starts');
  const id = uid(), who = actor.delegate?.email ?? actor.email;
  await commit(db, authority(actor), [
    db.prepare('INSERT INTO c_spend_views(id,owner_email,name,query,created_by,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_email,name) DO UPDATE SET query=excluded.query').bind(id, actor.email, name, JSON.stringify(query), who, now()),
    event(db, actor, 'spend-view-saved', {}, { name, ...query }),
  ]);
  return spendViews(db, actor);
}
