import { useState } from 'react';
import { apiHref, call, type D } from './api';
import { Details, Field, Form, Section } from './parts';
import { ReadingFields } from './receipt-reading-fields';
import { QuickExpense } from './quick-expense';
import { MATCH_NOTICE } from '../coaster/receipts/match-notice';

const names: Record<string, string> = { merchant: 'Merchant', date: 'Purchase date', total: 'Total', subtotal: 'Subtotal', salesTax: 'Sales tax', tip: 'Tip', currency: 'Currency', last4: 'Card last four', lineItems: 'Line items' };

export function ReceiptReadingSettings() {
  const [data, setData] = useState<D>(), [error, setError] = useState('');
  async function load() { try { setData(await call('settings/receipt-reading')); setError(''); } catch (e) { setError((e as Error).message); } }
  return <Section title="Receipt reading">
    <p>Reading sends the original receipt to the configured AI provider. It stays off until an owner or admin enables it, and each employee chooses whether to read each original. Reading does not submit expenses or authorize payment.</p>
    {!data && <button className="button" onClick={load}>Manage receipt reading</button>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {data && <Form key={data.version} label="Save receipt reading" onSubmit={async values => { await call('settings/receipt-reading', { ...values, version: data.version, threshold: Number(values.threshold) }); await load(); }}>
      <Field label="Enable receipt reading" name="enabled" type="checkbox" defaultValue={data.enabled} />
      <Field label="Vision model" name="model" defaultValue={data.model} hint="The exact model configured with your AI provider" />
      <Field label="Minimum confidence" name="threshold" type="number" min="0.9" max="1" step="0.01" defaultValue={data.threshold} />
      <Field label="I authorize sending explicitly selected receipts to the configured AI provider" name="consent" type="checkbox" />
    </Form>}
  </Section>;
}

/** Only an explicit employee action sends bytes; reviewed values remain separate from original evidence. */
export function ReceiptReading({ receipt, state, reload }: { receipt: D; state: D; reload: () => Promise<void> }) {
  const [data, setData] = useState<D>(), [error, setError] = useState(''), [prepare, setPrepare] = useState(false), [coding, setCoding] = useState<D>();
  async function load() { try { setData(await call(`receipt-inbox/${receipt.id}/reading`)); setError(''); } catch (e) { setError((e as Error).message); } }
  const sequence = { expectedSequence: receipt.lifecycleSequence, expectedReadingSequence: data?.sequence ?? 0 };
  const pref = data?.prefill ?? {};
  return <details className="disclosure" onToggle={e => { if (e.currentTarget.open && !data) load(); }}><summary>Read {receipt.name}</summary><div className="disclosure-body">
    <p>The original stays unchanged. Check each value against <a href={apiHref(`receipt-inbox/${receipt.id}?inline=1`)} target="_blank" rel="noreferrer">the original receipt</a>. Values marked for review cannot fill an expense or card match.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {data && <>
      <p>Reading: {data.state}. {data.attentionReason} {data.retryable && data.sequence > 0 && 'An explicit retry makes one new provider request.'}</p>
      <Form label={data.sequence ? 'Read receipt again' : 'Read receipt'} onSubmit={async values => { setData(await call(`receipt-inbox/${receipt.id}/reading`, { ...sequence, consent: values.consent })); await reload(); }}>
        <Field label="I authorize sending this original to the configured AI provider for receipt reading and coding suggestions" name="consent" type="checkbox" />
      </Form>
      {data.fields && <ReadingFields fields={data.fields} receipt={receipt} />}
      {data.fields && <Form label="Suggest coding from this reading" onSubmit={async values => { const current = await call(`coding/automatic/suggestions?receipt=${encodeURIComponent(receipt.id)}`); setCoding(await call(`receipt-inbox/${receipt.id}/reading/coding`, { ...sequence, contextVersion: current.contextVersion, consent: values.consent })); await reload(); }}><Field label="I authorize using the reviewed merchant and line items with the configured AI provider for coding suggestions" name="consent" type="checkbox" /></Form>}
      {coding && <p role="status">{coding.status}: {coding.reason}. {coding.codingSuggestions?.length ? 'Open receipt coding below to accept or correct the suggestion.' : ''}</p>}
      {data.fields && !receipt.attachment && <><button type="button" className="button" onClick={() => setPrepare(!prepare)}>{prepare ? 'Close expense preparation' : 'Prepare expense from reviewed reading'}</button>{prepare && <><p>Only confident or confirmed values fill this form. Saving creates a draft expense; attach the private original through its normal attachment control before submitting.</p><QuickExpense key={data.sequence} state={state} reload={reload} initial={pref} title="Expense from receipt reading" /></>}</>}
      {data.sequence > 0 && <Details label="Correct receipt values"><Form key={data.sequence} label="Save receipt corrections" onSubmit={async values => { setData(await call(`receipt-inbox/${receipt.id}/reading/corrections`, { ...sequence, values: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '')) })); await reload(); }}>
        {Object.entries(names).filter(([key]) => key !== 'lineItems').map(([key, label]) => <Field key={key} label={`Correct ${label.toLowerCase()}`} name={key} required={false} type={key === 'date' ? 'date' : 'text'} defaultValue={data.fields?.[key]?.value ?? ''} />)}
      </Form></Details>}
      {!receipt.attachment && !receipt.cashDraft && pref.merchant && pref.date && pref.total && pref.currency && <Form label="Use reviewed reading for card matching" onSubmit={async values => { await call(`receipt-inbox/${receipt.id}/card-match`, { expectedSequence: receipt.lifecycleSequence, enabled: true, merchant: pref.merchant, date: pref.date, total: pref.total, currency: pref.currency, last4: pref.last4 ?? '', notice: values.noticeAccepted ? MATCH_NOTICE : undefined }); await reload(); }}><p>{MATCH_NOTICE}</p><Field type="checkbox" name="noticeAccepted" label="I understand when this receipt will be shared" /></Form>}
      {!state.actor.delegate && <Details label="My standing matching choice"><p>{MATCH_NOTICE}</p><Form key={data.matchDefault.version} label="Save my reading matching choice" onSubmit={async values => { await call('settings/receipt-reading/matching', { version: data.matchDefault.version, enabled: values.enabled, consent: values.consent, notice: values.consent ? MATCH_NOTICE : undefined }); await load(); }}><Field label="Choose matching for my future read originals when the required fields are confident" name="enabled" type="checkbox" defaultValue={data.matchDefault.enabled} /><Field label="I understand when these receipts will be shared" name="consent" type="checkbox" /></Form><p>This never opts in an original you have withdrawn, discarded or merged, or one reserved for a cash draft. Turning it off leaves choices already made on individual originals; withdraw each of those separately.</p></Details>}
      {data.history?.length > 0 && <Details label="Reading history"><ol>{data.history.map((row: D) => <li key={row.sequence}>{row.sequence} · {row.kind ?? row.state} · {row.at}</li>)}</ol></Details>}
    </>}
  </div></details>;
}
