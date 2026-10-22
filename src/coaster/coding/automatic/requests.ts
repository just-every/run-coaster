import { all, authority, commit } from '../../session';
import { needRow } from '../../permissions';
import { claimItems, claimState, claimTotal, loadClaim, visible } from '../../claims';
import { checkedCoding } from '../validation';
import { categories } from '../../items';
import { codingCatalog, catalogState } from '../model';
import { now, requireThat, text, type Actor, type Data } from '../../types';
import { proposeCoding, proposalView } from './engine';
import { contextState, contextWrite, codingContext, humanObservation, prepareTarget, targetSuggestions, feedbackForEdit, type Target } from './storage';
import { fieldsInput, flatten, inactiveReason, itemFields, unflatten } from './model';

function native(actor:Actor) {requireThat(actor.kind==='person','A native session is required',403);}
export async function automaticPreview(db:D1Database,actor:Actor,b:Data) {
  native(actor);needRow(actor,'submit');
  return {...proposalView(await proposeCoding(db,actor.email,b)),receiptReadingAvailable:false};
}
async function ownReceipt(db:D1Database,actor:Actor,id:string) {
  native(actor);needRow(actor,'submit');
  const row=await db.prepare(`SELECT r.id,COALESCE((SELECT MAX(sequence) FROM c_capture_lifecycle WHERE receipt_id=r.id),0) AS sequence FROM c_capture_receipts r WHERE r.id=? AND r.owner_email=? AND NOT EXISTS(SELECT 1 FROM c_capture_lifecycle WHERE receipt_id=r.id AND kind IN ('discarded','merged'))`).bind(id,actor.email).first<{id:string;sequence:number}>();
  requireThat(row,'Receipt not found',404);return row;
}
export async function receiptCoding(db:D1Database,actor:Actor,id:string,b:Data) {
  const receipt=await ownReceipt(db,actor,id),context=await codingContext(db,'receipt',id);
  requireThat(b.version===(context?.version??0),'Receipt coding changed; reload before saving',409);
  const target:Target={kind:'receipt',id,employee:actor.email,merchant:text(b.merchant,'Merchant',200)},human=fieldsInput(b.values??{});
  const prepared=await prepareTarget(db,target,human,context?.values??{});
  const catalog=await codingCatalog(db),known=await categories(db),invalid=inactiveReason(prepared.values,catalog,known);
  requireThat(!invalid,invalid??'Choose active coding');
  await commit(db,all(authority(actor,'employee'),prepared.guard,catalogState(catalog.version),{sql:`EXISTS(SELECT 1 FROM c_capture_receipts WHERE id=? AND owner_email=?) AND (SELECT COALESCE(MAX(sequence),0) FROM c_capture_lifecycle WHERE receipt_id=?)=? AND NOT EXISTS(SELECT 1 FROM c_capture_lifecycle WHERE receipt_id=? AND kind IN ('discarded','merged'))`,params:[id,actor.email,id,receipt.sequence,id]}),[...prepared.writes,...(Object.keys(flatten(human)).length?[...await feedbackForEdit(db,target,{allocations:prepared.values.category?[{category_id:prepared.values.category}]:[],coding:prepared.values.dimensions,project:prepared.values.project,customer:prepared.values.customer,description:prepared.values.memo},actor.delegate?.email??actor.email),...humanObservation(db,target,human,new Date().toISOString().slice(0,10))]:[])]);
  return {version:prepared.version,values:prepared.values,codingSuggestions:await targetSuggestions(db,'receipt',id),flags:prepared.proposal.flags};
}
export async function suggestionsFor(db:D1Database,actor:Actor,query:Data) {
  native(actor);requireThat(!!query.item!==!!query.receipt,'Choose one expense or receipt');
  if(query.receipt){await ownReceipt(db,actor,String(query.receipt));const context=await codingContext(db,'receipt',query.receipt);return {context,contextVersion:context?.version??0,values:context?.values??{},merchant:context?.merchant??'',suggestions:await targetSuggestions(db,'receipt',query.receipt)};}
  const row=await db.prepare('SELECT claim_id FROM c_items WHERE id=?').bind(query.item).first<{claim_id:string}>();requireThat(row,'Expense not found',404);
  visible(actor,await loadClaim(db,row.claim_id));
  return {context:await codingContext(db,'item',query.item),suggestions:await targetSuggestions(db,'item',query.item)};
}
/** Feedback never rewrites a submitted revision. A routed approver can record changed advice, then use the existing
 * return workflow for the employee to correct the expense. Draft/returned owners apply it immediately. */
export async function decideSuggestion(db:D1Database,actor:Actor,id:string,b:Data) {
  native(actor);requireThat(['accept','override'].includes(b.action),'Accept the suggestion or supply corrected coding');
  const suggestion=await db.prepare('SELECT * FROM c_auto_coding_suggestions WHERE id=?').bind(id).first<Data>();requireThat(suggestion,'Coding suggestion not found',404);
  const target:Target={kind:suggestion.target_kind,id:suggestion.target_id,employee:suggestion.employee_email,claim:suggestion.claim_id,merchant:''};
  const context=await codingContext(db,target.kind,target.id);requireThat(context,'Coding context not found',409);target.merchant=context.merchant;target.mcc=context.mcc;
  const originalFields=flatten(JSON.parse(suggestion.fields)),currentFields=flatten(context.values);
  requireThat(context.version===suggestion.context_version||JSON.parse(suggestion.applied_fields).every((field:string)=>currentFields[field]===originalFields[field]),'This suggestion was superseded; open the current expense coding',409);
  const guard={sql:'NOT EXISTS(SELECT 1 FROM c_auto_coding_feedback WHERE suggestion_id=?)',params:[id]};
  requireThat(!await db.prepare('SELECT 1 FROM c_auto_coding_feedback WHERE suggestion_id=?').bind(id).first(),'This suggestion was already decided',409);
  let fields=b.action==='accept'?context.values:unflatten({...flatten(context.values),...flatten(fieldsInput(b.values))});
  if(b.action==='override')requireThat(Object.keys(flatten(fieldsInput(b.values))).length,'Supply the corrected coding');
  const catalog=await codingCatalog(db);
  for(const kind of ['project','customer'] as const) {const selected=catalog.values.find(v=>fields.dimensions?.[v.dimension_id]===v.id&&catalog.dimensions.some(d=>d.id===v.dimension_id&&d.kind===kind));if(selected)fields[kind]=selected.name;}
  const known=await categories(db),invalid=inactiveReason(fields,catalog,known);requireThat(!invalid,invalid??'Choose active coding');
  const writes:D1PreparedStatement[]=[],guards=[guard,contextState(target,context.version),catalogState(catalog.version)];
  let version=context.version+1,claimVersion:number|undefined,requiresReturn=false;
  if(target.kind==='receipt') {
    const receipt=await ownReceipt(db,actor,target.id);requireThat((b.contextVersion??b.version)===context.version,'Receipt coding changed; reload before deciding',409);
    guards.push({sql:'(SELECT COALESCE(MAX(sequence),0) FROM c_capture_lifecycle WHERE receipt_id=?)=?',params:[target.id,receipt.sequence]});
  } else {
    const row=await db.prepare('SELECT claim_id FROM c_items WHERE id=?').bind(target.id).first<{claim_id:string}>();requireThat(row,'Expense not found',404);
    const claim=await loadClaim(db,row.claim_id);visible(actor,claim);target.employee=claim.employee_email;
    requireThat(b.claimVersion===claim.version,'The claim changed; reload before deciding',409);
    const own=claim.employee_email===actor.email&&['draft','returned'].includes(claim.status),reviewer=claim.status==='submitted'&&actor.roles.manager&&(claim.assigned_emails?.includes(actor.email)||claim.approver_email===actor.email);
    requireThat(own||reviewer,'Only the employee editing this expense or its assigned approver decides its coding advice',403);
    requireThat(!reviewer||claim.employee_email!==actor.email&&claim.employee_email!==actor.delegate?.email,'Nobody reviews their own coding',403);
    guards.push(claimState(claim.id,claim.version,[claim.status]));
    const item=(await claimItems(db,claim.id)).find(i=>i.id===target.id)!;
    if(own) {
      requireThat(item.allocations.length===1||!fields.category,'Change split categories in the expense editor');
      const revised={...item,description:fields.memo??item.description,project:fields.project??'',customer:fields.customer??'',coding:fields.dimensions??{},allocations:item.allocations.map(a=>{const category=fields.category?known.find(c=>c.id===fields.category):null;return {...a,...(category?{category_id:category.id,category_name:category.name,account_code:category.account_code,tax_code:category.tax_code,ledger_account_id:category.ledger_account_id,ledger_account_snapshot:category.ledger_account_snapshot}:{})};})};
      const checked=await checkedCoding(db,[revised]),value=checked.items[0];guards.push(checked.guard);
      writes.push(db.prepare('UPDATE c_items SET description=?,project=?,customer=?,coding=? WHERE id=?').bind(value.description,value.project,value.customer,JSON.stringify(value.coding),target.id));
      if(fields.category)writes.push(db.prepare('UPDATE c_allocations SET category_id=? WHERE item_id=?').bind(fields.category,target.id));
      writes.push(claimTotal(db,claim.id));claimVersion=claim.version+1;fields=itemFields(value);
    }else{requiresReturn=b.action==='override';version=context.version;}
  }
  writes.push(db.prepare('INSERT INTO c_auto_coding_feedback(suggestion_id,action,values_json,actor_email,at) VALUES(?,?,?,?,?)').bind(id,b.action,JSON.stringify(fields),actor.delegate?.email??actor.email,now()),
    ...(!requiresReturn?[contextWrite(db,target,version,fields,[...context.humanFields,...Object.keys(flatten(fields))])]:[]),
    ...(!requiresReturn?humanObservation(db,target,fields,new Date().toISOString().slice(0,10)):[]));
  await commit(db,all(authority(actor,target.kind==='receipt'||actor.email===target.employee?'employee':'manager'),...guards),writes);
  return {applied:!requiresReturn,requiresReturn,claimVersion,version,codingSuggestions:await targetSuggestions(db,target.kind,target.id)};
}
