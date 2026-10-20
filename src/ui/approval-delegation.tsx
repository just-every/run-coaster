import { useState, type ChangeEvent } from 'react';
import { call, day, today, type D } from './api';
import { Field, Form, Section } from './parts';

/** Out of office: delegate new manager or finance approval work for a date range. */
export function Delegation({ state, reload }: { state: D; reload: () => Promise<D> }) {
  const roles = state.actor.roles;
  const [role, setRole] = useState<'manager' | 'finance'>(roles.manager ? 'manager' : 'finance');
  const me = state.actor.email, name = (email: string) => state.names[email] ?? email;
  const options = [
    ...(roles.manager ? [{ value: 'manager', label: 'Manager' }] : []),
    ...(roles.finance ? [{ value: 'finance', label: 'Finance' }] : []),
  ];
  const reviewers: string[] = (role === 'manager' ? state.managers : state.financeReviewers).filter((email: string) => email !== me);
  return <Section title="Delegation">
    <p className="muted">Delegates cover the selected role when an approval stage opens in this date range. Tasks already waiting stay with their current reviewer.</p>
    {state.delegations.length ? <ul className="ruled-list">{state.delegations.map((d: D) => <li key={d.id} className="job">
      <span>{d.approver_email === me ? `${name(d.delegate_email)} approves for you` : d.delegate_email === me ? `You approve for ${name(d.approver_email)}` : `${name(d.delegate_email)} approves for ${name(d.approver_email)}`} · {d.review_role === 'finance' ? 'Finance' : 'Manager'} · {day(d.starts_on)} to {day(d.ends_on)}</span>
      {(d.approver_email === me || roles.owner) && <button className="button small" onClick={async () => { await call(`delegations/${d.id}/revoke`, {}); await reload(); }}>End</button>}
    </li>)}</ul> : <p className="muted">Nobody approves on your behalf.</p>}
    <div className="sub-form"><Form label="Delegate approvals" onSubmit={async (v, form) => { await call('delegations', { ...v, role }); form.reset(); await reload(); }}>
      <Field label="Approval role" name="role" options={options} value={role} onChange={(e: ChangeEvent<HTMLSelectElement>) => setRole(e.target.value as 'manager' | 'finance')} />
      <Field key={role} label="Delegate" name="delegate" options={reviewers.map(email => ({ value: email, label: name(email) }))} />
      <Field label="From" name="startsOn" type="date" defaultValue={today()} />
      <Field label="Until" name="endsOn" type="date" defaultValue={today()} />
    </Form></div>
  </Section>;
}
