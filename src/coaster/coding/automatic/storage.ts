import { all, type Sql } from '../../session';
import { now, uid, type Data } from '../../types';
import { proposeCoding, type Proposal } from './engine';
import { advanceEpoch, flatten, itemFields, merchantKey, unflatten, type Fields } from './model';

export type Target = { kind:'item'|'receipt';id:string;employee:string;claim?:string;merchant:string;mcc?:string };
export async function codingContext(db:D1Database,kind:string,id:string):Promise<Data|null> {
  const row=await db.prepare('SELECT * FROM c_auto_coding_contexts WHERE target_kind=? AND target_id=?').bind(kind,id).first<Data>();
  return row?{...row,values:JSON.parse(row.values_json) as Fields,humanFields:JSON.parse(row.human_fields) as string[]}:null;
}
export const contextState=(target:Target,version:number):Sql=>({sql:version?'EXISTS(SELECT 1 FROM c_auto_coding_contexts WHERE target_kind=? AND target_id=? AND version=?)':'NOT EXISTS(SELECT 1 FROM c_auto_coding_contexts WHERE target_kind=? AND target_id=?)',params:version?[target.kind,target.id,version]:[target.kind,target.id]});
export function contextWrite(db:D1Database,target:Target,version:number,values:Fields,human:string[]) {
  return db.prepare('INSERT INTO c_auto_coding_contexts(target_kind,target_id,employee_email,merchant,merchant_key,mcc,values_json,human_fields,version,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(target_kind,target_id) DO UPDATE SET employee_email=excluded.employee_email,merchant=excluded.merchant,merchant_key=excluded.merchant_key,mcc=excluded.mcc,values_json=excluded.values_json,human_fields=excluded.human_fields,version=excluded.version,updated_at=excluded.updated_at').bind(target.kind,target.id,target.employee,target.merchant,merchantKey(target.merchant),target.mcc??'',JSON.stringify(values),JSON.stringify([...new Set(human)]),version,now());
}
export function suggestionWrites(db:D1Database,target:Target,proposal:Proposal,version:number) {
  return [
    ...(proposal.appliedFields.length?[db.prepare('INSERT INTO c_auto_coding_suggestions(id,target_kind,target_id,employee_email,claim_id,merchant_key,context_version,fields,applied_fields,evidence,catalog_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(uid(),target.kind,target.id,target.employee,target.claim??null,merchantKey(target.merchant),version,JSON.stringify(proposal.fields),JSON.stringify(proposal.appliedFields),JSON.stringify(proposal.evidence),proposal.catalogVersion,now())]:[]),
    ...proposal.flags.map(f=>db.prepare('INSERT OR IGNORE INTO c_auto_coding_flags(rule_id,rule_version,catalog_version,reason,created_at) VALUES(?,?,?,?,?)').bind(f.rule,f.ruleVersion,proposal.catalogVersion,f.reason,now())),
  ];
}
export async function prepareTarget(db:D1Database,target:Target,human:Fields,base:Fields={},protectedFields:string[]=[]) {
  const context=await codingContext(db,target.kind,target.id),version=(context?.version??0)+1;
  const existing={...flatten(base),...flatten(human)};
  const proposal=await proposeCoding(db,target.employee,{merchant:target.merchant,mcc:target.mcc,values:unflatten(existing),protectedFields});
  const values=unflatten({...existing,...flatten(proposal.fields)}),humanFields=[...(context?.humanFields??[]),...Object.keys(flatten(human))];
  return {proposal,values,version,guard:context?all(proposal.guard,contextState(target,version-1)):proposal.guard,writes:[contextWrite(db,target,version,values,humanFields),...suggestionWrites(db,target,proposal,version)]};
}
export function humanObservation(db:D1Database,target:Target,fields:Fields,date:string) {
  if(!Object.keys(flatten(fields)).length)return [];
  return [db.prepare(`INSERT INTO c_auto_coding_observations(employee_email,department_id,merchant_key,fields,target_kind,target_id,spent_on,observed_at) VALUES(?,COALESCE((SELECT department_id FROM c_members WHERE email=?),''),?,?,?,?,?,?)`).bind(target.employee,target.employee,merchantKey(target.merchant),JSON.stringify(fields),target.kind,target.id,date,now()),advanceEpoch(db)];
}
export async function targetSuggestions(db:D1Database,kind:string,id:string):Promise<Data[]> {
  const rows=(await db.prepare('SELECT s.*,f.action,f.values_json AS feedback_values,f.actor_email AS decided_by,f.at AS decided_at FROM c_auto_coding_suggestions s LEFT JOIN c_auto_coding_feedback f ON f.suggestion_id=s.id WHERE s.target_kind=? AND s.target_id=? ORDER BY s.created_at,s.rowid').bind(kind,id).all<Data>()).results;
  return rows.map(r=>({...r,fields:JSON.parse(r.fields),appliedFields:JSON.parse(r.applied_fields),evidence:JSON.parse(r.evidence),status:r.action??'pending',feedback:r.action?{action:r.action,values:JSON.parse(r.feedback_values),by:r.decided_by,at:r.decided_at}:null}));
}
/** Explicit normal expense edits also resolve pending advice and teach only this employee's private behavior. */
export async function feedbackForEdit(db:D1Database,target:Target,item:Data,actor:string) {
  const fields=itemFields(item),flat=flatten(fields),pending=(await targetSuggestions(db,target.kind,target.id)).filter(s=>s.status==='pending');
  return pending.map(s=>{const suggested=flatten(s.fields),accepted=s.appliedFields.every((f:string)=>flat[f]===suggested[f]);return db.prepare('INSERT INTO c_auto_coding_feedback(suggestion_id,action,values_json,actor_email,at) VALUES(?,?,?,?,?)').bind(s.id,accepted?'accept':'override',JSON.stringify(fields),actor,now());});
}
