import { useCallback, useEffect, useState } from 'react';
import { call, moment, type D } from './api';
import { Field, Form, Section } from './parts';

/** The metadata-only ledger connection and daily refresh. No connection exists until a person authorizes Intuit. */
export function QuickBooks({ state }: { state: D }) {
  const [status, setStatus] = useState<D>(), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const reload = useCallback(async () => { setStatus(await call('accounting/qbo')); setError(''); }, []);
  useEffect(() => { reload().catch(e => setError(e.message)); }, [reload]);
  const roles = state.actor.roles, connect = roles.owner || roles.admin || roles.finance, sync = roles.owner || roles.finance || roles.bookkeeper;
  return <Section title="QuickBooks accounting choices" label="QuickBooks accounting choices">
    <p className="muted">Connect your QuickBooks company to offer its accounts, classes, locations, customers, projects and vendors when coding expenses. Coaster reads accounting choices daily; it sends no expenses, receipts or employee records to QuickBooks.</p>
    {error && <p role="alert">{error}</p>}
    <p role="status" aria-live="polite">{notice}</p>
    {!status && !error && <p>Loading connection…</p>}
    {status && (status.connected ? <>
      <p>Connected to {status.environment === 'sandbox' ? 'sandbox' : 'production'} company {status.realm}. Last refresh: {moment(status.lastRefreshAt)}.</p>
      {status.error && <p role="alert">Refresh needs attention: {status.error}. The last successful choices remain available.</p>}
      <p>Daily refresh hour: {status.hour}:00 in {state.business.timezone}.</p>
      {sync && <Form label="Refresh accounting choices" onSubmit={async () => { await call('accounting/qbo/refresh', {}); await reload(); setNotice('Accounting choices refreshed. Reopen an expense to use the new choices.'); }}><p className="muted field-wide">The daily schedule keeps choices current without pressing this button.</p></Form>}
      {(roles.owner || roles.finance) && <Form key={status.version} label="Save daily refresh schedule" onSubmit={async v => { await call('accounting/qbo/schedule', { version: status.version, hour: Number(v.hour) }); await reload(); setNotice('Daily refresh schedule saved.'); }}>
          <Field label="Daily refresh hour" name="hour" type="number" min={0} max={23} defaultValue={status.hour} hint={`0–23, in ${state.business.timezone}`} />
        </Form>}
      {connect && <>
        <Form label="Disconnect QuickBooks" onSubmit={async v => { if (!v.consent) throw new Error('Confirm disconnect first.'); await call('accounting/qbo/disconnect', { consent: true, version: status.version }); await reload(); setNotice('QuickBooks disconnected. Daily requests stopped; existing expense records are kept.'); }}>
          <Field label="Disconnect this company and stop daily refresh" name="consent" type="checkbox" />
        </Form>
      </>}
    </> : <>
      <p>No QuickBooks company connected. Native accounting tags can be configured separately below.</p>
      {!status.configured ? <p>Configure the private QuickBooks app credentials with installation setup before connecting a company.</p> : connect && <Form label="Connect QuickBooks" onSubmit={async v => { const next = await call('accounting/qbo/connect', v); window.location.assign(next.authorizationUrl); }}>
        <Field label="I authorize reading this company’s accounting choices and keeping them current with daily refresh" name="consent" type="checkbox" />
        <p className="muted field-wide">You will choose the {status.environment} company on Intuit’s consent page. Disconnecting stops future requests. This connection does not post financial transactions.</p>
      </Form>}
    </>)}
  </Section>;
}
