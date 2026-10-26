import { useCallback, useEffect, useState } from 'react';
import { call, day, money, moment, type D } from './api';
import { Empty, Field, Form, Section } from './parts';

const connectionPath = ['payroll', 'gusto'].join('/');

/** Only the native owner mounts this connection screen. Tokens never enter workspace state. */
export function PayrollSettings({ members }: { members: D[] }) {
  const [status, setStatus] = useState<D>(), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    setStatus(await call(connectionPath));
    setError('');
  }, []);
  useEffect(() => { load().catch(e => setError(e.message)); }, [load]);
  return <Section title="Gusto sandbox" label="Gusto sandbox payroll">
    <p className="muted">Connect a company at demo.gusto.com to send reviewed, released reimbursements and taxable pay to a sandbox payroll. Run payroll in Gusto, then confirm provider payment from the batch.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <p role="status" aria-live="polite">{notice}</p>
    {!status && !error && <p>Loading payroll connection…</p>}
    {!status && error && <Form label="Retry payroll connection" onSubmit={load}><p className="muted field-wide">Payroll connection details are unavailable.</p></Form>}
    {status && (status.connection ? <>
      <p>Connected to {status.connection.company_name} · {moment(status.connection.connected_at)}.</p>
      <h3>Employee mappings</h3>
      {status.mappings.length ? <ul className="ruled-list">{status.mappings.map((mapping: D) => {
        const employee = status.employees.find((person: D) => person.uuid === mapping.employee_uuid);
        return <li key={mapping.email}>{members.find(person => person.email === mapping.email)?.name ?? mapping.email} · {employee ? `${employee.first_name} ${employee.last_name}` : 'Gusto employee unavailable'}</li>;
      })}</ul> : <Empty title="No employees mapped">Map each person before sending their batch to Gusto.</Empty>}
      {status.employees.length ? <Form label="Map payroll employee" onSubmit={async v => {
        await call(connectionPath + '/employees', { email: v.email, employee: v.employee });
        await load(); setNotice('Payroll employee mapped.');
      }}>
        <Field label="Coaster person" name="email" options={members.filter(person => person.active && person.is_employee).map(person => ({ value: person.email, label: `${person.name} · ${person.email}` }))} />
        <Field label="Gusto employee" name="employee" options={status.employees.map((person: D) => ({ value: person.uuid, label: `${person.first_name} ${person.last_name}${person.email ? ` · ${person.email}` : ''}` }))} />
      </Form> : <Empty title="No Gusto employees available">Add employees to the connected sandbox company before mapping them.</Empty>}
      <div className="sub-form"><Form label="Disconnect Gusto sandbox" onSubmit={async v => {
        if (!v.consent) throw new Error('Confirm disconnect first.');
        await call(connectionPath + '/disconnect', {}); await load(); setNotice('Gusto sandbox disconnected. Existing handoff history is retained.');
      }}>
        <Field label="Disconnect this sandbox company" name="consent" type="checkbox" />
      </Form></div>
    </> : <>
      <Empty title="No Gusto sandbox connected">Production payroll and other payroll providers are unavailable here.</Empty>
      <Form label="Connect Gusto sandbox" onSubmit={async (v, form) => {
        if (!v.consent) throw new Error('Authorize the sandbox connection first.');
        await call(connectionPath + '/connect', { company: v.company, token: v.token, consent: true });
        form.reset(); await load(); setNotice('Gusto sandbox connected.');
      }}>
        <Field label="Sandbox company UUID" name="company" autoComplete="off" />
        <Field label="Sandbox access token" name="token" type="password" autoComplete="off" />
        <Field label="I authorize reading this sandbox company’s employees and payrolls and sending the batch amounts I review" name="consent" type="checkbox" />
      </Form>
    </>)}
  </Section>;
}

/** Sending lines reserves the batch; only a matching processed provider run can confirm payment. */
export function PayrollBatch({ batch, payroll, error, reload }: { batch: D; payroll?: D; error: string; reload: () => Promise<void> }) {
  const [notice, setNotice] = useState('');
  const handoff = payroll?.handoff, lines = handoff?.lines ?? payroll?.lines ?? [];
  const ready = batch.status === 'approved' && !!batch.released_at;
  return <section className="panel-block" aria-label="Gusto sandbox payroll">
    <h3>Gusto sandbox</h3>
    <p role="status" aria-live="polite">{notice}</p>
    {error && <><p className="form-error" role="alert">{error}</p><Form label="Retry payroll details" onSubmit={reload}><p className="muted field-wide">Payment options are unavailable until the payroll handoff can be checked.</p></Form></>}
    {!payroll && !error && <p className="muted">Checking payroll handoff…</p>}
    {payroll && <>
      {!!lines.length && <div className="table-wrap"><table className="mini" aria-label="Payroll amounts to review">
        <thead><tr><th style={{ fontSize: 13 }}>Person</th><th className="figure" style={{ fontSize: 13 }}>Reimbursement</th><th className="figure" style={{ fontSize: 13 }}>Taxable pay</th></tr></thead>
        <tbody>{lines.map((line: D) => <tr key={line.email}><td>{line.name ?? line.email}{!line.employeeUuid && <span className="sub">Employee mapping required</span>}</td><td className="figure amount">{money(line.reimbursementMinor, batch.currency)}</td><td className="figure amount">{money(line.taxableMinor, batch.currency)}</td></tr>)}</tbody>
      </table></div>}
      {handoff ? <>
        <p><span className={`chip tone-${handoff.status === 'confirmed' ? 'done' : 'wait'}`} style={{ fontSize: 13 }}>{handoff.status === 'confirmed' ? 'Provider confirmed' : handoff.status === 'sent' ? 'Sent · awaiting provider confirmation' : 'Reserved · needs provider check'}</span></p>
        <p className="muted" style={{ overflowWrap: 'anywhere' }}>Payroll {handoff.payroll_uuid} · check date {day(handoff.check_date)}.</p>
        {handoff.status !== 'confirmed' && <Form label="Confirm provider payment" onSubmit={async () => {
          const result = await call(`batches/${batch.id}/payroll/confirm`, {});
          await reload(); setNotice(result.confirmed ? 'Provider confirmed the processed payroll receipt.' : 'Gusto has not confirmed this payroll yet. Claims remain unpaid.');
        }}>
          <p className="muted field-wide">Claims remain unpaid until Gusto reports the original run processed with the exact employee amounts and a payroll receipt. Complete payroll in Gusto, then check here. Provider confirmation records the processed run; Gusto tracks bank settlement.</p>
        </Form>}
      </> : ready ? payroll.payrolls.length ? <Form key={batch.version} label="Send to Gusto sandbox" onSubmit={async v => {
        if (!v.consent) throw new Error('Confirm the payroll amounts first.');
        try { await call(`batches/${batch.id}/payroll`, { version: batch.version, payroll: v.payroll, consent: true }); }
        finally { await reload(); }
      }}>
        <Field label="Sandbox payroll" name="payroll" options={payroll.payrolls.map((run: D) => ({ value: run.payroll_uuid, label: `Check date ${day(run.check_date)} · ${run.payroll_uuid}` }))} />
        <Field label="I reviewed these employee mappings, reimbursements and taxable amounts and authorize sending them to this sandbox payroll" name="consent" type="checkbox" />
        <p className="muted field-wide">Sending does not run payroll or mark claims paid. Use a sign-in from the last 10 minutes; you cannot send a batch containing your own claim.</p>
      </Form> : <Empty title="No sandbox payroll available">Connect Gusto sandbox and map employees in Settings, then make an unprocessed payroll available in Gusto.</Empty>
        : <p className="muted">{batch.status === 'reimbursed' ? 'No payroll handoff was recorded for this batch.' : 'Review and release this batch before sending its payroll amounts.'}</p>}
    </>}
  </section>;
}
