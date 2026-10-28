import { all, commit } from '../session';
import { needRow, rowAuthority } from '../permissions';
import { event } from '../events';
import { requireBusiness } from '../settings';
import { email, now, optionalText, requireThat, text, uid, type Actor, type Data } from '../types';
import { advanceCatalog, catalogState, codingCatalog, DIMENSION_KINDS, flag, type Catalog, type CodingValue, type Dimension } from './model';
export { codingCatalog, codingOptions } from './model';

export function catalogSetter(actor: Actor) {
  needRow(actor, 'settings');
  requireThat(actor.kind === 'person', 'Only a person configures accounting dimensions', 403);
  return rowAuthority(actor, 'settings');
}
export function dimensionInput(b: Data, catalog: Catalog): Dimension {
  const old = catalog.dimensions.find(d => d.id === b.id);
  requireThat(!b.id || old, 'Dimension not found', 404);
  requireThat(!old || old.source === 'native', 'Ledger dimension names and hierarchy come from their ledger', 409);
  const kind = String(b.kind ?? old?.kind ?? 'tag') as Dimension['kind'];
  requireThat(DIMENSION_KINDS.includes(kind), 'Choose an accounting dimension type');
  requireThat(!old || old.kind === kind, 'A saved dimension keeps its type');
  const parent = b.parent === undefined ? old?.parent_id ?? null : optionalText(b.parent, 'Parent dimension', 100) || null;
  requireThat(!old || old.parent_id === parent, 'A saved dimension keeps its parent; create another level to change the hierarchy');
  requireThat(!parent || catalog.dimensions.some(d => d.id === parent && d.active), 'Choose an active parent dimension');
  const name = text(b.name ?? old?.name, 'Dimension name', 100);
  requireThat(!catalog.dimensions.some(d => d.id !== old?.id && d.name === name), 'A dimension already has that name');
  return { id: old?.id ?? uid(), name, kind, parent_id: parent, required: b.required === undefined ? old?.required ?? 0 : +flag(b.required), active: b.active === undefined ? old?.active ?? 1 : +flag(b.active), source: 'native', source_company: '', updated_at: now() };
}
export function dimensionWrite(db: D1Database, d: Dimension) {
  return db.prepare('INSERT INTO c_coding_dimensions(id,name,kind,parent_id,required,active,source,source_company,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,required=excluded.required,active=excluded.active,updated_at=excluded.updated_at').bind(d.id,d.name,d.kind,d.parent_id,d.required,d.active,d.source,d.source_company,d.updated_at);
}
export async function valueInput(db: D1Database, b: Data, catalog: Catalog): Promise<CodingValue> {
  const old = catalog.values.find(v => v.id === b.id), dimension = catalog.dimensions.find(d => d.id === (b.dimension ?? old?.dimension_id));
  requireThat(!b.id || old, 'Dimension choice not found', 404);
  requireThat(dimension?.active, 'Choose an active dimension');
  requireThat(!old || old.dimension_id === dimension.id, 'A saved choice keeps its dimension');
  // Ledger choices may have native project ownership assigned, but no manual changes to provider facts.
  requireThat(dimension.source === 'native' || !!old && b.name === undefined && b.parent === undefined && b.active === undefined, 'Ledger choices are updated from their ledger', 409);
  const parent = b.parent === undefined ? old?.parent_value_id ?? null : optionalText(b.parent, 'Parent choice', 100) || null;
  requireThat(dimension.parent_id ? catalog.values.some(v => v.id === parent && v.dimension_id === dimension.parent_id && v.active) : !parent, dimension.parent_id ? 'Choose an active value from the parent dimension' : 'This dimension has no parent');
  const owner = b.owner === undefined ? old?.owner_email ?? null : b.owner ? email(b.owner, 'Project owner') : null;
  requireThat(!owner || dimension.kind === 'project', 'Only a project has a project owner');
  requireThat(!owner || await db.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_manager=1').bind(owner).first(), 'The project owner must be an active approver');
  const name = text(b.name ?? old?.name, 'Choice name', dimension.source === 'native' ? 200 : 500);
  requireThat(!catalog.values.some(v => v.id !== old?.id && v.dimension_id === dimension.id && v.parent_value_id === parent && v.name === name), 'That parent already has a choice with that name');
  return { id: old?.id ?? uid(), dimension_id: dimension.id, name, parent_value_id: parent, owner_email: owner, active: b.active === undefined ? old?.active ?? 1 : +flag(b.active), source_id: old?.source_id ?? '', updated_at: now() };
}
export function valueWrite(db: D1Database, v: CodingValue) {
  return db.prepare('INSERT INTO c_coding_values(id,dimension_id,name,parent_value_id,owner_email,active,source_id,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_value_id=excluded.parent_value_id,owner_email=excluded.owner_email,active=excluded.active,updated_at=excluded.updated_at').bind(v.id,v.dimension_id,v.name,v.parent_value_id,v.owner_email,v.active,v.source_id,v.updated_at);
}
export async function saveDimension(db: D1Database, actor: Actor, b: Data) {
  const auth = catalogSetter(actor); await requireBusiness(db);
  const catalog = await codingCatalog(db), dimension = dimensionInput(b, catalog);
  requireThat(b.version === catalog.version, 'Accounting dimensions changed; reload before saving', 409);
  await commit(db, all(auth, catalogState(catalog.version)), [dimensionWrite(db, dimension), advanceCatalog(db), event(db, actor, 'coding-dimension-saved', {}, { dimension })]);
  return { ...await codingCatalog(db), saved: dimension.id };
}
export async function saveCodingValue(db: D1Database, actor: Actor, b: Data) {
  const auth = catalogSetter(actor); await requireBusiness(db);
  const catalog = await codingCatalog(db), value = await valueInput(db, b, catalog);
  requireThat(b.version === catalog.version, 'Accounting dimensions changed; reload before saving', 409);
  const ownerGuard = value.owner_email ? [{ sql: 'EXISTS(SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_manager=1)', params: [value.owner_email] }] : [];
  await commit(db, all(auth, catalogState(catalog.version), ...ownerGuard), [valueWrite(db, value), advanceCatalog(db), event(db, actor, 'coding-choice-saved', {}, { value })]);
  return { ...await codingCatalog(db), saved: value.id };
}
/** Replace one category's explicit catalog bindings; global level requirements remain in force. */
export async function saveCodingRequirements(db: D1Database, actor: Actor, b: Data) {
  const auth = catalogSetter(actor); await requireBusiness(db);
  const catalog = await codingCatalog(db), category = text(b.category, 'Category', 100);
  requireThat(b.version === catalog.version, 'Accounting dimensions changed; reload before saving', 409);
  requireThat(await db.prepare("SELECT 1 FROM c_categories WHERE entity_id='primary' AND id=? AND active=1").bind(category).first(), 'Choose an active category');
  requireThat(Array.isArray(b.dimensions) && b.dimensions.length <= 40, 'Choose at most 40 dimensions');
  const rows = b.dimensions.map((r: Data) => {
    requireThat(catalog.dimensions.some(d => d.id === r.dimension && d.active), 'Choose an active dimension');
    return { dimension: r.dimension as string, required: +flag(r.required) };
  });
  requireThat(new Set(rows.map((r: Data) => r.dimension)).size === rows.length, 'Each dimension appears once per category');
  await commit(db, all(auth, catalogState(catalog.version)), [
    db.prepare('DELETE FROM c_category_dimensions WHERE category_id=?').bind(category),
    ...rows.map((r: Data) => db.prepare('INSERT INTO c_category_dimensions(category_id,dimension_id,required) VALUES(?,?,?)').bind(category,r.dimension,r.required)), advanceCatalog(db), event(db, actor, 'coding-requirements-saved', {}, { category, dimensions: rows }),
  ]);
  return codingCatalog(db);
}
