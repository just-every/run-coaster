import { all, type Sql } from '../../session';
import { codingCatalog, catalogState } from '../model';
import { categories } from '../../items';
import type { Data } from '../../types';
import { flatten, inactiveReason, itemFields, unflatten, type Evidence, type ReceiptCodingCandidate } from './model';
import { codingContext, contextState, contextWrite, suggestionWrites, feedbackForEdit, targetSuggestions, type Target } from './storage';
import { proposeCoding } from './engine';
import { currentSettings, settingsStill } from '../../receipts/reading/settings';

const readingReason='Verified coding from the attached private receipt reading; the active choice fills an unentered expense field after higher-priority sources';
async function savedReading(db:D1Database,receipt:Data,id:string) {
  const [suggestions,settings,reading]=await Promise.all([targetSuggestions(db,'receipt',id),currentSettings(db),db.prepare('SELECT sequence,kind,at FROM c_receipt_readings WHERE receipt_id=? ORDER BY sequence DESC LIMIT 1').bind(id).first<{sequence:number;kind:string;at:string}>()]);
  if(!settings?.enabled||!reading||!['read','corrected'].includes(reading.kind))return null;
  // Generated original text stays private; a memo crosses only through the existing explicit human-choice path.
  const values=flatten(receipt.values),picked:Record<string,string>={},confidence:Record<string,number>={},evidence=new Map<string,Evidence>();
  for(const suggestion of [...suggestions].reverse()){
    if(suggestion.status!=='pending'||suggestion.created_at<=reading.at)continue;
    const fields=flatten(suggestion.fields);
    for(const entry of suggestion.evidence as Evidence[])if(entry.source==='receipt-reading'&&entry.field!=='memo'&&entry.receipt===id&&typeof entry.confidence==='number'&&entry.confidence>=settings.threshold&&entry.confidence<=1&&entry.model&&!receipt.humanFields.includes(entry.field)&&values[entry.field]===fields[entry.field]&&!picked[entry.field]){
      picked[entry.field]=fields[entry.field];confidence[entry.field]=entry.confidence;
      // The private model explanation stays on the original. Expense readers receive controlled provenance only.
      evidence.set(entry.field,{field:entry.field,source:'receipt-reading',reason:readingReason,confidence:entry.confidence,model:entry.model,receipt:id});
    }
  }
  if(!Object.keys(picked).length)return null;
  const candidate:ReceiptCodingCandidate={fields:unflatten(picked),confidence,reason:readingReason,model:[...evidence.values()][0].model!,receipt:id};
  return {candidate,evidence,guards:[settingsStill(settings.version),{sql:"EXISTS(SELECT 1 FROM c_receipt_readings WHERE receipt_id=? AND sequence=? AND kind IN ('read','corrected')) AND (SELECT MAX(sequence) FROM c_receipt_readings WHERE receipt_id=?)=?",params:[id,reading.sequence,id,reading.sequence]}] as Sql[]};
}

/** A populated import default is logically empty only while its exact native provenance remains unchanged. */
async function importerPlaceholder(db:D1Database,item:Data,context:Data|null) {
  if(!context||context.humanFields.includes('category')||item.allocations.length!==1||!(item.card_charge_id||item.personal_card_charge_id))return false;
  const allocation=item.allocations[0],charge=await db.prepare('SELECT ch.category_id,ch.amount_minor,f.mapping FROM c_receipt_card_charges ch JOIN c_card_sources f ON f.id=ch.file_id WHERE ch.id=? AND ch.item_id=? AND f.undone_at IS NULL').bind(item.card_charge_id??item.personal_card_charge_id,item.id).first<Data>();
  if(!charge||charge.category_id!==allocation.category_id||charge.amount_minor!==item.amount_minor||allocation.amount_minor!==item.amount_minor||allocation.cost_centre!==(JSON.parse(charge.mapping).coding?.costCentre??''))return false;
  return !(await targetSuggestions(db,'item',item.id)).some(s=>s.evidence.some((e:Evidence)=>e.field==='category'));
}

/** An attached original may fill empty coding only. Statement facts and any existing employee/approver coding win.
 * Human-entered receipt coding is carried as human input; generated suggestions are recomputed against today's catalog. */
export async function receiptTransfer(db:D1Database,item:Data,receiptId:string,actor='automation: receipt coding') {
  const receipt=await codingContext(db,'receipt',receiptId);
  if(!receipt)return {writes:[],guards:[]};
  const context=await codingContext(db,'item',item.id),catalog=await codingCatalog(db),known=await categories(db);
  if(receipt.employee_email!==context?.employee_email&&context)return {writes:[],guards:[]};
  const existing=flatten(itemFields(item)),receiptFields=flatten(receipt.values),entered:Record<string,string>={};
  for(const field of receipt.humanFields as string[]) if((!existing[field]||context&&!context.humanFields.includes(field))&&receiptFields[field]&&!(field==='category'&&item.allocations.length>1))entered[field]=receiptFields[field];
  const human=unflatten(entered);
  if(inactiveReason(human,catalog,known))for(const k of Object.keys(entered))delete entered[k];
  const reading=await savedReading(db,receipt,receiptId),logical={...existing};
  if(reading&&await importerPlaceholder(db,item,context))delete logical.category;
  const proposal=await proposeCoding(db,receipt.employee_email,{merchant:receipt.merchant,mcc:context?.mcc,values:unflatten({...logical,...entered}),protectedFields:context?.humanFields??[]},reading?.candidate);
  proposal.evidence=proposal.evidence.map(entry=>entry.source==='receipt-reading'?reading!.evidence.get(entry.field)!:entry);
  const patch={...flatten(proposal.fields),...entered};
  const merged=unflatten({...existing,...patch});
  if(inactiveReason(merged,catalog,known))return {writes:[],guards:[]};
  if(!Object.keys(patch).length)return {writes:[],guards:[]};
  const value={...item,allocations:item.allocations.map((a:Data)=>({...a,...(patch.category?{category_id:patch.category}:{})})),coding:merged.dimensions??{},project:merged.project??'',customer:merged.customer??'',description:merged.memo??''};
  for(const kind of ['project','customer'] as const){const selected=catalog.values.find(v=>value.coding[v.dimension_id]===v.id&&catalog.dimensions.some(d=>d.id===v.dimension_id&&d.kind===kind));if(selected)value[kind]=selected.name;}
  const target:Target={kind:'item',id:item.id,claim:item.claim_id,employee:receipt.employee_email,merchant:item.merchant,mcc:context?.mcc},version=(context?.version??0)+1;
  const evidence:Evidence[]=[...proposal.evidence,...Object.keys(entered).map(field=>({field,source:'receipt-entry',reason:'Coding entered by the employee on the attached original; no employee or approver had filled the expense field'}))];
  return {guards:[proposal.guard,catalogState(catalog.version),...(reading?.guards??[]),contextState(target,version-1),contextState({kind:'receipt',id:receiptId,employee:receipt.employee_email,merchant:receipt.merchant},receipt.version)],writes:[
    ...(Object.keys(entered).length?await feedbackForEdit(db,target,value,actor):[]),
    ...(patch.category?[db.prepare('UPDATE c_allocations SET category_id=? WHERE item_id=?').bind(patch.category,item.id)]:[]),
    db.prepare('UPDATE c_items SET coding=?,project=?,customer=?,description=? WHERE id=?').bind(JSON.stringify(value.coding),value.project,value.customer,value.description,item.id),
    contextWrite(db,target,version,itemFields(value),[...(context?.humanFields??[]),...Object.keys(entered)]),
    ...suggestionWrites(db,target,{...proposal,fields:unflatten(patch),appliedFields:Object.keys(patch),evidence},version),
  ]};
}

/** A person-confirmed attachment or unique consented card match supplies the original with the actual linked
 * charge's MCC. It is a card fact, never inferred from pixels, the filename, or a label in a fixture. */
export async function chargeEvidenceForReceipt(db:D1Database,receiptId:string,itemId:string) {
  const receipt=await codingContext(db,'receipt',receiptId),charge=await codingContext(db,'item',itemId);
  if(!receipt||!charge?.mcc||receipt.employee_email!==charge.employee_email)return {writes:[],guards:[]};
  const target:Target={kind:'receipt',id:receiptId,employee:receipt.employee_email,merchant:receipt.merchant,mcc:charge.mcc};
  const proposal=await proposeCoding(db,receipt.employee_email,{merchant:receipt.merchant,mcc:charge.mcc,values:receipt.values});
  if(!proposal.appliedFields.length&&!proposal.flags.length)return {writes:[],guards:[]};
  const values=unflatten({...flatten(receipt.values),...flatten(proposal.fields)}),version=receipt.version+1;
  return {guards:[proposal.guard,contextState(target,receipt.version),contextState({kind:'item',id:itemId,employee:charge.employee_email,merchant:charge.merchant},charge.version)],writes:[contextWrite(db,target,version,values,receipt.humanFields),...suggestionWrites(db,target,proposal,version)]};
}
