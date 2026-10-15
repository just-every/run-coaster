import { ClaimPanel } from './claim-panel';
import { ClaimRow, type ViewProps } from './claims';
import { Empty } from './parts';
import type { D } from './api';

/** Claims routed to this manager: waiting first, then the ones already decided. */
export function Approvals({ state, reload, id }: ViewProps) {
  const routed = state.claims.filter((c: D) => c.approver_email === state.actor.email && c.employee_email !== state.actor.email);
  const waiting = routed.filter((c: D) => c.status === 'submitted'), decided = routed.filter((c: D) => c.status !== 'submitted');
  return <>
    <section className={`panel claims${id ? ' has-selection' : ''}`} aria-label="Approvals">
      <div className="claims-tools"><h2 className="list-title">Waiting for you · {waiting.length}</h2></div>
      {waiting.length ? <ul className="claim-list">{waiting.map((c: D) => <ClaimRow key={c.id} claim={c} selected={c.id === id} view="approvals" />)}</ul> : <Empty title="Nothing waiting for you">Claims your team submits appear here for a decision.</Empty>}
      {decided.length > 0 && <><div className="claims-tools"><h2 className="list-title">Decided</h2></div><ul className="claim-list">{decided.map((c: D) => <ClaimRow key={c.id} claim={c} selected={c.id === id} view="approvals" />)}</ul></>}
    </section>
    {id ? <ClaimPanel key={id} id={id} state={state} reload={reload} back="approvals" /> : <section className="panel detail detail-empty"><Empty large title="Choose a claim to review">Check each expense, its receipt and any policy exception, then approve, return or reject it.</Empty></section>}
  </>;
}
