import { ClaimPanel } from './claim-panel';
import { matches, type ViewProps } from './claims';
import { ClaimsTable } from './claims-table';
import { Empty, PageHead, Tiles } from './parts';
import { Work } from './shell';
import { money, type D } from './api';

/** Claims routed to this manager, in the main screen's layout: waiting first, then the ones already decided. */
export function Approvals({ state, reload, id, query }: ViewProps) {
  const routed = state.claims.filter((c: D) => c.approver_email === state.actor.email && c.employee_email !== state.actor.email);
  const waiting = routed.filter((c: D) => c.status === 'submitted'), decided = routed.filter((c: D) => c.status !== 'submitted');
  const approved = decided.filter((c: D) => ['approved', 'batched', 'reimbursed'].includes(c.status)), sent = decided.filter((c: D) => ['returned', 'rejected'].includes(c.status));
  const shown = routed.filter((c: D) => matches(c, query)), currency = state.business.currency;
  const panel = id ? <ClaimPanel key={id} id={id} state={state} reload={reload} back="approvals" />
    : <aside className="side side-empty"><Empty large title="Choose a claim to review">Check each expense, its receipt and any policy exception, then approve, return or reject it.</Empty></aside>;
  return <Work panel={panel} selected={!!id}>
    <PageHead title="Approvals" line={`${waiting.length} claim${waiting.length === 1 ? '' : 's'} waiting for your decision, ${decided.length} decided`} />
    <Tiles label="Approval totals" tiles={[
      { label: 'Approved by you', value: approved.length, note: money(approved.reduce((n: number, c: D) => n + c.total_minor, 0), currency) },
      { label: 'Returned or rejected', value: sent.length, note: 'Each with its reason in the history' },
      { label: 'Waiting for you', value: waiting.length, note: money(waiting.reduce((n: number, c: D) => n + c.total_minor, 0), currency), wash: true },
    ]} />
    {shown.length
      ? <ClaimsTable claims={shown} selected={id} view="approvals" label="Approvals" initialSort="status" foot={<span>Showing {shown.length} of {routed.length} claims routed to you · waiting first</span>} />
      : <section className="panel"><Empty large title={query ? 'No claims match that search' : 'Nothing waiting for you'}>{query ? null : 'Claims your team submits appear here for a decision.'}</Empty></section>}
  </Work>;
}
