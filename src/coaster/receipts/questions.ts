import { event } from '../events';
import { all, authority, commit, sha256Hex } from '../session';
import { claimState, claimTotal } from '../claims';
import { decimal, requireThat, type Actor, type Data } from '../types';
import { ownOriginal, latestReading, expected, originalStill, crossSources, captureState } from './reading/access';
import { readingLine } from './reading/history';
import { correctedFields } from './reading/normalize';
import { FIELD_NAMES, type Fields } from './reading/model';
import { mailReadings, mailSources, mailComparison } from './reading/mail-sources';

/** A question is a projection of the current private reading and attached charge,
 * not another copy of OCR or a new mutable conversation. A confirmed field cannot
 * generate the same question again. Merchant email intake inherits this door. */
export async function receiptQuestion(db:D1Database,id:string){
 const r=await db.prepare("SELECT r.id,r.owner_email,r.media_type FROM c_capture_receipts r JOIN c_members m ON m.email=r.owner_email AND m.active=1 WHERE r.id=? AND NOT EXISTS(SELECT 1 FROM c_capture_lifecycle l WHERE l.receipt_id=r.id AND l.kind IN ('discarded','merged'))").bind(id).first<Data>();if(!r)return null;
 const reading=await latestReading(db,id);if(!reading||!['read','corrected'].includes(reading.kind))return null;
 const attached=await db.prepare("SELECT i.id AS item,c.id AS claim,c.number,c.title,c.version,c.status,ch.id AS charge,ch.amount_minor,ch.currency,ch.descriptor,ch.transaction_on,ch.posted_on,card.last4 FROM c_receipts a JOIN c_items i ON i.receipt_id=a.id JOIN c_claims c ON c.id=i.claim_id JOIN c_card_charges ch ON ch.id=i.card_charge_id JOIN c_cards card ON card.id=ch.card_id WHERE a.capture_receipt_id=? AND c.employee_email=? AND c.status IN ('draft','returned')").bind(id,r.owner_email).first<Data>();if(!attached)return null;
 const fields=JSON.parse(reading.fields_json) as Fields,card:Data={total:decimal(attached.amount_minor),currency:attached.currency,merchant:attached.descriptor,date:attached.transaction_on??attached.posted_on,last4:attached.last4};
 const equal=(key:string,value:unknown,expected:string)=>key==='merchant'?String(value??'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'')===expected.toLowerCase().replace(/[^\p{L}\p{N}]/gu,''):value===expected;
 const siblings=await mailReadings(db,id),mail=mailSources(siblings),confirmed=JSON.parse(reading.usage_json).mailComparison??{};
 const conflicts=FIELD_NAMES.filter(key=>key!=='lineItems').flatMap(key=>{
  const f=fields[key];
  const evidence=mail.filter(source=>source.values[key]!==undefined).map(source=>({kind:source.kind,value:source.values[key]!,receiptId:source.receiptId!,readingSequence:source.readingSequence!,mediaType:source.mediaType!,regions:source.regions?.[key]??[]}));
  if(f.source==='person'&&!evidence.some(source=>!(confirmed[key]??[]).some((prior:Data)=>prior.receiptId===source.receiptId&&prior.readingSequence===source.readingSequence)&&!equal(key,f.value,source.value)))return [];
  const values=[...(typeof f.value==='string'?[f.value]:[]),...(card[key]!==undefined?[card[key]]:[]),...evidence.map(source=>source.value)];
  if(values.length<2||values.every(value=>equal(key,value,values[0])))return [];
  return [{field:key,read:f.value,card:card[key]??null,regions:f.regions,sources:evidence}];
 });
 if(!conflicts.length)return null;
 const questionId=await sha256Hex(JSON.stringify([id,reading.sequence,attached.charge,siblings.map(r=>[r.id,r.reading_sequence,r.lifecycle_sequence,r.state_sequence]),conflicts]));
 return {id:questionId,receiptId:id,employee:r.owner_email,readingSequence:reading.sequence,claimId:attached.claim,itemId:attached.item,claimNumber:attached.number,title:attached.title,version:attached.version,chargeId:attached.charge,mediaType:r.media_type,receiptValues:{total:fields.total.value,currency:fields.currency.value},conflicts,prompt:'Which receipt values are correct? Confirm them against the original, including any handwritten tip. The posted card amount stays unchanged.',notice:'Your confirmed receipt total, currency and difference will be saved on this draft expense and shared with its reviewers when submitted. Original readings and source regions stay in your private receipt history.'};
}
export async function receiptQuestions(db:D1Database,employee?:string){
 const rows=(await db.prepare(`SELECT DISTINCT r.id FROM c_capture_receipts r JOIN c_receipts a ON a.capture_receipt_id=r.id JOIN c_items i ON i.receipt_id=a.id JOIN c_claims c ON c.id=i.claim_id WHERE i.card_charge_id IS NOT NULL AND c.status IN ('draft','returned')${employee?' AND r.owner_email=?':''}`).bind(...(employee?[employee]:[])).all<{id:string}>()).results;
 const questions=[];for(const r of rows){const q=await receiptQuestion(db,r.id);if(q)questions.push(q);}return questions;
}
export async function answerReceiptQuestion(db:D1Database,a:Actor,id:string,b:Data){
 requireThat(Object.keys(b).every(k=>['questionId','expectedSequence','expectedReadingSequence','version','values','consent'].includes(k))&&b.consent===true,'Explicit consent to save confirmed receipt values on the expense is required');
 const r=await ownOriginal(db,a,id),reading=await latestReading(db,id);expected(b,r,reading);
 const q=await receiptQuestion(db,id);requireThat(q&&q.id===b.questionId&&q.employee===a.email&&q.version===b.version,'The question or editable expense changed; reload',409);
 requireThat(b.values&&typeof b.values==='object'&&!Array.isArray(b.values)&&q.conflicts.every(c=>typeof b.values[c.field]==='string')&&typeof b.values.total==='string'&&typeof b.values.currency==='string','Confirm every conflicting receipt value');
 const allowed=new Set(['total','currency',...q.conflicts.map(c=>c.field),...(q.conflicts.some(c=>c.field==='total')?['tip','subtotal','salesTax']:[])]);
 requireThat(Object.keys(b.values).every(key=>allowed.has(key)),'Confirm only the fields named in this receipt question');
 const previous=JSON.parse(reading!.fields_json) as Fields,pages=JSON.parse(reading!.usage_json).pages??1;
 const fields=correctedFields(previous,b.values,pages,await crossSources(db,id));
 const total=fields.total.value,currency=fields.currency.value;
 const comparison={confirmationSequence:reading!.sequence+1,receiptTotal:total,receiptCurrency:currency,postedTotal:q.conflicts.find(c=>c.field==='total')?.card??null};
 await commit(db,all(authority(a,'employee'),originalStill(a,r,b.expectedSequence,reading!.sequence),claimState(q.claimId,q.version,['draft','returned']),{sql:'EXISTS(SELECT 1 FROM c_items i JOIN c_receipts r ON r.id=i.receipt_id WHERE i.id=? AND i.claim_id=? AND i.card_charge_id=? AND r.capture_receipt_id=?)',params:[q.itemId,q.claimId,q.chargeId,id]}),[
  readingLine(db,a,r,reading!.sequence+1,'corrected',reading!.attempt_id,reading!.settings_version,reading!.model,fields,{pages,mailComparison:mailComparison(r.mailReadings,JSON.parse(reading!.usage_json).mailComparison,Object.keys(b.values))}),
  captureState(db,a,id,Object.values(fields).some(f=>f.review)?'needs-attention':'read','Receipt question answered by the person; posted statement facts kept'),
  db.prepare('UPDATE c_items SET receipt_resolution=? WHERE id=? AND claim_id=?').bind(JSON.stringify(comparison),q.itemId,q.claimId),claimTotal(db,q.claimId),event(db,a,'receipt-answer-confirmed',{claim:q.claimId},{item:q.itemId}),
 ]);
 return {answered:true,question:null,confirmed:comparison};
}
