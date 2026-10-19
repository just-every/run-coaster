import { all, authority, commit, sha256Hex } from './session';
import { captureConfiguration, policyStill } from './policy-configuration';
import { evaluateRules } from './policy-rules';
import { parseRule, type Rule } from './policy';
import { event } from './events';
import { perPersonShares, type ClaimItem, type PolicyException } from './exceptions';
import type { Business } from './settings';
import type { adviceInputs, History } from './policy-advice';
import { now, requireThat, text, type Actor, type Data } from './types';

type Input = Awaited<ReturnType<typeof adviceInputs>>;
const snapshot = (claim: History): Data => JSON.parse(claim.snapshot);
const itemsOf = (claim: History): ClaimItem[] => snapshot(claim).items;
const inWindow = (item: ClaimItem, input: Input) => item.spent_on >= input.window.from && item.spent_on <= input.window.to;
const categoryAmount = (item: ClaimItem, category: string) => item.allocations.filter(a => a.category_id === category).reduce((n, a) => n + a.amount_minor, 0);
const bucket = (item: ClaimItem, kind: string) => kind === 'trip-limit' ? item.request_id ?? '' : kind === 'monthly-limit' ? item.spent_on.slice(0, 7) : item.spent_on;
export const ruleRequest = (rules: Rule[]) => rules.map(r => 'limit_minor' in r ? { ...r, limit: (r.limit_minor / 100).toFixed(2) } : r);

/** Replays the real rule evaluator over frozen, submitted records. It never reads a private draft or uses today's
 * clock for an old submission deadline. Aggregates are explicitly the submitted replay population, not invented
 * historical drafts. Every expense of each contributing claim participates in its daily/month/trip total. */
async function rulesFor(db: D1Database, input: Input, claim: History, rules: Rule[], version = input.current.version) {
  const items = itemsOf(claim), today = new Intl.DateTimeFormat('en-CA', { timeZone: input.business.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(claim.submitted_at));
  const found = await evaluateRules(db, { rules, version }, claim, items, input.business as Business, input.current.configuration.categories, {
    today,
    otherTotal: (kind, key, category) => input.history.filter(c => c.id !== claim.id && c.employee_email === claim.employee_email).flatMap(itemsOf).filter(i => bucket(i, kind) === key).reduce((n, i) => n + categoryAmount(i, category), 0),
  });
  return found.filter(e => items.some(i => i.id === e.item && inWindow(i, input)));
}

function ownerChecks(input: Input, claim: History) {
  const config = input.current.configuration, categories = new Map(config.categories.map(c => [c.id, c]));
  return itemsOf(claim).filter(i => inWindow(i, input)).flatMap(item => {
    const found: PolicyException[] = [], add = (code: PolicyException['code'], message: string, hard = false) => found.push({ item: item.id, code, message, hard });
    if (item.kind === 'receipt' && !item.receipt_id && (item.amount_minor > config.receipt_threshold_minor || item.allocations.some(a => categories.get(a.category_id)?.receipt_always))) add('missing-receipt', 'Owner receipt rule');
    if (config.preapproval_threshold_minor != null && item.amount_minor > config.preapproval_threshold_minor && !item.request_id) add('needs-pre-approval', 'Owner spend request rule');
    for (const id of new Set(item.allocations.map(a => a.category_id))) {
      const category = categories.get(id);
      if (category?.limit_minor != null && categoryAmount(item, id) > category.limit_minor) add('over-limit', `Owner limit ${id}`);
      for (const field of category?.required_fields ?? []) if (!item.fields[field]) add('missing-field', `Owner required ${field}`, true);
    }
    for (const share of perPersonShares(item, categories).filter(s => s.over)) add('over-per-person', `Owner attendee limit ${share.category}`);
    return found;
  });
}

const signature = (e: PolicyException) => JSON.stringify([e.item, e.code, e.message, !!e.hard]);
const blocked = (exceptions: PolicyException[]) => exceptions.some(e => e.hard || e.code === 'needs-pre-approval');

function candidateRule(input: Input, value: Data) {
  requireThat(value && typeof value === 'object', 'Choose a supported policy rule');
  const categories = input.current.configuration.categories;
  const normalized = parseRule(value, categories.map(c => ({ ...c, active: 1 })));
  if ('category' in normalized && !categories.find(c => c.id === normalized.category)?.active)
    requireThat(input.current.rules.some(r => JSON.stringify(r) === JSON.stringify(normalized)), 'Choose an active category');
  return normalized;
}

export async function changePreview(db: D1Database, input: Input, proposed: unknown, minutes: number) {
  requireThat(Array.isArray(proposed) && proposed.length <= 50, 'Preview at most 50 policy rules');
  const rules = (proposed as Data[]).map(r => candidateRule(input, r));
  requireThat(rules.filter(r => r.kind === 'deadline').length <= 1, 'Set one submission deadline');
  let before = 0, after = 0, eligibleBeforeMinor = 0, eligibleAfterMinor = 0, observedApprovalHours = 0;
  let recordedReimbursedMinor = 0, awaitingReimbursementMinor = 0;
  const affected = [];
  for (const claim of input.history) {
    const owner = ownerChecks(input, claim), a = [...owner, ...await rulesFor(db, input, claim, input.current.rules)], b = [...owner, ...await rulesFor(db, input, claim, rules)];
    before += a.length; after += b.length;
    const total = itemsOf(claim).filter(i => inWindow(i, input)).reduce((n, i) => n + i.amount_minor, 0);
    if (!blocked(a)) eligibleBeforeMinor += total;
    if (!blocked(b)) eligibleAfterMinor += total;
    const left = a.map(signature).sort(), right = b.map(signature).sort();
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    const approvalHours = claim.decided_at ? Math.max(0, (Date.parse(claim.decided_at) - Date.parse(claim.submitted_at)) / 3_600_000) : null;
    observedApprovalHours += approvalHours ?? 0;
    if (claim.status === 'reimbursed') recordedReimbursedMinor += total;
    else if (['approved', 'batched'].includes(claim.status)) awaitingReimbursementMinor += total;
    const changedItems = itemsOf(claim).filter(i => inWindow(i, input) && JSON.stringify(a.filter(e => e.item === i.id).map(signature).sort()) !== JSON.stringify(b.filter(e => e.item === i.id).map(signature).sort()));
    affected.push({ id: claim.id, number: `CL-${String(claim.number).padStart(4, '0')}`, title: snapshot(claim).title, revision: claim.revision, employee: claim.employee_email, status: claim.status,
      before: a.length, after: b.length, blockedBefore: blocked(a), blockedAfter: blocked(b), amountMinor: total, observedApprovalHours: approvalHours,
      expenses: changedItems.map(i => ({ id: i.id, merchant: i.merchant, spentOn: i.spent_on, amountMinor: i.amount_minor, before: a.filter(e => e.item === i.id), after: b.filter(e => e.item === i.id) })) });
  }
  const result = { rules: ruleRequest(rules), before, after, affected, minutesPerException: minutes, estimatedHoursSaved: (before - after) * minutes / 60, estimate: true,
    approval: { observedHoursOnAffectedClaims: observedApprovalHours, estimatedReviewHoursDelta: (after - before) * minutes / 60, predictedDecisionTime: null },
    reimbursement: { eligibleBeforeMinor, eligibleAfterMinor, recordedReimbursedMinor, awaitingReimbursementMinor, estimate: true },
    population: 'Latest submitted revisions; inclusive expense-date window; period totals use submitted records only; deadlines use original submission day. Eligibility excludes hard exceptions and missing approved requests; this is a counterfactual, never a payment or decision change.' };
  const proposalToken = await sha256Hex(JSON.stringify({ current: input.current, latest: input.latest, history: input.history, categories: input.categories, business: input.business, window: input.window, result }));
  return { ...result, proposalToken };
}

/** Repeatedly acknowledged exceptions support removal of a soft finance rule. An owner floor stays active; a hard
 * rule is never automatically relaxed. One expense counts once, even if the recorded list repeats its exception. */
export async function recurringChanges(db: D1Database, input: Input, minutes: number) {
  const suggestions = [];
  for (const [index, rule] of input.current.rules.entries()) {
    if (rule.hard) continue;
    const evidence = new Set<string>();
    for (const claim of input.history.filter(c => ['approved', 'batched', 'reimbursed'].includes(c.status) && c.decision === 'approved')) {
      const historical = input.policies.find(p => p.version === snapshot(claim).policyVersion);
      // Only exact recorded rule semantics are evidence; a changed rule does not inherit unrelated approvals.
      if (!historical?.rules.some(r => JSON.stringify(r) === JSON.stringify(rule))) continue;
      const acknowledgments: PolicyException[] = JSON.parse(claim.approved_exceptions ?? '[]');
      for (const e of await rulesFor(db, input, claim, [rule], historical.version)) if (acknowledgments.some(a => !a.hard && a.item === e.item && a.code === e.code && a.policy === e.policy && a.message === e.message)) evidence.add(e.item);
    }
    if (evidence.size < 3) continue;
    const preview = await changePreview(db, input, ruleRequest(input.current.rules.filter((_, i) => i !== index)), minutes);
    suggestions.push({ kind: rule.kind, ruleIndex: index, approvedExceptions: evidence.size, ...preview });
  }
  return suggestions;
}

export async function adoptChange(db: D1Database, actor: Actor, input: Input, body: Data, minutes: number) {
  const preview = await changePreview(db, input, body.proposedRules, minutes);
  requireThat(preview.proposalToken === text(body.proposalToken, 'Proposal token', 64), 'This proposal changed; reload the policy advice and review it again', 409);
  const rules = preview.rules.map(r => candidateRule(input, r));
  const version = input.latest + 1, at = now();
  await commit(db, all(authority(actor, 'owner'), policyStill(input.current.version, input.business.timezone),
    { sql: '(SELECT MAX(version) FROM c_policies)=?', params: [input.latest] }, { sql: '(SELECT COALESCE(MAX(seq),0) FROM c_events)=?', params: [input.eventSeq] }), [
    db.prepare('INSERT INTO c_policies(version,effective_from,rules,published_by,published_at) VALUES(?,?,?,?,?)').bind(version, input.window.to, JSON.stringify(rules), actor.delegate?.email ?? actor.email, at),
    captureConfiguration(db, version), event(db, actor, 'policy-advice-adopted', {}, { ...preview, previousPolicyVersion: input.current.version, policyVersion: version, window: input.window }),
  ]);
  return { policyVersion: version, effectiveFrom: input.window.to, adopted: preview };
}
