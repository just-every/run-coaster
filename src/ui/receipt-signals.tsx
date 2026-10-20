import { call, type D } from './api';
import { Field, Form } from './parts';

/** The reviewer reads actual metadata, never an authenticity verdict. */
export function ReceiptSignals({ revision, events, mayReview, claimId, done }: { revision?: D; events: D[]; mayReview: boolean; claimId: string; done: () => Promise<void> }) {
  const results = revision?.snapshot.receiptSignals;
  if (!results?.length) return null;
  return <section className="panel-block" aria-label="Receipt metadata signals">
    <h3>Receipt metadata · revision {revision!.revision}</h3>
    <p className="muted">A possible signal needs a person’s review. These signals do not reject a claim, change its approval route or delay payment. Receipt contents, recompression and near-duplicate images have not been checked.</p>
    <ul className="ruled-list">{results.map((r: D) => <li key={r.item}>
      <strong>{revision!.snapshot.items.find((i: D) => i.id === r.item)?.merchant}</strong>
      <p>{r.status === 'no metadata to check' ? 'no metadata to check' : r.status === 'unsupported' ? 'Metadata is not checked for this receipt type' : r.signals.length ? 'possible, needs review' : 'No metadata signal raised'}</p>
      {r.signals.length > 0 && <ul>{r.signals.map((signal: D) => {
        const review = events.find(e => e.action === 'receipt-signal-reviewed' && e.detail.revision === revision!.revision && e.detail.item === r.item && e.detail.code === signal.code);
        return <li key={signal.code}>{signal.reason}{review ? <p>Reviewed by {review.actor_email}: {review.detail.note}</p> : mayReview ? <Form label={signal.code === 'editing-software' ? 'Record software review' : 'Record date review'} onSubmit={async values => { await call(`claims/${claimId}/receipt-signals/review`, { revision: revision!.revision, item: r.item, code: signal.code, note: values.note }); await done(); }}><Field label={signal.code === 'editing-software' ? 'Software review note' : 'Image date review note'} name="note" /></Form> : null}</li>;
      })}</ul>}
      <details className="disclosure"><summary>Metadata evidence</summary>
        {Object.entries(r.fields).map(([name,value]) => <p key={name}>{name}: {String(value)}</p>)}
        <p className="muted">Receipt SHA-256: <span style={{overflowWrap:'anywhere'}}>{r.sha256}</span></p>
      </details>
    </li>)}</ul>
  </section>;
}
