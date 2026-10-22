import { policyReview } from './policy-review';
import { all, type Sql } from './session';
import { currentRules } from './coding/automatic/rules';
import { epoch, epochState, flatten, itemFields, merchantKey } from './coding/automatic/model';
import { codingContext } from './coding/automatic/storage';
import { unreviewedCoding } from './expense-approvals';
import type { ClaimItem, PolicyException } from './exceptions';
import type { policyConfiguration } from './policy-configuration';
import type { Data } from './types';
import { amount } from './types';

type Active=Awaited<ReturnType<typeof policyConfiguration>>;
const merchant=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
/** Read private evidence internally. The submitted assessment contains results
 * and the already-shared receipt fingerprint, never private readings/lines. */
export async function evidencedPolicyReview(db:D1Database,items:ClaimItem[],exceptions:PolicyException[],active:Active,employee:string,currency:string){
 const review=policyReview(items,exceptions,active),version=await epoch(db),rules=await currentRules(db),guards:Sql[]=[epochState(version)];
 for(const recommendation of review.recommendations){
  const item=items.find(i=>i.id===recommendation.item)!,evidence=recommendation.evidence as Data;
  const receipt= item.receipt_id ? await db.prepare('SELECT capture_receipt_id FROM c_receipts WHERE id=?').bind(item.receipt_id).first<{capture_receipt_id:string|null}>():null;
  let receiptChecked=false,receiptNeedsReview=false;
  if(receipt?.capture_receipt_id){
   const line=await db.prepare('SELECT sequence,kind,fields_json FROM c_receipt_readings WHERE receipt_id=? ORDER BY sequence DESC LIMIT 1').bind(receipt.capture_receipt_id).first<{sequence:number;kind:string;fields_json:string}>();
   guards.push({sql:'COALESCE((SELECT MAX(sequence) FROM c_receipt_readings WHERE receipt_id=?),0)=?',params:[receipt.capture_receipt_id,line?.sequence??0]});
   if(line&&['read','corrected'].includes(line.kind)){
    const fields=JSON.parse(line.fields_json),basis=item.card_match_basis?JSON.parse(item.card_match_basis):null;
    receiptNeedsReview=['merchant','date','total','currency'].some(k=>fields[k]?.review);
    const confident=['merchant','date','total','currency'].every(k=>fields[k]?.value!==null&&!fields[k]?.review);
    receiptChecked=confident&&merchant(fields.merchant.value)===merchant(item.merchant)&&fields.date.value===(basis?.enteredDate??item.spent_on)&&amount(fields.total.value)===(basis?.enteredTotalMinor??item.original_minor??item.amount_minor)&&fields.currency.value===(basis?.enteredCurrency??(item.original_currency||currency));
   }
  }
  // A person-confirmed card match is separately identified; it is not called reading.
  const matched=!!item.card_charge_id&&!!item.receipt_id&&!!item.card_match_basis;
  const actual=flatten(itemFields(item)),context=await codingContext(db,'item',item.id);
  const finance=rules.find(r=>r.scope==='finance'&&r.kind==='merchant'&&r.active&&r.merchant_key===merchantKey(item.merchant));
  const financeFields=finance&&flatten(finance.fields);
  const financeAgrees=!!financeFields&&Object.keys(actual).filter(k=>k!=='memo').every(k=>financeFields[k]===actual[k])&&!!financeFields.category;
  const humanAgrees=!!context&&Object.keys(actual).filter(k=>k!=='memo').every(k=>context.humanFields.includes(k));
  const codingChecked=!unreviewedCoding(item)&&financeAgrees;
  evidence.checksUnavailable=evidence.checksUnavailable.filter((name:string)=>!(name==='receipt-content'&&receiptChecked)&&!(name==='card-match'&&matched)&&!(name==='coding-confidence'&&codingChecked));
  evidence.receiptAssessment=item.receipt_id?{method:receiptChecked?'retained-reading-agrees':matched?'person-confirmed-card-match':'contents-unchecked',agrees:(receiptChecked||matched)&&!receiptNeedsReview,reviewRequired:receiptNeedsReview}:null;
  evidence.cardAssessment=item.card_charge_id?{transactionKey:item.card_transaction_key,amountMinor:item.amount_minor,last4:item.card_last4,matched}:null;
  evidence.codingAssessment={reviewRequired:!codingChecked,method:financeAgrees?'finance-merchant-rule':humanAgrees?'person-chosen-coding':'unreviewed-suggestion',...(financeAgrees?{rule:finance!.id,version:finance!.version}:{})};
  evidence.tripAssessment={requestId:item.request_id??null,method:item.request_id?'linked-request-and-trip-policy':'no-linked-trip'};
  evidence.pastSpendAssessment={method:'submission-policy-evaluator',policyVersion:active.version,rules:active.rules.filter(r=>['daily-limit','trip-limit','monthly-limit'].includes(r.kind)).map(r=>r.kind)};
  evidence.agentEligible=!exceptions.some(e=>e.item===item.id)&&item.kind==='receipt'&&!!item.receipt_id&&(receiptChecked||matched)&&!receiptNeedsReview&&codingChecked;
 }
 return {review,guard:all(guards[0],...guards.slice(1))};
}
