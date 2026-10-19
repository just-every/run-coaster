import { useState } from 'react';
import { call, day, money, type D } from './api';
import { Badge, Empty, Field, Form, Section } from './parts';

/** What an advance stands at: drawn down by its claim, what that claim is paid beyond it and what is owed back. */
export const settlement = (a: D) => [
  a.claim ? `${a.claim} draws ${money(a.applied_minor, a.currency)}` : a.status === 'paid' ? 'no claim linked yet' : '',
  a.reimburseMinor ? `${money(a.reimburseMinor, a.currency)} reimbursed beyond it` : '',
  a.owedMinor > 0 ? `${money(a.owedMinor, a.currency)} owed back by ${day(a.returnDueOn)}${a.overdue ? ` · overdue ${a.daysOverdue} days` : ''}` : '',
].filter(Boolean).join(' · ');

/** Cash advances (CLAIM-004): an employee asks for one for a trip, their approver decides it, finance records it paid and
 * any excess returned; a later claim draws it down. */
export function CashAdvances({ state, reload, mode }: { state: D; reload: () => Promise<unknown>; mode: 'mine' | 'deciding' | 'finance' }) {
  const me = state.actor.email, [error, setError] = useState('');
  const shown = state.advances.filter((a: D) => mode === 'mine' ? a.employee_email === me : mode === 'deciding' ? a.approver_email === me && a.employee_email !== me && a.status === 'submitted' : a.status !== 'rejected' && a.employee_email !== me);
  const act = (a: D, path: string) => async (v: D) => { try { setError(''); await call(`advances/${a.id}/${path}`, { version: a.version, ...v }); await reload(); } catch (e) { setError((e as Error).message); } };
  const title = mode === 'deciding' ? 'Cash advances to decide' : mode === 'finance' ? 'Cash advances' : 'My cash advances';
  return <Section title={title} label={title}>
    {mode === 'mine' && <p className="muted">Ask for cash before a trip. Once finance pays it, link it to the trip’s claim: the claim pays you only what goes beyond the advance, and anything left over is returned within 120 days of the advance being paid.</p>}
    {mode === 'finance' && <p className="muted">Record approved advances paid once you have paid them (Coaster moves no money), and record excess the employee returns. An excess still owed 120 days after the advance was paid is overdue and shows on the accountable plan.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {shown.length ? <ul className="ruled-list">{shown.map((a: D) => <li key={a.id} className="job">
      <span><strong>{a.advance}</strong> · {a.purpose} · {state.names[a.employee_email] ?? a.employee_email} · {money(a.amount_minor, a.currency)}{a.paid_on ? ` · paid ${day(a.paid_on)}` : ''}{settlement(a) ? ` · ${settlement(a)}` : ''}{a.reason ? ` · “${a.reason}”` : ''}</span>
      {mode === 'deciding'
        ? <span className="row-actions"><button className="button small" onClick={() => act(a, 'decision')({ decision: 'approved' })}>Approve</button>
            <Form label="Reject" className="record-form-inline" onSubmit={v => act(a, 'decision')({ decision: 'rejected', reason: v.reason })}><Field label="Reason to reject" name="reason" /></Form></span>
        : mode === 'finance' && a.status === 'approved'
          ? <Form label="Record paid" className="record-form-inline" onSubmit={act(a, 'paid')}><Field label="Payment reference" name="reference" /><Field label="Paid on" name="paidOn" type="date" /></Form>
          : mode === 'finance' && a.owedMinor > 0
            ? <Form label="Record returned" className="record-form-inline" onSubmit={act(a, 'return')}><Field label="Returned" name="amount" inputMode="decimal" defaultValue={(a.owedMinor / 100).toFixed(2)} /><Field label="Returned on" name="returnedOn" type="date" /><Field label="Reference" name="reference" /></Form>
            : <Badge status={a.overdue ? 'overdue' : a.status} />}
    </li>)}</ul> : <Empty title={mode === 'deciding' ? 'No cash advances for you' : 'No cash advances'} />}
    {mode === 'mine' && <div className="sub-form"><Form label="Request an advance" onSubmit={async (v, form) => { await call('advances', v); form.reset(); await reload(); }}>
      <Field label="What for" name="purpose" placeholder="Chicago trade show" />
      <Field label="Amount" name="amount" inputMode="decimal" placeholder="1000.00" hint={state.business.currency} />
    </Form></div>}
  </Section>;
}

/** On a claim: the advance it draws down, and for its employee while it can change, linking or unlinking one. */
export function ClaimAdvance({ state, claim, advance, editable, done }: { state: D; claim: D; advance: D | null; editable: boolean; done: () => Promise<unknown> }) {
  const free = state.advances.filter((a: D) => a.employee_email === claim.employee_email && a.status === 'paid' && !a.claim);
  if (!advance && !(editable && free.length)) return null;
  return <section className="panel-block" aria-label="Cash advance">
    <h3>Cash advance</h3>
    {advance && <p>{advance.advance} · {advance.purpose} · {money(advance.amount_minor, advance.currency)}{settlement(advance) ? ` · ${settlement(advance)}` : ''}</p>}
    {editable && <Form label={advance ? 'Change advance' : 'Link advance'} className="record-form-inline" onSubmit={async v => { await call(`claims/${claim.id}/advance`, { version: claim.version, advance: v.advance }); await done(); }}>
      <Field label="Advance" name="advance" required={false} defaultValue={advance?.id ?? ''} options={[{ value: '', label: 'No advance' }, ...[...(advance ? [advance] : []), ...free].map((a: D) => ({ value: a.id, label: `${a.advance} ${a.purpose} · ${money(a.amount_minor, a.currency)}` }))]} />
    </Form>}
  </section>;
}
