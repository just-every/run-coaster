import { useEffect, useState } from 'react';
import { call, type D } from './api';
import { CodingReasons, codingWords } from './automatic-coding';
import { Field, Form } from './parts';
import { CodingFields } from './coding';

/** Receipt coding stays in its employee's private inbox until attached and submitted normally. */
export function ReceiptCoding({ receipt, state, reload }: { receipt: D; state: D; reload: () => Promise<unknown> }) {
  const [data, setData] = useState<D>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function load() {
    try { setData(await call(`coding/automatic/suggestions?receipt=${encodeURIComponent(receipt.id)}`)); setError(''); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (data) load(); }, [receipt]);
  const current = data?.context;
  async function decide(suggestion: D, action: string, values?: D) {
    setBusy(true); setError('');
    try { await call(`coding/automatic/suggestions/${suggestion.id}/decision`, { contextVersion: data?.contextVersion ?? current?.version ?? 0, action, ...(values ? { values } : {}) }); await load(); await reload(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <details className="disclosure" onToggle={e => { if (e.currentTarget.open && !data) load(); }}>
    <summary>Coding for {receipt.name}</summary><div className="disclosure-body">
      <p className="muted">Enter the merchant yourself, or use the explicit reading controls above to prepare coding from reviewed receipt fields. Suggestions show their source below. This coding stays in your private inbox.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {data && <>
        <Form key={`merchant:${current?.version ?? 0}`} label="Suggest receipt coding" onSubmit={async v => { await call(`coding/automatic/receipts/${receipt.id}`, { version: data.contextVersion ?? current?.version ?? 0, merchant: v.merchant }); await load(); }}>
          <Field label="Merchant on this receipt" name="merchant" defaultValue={current?.merchant} />
        </Form>
        {data.suggestions.map((s: D) => <div className="sub-form" key={s.id}>
          <h3>{s.status === 'accept' ? 'Accepted coding' : s.status === 'override' ? 'Corrected coding' : 'Suggested coding'}</h3>
          <CodingReasons evidence={s.evidence ?? []} state={state} />
          <p>Suggested: {codingWords(s.fields, state)}</p>
          {s.status === 'override' && <p>Saved correction: {codingWords(s.feedback.values, state)}</p>}
          {s.status === 'pending' && <>
            <button type="button" className="button" disabled={busy} onClick={() => decide(s, 'accept')}>Accept receipt coding</button>
            <ReceiptCodingCorrection state={state} suggestion={s} onSave={values => decide(s, 'override', values)} />
          </>}
        </div>)}
        {current && !data.suggestions.length && <p>No active rule or repeated coding history suggests a value for this merchant. Enter coding when you add the expense.</p>}
      </>}
    </div>
  </details>;
}

function ReceiptCodingCorrection({ state, suggestion, onSave }: { state: D; suggestion: D; onSave: (v: D) => Promise<void> }) {
  const [dimensions, setDimensions] = useState<Record<string,string>>(suggestion.fields.dimensions ?? {});
  return <details className="disclosure"><summary>Correct receipt coding</summary><div className="disclosure-body">
    <Form label="Save corrected receipt coding" onSubmit={v => onSave({ category: v.category, dimensions, project: v.project, customer: v.customer, memo: v.memo })}>
      <Field label="Receipt category" name="category" required={false} defaultValue={suggestion.fields.category} options={state.categories.filter((c: D) => c.active).map((c: D) => ({ value: c.id, label: c.name }))} />
      <CodingFields catalog={state.coding} categories={[]} value={dimensions} onChange={setDimensions} enforceRequired={false} />
      <Field label="Receipt project" name="project" required={false} defaultValue={suggestion.fields.project} />
      <Field label="Receipt customer" name="customer" required={false} defaultValue={suggestion.fields.customer} />
      <Field label="Receipt memo" name="memo" required={false} defaultValue={suggestion.fields.memo} />
    </Form>
  </div></details>;
}
