import { call, type D } from './api';
import { Field, Form } from './parts';

const names: Record<string, string> = { 'editing-software': 'Software', 'image-date-mismatch': 'Image date', 'same-receipt': 'Shared receipt', 'near-duplicate-image': 'Similar image', 'image-content-change': 'Image change', 'compression-grid': 'Compression artifact', 'split-charge': 'Split purchase', 'round-amount-pattern': 'Round amount', 'weekend-pattern': 'Weekend spend', 'card-disagreement': 'Card difference' };

/** The reviewer sees observations and comparisons, never an authenticity verdict. */
export function ReceiptSignals({ revision, events, mayReview, claimId, done }: { revision?: D; events: D[]; mayReview: boolean; claimId: string; done: () => Promise<void> }) {
  const results = revision?.snapshot.receiptSignals;
  if (!results?.length) return null;
  return <section className="panel-block" aria-label="Receipt and spend signals">
    <h3>Receipt and spend signals · revision {revision!.revision}</h3>
    <p className="muted">A possible signal needs a person’s review. These signals do not reject a claim, change its approval route or delay payment. Each observation names the measured comparison; it is not a finding of wrongdoing. A missing signal does not verify authenticity.</p>
    <ul className="ruled-list">{results.map((r: D) => <li key={r.item}>
      <strong>{revision!.snapshot.items.find((i: D) => i.id === r.item)?.merchant}</strong>
      <p>{r.signals.length ? 'possible, needs review' : r.status === 'no metadata to check' ? 'no metadata to check' : r.status === 'unsupported' ? 'Metadata is not checked for this receipt type' : 'No signal raised'}</p>
      {r.status === 'no metadata to check' && r.signals.length > 0 && <p className="muted">no metadata to check</p>}
      {r.signals.length > 0 && <ul>{r.signals.map((signal: D) => {
        const name = names[signal.code] ?? 'Receipt';
        const review = events.find(e => e.action === 'receipt-signal-reviewed' && e.detail.revision === revision!.revision && e.detail.item === r.item && e.detail.code === signal.code);
        return <li key={signal.code}>{signal.reason}{signal.evidence && <details className="disclosure"><summary>Comparison measurements</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(signal.evidence, null, 2)}</pre></details>}{review ? <p>Reviewed by {review.actor_email}: {review.detail.note}</p> : mayReview ? <Form label={signal.code === 'image-date-mismatch' ? 'Record date review' : `Record ${name.toLowerCase()} review`} onSubmit={async values => { await call(`claims/${claimId}/receipt-signals/review`, { revision: revision!.revision, item: r.item, code: signal.code, note: values.note }); await done(); }}><Field label={`${name} review note`} name="note" /></Form> : null}</li>;
      })}</ul>}
      <details className="disclosure"><summary>Signal evidence</summary>
        <p>Metadata: {r.status}. Image inspection: {r.image?.status ?? 'not checked'}{r.image?.reason ? ` · ${r.image.reason}` : ''}</p>
        {Object.entries(r.fields).map(([name,value]) => <p key={name}>{name}: {String(value)}</p>)}
        <p className="muted">Receipt SHA-256: <span style={{overflowWrap:'anywhere'}}>{r.sha256 ?? 'No receipt attached'}</span></p>
      </details>
    </li>)}</ul>
  </section>;
}
