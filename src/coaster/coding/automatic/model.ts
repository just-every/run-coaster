import { optionalText, requireThat, text, type Data } from '../../types';
import type { Sql } from '../../session';
import { codingInput, offeredValue, type Catalog } from '../model';
import type { Category } from '../../items';

export type Fields = { category?: string; dimensions?: Record<string,string>; project?: string; customer?: string; memo?: string };
export type Flat = Record<string,string>;
export type Evidence = { field: string; source: string; rule?: string; ruleVersion?: number; reason: string };
export type Rule = { id: string; version: number; kind: 'merchant'|'mcc'; scope: 'finance'|'personal'; owner_email: string; merchant: string; merchant_key: string; fields: Fields; active: number; set_by: string; set_at: string };
export const merchantKey = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/gu,' ');
export const epochState = (version: number): Sql => ({ sql:'EXISTS(SELECT 1 FROM c_auto_coding_epoch WHERE id=1 AND version=?)',params:[version] });
export const advanceEpoch = (db: D1Database) => db.prepare('UPDATE c_auto_coding_epoch SET version=version+1 WHERE id=1');
export const epoch = async(db: D1Database) => (await db.prepare('SELECT version FROM c_auto_coding_epoch WHERE id=1').first<{version:number}>())!.version;
export function fieldsInput(raw: unknown): Fields {
  requireThat(raw && typeof raw === 'object' && !Array.isArray(raw),'Supply coding fields');
  const value=raw as Data;
  requireThat(Object.keys(value).every(k=>['category','dimensions','project','customer','memo'].includes(k)),'Use category, dimensions, project, customer and memo coding fields');
  const fields:Fields={};
  if(value.category) fields.category=text(value.category,'Category',100);
  if(value.dimensions) fields.dimensions=codingInput(value.dimensions);
  for(const field of ['project','customer','memo'] as const) {
    const v=optionalText(value[field],field==='memo'?'Memo':field,field==='memo'?500:500); if(v) fields[field]=v;
  }
  return fields;
}
export function flatten(fields: Fields): Flat {
  return { ...(fields.category?{category:fields.category}:{}),...Object.fromEntries(Object.entries(fields.dimensions??{}).map(([k,v])=>[`dimension:${k}`,v])),...(fields.project?{project:fields.project}:{}),...(fields.customer?{customer:fields.customer}:{}),...(fields.memo?{memo:fields.memo}:{}) };
}
export function unflatten(flat: Flat): Fields {
  const fields:Fields={dimensions:{}};
  for(const [key,value] of Object.entries(flat)) if(key.startsWith('dimension:')) fields.dimensions![key.slice(10)]=value; else if(['category','project','customer','memo'].includes(key)) (fields as Data)[key]=value;
  return fields;
}
export function inactiveReason(fields: Fields, catalog: Catalog, categories: Category[]): string | null {
  if(fields.category) {
    const category=categories.find(c=>c.id===fields.category);
    if(!category?.active) return 'The category is archived or unavailable';
    if(category.ledger_account_id&&!category.ledger_account_available) return 'The category’s mapped chart account is archived or unavailable';
  }
  for(const [id,selected] of Object.entries(fields.dimensions??{})) {
    const dimension=catalog.dimensions.find(d=>d.id===id),value=catalog.values.find(v=>v.id===selected&&v.dimension_id===id);
    if(!dimension?.active||!value||!offeredValue(catalog,value)) return `The ${dimension?.name??'dimension'} choice is archived or unavailable`;
    if(dimension.parent_id&&fields.dimensions?.[dimension.parent_id]!==value.parent_value_id) return `${dimension.name} does not belong to the selected parent`;
  }
  return null;
}
export const itemFields = (item: Data): Fields => ({ category:item.allocations?.length===1?item.allocations[0].category_id:undefined,dimensions:item.coding??{},project:item.project||undefined,customer:item.customer||undefined,memo:item.description||undefined });
