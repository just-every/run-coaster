import type { TargetRow } from '../../modules/import-kit/src/d1/index';
import { localDay } from '../delegation';
import { configurationSql } from '../policy-configuration';
import { policyKind, policyCount, readConcurPolicy, matchConcurPolicy, writeConcurPolicy, removeConcurPolicy } from './concur-policy';

export const sql = (sql: string, ...params: unknown[]) => ({ sql, params });
const fields:Record<string,string[]>={member:['member_id','email','name','is_employee','is_manager','is_finance','is_auditor','approver_email','active','updated_at'],category:['id','name','account_code','tax_code','limit_minor','active','receipt_always','per_person_limit_minor','required_fields'],'approval-chain':['id','employee_id','steps']};
fields.card=['id','issuer','last4','employee_email','assigned_by','assigned_at'];
fields['tag-dimension']=['id','name','kind','parent_id','required','active','source','source_company','updated_at'];
fields.tag=['id','dimension_id','name','parent_value_id','owner_email','active','source_id','updated_at'];
const tables:Record<string,string>={member:'c_members',category:'c_categories','approval-chain':'c_import_chains',card:'c_cards','tag-dimension':'c_coding_dimensions',tag:'c_coding_values'};
const idColumn=(kind:string)=>kind==='member'?'member_id':'id';
export const nativeKind=(kind:string)=>kind in tables || kind===policyKind;
export const nativeQuery=(kind:string)=>`SELECT ${fields[kind].join(',')} FROM ${tables[kind]} WHERE ${idColumn(kind)}=?`;
export async function readNative(db:any,destination:string,kind:string,id:string):Promise<TargetRow|undefined>{
  if(kind===policyKind)return readConcurPolicy(db,destination,id);
  const value=await db.prepare(nativeQuery(kind)).bind(id).first();
  if(!value)return undefined;
  const marker=await db.prepare('SELECT revision FROM c_import_targets WHERE kind=? AND id=?').bind(kind,id).first();
  return {destination,targetKind:kind,targetId:id,revision:marker?.revision??'native',value};
}
export function nativeMatch(r:TargetRow|null|undefined,kind:string,id:string){
  if(kind===policyKind)return matchConcurPolicy(r,id);
  if(!r)return sql(`NOT EXISTS(SELECT 1 FROM ${tables[kind]} WHERE ${idColumn(kind)}=?)`,id);
  const value=r.value as Record<string,unknown>;
  return sql(`EXISTS(SELECT 1 FROM ${tables[kind]} WHERE ${idColumn(kind)}=? AND ${fields[kind].map(f=>`${f} IS ?`).join(' AND ')}) AND COALESCE((SELECT revision FROM c_import_targets WHERE kind=? AND id=?),'native')=?`,id,...fields[kind].map(f=>value[f]),kind,id,r.revision);
}
const policy=(day:string)=>[
 sql("INSERT INTO c_policies(version,effective_from,rules,published_by,published_at) SELECT COALESCE(MAX(version),0)+1,?,COALESCE((SELECT rules FROM c_policies WHERE entity_id='primary' AND effective_from<=? ORDER BY version DESC LIMIT 1),'[]'),'role:owner',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM c_policies",day,day),
 sql(`INSERT INTO c_policy_configurations(version,configuration) SELECT (SELECT MAX(version) FROM c_policies),${configurationSql} FROM c_business b WHERE b.id=1`)
];
export function writeNative(r:TargetRow,timezone:string){
 if(r.targetKind===policyKind)return writeConcurPolicy(r);
 const k=r.targetKind, v=r.value as Record<string,unknown>, cols=fields[k];
 return [sql(`INSERT INTO ${tables[k]}(${cols.join(',')}${k==='approval-chain'?',revision':''}) VALUES(${cols.map(()=>'?').join(',')}${k==='approval-chain'?',?':''}) ON CONFLICT(${idColumn(k)}) DO UPDATE SET ${cols.filter(c=>c!==idColumn(k)).map(c=>`${c}=excluded.${c}`).join(',')}${k==='approval-chain'?',revision=excluded.revision':''}`,...cols.map(c=>v[c]),...(k==='approval-chain'?[r.revision]:[])),sql('INSERT INTO c_import_targets(kind,id,revision) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision',k,r.targetId,r.revision),...(k==='card'?[sql("INSERT INTO c_events(id,seq,at,actor_email,action,claim_id,batch_id,detail) VALUES(lower(hex(randomblob(16))),(SELECT COALESCE(MAX(seq),0)+1 FROM c_events),strftime('%Y-%m-%dT%H:%M:%fZ','now'),'role:owner','import-card-assigned',NULL,NULL,json_object('card',?,'employee',?))",r.targetId,v.employee_email)]:[]),...(k==='category'?policy(localDay(timezone)):[]),...(['tag-dimension','tag'].includes(k)?[sql('UPDATE c_coding_version SET version=version+1 WHERE id=1')]:[])];
}
export function removeNative(k:string,id:string,timezone:string){
 if(k==='card')return [sql('INSERT INTO c_import_card_undo(id) VALUES(?)',id),sql('DELETE FROM c_cards WHERE id=?',id),sql('DELETE FROM c_import_card_undo WHERE id=?',id),sql("DELETE FROM c_import_targets WHERE kind='card' AND id=?",id)];
 if(k===policyKind)return removeConcurPolicy(id,timezone);
 return [
  // Every inserted member receives this derived membership; explicit later entity assignments retain the member.
  ...(k==='member'?[sql("DELETE FROM c_entity_members WHERE entity_id='primary' AND email=(SELECT email FROM c_members WHERE member_id=?)",id)]:[]),
  sql(`DELETE FROM ${tables[k]} WHERE ${idColumn(k)}=?`,id),
  sql('DELETE FROM c_import_targets WHERE kind=? AND id=?',k,id),
  ...(k==='category'?policy(localDay(timezone)):[]),
  ...(['tag-dimension','tag'].includes(k)?[sql('UPDATE c_coding_version SET version=version+1 WHERE id=1')]:[]),
 ];
}
export async function nativeRows(db:any,destination:string){
 const markers=(await db.prepare('SELECT kind,id FROM c_import_targets ORDER BY kind,id').all()).results;
 const rows:TargetRow[]=[];
 for(const m of markers){const r=await readNative(db,destination,m.kind,m.id);if(r)rows.push(r);}
 for(const m of (await db.prepare('SELECT id FROM c_concur_policy_imports ORDER BY id').all()).results){const r=await readConcurPolicy(db,destination,m.id);if(r)rows.push(r);}
 return rows;
}
export const nativeCount=`(SELECT COUNT(*) FROM c_import_targets t WHERE ${Object.entries(tables).map(([kind,table])=>`(t.kind='${kind}' AND EXISTS(SELECT 1 FROM ${table} n WHERE n.${idColumn(kind)}=t.id))`).join(' OR ')}) + ${policyCount}`;
