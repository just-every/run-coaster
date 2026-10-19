import { ClaimPanel } from './claim-panel';
import { matches, type ViewProps } from './claims';
import { ClaimsTable } from './claims-table';
import { Empty, Field, Form, PageHead, Section, Tiles } from './parts';
import { useDesktop, Work } from './shell';
import { oldestWaiting } from './app';
import { SpendRequests } from './requests';
import { CashAdvances } from './advances';
import { call, day, money, plural, today, type D } from './api';

/** Claims routed to this manager, in the main screen's layout: waiting first, then the ones already decided. */
export function Approvals({ state, reload, id, query }: ViewProps) {
  const routed = state.claims.filter((c: D) => c.approver_email === state.actor.email && c.employee_email !== state.actor.email);
  const waiting = routed.filter((c: D) => c.status === 'submitted'), decided = routed.filter((c: D) => c.status !== 'submitted');
  const approved = decided.filter((c: D) => ['approved', 'batched', 'reimbursed'].includes(c.status)), sent = decided.filter((c: D) => ['returned', 'rejected'].includes(c.status));
  const shown = routed.filter((c: D) => matches(c, query)), currency = state.business.currency;
  // At desktop widths, with no claim chosen, the panel opens on the claim waiting longest for this person's decision.
  const desktop = useDesktop(), landing = !id && desktop ? oldestWaiting(state, shown) : undefined;
  const open: string | undefined = id ?? landing?.id;
  const panel = open ? <ClaimPanel key={open} id={open} state={state} reload={reload} back="approvals" closable={!!id} />
    : <aside className="side side-empty"><Empty large title="Nothing is waiting for your decision">Choose a claim to see each expense, its receipt and any policy exception, and the decision made on it.</Empty></aside>;
  return <Work panel={panel} selected={!!id}>
    <PageHead title="Approvals" line={`${plural(waiting.length, 'claim')} waiting for your decision, ${decided.length} decided`} />
    <Tiles label="Approval totals" tiles={[
      { label: 'Approved by you', value: approved.length, note: money(approved.reduce((n: number, c: D) => n + c.total_minor, 0), currency) },
      { label: 'Returned or rejected', value: sent.length, note: 'Each with its reason in the history' },
      { label: 'Waiting for you', value: waiting.length, note: money(waiting.reduce((n: number, c: D) => n + c.total_minor, 0), currency), wash: true },
    ]} />
    {shown.length
      ? <ClaimsTable claims={shown} selected={open} view="approvals" label="Approvals" initialSort="status" foot={<span>Showing {shown.length} of {plural(routed.length, 'claim')} routed to you · waiting first{state.business ? ` · ${routed.filter((c: D) => c.over_service_level).length} past the ${state.business.service_level_days}-business-day service level` : ''}</span>} />
      : <section className="panel"><Empty large title={query ? 'No claims match that search' : 'Nothing waiting for you'}>{query ? null : 'Claims your team submits appear here for a decision.'}</Empty></section>}
    <SpendRequests state={state} reload={reload} deciding />
    <CashAdvances state={state} reload={reload} mode="deciding" />
    <Delegation state={state} reload={reload} />
  </Work>;
}

/** Out of office: hand approvals to another manager for a date range; claims submitted in it go to them on your behalf. */
function Delegation({ state, reload }: { state: D; reload: () => Promise<D> }) {
  const me = state.actor.email, name = (email: string) => state.names[email] ?? email;
  const managers: string[] = state.managers.filter((email: string) => email !== me);
  return <Section title="Delegation">
    {state.delegations.length ? <ul className="ruled-list">{state.delegations.map((d: D) => <li key={d.id} className="job">
      <span>{d.approver_email === me ? `${name(d.delegate_email)} approves for you` : `You approve for ${name(d.approver_email)}`} · {day(d.starts_on)} to {day(d.ends_on)}</span>
      {(d.approver_email === me || state.actor.roles.owner) && <button className="button small" onClick={async () => { await call(`delegations/${d.id}/revoke`, {}); await reload(); }}>End</button>}
    </li>)}</ul> : <p className="muted">Nobody approves on your behalf.</p>}
    <div className="sub-form"><Form label="Delegate approvals" onSubmit={async (v, form) => { await call('delegations', v); form.reset(); await reload(); }}>
      <Field label="Delegate" name="delegate" options={managers.map(email => ({ value: email, label: name(email) }))} />
      <Field label="From" name="startsOn" type="date" defaultValue={today()} />
      <Field label="Until" name="endsOn" type="date" defaultValue={today()} />
    </Form></div>
  </Section>;
}
