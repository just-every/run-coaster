import type { Data } from '../../types';
import { flatten, itemFields, type Fields } from './model';
import { codingContext, contextWrite, feedbackForEdit, humanObservation, prepareTarget, type Target } from './storage';

/** Values sent through the normal editor are human input. Omitted fields can be suggested; explicit blank fields
 * and split category allocations remain protected. No client-supplied source label grants automatic authority. */
export function requestFields(b:Data):Fields {
  const category=b.allocations?.length===1?b.allocations[0].category:b.allocations?.length>1?undefined:b.category;
  return {category:category||undefined,dimensions:b.coding??{},project:b.project||undefined,customer:b.customer||undefined,memo:b.description||undefined};
}
export function protectedRequestFields(b:Data):string[] {
  return [...(b.category!==undefined||b.allocations?.length?['category']:[]),...Object.keys(b.coding??{}).map(k=>`dimension:${k}`),...['project','customer'].filter(k=>b[k]!==undefined),...(b.description!==undefined?['memo']:[])];
}
export function mergeRequest(b:Data,fields:Fields) {
  const category=fields.category;
  return {...b,...(!b.category&&category&&!b.allocations?.length?{category}:{}),...(b.allocations?.length===1&&category&&!b.allocations[0].category?{allocations:[{...b.allocations[0],category}]}:{}),coding:{...fields.dimensions,...b.coding},project:b.project??fields.project,customer:b.customer??fields.customer,description:b.description??fields.memo};
}
export async function prepareItemInput(db:D1Database,employee:string,claim:string,id:string,b:Data) {
  const prior=await codingContext(db,'item',id),target:Target={kind:'item',id,claim,employee,merchant:b.merchant,mcc:prior?.mcc};
  const prepared=await prepareTarget(db,target,requestFields(b),{},[...protectedRequestFields(b),...(prior?.humanFields??[])]);
  return {...prepared,target,input:mergeRequest(b,prepared.proposal.fields)};
}
export async function itemLearningWrites(db:D1Database,target:Target,item:Data,actor:string,existing:boolean) {
  const context=await codingContext(db,'item',target.id),fields=itemFields(item);
  return [
    ...(existing?await feedbackForEdit(db,target,item,actor):[]),
    contextWrite(db,target,(context?.version??0)+1,fields,[...(context?.humanFields??[]),...Object.keys(flatten(fields))]),
    ...humanObservation(db,target,fields,item.spent_on),
  ];
}
