import { Delegation } from './approval-delegation';
import { BulkApprovals } from './bulk-approvals';
import { ClaimPanel } from './claim-panel';
import { matches, type ViewProps } from './claims';
import { ClaimsTable } from './claims-table';
import { Empty, PageHead, Tiles } from './parts';
import { useDesktop, Work } from './shell';
import { oldestWaiting } from './app';
import { SpendRequests } from './requests';
import { CashAdvances } from './advances';
import { money, plural, type D } from './api';

/** Claims routed to this manager, in the main screen's layout: waiting first, then the ones already decided. */
export function Approvals({ state, reload, id, query }: ViewProps) {
  const routed = state.claims.filter((c: D) => (c.assigned_emails?.length ? c.assigned_emails.includes(state.actor.email) : c.approver_email === state.actor.email) && c.employee_email !== state.actor.email);
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
    <BulkApprovals waiting={waiting} names={state.names} reload={reload} />
    {shown.length
      ? <ClaimsTable claims={shown} selected={open} view="approvals" label="Approvals" initialSort="status" foot={<span>Showing {shown.length} of {plural(routed.length, 'claim')} routed to you · waiting first{state.business ? ` · ${routed.filter((c: D) => c.over_service_level).length} past the ${state.business.service_level_days}-business-day service level` : ''}</span>} />
      : <section className="panel"><Empty large title={query ? 'No claims match that search' : 'Nothing waiting for you'}>{query ? null : 'Claims your team submits appear here for a decision.'}</Empty></section>}
    <SpendRequests state={state} reload={reload} deciding />
    <CashAdvances state={state} reload={reload} mode="deciding" />
    {(state.actor.roles.manager || state.actor.roles.finance) && <Delegation state={state} reload={reload} />}
  </Work>;
}

