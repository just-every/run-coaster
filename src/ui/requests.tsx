import { useState } from 'react';
import { call, day, money, type D } from './api';
import { Badge, Empty, Field, Form, Section } from './parts';

export const requestNumber = (n: number) => `SR-${String(n).padStart(4, '0')}`;
const line = (r: D, names: Record<string, string>) => `${requestNumber(r.number)} · ${r.title} · ${names[r.employee_email] ?? r.employee_email} · estimate ${money(r.estimate_minor, r.currency)}, spent ${money(r.actual_minor, r.currency)}`;

/** Spend requests (CLAIM-005): an employee asks before spending; their approver decides; expenses link to an approved one. */
export function SpendRequests({ state, reload, deciding = false }: { state: D; reload: () => Promise<unknown>; deciding?: boolean }) {
  const me = state.actor.email, [error, setError] = useState('');
  const shown = state.requests.filter((r: D) => deciding ? r.approver_email === me && r.employee_email !== me : r.employee_email === me);
  const decide = async (r: D, decision: string, reason = '') => { try { setError(''); await call(`requests/${r.id}/decision`, { version: r.version, decision, reason }); await reload(); } catch (e) { setError((e as Error).message); } };
  return <Section title={deciding ? 'Spend requests to decide' : 'Spend requests'}>
    {!deciding && <p className="muted">Ask before a trip, conference or large purchase{state.business.preapproval_threshold_minor != null ? `; anything over ${money(state.business.preapproval_threshold_minor, state.business.currency)} needs an approved request` : ''}. Link its expenses to it and your approver sees the estimate against what was spent.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {shown.length ? <ul className="ruled-list">{shown.map((r: D) => <li key={r.id} className="job">
      <span>{line(r, state.names)}{r.purpose ? ` · ${r.purpose}` : ''}{r.reason ? ` · “${r.reason}”` : ''} · {day(r.created_at)}</span>
      {deciding && r.status === 'submitted'
        ? <span className="row-actions"><button className="button small" onClick={() => decide(r, 'approved')}>Approve</button>
            <Form label="Reject" className="record-form-inline" onSubmit={v => decide(r, 'rejected', v.reason)}><Field label="Reason to reject" name="reason" /></Form></span>
        : <Badge status={r.status} />}
    </li>)}</ul> : <Empty title={deciding ? 'No spend requests for you' : 'No spend requests'} />}
    {!deciding && <div className="sub-form"><Form label="Request approval" onSubmit={async (v, form) => { await call('requests', v); form.reset(); await reload(); }}>
      <Field label="What for" name="title" placeholder="Sydney design conference" />
      <Field label="Estimate" name="estimate" inputMode="decimal" placeholder="2400.00" hint={state.business.currency} />
      <Field label="Purpose" name="purpose" type="textarea" required={false} />
    </Form></div>}
  </Section>;
}
