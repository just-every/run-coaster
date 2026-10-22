import { requireThat, text, type Data } from '../types';
import type { Sql } from '../session';

export const DIMENSION_KINDS = ['account', 'class', 'location', 'department', 'project', 'customer', 'vendor', 'tag', 'cost-centre'] as const;
export type Dimension = { id: string; name: string; kind: typeof DIMENSION_KINDS[number]; parent_id: string | null; required: number; active: number; source: 'native' | 'quickbooks'; source_company: string; updated_at: string };
export type CodingValue = { id: string; dimension_id: string; name: string; parent_value_id: string | null; owner_email: string | null; active: number; source_id: string; updated_at: string };
export type Requirement = { category_id: string; dimension_id: string; required: number };
export type Catalog = { version: number; dimensions: Dimension[]; values: CodingValue[]; requirements: Requirement[] };
export type CodingSnapshot = { dimension: string; dimensionName: string; kind: Dimension['kind']; id: string; name: string; parent: string | null; owner: string | null; source: Dimension['source']; sourceCompany: string; sourceId: string };
export function flag(v: unknown) {
  requireThat([undefined,null,'',true,false,0,1,'0','1','true','false','on','off','yes','no'].includes(v as any), 'Use true or false for accounting configuration flags');
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on' || v === 'yes';
}
export const catalogState = (version: number): Sql => ({ sql: 'EXISTS(SELECT 1 FROM c_coding_version WHERE id=1 AND version=?)', params: [version] });
export const advanceCatalog = (db: D1Database) => db.prepare('UPDATE c_coding_version SET version=version+1 WHERE id=1');
export function codingInput(value: unknown): Record<string, string> {
  if (value === undefined || value === null || value === '') return {};
  requireThat(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 40, 'Coding must contain at most 40 dimension choices');
  return Object.fromEntries(Object.entries(value as Data).map(([dimension, id]) => [text(dimension, 'Dimension', 100), text(id, 'Dimension choice', 100)]));
}
export async function codingCatalog(db: D1Database): Promise<Catalog> {
  const rows = await db.batch([
    db.prepare('SELECT version FROM c_coding_version WHERE id=1'),
    db.prepare('SELECT * FROM c_coding_dimensions ORDER BY name'),
    db.prepare('SELECT * FROM c_coding_values ORDER BY name,id'),
    db.prepare('SELECT * FROM c_category_dimensions ORDER BY category_id,dimension_id'),
  ]);
  return { version: (rows[0].results[0] as Data).version, dimensions: rows[1].results as Dimension[], values: rows[2].results as CodingValue[], requirements: rows[3].results as Requirement[] };
}
/** A retired ancestor removes all its dependent choices from expense forms as well. */
export function offeredValue(catalog: Catalog, value: CodingValue, seen = new Set<string>()): boolean {
  if (seen.has(value.id)) return false;
  const dimension = catalog.dimensions.find(d => d.id === value.dimension_id);
  if (!dimension?.active || !value.active) return false;
  if (!dimension.parent_id) return value.parent_value_id === null;
  const parent = catalog.values.find(v => v.id === value.parent_value_id && v.dimension_id === dimension.parent_id);
  return !!parent && offeredValue(catalog, parent, new Set([...seen, value.id]));
}
export function codingOptions(catalog: Catalog, dimension: string, parent?: string) {
  return catalog.values.filter(v => v.dimension_id === dimension && offeredValue(catalog, v) && (!catalog.dimensions.find(d => d.id === dimension)?.parent_id || v.parent_value_id === parent));
}
