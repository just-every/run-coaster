import { redactFields } from '../../modules/import-kit/src/d1/field-redaction';
import type { D1FieldRedaction, D1TargetAdapter, TargetRow } from '../../modules/import-kit/src/d1/index';
import { sql } from './native-targets';

/** An erasure may also remove chains. Fence only selected field holders, rather
 * than treating unrelated configuration as an immutable history-only row set. */
export async function importRedaction(adapter:D1TargetAdapter,db:any,destination:string,fields:readonly D1FieldRedaction[]){
 const rows=(await adapter.list(db,destination)).filter(r=>redactFields(r.value,fields)!==r.value);
 const native=(kind:string,table:string,id:string,columns:string[])=>`SELECT '${kind}' kind,n.${id} id,json_object(${columns.flatMap(c=>[`'${c}'`,`n.${c}`]).join(',')}) value FROM c_import_targets t JOIN ${table} n ON t.kind='${kind}' AND t.id=n.${id}`;
 const union=`SELECT kind,id,value FROM c_history WHERE destination=? UNION ALL ${native('member','c_members','member_id',['member_id','email','name','is_employee','is_manager','is_finance','is_auditor','approver_email','active','updated_at'])} UNION ALL ${native('category','c_categories','id',['id','name','account_code','tax_code','limit_minor','active','receipt_always','per_person_limit_minor','required_fields'])} UNION ALL ${native('approval-chain','c_import_chains','id',['id','employee_id','steps'])}`;
 // This importer recognises exact scalar column paths. Refuse unknown selectors
 // instead of accidentally weakening the erasure's holding-set fence.
 if(fields.some(f=>f.path.length!==1||typeof f.path[0]!=='string'))throw new Error('Unsupported import redaction path');
 const selected=fields.map(()=>"json_extract(value,?)=?").join(' OR ')||'0';
 const params=fields.flatMap(f=>['$."'+String(f.path[0]).replaceAll('"','\\"')+'"',f.value]);
 const holders=`SELECT kind,id FROM (${union}) WHERE ${selected}`;
 return {rows,holding:(expected:TargetRow[])=>[sql(`(SELECT COUNT(*) FROM (${holders}))=? AND NOT EXISTS(SELECT 1 FROM (${holders}) h WHERE NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE json_extract(e.value,'$[0]')=h.kind AND json_extract(e.value,'$[1]')=h.id))`,destination,...params,expected.length,destination,...params,JSON.stringify(expected.map(r=>[r.targetKind,r.targetId])))],matches:(values:TargetRow[])=>values.length?values.map(r=>adapter.matches(r,destination,r.targetKind,r.targetId)):[sql('1')],write:(values:TargetRow[])=>values.flatMap(r=>adapter.write(r))};
}
