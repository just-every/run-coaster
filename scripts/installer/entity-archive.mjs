import { PortabilityError } from '@runeditrun/rer/modules/portability';

const check = ok => { if (!ok) throw new PortabilityError('coaster_entity', 409); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const currency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
const timezone = value => {
  if (!nonempty(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
};
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const money = value => Number.isSafeInteger(value);
const parse = raw => { try { return JSON.parse(raw); } catch { check(false); } };

/** Entity ownership travels with records; submission/report labels remain historical evidence. */
export async function validateEntityArchive(read, manifest) {
  const names = ['c_entities', 'c_entity_members', 'c_entity_reports', 'c_members', 'c_claims', 'c_categories',
    'c_policies', 'c_policy_configurations', 'c_approval_workflows', 'c_items', 'c_allocations', 'c_revisions', 'c_batches', 'c_batch_claims'];
  const [entities, memberships, reports, members, claims, categories, policies, configurations, workflows, items, allocations, revisions, batches, batchClaims] = await Promise.all(names.map(read));
  if (!entities.length) {
    // Only an archive predating the entity schema may rely on migration defaults.
    check(Array.isArray(manifest?.tables) && !manifest.tables.some(table => table.name === 'c_entities'));
    check(!memberships.length && !reports.length);
    check([...claims, ...categories, ...policies, ...workflows, ...batches].every(row => row.entity_id === undefined));
    check(revisions.every(row => parse(row.snapshot).entity === undefined));
    return;
  }
  const entityById = new Map(entities.map(row => [row.id, row]));
  const claimById = new Map(claims.map(row => [row.id, row]));
  const categoryById = new Map(categories.map(row => [row.id, row]));
  const policyByVersion = new Map(policies.map(row => [row.version, row]));
  const workflowByVersion = new Map(workflows.map(row => [row.version, row]));
  const batchById = new Map(batches.map(row => [row.id, row]));
  const itemById = new Map(items.map(row => [row.id, row]));
  check(entityById.size === entities.length && entityById.has('primary'));
  for (const entity of entities) {
    check(nonempty(entity.id) && (nonempty(entity.name) || entity.id === 'primary') && currency(entity.currency) && timezone(entity.timezone));
    check(Number.isSafeInteger(entity.version) && entity.version > 0 && [0, 1].includes(entity.fx_enabled));
    check(money(entity.receipt_threshold_minor) && entity.receipt_threshold_minor >= 0);
    check(entity.preapproval_threshold_minor === null || money(entity.preapproval_threshold_minor) && entity.preapproval_threshold_minor >= 0);
  }
  const membershipKeys = new Set();
  for (const membership of memberships) {
    const key = JSON.stringify([membership.entity_id, membership.email]);
    check(entityById.has(membership.entity_id) && members.some(member => member.email === membership.email)
      && [0, 1].includes(membership.active) && !membershipKeys.has(key));
    membershipKeys.add(key);
  }
  for (const row of [...claims, ...categories, ...policies, ...workflows, ...batches]) check(entityById.has(row.entity_id));
  for (const claim of claims) check(claim.currency === entityById.get(claim.entity_id).currency);
  for (const batch of batches) check(batch.currency === entityById.get(batch.entity_id).currency);
  for (const relation of batchClaims) {
    const batch = batchById.get(relation.batch_id), claim = claimById.get(relation.claim_id);
    check(batch && claim && batch.entity_id === claim.entity_id && batch.currency === claim.currency);
  }
  const sameCategory = (id, entity) => check(categoryById.get(id)?.entity_id === entity);
  for (const allocation of allocations) {
    const claim = claimById.get(itemById.get(allocation.item_id)?.claim_id);
    check(claim); sameCategory(allocation.category_id, claim.entity_id);
  }
  for (const configuration of configurations) {
    const policy = policyByVersion.get(configuration.version), captured = parse(configuration.configuration);
    check(policy && object(captured) && Array.isArray(captured.categories));
    for (const category of captured.categories) sameCategory(category.id, policy.entity_id);
  }
  for (const policy of policies) {
    const rules = parse(policy.rules); check(Array.isArray(rules));
    for (const rule of rules) if (rule.category !== undefined) sameCategory(rule.category, policy.entity_id);
  }
  for (const workflow of workflows) {
    const rules = parse(workflow.rules); check(Array.isArray(rules));
    for (const rule of rules) if (rule.condition?.kind === 'category') sameCategory(rule.condition.value, workflow.entity_id);
  }
  for (const revision of revisions) {
    const claim = claimById.get(revision.claim_id), snapshot = parse(revision.snapshot);
    check(claim && object(snapshot) && snapshot.currency === claim.currency);
    if (snapshot.entity === undefined) check(claim.entity_id === 'primary');
    else check(object(snapshot.entity) && snapshot.entity.id === claim.entity_id && snapshot.entity.currency === snapshot.currency
      && nonempty(snapshot.entity.name) && timezone(snapshot.entity.timezone));
    if (snapshot.policyVersion !== undefined) check(policyByVersion.get(snapshot.policyVersion)?.entity_id === claim.entity_id);
    if (snapshot.workflow) check(workflowByVersion.get(snapshot.workflow.version)?.entity_id === claim.entity_id);
    for (const item of snapshot.items ?? []) for (const allocation of item.allocations ?? []) sameCategory(allocation.category_id, claim.entity_id);
  }
  for (const report of reports) {
    const snapshot = parse(report.snapshot);
    check(object(snapshot) && snapshot.id === report.id && currency(snapshot.currency) && day(snapshot.from) && day(snapshot.to)
      && snapshot.from <= snapshot.to && money(snapshot.totalMinor) && Array.isArray(snapshot.lines));
    let total = 0;
    for (const line of snapshot.lines) {
      const entity = entityById.get(line.entity), claim = claimById.get(line.claim);
      check(entity && claim && (claim.status !== 'draft' && claim.revision > 0 || nonempty(line.cardCharge)) && claim.entity_id === entity.id
        && line.currency === entity.currency && nonempty(line.entityName) && money(line.nativeMinor) && money(line.amountMinor));
      check(typeof line.fx_rate === 'string' && /^\d+(?:\.\d+)?$/.test(line.fx_rate) && Number.isFinite(Number(line.fx_rate)) && Number(line.fx_rate) > 0
        && day(line.fx_date) && typeof line.fx_source === 'string');
      if (line.currency === snapshot.currency) check(Number(line.fx_rate) === 1 && line.nativeMinor === line.amountMinor);
      else check(nonempty(line.fx_source));
      total += line.amountMinor; check(money(total));
    }
    check(total === snapshot.totalMinor);
  }
}
