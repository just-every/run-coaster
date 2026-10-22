import { all, authority, commit } from './session';
import { claimState, loadClaim } from './claims';
import { event } from './events';
import { requireThat, type Actor, type Data } from './types';

/** Agreement is explicit per-expense reviewer feedback, never inferred from payment or an automatic approval. */
export async function reviewFeedback(db:D1Database,a:Actor,id:string,b:Data){
 const c=await loadClaim(db,id);
 requireThat(a.kind==='person'&&(a.roles.manager||a.roles.finance)&&!a.publicCredential&&c.employee_email!==a.email&&c.employee_email!==a.delegate?.email,'Only a native assigned reviewer records agreement',403);
 requireThat(c.status==='submitted'&&(c.assigned_emails?.length?c.assigned_emails.includes(a.email):c.approver_email===a.email),'This claim is not waiting for your review',403);
 requireThat(b.version===c.version&&b.revision===c.revision,'Review the current submitted revision',409);
 const r=await db.prepare('SELECT snapshot FROM c_revisions WHERE claim_id=? AND revision=?').bind(id,c.revision).first<{snapshot:string}>();
 requireThat(typeof b.item==='string'&&JSON.parse(r!.snapshot).policyReview?.recommendations.some((r:Data)=>r.item===b.item)&&typeof b.agree==='boolean','Choose a recommendation and agree or disagree');
 const by=a.delegate?.email??a.email;
 const absent={sql:"NOT EXISTS(SELECT 1 FROM c_events WHERE claim_id=? AND action='policy-review-feedback' AND actor_email=? AND json_extract(detail,'$.revision')=? AND json_extract(detail,'$.item')=?)",params:[id,by,c.revision,b.item]};
 requireThat(!await db.prepare(`SELECT 1 WHERE NOT (${absent.sql})`).bind(...absent.params).first(), 'Your feedback is already recorded',409);
 const routed={sql:"EXISTS(SELECT 1 FROM c_claims c WHERE c.id=? AND ((NOT EXISTS(SELECT 1 FROM c_workflow_tasks t WHERE t.kind='claim' AND t.record_id=c.id AND t.revision=c.revision) AND c.approver_email=?) OR EXISTS(SELECT 1 FROM c_workflow_tasks t WHERE t.kind='claim' AND t.record_id=c.id AND t.revision=c.revision AND t.email=? AND t.status='waiting')))",params:[id,a.email,a.email]};
 await commit(db,all(authority(a),claimState(id,c.version,['submitted']),routed,absent),[event(db,a,'policy-review-feedback',{claim:id},{revision:c.revision,item:b.item,agree:b.agree,onBehalfOf:a.delegate?a.email:null})]);
 return {recorded:true};
}
export async function reviewerAgreement(db:D1Database,a:Actor){
 const rows=(await db.prepare("SELECT json_extract(detail,'$.agree') agree FROM c_events WHERE action='policy-review-feedback' AND actor_email=?").bind(a.delegate?.email??a.email).all<{agree:number}>()).results;
 const agreed=rows.filter(r=>r.agree===1).length;
 return {method:'explicit-reviewer-feedback',agreed,total:rows.length,percent:rows.length?100*agreed/rows.length:null};
}
