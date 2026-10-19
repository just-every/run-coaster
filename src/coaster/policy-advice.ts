import { all, authority, commit, need, sha256Hex } from './session';
import { captureConfiguration, policyStill, type Configuration } from './policy-configuration';
import { event } from './events';
import { localDay } from './delegation';
import { money, type ClaimItem, type PolicyException } from './exceptions';
import type { Category } from './items';
import type { Rule } from './policy';
import { now, requireThat, text, type Actor, type Data } from './types';

type ExpenseLimit = Extract<Rule, { limit_minor: number }> & { kind: 'per-expense-limit' };
type HistoricalPolicy = { version: number; effective_from: string; rules: Rule[]; configuration: Configuration & { legacy_capture?: number } };
type History = { id: string; number: number; employee_email: string; status: string; revision: number; snapshot: string; decision: string | null; approved_exceptions: string | null };
const softLimits = (rules: Rule[], category: string) => rules.filter((r): r is ExpenseLimit => r.kind === 'per-expense-limit' && r.category === category && !r.hard);
const categoryAmount = (item: ClaimItem, category: string) => item.allocations.filter(a => a.category_id === category).reduce((n, a) => n + a.amount_minor, 0);

function minutesInput(body: Data) {
  const value = body.minutesPerException;
  requireThat(typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1440, 'Enter estimated minutes per exception, greater than zero and at most 1440');
  return value;
}

/** Rolling calendar year, including today; clamp February 29 to February 28. */
function yearBefore(day: string) {
  const [year, month, date] = day.split('-').map(Number);
  const last = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
  return `${year - 1}-${String(month).padStart(2, '0')}-${String(Math.min(date, last)).padStart(2, '0')}`;
}

/** Legacy exceptions have no category id. Attribute only the exact recorded owner-limit format, using the frozen
 * allocation's id/name, not an unrelated exception on the same item or today's renamed category. */
function legacyOwnerException(exception: PolicyException, item: ClaimItem, category: string, currency: string) {
  const parts = item.allocations.filter(a => a.category_id === category), name = parts[0]?.category_name;
  if (!name || parts.some(a => a.category_name !== name) || item.allocations.some(a => a.category_id !== category && a.category_name === name)) return false;
  const prefix = `Over the ${name} limit of `;
  if (!exception.message.startsWith(prefix)) return false;
  const printed = exception.message.slice(prefix.length), raw = printed.slice(currency === 'USD' ? 1 : currency.length + 1).replaceAll(',', '');
  if (!/^\d+\.\d{2}$/.test(raw)) return false;
  const limit = Math.round(Number(raw) * 100);
  return Number.isSafeInteger(limit) && money(limit, currency) === printed && categoryAmount(item, category) > limit;
}

function acknowledged(item: ClaimItem, category: string, snapshot: Data, approved: PolicyException[], policies: Map<number, HistoricalPolicy>) {
  return (snapshot.exceptions as PolicyException[]).some(e => {
    if (e.item !== item.id || e.code !== 'over-limit' || e.hard || !approved.some(a => a.item === e.item && a.code === e.code && a.message === e.message && a.policy === e.policy && !a.hard)) return false;
    if (legacyOwnerException(e, item, category, snapshot.currency)) return true;
    const policy = policies.get(e.policy ?? snapshot.policyVersion);
    if (!policy) return false;
    const amount = categoryAmount(item, category), historical = policy.configuration.categories.find(c => c.id === category);
    if (!historical) return false;
    return softLimits(policy.rules, category).some(r => amount > r.limit_minor && e.message === `${historical.name} totals ${money(amount, snapshot.currency)} for 1 person, over ${money(r.limit_minor, snapshot.currency)} per expense (policy v${policy.version})`);
  });
}

function replayExpenses(history: History[], window: { from: string; to: string }, category: string, policies: Map<number, HistoricalPolicy>) {
  return history.flatMap(claim => {
    const snapshot: Data = JSON.parse(claim.snapshot), approved: PolicyException[] = JSON.parse(claim.approved_exceptions ?? '[]');
    const hasApproval = ['approved', 'batched', 'reimbursed'].includes(claim.status) && claim.decision === 'approved';
    return (snapshot.items as ClaimItem[])
      .filter(item => item.spent_on >= window.from && item.spent_on <= window.to)
      .map(item => ({
        claim, title: snapshot.title as string, item, amount: categoryAmount(item, category),
        approvedException: hasApproval && acknowledged(item, category, snapshot, approved, policies),
      }))
      .filter(expense => expense.amount > 0);
  });
}

/** Read one consistent native snapshot. Drafts stay private; every claim is replayed from its latest submitted
 * revision only. Imported history has no native acknowledgments and is never invented as approval evidence. */
async function inputs(db: D1Database) {
  const [business, categories, versions, claims, events] = await db.batch([
    db.prepare('SELECT timezone,currency FROM c_business WHERE id=1'),
    db.prepare('SELECT id,name,active,limit_minor FROM c_categories ORDER BY id'),
    db.prepare('SELECT p.version,p.effective_from,p.rules,c.configuration FROM c_policies p JOIN c_policy_configurations c ON c.version=p.version ORDER BY p.version'),
    db.prepare("SELECT c.id,c.number,c.employee_email,c.status,c.revision,r.snapshot,d.decision,d.exceptions AS approved_exceptions FROM c_claims c JOIN c_revisions r ON r.claim_id=c.id AND r.revision=c.revision LEFT JOIN c_decisions d ON d.claim_id=r.claim_id AND d.revision=r.revision WHERE c.status IN ('submitted','approved','batched','reimbursed') AND NOT EXISTS(SELECT 1 FROM c_revisions newer WHERE newer.claim_id=c.id AND newer.revision>r.revision) ORDER BY c.number,c.id"),
    db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM c_events'),
  ]);
  const businessRow = business.results[0] as { timezone: string; currency: string } | undefined;
  requireThat(businessRow, 'The owner has not set up the business yet', 409);
  const today = localDay(businessRow.timezone), window = { from: yearBefore(today), to: today };
  const policies = (versions.results as Data[]).map(p => ({ ...p, rules: JSON.parse(p.rules), configuration: JSON.parse(p.configuration) })) as HistoricalPolicy[];
  const current = policies.filter(p => p.effective_from <= today).at(-1);
  requireThat(current, 'The active policy configuration is missing; ask the owner to save the business settings', 409);
  return { business: businessRow, categories: categories.results as Pick<Category, 'id' | 'name' | 'active' | 'limit_minor'>[], policies, current, history: claims.results as History[], window, latest: policies.at(-1)!.version, eventSeq: (events.results[0] as { seq: number }).seq };
}

async function calculate(db: D1Database, minutesPerException: number) {
  const input = await inputs(db), { current, window } = input, policies = new Map(input.policies.map(p => [p.version, p]));
  const suggestions = [];
  for (const category of input.categories) {
    if (!category.active || current.rules.some(r => r.kind === 'per-expense-limit' && r.category === category.id && r.hard)) continue;
    const owner = current.configuration.categories.find(c => c.id === category.id), rules = softLimits(current.rules, category.id);
    const limits = [...(owner?.limit_minor == null ? [] : [owner.limit_minor]), ...rules.map(r => r.limit_minor)];
    if (!limits.length) continue;
    const currentLimitMinor = Math.min(...limits);
    const expenses = replayExpenses(input.history, window, category.id, policies);
    const recurring = expenses.filter(e => e.approvedException && e.amount > currentLimitMinor);
    if (recurring.length < 3) continue;
    const proposedLimitMinor = recurring.reduce((limit, expense) => Math.max(limit, expense.amount), currentLimitMinor);
    const beforeCount = (amount: number) => limits.filter(limit => amount > limit).length;
    // Raise only lower limits: a looser owner or finance cap must never be tightened incidentally.
    const afterCount = (amount: number) => limits.filter(limit => amount > Math.max(limit, proposedLimitMinor)).length;
    const affected = input.history.flatMap(c => {
      const changed = expenses.filter(e => e.claim.id === c.id && beforeCount(e.amount) !== afterCount(e.amount));
      if (!changed.length) return [];
      const items = changed.map(e => ({
        id: e.item.id, spentOn: e.item.spent_on, merchant: e.item.merchant, amountMinor: e.amount,
        before: beforeCount(e.amount), after: afterCount(e.amount), approvedException: e.approvedException,
      }));
      return [{
        id: c.id, number: `CL-${String(c.number).padStart(4, '0')}`, title: changed[0].title, employee: c.employee_email, revision: c.revision,
        categoryAmountMinor: items.reduce((n, i) => n + i.amountMinor, 0),
        before: items.reduce((n, i) => n + i.before, 0), after: items.reduce((n, i) => n + i.after, 0), expenses: items,
      }];
    });
    const before = expenses.reduce((n, e) => n + beforeCount(e.amount), 0), after = expenses.reduce((n, e) => n + afterCount(e.amount), 0);
    const suggestion = {
      category: category.id, categoryName: category.name, currentLimitMinor, proposedLimitMinor,
      approvedExceptions: recurring.length, before, after, affected,
      estimatedHoursSaved: (before - after) * minutesPerException / 60, minutesPerException, estimate: true,
    };
    const proposalToken = await sha256Hex(JSON.stringify({
      policyVersion: current.version, latest: input.latest, business: input.business,
      configuration: current.configuration, rules: current.rules, categories: input.categories,
      history: input.history, window, suggestion,
    }));
    suggestions.push({ ...suggestion, proposalToken });
  }
  return { input, result: { policyVersion: current.version, window, suggestions } };
}

/** Deterministic internal advice, within finance's existing submitted-claim access; no key gains a new read grant. */
export async function advice(db: D1Database, actor: Actor, body: Data) {
  need(actor, 'finance');
  requireThat(actor.kind === 'person', 'Only a signed-in person reads policy advice', 403);
  return (await calculate(db, minutesInput(body))).result;
}

/** The token binds exact server-computed inputs; it grants no authority. Adoption appends a new version and leaves
 * all revisions, decisions and older policy/configuration snapshots untouched. */
export async function adoptAdvice(db: D1Database, actor: Actor, body: Data) {
  need(actor, 'owner');
  requireThat(actor.kind === 'person', 'Only a signed-in owner adopts policy advice', 403);
  const category = text(body.category, 'Category', 64), token = text(body.proposalToken, 'Proposal token', 64);
  const { input, result } = await calculate(db, minutesInput(body));
  const adopted = result.suggestions.find(s => s.category === category && s.proposalToken === token);
  requireThat(adopted, 'This proposal changed; reload the policy advice and review it again', 409);
  const version = input.latest + 1, at = now(), limit = adopted.proposedLimitMinor;
  const rules = input.current.rules.map(r => r.kind === 'per-expense-limit' && r.category === category && !r.hard && r.limit_minor < limit ? { ...r, limit_minor: limit } : r);
  await commit(db, all(authority(actor, 'owner'), policyStill(input.current.version, input.business.timezone),
    { sql: '(SELECT MAX(version) FROM c_policies)=?', params: [input.latest] },
    { sql: '(SELECT COALESCE(MAX(seq),0) FROM c_events)=?', params: [input.eventSeq] }), [
    db.prepare('UPDATE c_categories SET limit_minor=? WHERE id=? AND limit_minor IS NOT NULL AND limit_minor<?').bind(limit, category, limit),
    db.prepare('INSERT INTO c_policies(version,effective_from,rules,published_by,published_at) VALUES(?,?,?,?,?)').bind(version, input.window.to, JSON.stringify(rules), actor.delegate?.email ?? actor.email, at),
    captureConfiguration(db, version),
    event(db, actor, 'policy-advice-adopted', {}, { ...adopted, previousPolicyVersion: input.current.version, policyVersion: version, window: input.window }),
  ]);
  return { policyVersion: version, effectiveFrom: input.window.to, adopted };
}
