import { useState } from 'react';
import { call, money, type D } from './api';

/** The same submitted evidence the person decides; never recomputed from later edits. */
export function PolicyReview({ revision, claim, agreement, feedback=[],mayRecord=false,onDone }: { revision?: D;claim?:D;agreement?:D;feedback?:D[];mayRecord?:boolean;onDone?:()=>Promise<void> }) {
  const [error,setError]=useState('');
  const review = revision?.snapshot.policyReview;
  if (!review) return null;
  const items = revision!.snapshot.items;
  return <section className="panel-block" aria-label="Policy review">
    <h3>Policy review · revision {revision!.revision}</h3>
    <p className="muted">Deterministic policy advice, recorded at submission under policy v{review.policyVersion}. {revision!.snapshot.expenseApprovals?.length?'Explicit envelope or rule approvals are recorded below. Other recommendations grant no approval.':'This advice grants no approval.'}</p>
    {agreement&&<p>Your explicit agreement: {agreement.total ? `${agreement.agreed} of ${agreement.total} recommendations (${agreement.percent.toFixed(1)}%)` : 'No feedback recorded yet'}. Unanswered recommendations and automatic approvals do not count.</p>}
    {error&&<p role="alert" className="form-error">{error}</p>}
    <ul className="ruled-list">{review.recommendations.map((r: D) => <li key={r.item}>
      <strong>{items.find((i: D) => i.id === r.item)?.merchant} · {money(r.evidence.amountMinor, revision!.snapshot.currency)}</strong>
      {revision!.snapshot.expenseApprovals?.filter((a:D)=>a.item===r.item).map((a:D)=><p key={a.item}><strong>Approved by {a.actor}</strong>{a.onBehalfOf?` on behalf of ${a.onBehalfOf}`:''} at submission · {a.reason}{a.sampled?' · audit sampled':''}</p>)}
      <p>{r.recommendation === 'review' ? 'Needs your review' : 'No configured-policy exception'}</p>
      <ul>{r.reasons.map((reason: D, i: number) => <li key={i}>{reason.message}{reason.policy ? ` · policy v${reason.policy}` : ''}</li>)}</ul>
      <p className="muted">Receipt: {r.evidence.receiptAssessment?.method==='retained-reading-agrees'?'retained reading agrees':r.evidence.receiptAssessment?.method==='person-confirmed-card-match'?'person-confirmed card match':r.evidence.receipt?'attached; contents not read':'not attached'}. {r.evidence.codingAssessment?.reviewRequired?'Coding needs review.':r.evidence.codingAssessment?'Coding matches the finance merchant rule.':'Card matching and coding confidence have not been checked.'}</p>
      {r.evidence.cardAssessment&&<p className="muted">Card transaction: <span style={{overflowWrap:'anywhere'}}>{r.evidence.cardAssessment.transactionKey}</span> · {r.evidence.cardAssessment.matched?'matched receipt':'no confirmed match'}</p>}
      {mayRecord&&claim&&onDone&&<div className="actions">{feedback.some((f:D)=>f.detail.revision===revision!.revision&&f.detail.item===r.item)?<span>Agreement feedback recorded</span>:[true,false].map(agree=><button key={String(agree)} className="button small" aria-label={`${agree?'Agree':'Disagree'} with ${items.find((i:D)=>i.id===r.item)?.merchant} recommendation`} onClick={async()=>{setError('');try{await call(`claims/${claim.id}/policy-review-feedback`,{version:claim.version,revision:revision!.revision,item:r.item,agree});await onDone();}catch(e){setError((e as Error).message);}}}>{agree?'Agree':'Disagree'}</button>)}</div>}
      <details className="disclosure"><summary>Review evidence</summary><p>Date: {r.evidence.date} · Expense: {r.item}</p>
        {r.evidence.receipt && <p className="muted">Receipt SHA-256: <span style={{overflowWrap:'anywhere'}}>{r.evidence.receipt.sha256}</span></p>}
        <ul>{r.evidence.allocations.map((a: D, i: number) => <li key={i}>{items.find((item: D) => item.id === r.item)?.allocations.find((part: D) => part.category_id === a.category)?.category_name ?? a.category}: {money(a.amountMinor, revision!.snapshot.currency)}</li>)}</ul>
        {r.evidence.codingAssessment?.rule&&<p>Finance coding rule: {r.evidence.codingAssessment.rule} · version {r.evidence.codingAssessment.version}</p>}
        {r.evidence.receiptAssessment?.reviewRequired&&<p>Receipt evidence needs review before automatic approval.</p>}
        {r.evidence.requestId && <p>Linked spend request: {r.evidence.requestId}</p>}
      </details>
    </li>)}</ul>
  </section>;
}
