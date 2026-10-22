import { all, type Sql } from './session';
import { ruleEvent } from './events';
import { type ApprovalRule } from './auto-approval';
import { type Envelope, envelopeStill } from './approval-envelopes';
import { decimal, now, type Data } from './types';
import type { ClaimItem, PolicyException } from './exceptions';
import { flatten, itemFields } from './coding/automatic/model';

/** Pending generated coding is not a person's reviewed choice. A deterministic
 * finance rule is independently verifiable; learned/model suggestions require review. */
export function unreviewedCoding(item:Data){
 const actual=flatten(itemFields(item));
 return (item.codingSuggestions??[]).some((s:Data)=>s.status==='pending'&&s.appliedFields.some((field:string)=>actual[field]===flatten(s.fields)[field]&&s.evidence.some((e:Data)=>e.field===field&&e.source!=='merchant-rule')));
}
export type ExpenseApproval={item:string;source:'rule'|'agent';version:number;actor:string;onBehalfOf?:string;reason:string;at:string;sampled:boolean;ordinal:number;samplePercent:number|null};
const actions="action IN ('expense-approved-by-rule','policy-agent-expense-approved')";
export async function expenseApprovals(db:D1Database,items:ClaimItem[],exceptions:PolicyException[],review:Data,rule:ApprovalRule|null,envelope:Envelope|null,employee:string,currency:string){
 const n=(await db.prepare(`SELECT COUNT(*) n FROM c_events WHERE ${actions}`).first<{n:number}>())!.n;
 const percent=(await db.prepare('SELECT audit_sample_percent percent FROM c_business WHERE id=1').first<{percent:number|null}>())!.percent;
 const liveOwner=envelope?!!await db.prepare("SELECT 1 FROM oa_operators WHERE lower(email)=? AND role='owner' AND status='active'").bind(envelope.set_by).first():false;
 const approvals:ExpenseApproval[]=[],at=now();
 for(const item of items){
  if(exceptions.some(e=>e.item===item.id)||unreviewedCoding(item))continue;
  const advised=review.recommendations.find((r:Data)=>r.item===item.id),compliant=advised?.evidence.agentEligible===true;
  const source=rule?.enabled&&rule.limit_minor!==null&&item.card_charge_id&&item.receipt_id&&item.amount_minor<rule.limit_minor?'rule':liveOwner&&envelope?.enabled&&envelope.limit_minor!==null&&employee!==envelope.set_by&&item.amount_minor<envelope.limit_minor&&compliant?'agent':null;
  if(!source)continue;
  const version=source==='rule'?rule!.version:envelope!.version,limit=source==='rule'?rule!.limit_minor!:envelope!.limit_minor!;
  const ordinal=n+approvals.length+1;
  approvals.push({item:item.id,source,version,actor:source==='rule'?`rule v${version}`:`policy agent v${version}`,...(source==='agent'?{onBehalfOf:envelope!.set_by}:{}),reason:source==='rule'?`Matched company-card expense under ${currency} ${decimal(limit)} with its receipt and no policy exception`:`Compliant expense under ${currency} ${decimal(limit)}; policy v${review.policyVersion}, receipt evidence and reviewed coding verified`,at,sampled:!!percent&&Math.floor(ordinal*percent/100)>Math.floor((ordinal-1)*percent/100),ordinal,samplePercent:percent});
 }
 const guard=all(envelopeStill(envelope?.version??0),{sql:`(SELECT COUNT(*) FROM c_events WHERE ${actions})=? AND (SELECT audit_sample_percent FROM c_business WHERE id=1) IS ?`,params:[n,percent]},...(approvals.some(a=>a.source==='agent')?[{sql:"EXISTS(SELECT 1 FROM oa_operators WHERE lower(email)=? AND role='owner' AND status='active')",params:[envelope!.set_by]}]:[]));
 return {approvals,guard,writes:(claim:string,revision:number)=>approvals.map(a=>ruleEvent(db,a.actor,a.source==='rule'?'expense-approved-by-rule':'policy-agent-expense-approved',{claim},{revision,item:a.item,version:a.version,reason:a.reason,onBehalfOf:a.onBehalfOf??null,sampled:a.sampled,ordinal:a.ordinal,samplePercent:a.samplePercent}))};
}
