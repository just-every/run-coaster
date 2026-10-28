import { all, authority, commit, need, sha256Hex, type Sql } from '../session';
import { claimItems, claimState, loadClaim, type Claim } from '../claims';
import { categories } from '../items';
import { codingCatalog } from '../coding/model';
import { checkedCoding } from '../coding/validation';
import { proposeCoding, proposalView } from '../coding/automatic/engine';
import { flatten, itemFields, merchantKey, unflatten } from '../coding/automatic/model';
import { codingContext, contextWrite, targetSuggestions, type Target } from '../coding/automatic/storage';
import { event } from '../events';
import { now, requireThat, uid, type Actor, type Data } from '../types';

const contextsState = (entries: Data[], applied = false): Sql => ({
  sql: `NOT EXISTS(SELECT 1 FROM json_each(?) e LEFT JOIN c_auto_coding_contexts c ON c.target_kind='item' AND c.target_id=json_extract(e.value,'$.item') WHERE COALESCE(c.version,0)<>json_extract(e.value,'$.version'))`,
  params: [JSON.stringify(entries.map(e => ({ item: e.item, version: e.contextVersion + (applied && e.changes.length ? 1 : 0) })))],
});
const distinct = (guards: Sql[]) => [...new Map(guards.map(g => [JSON.stringify(g), g])).values()];

/** A review snapshot, never an execution grant. Only category and catalog dimensions can change. */
export async function expenseCodingPlan(db: D1Database, claim: Claim, items: Data[]) {
  const known = await categories(db), catalog = await codingCatalog(db), entries: Data[] = [], guards: Sql[] = [];
  for (const item of items) {
    const context = await codingContext(db, 'item', item.id), suggestions = await targetSuggestions(db, 'item', item.id);
    const target: Target = { kind: 'item', id: item.id, employee: claim.employee_email, claim: claim.id, merchant: item.merchant, mcc: context?.mcc };
    const advice = await proposeCoding(db, claim.employee_email, { merchant: item.merchant, mcc: context?.mcc });
    const current = flatten(itemFields(item)), proposed = flatten(advice.fields), human = context?.humanFields ?? [];
    const disputed = suggestions.some(s => s.status === 'override') && Object.entries(proposed).some(([field, value]) => current[field] !== value);
    const changes: Data[] = [];
    for (const [field, value] of Object.entries(proposed)) {
      if (field !== 'category' && !field.startsWith('dimension:') || human.includes(field) || current[field] === value) continue;
      if (field === 'category' && item.allocations.length !== 1) continue;
      const dimension = catalog.dimensions.find(d => d.id === field.slice(10));
      // Existing free-text choices and cost-centre splits remain human decisions.
      if (dimension?.kind === 'project' && item.project && (human.includes('project') || !context?.values.project)) continue;
      if (dimension?.kind === 'customer' && item.customer && (human.includes('customer') || !context?.values.customer)) continue;
      if (dimension?.kind === 'cost-centre' && item.allocations.some((a: Data) => a.cost_centre)) continue;
      const label = (id: string | undefined) => field === 'category' ? known.find(c => c.id === id)?.name : catalog.values.find(v => v.id === id)?.name;
      changes.push({ field, label: field === 'category' ? 'Category' : dimension?.name, before: current[field] ?? null, beforeLabel: label(current[field]) ?? 'Not set', after: value, afterLabel: label(value) });
    }
    const next = unflatten({ ...current, ...Object.fromEntries(changes.map(c => [c.field, c.after])) });
    const candidate = { ...item, allocations: item.allocations.map((a: Data) => ({ ...a, ...(changes.some(c => c.field === 'category') ? (() => { const category = known.find(c => c.id === next.category)!; return { category_id: category.id, ledger_account_id: category.ledger_account_id, ledger_account_snapshot: category.ledger_account_snapshot, account_code: category.account_code, tax_code: category.tax_code }; })() : {}) })), coding: next.dimensions ?? {},
      // A catalog project or customer replaces only its previous automatic display value.
      ...(changes.some(c => catalog.dimensions.find(d => d.id === c.field.slice(10))?.kind === 'project') ? { project: '' } : {}),
      ...(changes.some(c => catalog.dimensions.find(d => d.id === c.field.slice(10))?.kind === 'customer') ? { customer: '' } : {}) };
    const checked = changes.length && !disputed ? await checkedCoding(db, [candidate]) : null;
    guards.push(advice.guard, ...(checked ? [checked.guard] : []));
    entries.push({ item: item.id, merchant: item.merchant, contextVersion: context?.version ?? 0, humanFields: human, changes, disputed, advice: proposalView(advice), next: checked?.items[0] ?? candidate, target });
  }
  const review = { sourceClaim: claim.id, sourceVersion: claim.version, entries: entries.map(({ next, target, ...entry }) => entry) };
  return { entries, stableGuards: distinct(guards), guards: [...distinct(guards), contextsState(entries)], review, fingerprint: await sha256Hex(JSON.stringify(review)) };
}

/** Explicit confirmation in the employee's own session; the proposal itself never authorizes a write. */
export async function applyExpenseCoding(db: D1Database, actor: Actor, p: Data, b: Data) {
  requireThat(actor.kind === 'person' && !actor.delegate && !actor.publicCredential, 'Confirm coding in your own native session', 403);
  need(actor, 'employee');
  requireThat(p.for_email === actor.email, 'This proposal is for someone else', 403);
  requireThat(p.status === 'proposed', 'This proposal was already decided', 409);
  requireThat(p.payload.preparation === 'expense', 'Choose an expense review proposal', 409);
  const claim = await loadClaim(db, p.payload.sourceClaim);
  requireThat(claim.employee_email === actor.email, 'Claim not found', 404);
  requireThat(claim.status === 'draft' && claim.revision === 0, 'Only never-submitted drafts can receive reviewed coding', 409);
  const plan = await expenseCodingPlan(db, claim, await claimItems(db, claim.id));
  requireThat(p.payload.codingApplication?.fingerprint === plan.fingerprint && b.fingerprint === plan.fingerprint && b.confirm === true, 'Coding inputs changed; prepare a new review and confirm its exact changes', 409);
  requireThat(!p.payload.stopped && !plan.entries.some(e => e.disputed), 'Resolve disputed coding before applying a new review', 409);
  const changed = plan.entries.filter(e => e.changes.length);
  requireThat(changed.length, 'There are no coding changes; accept the review plan instead', 409);
  const at = now(), writes: D1PreparedStatement[] = [];
  for (const entry of plan.entries) {
    const { next, target, contextVersion, humanFields, changes } = entry;
    if (!changes.length) continue;
    // Keep allocation positions, amounts, original amounts and descriptions; no expense is recreated.
    if (changes.some((c: Data) => c.field === 'category')) writes.push(db.prepare('UPDATE c_allocations SET category_id=? WHERE item_id=?').bind(next.allocations[0].category_id, entry.item));
    for (const [position, allocation] of next.allocations.entries()) writes.push(db.prepare('UPDATE c_allocations SET cost_centre=? WHERE item_id=? AND position=?').bind(allocation.cost_centre, entry.item, position));
    writes.push(db.prepare('UPDATE c_items SET coding=?,project=?,customer=? WHERE id=? AND claim_id=?').bind(JSON.stringify(next.coding), next.project, next.customer, entry.item, claim.id));
    writes.push(contextWrite(db, target, contextVersion + 1, itemFields(next), [...humanFields, ...changes.map((c: Data) => c.field)]));
    const suggestion = uid(), fields = unflatten(Object.fromEntries(changes.map((c: Data) => [c.field, c.after])));
    writes.push(db.prepare('INSERT INTO c_auto_coding_suggestions(id,target_kind,target_id,employee_email,claim_id,merchant_key,context_version,fields,applied_fields,evidence,catalog_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(suggestion, 'item', entry.item, actor.email, claim.id, merchantKey(next.merchant), contextVersion + 1, JSON.stringify(fields), JSON.stringify(changes.map((c: Data) => c.field)), JSON.stringify(entry.advice.evidence.filter((e: Data) => changes.some((c: Data) => c.field === e.field))), entry.advice.catalogVersion, at),
      db.prepare("INSERT INTO c_auto_coding_feedback(suggestion_id,action,values_json,actor_email,at) VALUES(?,'accept',?,?,?)").bind(suggestion, JSON.stringify(itemFields(next)), actor.email, at));
  }
  writes.push(db.prepare('UPDATE c_claims SET version=version+1,updated_at=? WHERE id=?').bind(at, claim.id),
    db.prepare("UPDATE c_proposals SET status='accepted',decided_by=?,decided_at=?,result_id=? WHERE id=?").bind(actor.email, at, claim.id, p.id),
    event(db, actor, 'agent-coding-applied', { claim: claim.id }, { proposal: p.id, agent: p.agent_label, fingerprint: plan.fingerprint, changes: changed.map(e => ({ item: e.item, changes: e.changes, evidence: e.advice.evidence })), confirmation: 'native-employee' }));
  const stable = all(authority(actor, 'employee'), ...plan.stableGuards);
  const claimGuard = (version: number): Sql => all(claimState(claim.id, version, ['draft']), { sql: 'EXISTS(SELECT 1 FROM c_claims WHERE id=? AND employee_email=? AND revision=0)', params: [claim.id, actor.email] });
  const condition = all(stable, claimGuard(claim.version), ...plan.guards, { sql: "EXISTS(SELECT 1 FROM c_proposals WHERE id=? AND for_email=? AND status='proposed' AND payload=?)", params: [p.id, actor.email, JSON.stringify(p.payload)] });
  condition.after = all(stable, claimGuard(claim.version + 1), contextsState(plan.entries, true), { sql: "EXISTS(SELECT 1 FROM c_proposals WHERE id=? AND status='accepted' AND decided_by=? AND result_id=?)", params: [p.id, actor.email, claim.id] });
  await commit(db, condition, writes);
  return { proposal: { ...p, status: 'accepted' }, claim: await loadClaim(db, claim.id) };
}
