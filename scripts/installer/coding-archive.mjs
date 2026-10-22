import { PortabilityError } from '@runeditrun/rer/modules/portability';

/** Catalog references remain valid across exit and restore, including inactive choices frozen in old revisions. */
export async function validateCodingArchive(read) {
  const [dimensions, values, requirements, versions, items, categories, revisions] = await Promise.all(['c_coding_dimensions', 'c_coding_values', 'c_category_dimensions', 'c_coding_version', 'c_items', 'c_categories', 'c_revisions'].map(read));
  const fail = () => { throw new PortabilityError('coaster_coding_catalog', 409); };
  const check = valid => { if (!valid) fail(); };
  const dimension = new Map(dimensions.map(d => [d.id, d])), value = new Map(values.map(v => [v.id, v]));
  // Archives from before catalog support carry no catalog tables; migration defaults supply their empty catalog.
  if (!versions.length) {
    check(!dimensions.length && !values.length && !requirements.length && items.every(i => !i.coding || i.coding === '{}') && categories.every(c => !c.ledger_account_id));
  } else check(versions.length === 1 && versions[0].id === 1 && Number.isInteger(versions[0].version) && versions[0].version >= 0);
  for (const d of dimensions) {
    const seen = new Set([d.id]);
    for (let parent = d.parent_id; parent;) {
      check(dimension.has(parent) && !seen.has(parent)); seen.add(parent); parent = dimension.get(parent).parent_id;
    }
  }
  for (const v of values) {
    const d = dimension.get(v.dimension_id), parent = value.get(v.parent_value_id);
    check(d && (d.parent_id ? parent?.dimension_id === d.parent_id : !v.parent_value_id));
  }
  for (const r of requirements) check(categories.some(c => c.id === r.category_id) && dimension.has(r.dimension_id));
  function mapping(id, raw) {
    const snapshot = typeof raw === 'string' ? JSON.parse(raw) : raw ?? {};
    if (!id) { check(!snapshot.id); return; }
    const account = value.get(id), level = account && dimension.get(account.dimension_id);
    check(account && level?.kind === 'account' && snapshot.id === account.id && snapshot.dimension === level.id && snapshot.source === level.source && snapshot.sourceCompany === level.source_company && snapshot.sourceId === account.source_id);
  }
  for (const category of categories) mapping(category.ledger_account_id, category.ledger_account_snapshot);
  function coding(raw) {
    const choices = typeof raw === 'string' ? JSON.parse(raw) : raw ?? {};
    check(choices && typeof choices === 'object' && !Array.isArray(choices));
    for (const [d, id] of Object.entries(choices)) {
      const v = value.get(id), level = dimension.get(d);
      check(level && v?.dimension_id === d && (!level.parent_id || choices[level.parent_id] === v.parent_value_id));
    }
  }
  for (const item of items) coding(item.coding);
  for (const revision of revisions) for (const item of JSON.parse(revision.snapshot).items ?? []) {
    coding(item.coding);
    for (const allocation of item.allocations ?? []) mapping(allocation.ledger_account_id, allocation.ledger_account ?? allocation.ledger_account_snapshot);
  }
}
