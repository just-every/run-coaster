import { money, type D } from './api';

/** The same submitted evidence the person decides; never recomputed from later edits. */
export function PolicyReview({ revision }: { revision?: D }) {
  const review = revision?.snapshot.policyReview;
  if (!review) return null;
  const items = revision!.snapshot.items;
  return <section className="panel-block" aria-label="Policy review">
    <h3>Policy review · revision {revision!.revision}</h3>
    <p className="muted">Deterministic policy advice, recorded at submission under policy v{review.policyVersion}. This advice grants no approval.</p>
    <ul className="ruled-list">{review.recommendations.map((r: D) => <li key={r.item}>
      <strong>{items.find((i: D) => i.id === r.item)?.merchant} · {money(r.evidence.amountMinor, revision!.snapshot.currency)}</strong>
      <p>{r.recommendation === 'review' ? 'Needs your review' : 'No configured-policy exception'}</p>
      <ul>{r.reasons.map((reason: D, i: number) => <li key={i}>{reason.message}{reason.policy ? ` · policy v${reason.policy}` : ''}</li>)}</ul>
      <p className="muted">Receipt: {r.evidence.receipt ? 'attached; contents not read' : 'not attached'}. Card matching and coding confidence have not been checked.</p>
      <details className="disclosure"><summary>Review evidence</summary><p>Date: {r.evidence.date} · Expense: {r.item}</p>
        {r.evidence.receipt && <p className="muted">Receipt SHA-256: <span style={{overflowWrap:'anywhere'}}>{r.evidence.receipt.sha256}</span></p>}
        <ul>{r.evidence.allocations.map((a: D, i: number) => <li key={i}>{items.find((item: D) => item.id === r.item)?.allocations.find((part: D) => part.category_id === a.category)?.category_name ?? a.category}: {money(a.amountMinor, revision!.snapshot.currency)}</li>)}</ul>
        {r.evidence.requestId && <p>Linked spend request: {r.evidence.requestId}</p>}
      </details>
    </li>)}</ul>
  </section>;
}
