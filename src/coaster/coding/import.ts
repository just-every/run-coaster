import { all, commit } from '../session';
import { event } from '../events';
import { requireBusiness } from '../settings';
import { parseCsv } from '../imports/csv';
import { requireThat, type Actor, type Data } from '../types';
import { advanceCatalog, catalogState, codingCatalog } from './model';
import { catalogSetter, dimensionInput, dimensionWrite, valueInput, valueWrite } from './catalog';

/** Exact headers: dimension,parentDimension,kind,required,value,parentValue,owner.
 * Repeated dimension definitions must agree. Parents can occur later in the CSV; all rows commit together. */
export async function importCoding(db: D1Database, actor: Actor, b: Data) {
  const auth = catalogSetter(actor); await requireBusiness(db);
  const catalog = await codingCatalog(db);
  requireThat(b.version === catalog.version, 'Accounting dimensions changed; reload before importing', 409);
  requireThat(typeof b.csv === 'string' && b.csv.length > 0 && b.csv.length <= 200_000, 'Choose a coding CSV of at most 200 KB');
  const { headers, rows } = parseCsv(b.csv), expected = ['dimension','parentDimension','kind','required','value','parentValue','owner'];
  requireThat(expected.every(h => headers.includes(h)) && headers.every(h => expected.includes(h)), `Use these CSV headers: ${expected.join(',')}`);
  requireThat(rows.length > 0 && rows.length <= 500, 'Import one to 500 coding choices');
  const definitions = new Map<string, typeof rows[number]>();
  for (const r of rows) {
    const previous = definitions.get(r.dimension);
    requireThat(!previous || ['parentDimension','kind','required'].every(k => r[k] === previous[k]), `Conflicting definitions of ${r.dimension}`);
    definitions.set(r.dimension, r);
  }
  const statements: D1PreparedStatement[] = [], pending = [...definitions.values()];
  while (pending.length) {
    const ready = pending.findIndex(r => !r.parentDimension || catalog.dimensions.some(d => d.name === r.parentDimension && d.active));
    requireThat(ready >= 0, 'Every parent dimension must exist and the hierarchy must have no cycle');
    const [r] = pending.splice(ready,1), old = catalog.dimensions.find(d => d.name === r.dimension);
    const parent = catalog.dimensions.find(d => d.name === r.parentDimension)?.id ?? '';
    const dimension = dimensionInput({ id: old?.id, name: r.dimension, kind: r.kind || 'tag', required: r.required, parent }, catalog);
    if (old) catalog.dimensions = catalog.dimensions.filter(d => d.id !== old.id);
    catalog.dimensions.push(dimension); statements.push(dimensionWrite(db,dimension));
  }
  const remaining = rows.map((r,i) => ({ r, line: i + 2 })), seen = new Set<string>(), ownerGuards = [];
  while (remaining.length) {
    const ready = remaining.findIndex(({ r }) => {
      const d = catalog.dimensions.find(d => d.name === r.dimension)!;
      return !d.parent_id || catalog.values.some(v => v.dimension_id === d.parent_id && v.name === r.parentValue && v.active);
    });
    requireThat(ready >= 0, 'Every parent choice must exist; use its exact name and include it before its children can be imported');
    const [{ r, line }] = remaining.splice(ready,1), dimension = catalog.dimensions.find(d => d.name === r.dimension)!;
    const parents = dimension.parent_id ? catalog.values.filter(v => v.dimension_id === dimension.parent_id && v.name === r.parentValue && v.active) : [];
    requireThat(!dimension.parent_id || parents.length === 1, `Row ${line}: the parent name must identify one choice`);
    const parent = parents[0]?.id ?? null;
    const old = catalog.values.find(v => v.dimension_id === dimension.id && v.parent_value_id === parent && v.name === r.value);
    let value;
    try { value = await valueInput(db,{ id: old?.id, dimension: dimension.id, name: r.value, parent: parent ?? '', owner: r.owner },catalog); }
    catch (error) { throw Object.assign(error as Error, { message: `Row ${line}: ${(error as Error).message}` }); }
    const key = `${dimension.id}:${parent}:${value.name}`;
    requireThat(!seen.has(key), `Row ${line}: the same choice appears twice`); seen.add(key);
    if (old) catalog.values = catalog.values.filter(v => v.id !== old.id);
    catalog.values.push(value); statements.push(valueWrite(db,value));
    if (value.owner_email) ownerGuards.push({ sql: 'EXISTS(SELECT 1 FROM c_members WHERE email=? AND active=1 AND is_manager=1)', params: [value.owner_email] });
  }
  await commit(db, all(auth,catalogState(catalog.version),...ownerGuards), [...statements,advanceCatalog(db),event(db,actor,'coding-csv-imported',{}, { dimensions: definitions.size, values: rows.length })]);
  return codingCatalog(db);
}
