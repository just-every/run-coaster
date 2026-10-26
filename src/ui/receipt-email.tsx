import { useEffect, useState } from 'react';
import { call, moment } from './api';
import { Field, Form, Section } from './parts';

type ReceiptAlias = { email: string; confirmed: boolean };
type HeldMessage = { id: string; from: string; subject: string; receivedAt: string; reason: string; sourceUrl: string };
type ReceiptEmailData = { address: string | null; aliases: ReceiptAlias[]; held: HeldMessage[]; owner: boolean };
export type ReceiptEmailSource = Pick<HeldMessage, 'from' | 'subject' | 'receivedAt' | 'sourceUrl'>;

function useReceiptEmail() {
  const [data, setData] = useState<ReceiptEmailData>(), [error, setError] = useState('');
  async function load() {
    const value: ReceiptEmailData = await call('settings/receipt-email');
    setData(value); setError('');
  }
  async function retry() { try { await load(); } catch (e) { setError((e as Error).message); } }
  useEffect(() => {
    let current = true;
    call('settings/receipt-email').then((value: ReceiptEmailData) => { if (current) setData(value); }).catch(e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, []);
  return { data, error, load, retry };
}

export function ReceiptEmailAddress() {
  const { data, error, retry } = useReceiptEmail();
  return <div style={{ overflowWrap: 'anywhere' }}>
    {data ? <p>{data.address ? <>Forward receipts to <strong>{data.address}</strong> from your member address or a confirmed alias.</> : 'No receipt forwarding address is configured.'} Manage receipt email in Settings.</p> : !error && <p role="status">Loading forwarding address…</p>}
    {error && <p role="alert" className="form-error">{error} <button type="button" className="button small" onClick={retry}>Reload forwarding address</button></p>}
  </div>;
}

export function ReceiptEmailProvenance({ source }: { source: ReceiptEmailSource }) {
  return <div style={{ overflowWrap: 'anywhere' }}>
    <p className="muted">Email from {source.from} · {moment(source.receivedAt)}{source.subject ? <> · {source.subject}</> : null}</p>
    <p><a href={source.sourceUrl} download>Download source message</a></p>
  </div>;
}

function AliasProof({ alias, changed }: { alias: ReceiptAlias; changed: (notice: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <li>
    <p><strong>{alias.email}</strong> · {alias.confirmed ? 'Confirmed' : 'Awaiting confirmation'}</p>
    {!alias.confirmed && <Form label="Confirm alias" onSubmit={async values => {
      await call('settings/receipt-email/aliases/confirm', { email: alias.email, code: values.code });
      await changed('Alias confirmed. Future receipts from this address can enter your inbox.');
    }}>
      <Field label={`Confirmation code for ${alias.email}`} name="code" autoComplete="one-time-code" />
    </Form>}
    <button type="button" className="button small" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try {
        await call('settings/receipt-email/aliases/remove', { email: alias.email });
        await changed('Alias removed. Future receipts from this address will no longer be assigned through this alias.');
      } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}>{busy ? 'Removing…' : 'Remove alias'}</button>
    {error && <p className="form-error" role="alert">{error}</p>}
  </li>;
}

export function ReceiptEmailSettings() {
  const { data, error, load, retry } = useReceiptEmail(), [notice, setNotice] = useState('');
  const changed = async (message: string) => { setNotice(message); await load(); };
  return <Section title="Receipt email">
    <div style={{ fontSize: 14, overflowWrap: 'anywhere' }}>
      <p className="muted">Receipts from your member address or a confirmed alias enter your private inbox. Unknown senders are held for the owner.</p>
      <p role="status" aria-live="polite">{notice}</p>
      {error && <p className="form-error" role="alert">{error} <button type="button" className="button small" onClick={retry}>Reload receipt email</button></p>}
      {!data && !error && <p role="status">Loading receipt email…</p>}
      {data && <>
        <p>{data.address ? <>Forward receipts to <strong>{data.address}</strong>.</> : 'No receipt forwarding address is configured.'}</p>
        {data.owner && <>
          <p>Configure Cloudflare email routing separately to deliver messages to this installation. Saving the address does not check that routing.</p>
          <Form key={data.address ?? ''} label="Save receipt email address" onSubmit={async values => {
            if (values.consent !== true) throw new Error('Confirm receipt intake before saving this address.');
            await call('settings/receipt-email', { address: values.address, consent: true });
            await changed('Receipt email address saved.');
          }}>
            <Field label="Receipt forwarding address" name="address" type="email" defaultValue={data.address ?? ''} />
            <Field label="I authorize receipt intake at this address" name="consent" type="checkbox" />
          </Form>
        </>}
        <h3>Your sender aliases</h3>
        <p>Confirm each alias with the one-time code sent to that address. Confirming an alias applies to future messages; held messages stay held.</p>
        {data.aliases.length ? <ul>{data.aliases.map(alias => <AliasProof key={alias.email} alias={alias} changed={changed} />)}</ul> : <p>You have no sender aliases.</p>}
        <Form label="Send confirmation code" onSubmit={async (values, form) => {
          await call('settings/receipt-email/aliases', { email: values.email });
          await changed('Confirmation code sent. Enter it beside the alias above.');
          form.reset();
        }}>
          <Field label="Your other email address" name="email" type="email" autoComplete="email" />
        </Form>
        {data.owner && <>
          <h3>Held messages</h3>
          {data.held.length ? <ul>{data.held.map(message => <li key={message.id}>
            <ReceiptEmailProvenance source={message} />
            <p>Held: {message.reason}</p>
          </li>)}</ul> : <p>No held messages.</p>}
        </>}
      </>}
    </div>
  </Section>;
}
