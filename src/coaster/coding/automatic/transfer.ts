import { all } from '../../session';
import { codingCatalog, catalogState } from '../model';
import { categories } from '../../items';
import type { Data } from '../../types';
import { fieldsInput, flatten, inactiveReason, itemFields, unflatten, type Evidence } from './model';
import { codingContext, contextState, contextWrite, suggestionWrites, type Target } from './storage';
import { proposeCoding } from './engine';

/** An attached original may fill empty coding only. Statement facts and any existing employee/approver coding win.
 * Human-entered receipt coding is carried as human input; generated suggestions are recomputed against today's catalog. */
export async function receiptTransfer(db:D1Database,item:Data,receiptId:string) {
  const receipt=await codingContext(db,'receipt',receiptId);
  if(!receipt)return {writes:[],guards:[]};
  const context=await codingContext(db,'item',item.id),catalog=await codingCatalog(db),known=await categories(db);
  const existing=flatten(itemFields(item)),receiptFields=flatten(receipt.values),entered:Record<string,string>={};
  for(const field of receipt.humanFields as string[]) if(!existing[field]&&receiptFields[field])entered[field]=receiptFields[field];
  const human=unflatten(entered);
  if(inactiveReason(human,catalog,known))for(const k of Object.keys(entered))delete entered[k];
  const proposal=await proposeCoding(db,receipt.employee_email,{merchant:receipt.merchant,values:unflatten({...existing,...entered})});
  const patch={...flatten(proposal.fields),...entered};
  const merged=unflatten({...existing,...patch});
  if(inactiveReason(merged,catalog,known))return {writes:[],guards:[]};
  if(!Object.keys(patch).length)return {writes:[],guards:[]};
  const value={...item,coding:merged.dimensions??{},project:merged.project??'',customer:merged.customer??'',description:merged.memo??''};
  for(const kind of ['project','customer'] as const){const selected=catalog.values.find(v=>value.coding[v.dimension_id]===v.id&&catalog.dimensions.some(d=>d.id===v.dimension_id&&d.kind===kind));if(selected)value[kind]=selected.name;}
  const target:Target={kind:'item',id:item.id,claim:item.claim_id,employee:receipt.employee_email,merchant:item.merchant,mcc:context?.mcc},version=(context?.version??0)+1;
  const evidence:Evidence[]=[...proposal.evidence,...Object.keys(entered).map(field=>({field,source:'receipt-entry',reason:'Coding entered by the employee on the attached original; the expense field was empty'}))];
  return {guards:[proposal.guard,catalogState(catalog.version),contextState(target,version-1),contextState({kind:'receipt',id:receiptId,employee:receipt.employee_email,merchant:receipt.merchant},receipt.version)],writes:[
    db.prepare('UPDATE c_items SET coding=?,project=?,customer=?,description=? WHERE id=?').bind(JSON.stringify(value.coding),value.project,value.customer,value.description,item.id),
    contextWrite(db,target,version,itemFields(value),[...(context?.humanFields??[]),...Object.keys(entered)]),
    ...suggestionWrites(db,target,{...proposal,fields:unflatten(patch),appliedFields:Object.keys(patch),evidence},version),
  ]};
}
