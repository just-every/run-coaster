import type { D1UndoDependency, D1UndoEffect, TargetRow } from '../../modules/import-kit/src/d1/index';
import { sql } from './native-targets';

/** Fence the complete relation sets, including absence, before deciding what undo can remove. */
export async function importDependencies(db:any,effects:D1UndoEffect[],rows:TargetRow[]){
 const dependencies:D1UndoDependency[]=[],guards:ReturnType<typeof sql>[]=[];
 // A JSON array of complete rows is guarded even when no relation currently exists.
 const query=async(q:string)=>{const r=(await db.prepare(`SELECT json_group_array(json(value)) AS value FROM (${q})`).first()).value;guards.push(sql(`(SELECT json_group_array(json(value)) FROM (${q}))=?`,r));return JSON.parse(r);};
 const claims=await query("SELECT json_object('id',id,'employee',employee_email,'approver',approver_email) value FROM c_claims ORDER BY id");
 const requests=await query("SELECT json_object('id',id,'employee',employee_email,'approver',approver_email) value FROM c_requests ORDER BY id");
 const allocations=await query("SELECT json_object('item',item_id,'category',category_id) value FROM c_allocations ORDER BY item_id,position");
 const members=await query("SELECT json_object('id',member_id,'email',email,'approver',approver_email) value FROM c_members ORDER BY member_id");
 const chains=await query("SELECT json_object('id',id,'employee',employee_id,'steps',json(steps)) value FROM c_import_chains ORDER BY id");
 const frozen=await query("SELECT json_object('claim',claim_id,'chain',chain_id,'steps',json(steps)) value FROM c_claim_chains ORDER BY claim_id,revision");
 const rules=await query("SELECT json_object('version',version,'rules',json(rules)) value FROM c_policies ORDER BY version");
 const allowance=await query("SELECT json_object('id',id,'category',category_id) value FROM c_allowances ORDER BY id");
 const key=(kind:string,id:string)=>effects.find(e=>e.expected.targetKind===kind&&e.expected.targetId===id)?.provenance.id;
 const edge=(required:string,dependent:string|undefined,table:string,id:string)=>dependencies.push({requiredEffectId:required,...(dependent?{dependentEffectId:dependent}:{}),cause:{table,recordId:id},evidence:{reason:'Live native reference'}});
 for(const effect of effects){
  const e=effect.expected,id=e.targetId,required=effect.provenance.id,value=e.value as any;
  if(e.targetKind==='member'){
   for(const r of [...claims,...requests])if(r.employee===value.email||r.approver===value.email)edge(required,undefined,'c_claims/c_requests',r.id);
   for(const m of members)if(m.approver===value.email)edge(required,key('member',m.id),'c_members',m.id);
   for(const c of chains)if(c.employee===id||c.steps.includes(id))edge(required,key('approval-chain',c.id),'c_import_chains',c.id);
   for(const f of frozen)if(f.steps.some((s:any)=>s.memberId===id))edge(required,undefined,'c_claim_chains',f.claim);
  }
  if(e.targetKind==='category'){
   for(const a of allocations)if(a.category===id)edge(required,undefined,'c_allocations',a.item);
   for(const a of allowance)if(a.category===id)edge(required,undefined,'c_allowances',a.id);
   for(const p of rules)if(p.rules.some((r:any)=>r.category===id))edge(required,undefined,'c_policies',String(p.version));
  }
  if(e.targetKind==='approval-chain')for(const f of frozen)if(f.chain===id)edge(required,undefined,'c_claim_chains',f.claim);
  if(e.targetKind==='crosswalk'){
   const native=key(value.kind,value.targetId);
   if(native)edge(required,native,'c_import_targets',value.targetId);
   else if(rows.some(r=>r.targetKind===value.kind&&r.targetId===value.targetId))edge(required,undefined,'c_import_targets',value.targetId);
  }
 }
 return {dependencies,guards};
}
