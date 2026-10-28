import { requireThat, type Data } from '../types';
import { all } from '../session';
import { codingCatalog, codingInput, catalogState, offeredValue, type Catalog, type CodingSnapshot } from './model';

/** Apply only explicit catalog choices and category bindings. Existing free-text customer/project coding stays valid
 * where no catalog binding requires the dimension; it never masquerades as a ledger catalog choice. */
export function validateCoding<T extends Data>(catalog: Catalog, item: T): T & { coding: Record<string,string>; codingSnapshot: CodingSnapshot[]; codingVersion: number } {
  const coding = codingInput(item.coding), snapshot: CodingSnapshot[] = [];
  const categories = new Set<string>((item.allocations ?? []).map((a: Data) => a.category_id));
  const bindings = catalog.requirements.filter(r => categories.has(r.category_id));
  const required = new Set([...catalog.dimensions.filter(d => d.active && d.required).map(d => d.id), ...bindings.filter(r => r.required).map(r => r.dimension_id)]);
  for (const id of required) {
    const dimension = catalog.dimensions.find(d => d.id === id);
    requireThat(dimension?.active, `A required accounting dimension is unavailable; ask the owner to correct ${dimension?.name ?? id}`,409);
    requireThat(coding[id], `${dimension.name} is required for this expense`);
  }
  for (const [dimensionId,id] of Object.entries(coding)) {
    const dimension = catalog.dimensions.find(d => d.id === dimensionId), value = catalog.values.find(v => v.id === id && v.dimension_id === dimensionId);
    requireThat(dimension?.active && value && offeredValue(catalog,value), `Choose an active ${dimension?.name ?? 'accounting dimension'} value`);
    requireThat(!dimension.parent_id || coding[dimension.parent_id] === value.parent_value_id, `${dimension.name} must belong to the selected ${catalog.dimensions.find(d => d.id === dimension.parent_id)?.name ?? 'parent'}`);
    snapshot.push({ dimension: dimension.id, dimensionName: dimension.name, kind: dimension.kind, id: value.id, name: value.name, parent: value.parent_value_id, owner: value.owner_email, source: dimension.source, sourceCompany: dimension.source_company, sourceId: value.source_id });
  }
  const chosen = (kind: string) => snapshot.filter(s => s.kind === kind);
  for (const kind of ['project','customer','cost-centre']) requireThat(chosen(kind).length <= 1, `Choose only one ${kind} dimension per expense`);
  const project = chosen('project')[0], customer = chosen('customer')[0], costCentre = chosen('cost-centre')[0];
  // Reject contradictory legacy fields instead of silently changing a person's coding.
  requireThat(!project || !item.project || item.project === project.name, 'Project text must match the selected project');
  requireThat(!customer || !item.customer || item.customer === customer.name, 'Customer text must match the selected customer');
  requireThat(!item.billable || customer || item.customer, 'A billable expense needs a customer');
  return { ...item, ...(project ? { project: project.name } : {}), ...(customer ? { customer: customer.name } : {}), ...(costCentre ? { allocations: item.allocations.map((a: Data) => ({ ...a, cost_centre: costCentre.name })) } : {}), coding, codingSnapshot: snapshot, codingVersion: catalog.version };
}
export async function checkedCoding<T extends Data>(db: D1Database, items: T[], entityId = 'primary') {
  const whole = await codingCatalog(db);
  const catalog = entityId==='primary'?whole:{...whole,dimensions:[],values:[],requirements:[]};
  if(entityId!=='primary')requireThat(items.every(i=>!Object.keys(i.coding??{}).length),'Provider and shared catalog choices are unavailable for this legal entity',409);
  const mappings = new Map<string,Data>();
  for (const item of items) for (const part of item.allocations ?? []) if (part.ledger_account_snapshot !== undefined) mappings.set(part.category_id,part);
  const expected = [...mappings.values()].map(p => ({ id:p.category_id,account:p.ledger_account_id,snapshot:p.ledger_account_snapshot,code:p.account_code,tax:p.tax_code }));
  const guards = expected.length ? [{ sql: `NOT EXISTS(SELECT 1 FROM json_each(?) e LEFT JOIN c_categories c ON c.id=json_extract(e.value,'$.id') WHERE c.id IS NULL OR c.ledger_account_id IS NOT json_extract(e.value,'$.account') OR c.ledger_account_snapshot<>json_extract(e.value,'$.snapshot') OR c.account_code<>json_extract(e.value,'$.code') OR c.tax_code<>json_extract(e.value,'$.tax'))`, params:[JSON.stringify(expected)] }] : [];
  return { items: items.map(item => validateCoding(catalog,item)), guard: all(catalogState(catalog.version),...guards) };
}
