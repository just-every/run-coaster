import { useState } from 'react';
import { call, claimNumber, money, plural, type D } from './api';
import { Choice, Empty, Field, Form, PageHead, Tiles } from './parts';
import { Icon } from './icons';
import { ClaimPanel } from './claim-panel';
import { ClaimsTable } from './claims-table';
import { AgentStrip } from './proposals';
import { SpendRequests } from './requests';
import { CashAdvances } from './advances';
import { ReceiptInbox } from './receipt-inbox';
import { QuickExpense } from './quick-expense';
import { Side, useDesktop, Work } from './shell';
import { go, oldestWaiting, waitingFor } from './app';

export type ViewProps = { state: D; reload: () => Promise<D>; id?: string; query: string };

const sum = (claims: D[]) => claims.reduce((n, c) => n + c.total_minor, 0);
/** A claim matches the top bar's search on its number, title or person. */
export const matches = (c: D, query: string) => `${claimNumber(c.number)} ${c.title} ${c.employee_name}`.toLowerCase().includes(query.trim().toLowerCase());

function NewClaim({ reload, onClose }: { reload: () => Promise<D>; onClose: () => void }) {
  return <Side className="side" label="New claim">
    <div className="panel-head"><h2>New claim</h2><button type="button" className="panel-close button-reset" onClick={onClose} aria-label="Close new claim"><Icon name="cross" /></button></div>
    <p className="panel-date">Name it for the trip or project, then add each expense with its receipt.</p>
    <Form label="Start claim" className="record-form-inline" onSubmit={async v => { const claim = await call('claims', { title: v.title }); await reload(); onClose(); go('claims', claim.id); }} secondary={<button type="button" className="button" onClick={onClose}>Cancel</button>}>
      <Field label="Claim title" name="title" placeholder="Denver client trip" autoFocus />
    </Form>
  </Side>;
}

/** The main screen (owner pick J): the claims this person can see, counted in three tiles, what agents prepared for
    them, the dense table, and the selected claim in the panel at the right. */
export function Claims({ state, reload, id, query, creating, onCreating, onNewClaim }: ViewProps & { creating: boolean; onCreating: (open: boolean) => void; onNewClaim?: () => void }) {
  const roles = state.actor.roles, wide = roles.owner || roles.admin || roles.finance || roles.auditor || roles.bookkeeper;
  const [scope, setScope] = useState(wide ? 'all' : 'mine');
  const scoped = state.claims.filter((c: D) => scope === 'all' || c.employee_email === state.actor.email);
  const shown = scoped.filter((c: D) => matches(c, query));
  const waiting = scoped.filter((c: D) => c.status === 'submitted'), ready = scoped.filter((c: D) => c.status === 'approved');
  const approved = scoped.filter((c: D) => ['approved', 'batched', 'reimbursed'].includes(c.status)), paid = scoped.filter((c: D) => c.status === 'reimbursed');
  const proposals = state.proposals.filter((p: D) => p.kind === 'claim' && p.status === 'proposed');
  const whose = scope === 'all' ? `at ${state.business.name}` : 'of yours';
  // At desktop widths, with no claim chosen, the panel opens on the oldest claim waiting for this person's decision,
  // as the pick does; on phones the list comes first and a claim replaces it only when chosen.
  const desktop = useDesktop();
  const landing = !id && !creating && desktop ? oldestWaiting(state, shown) : undefined;
  const open: string | undefined = id ?? landing?.id, elsewhere = waitingFor(state).filter((c: D) => !shown.includes(c)).length;
  const panel = creating ? <NewClaim reload={reload} onClose={() => onCreating(false)} />
    : open ? <ClaimPanel key={open} id={open} state={state} reload={reload} back="claims" closable={!!id} />
    : elsewhere ? <aside className="side side-empty"><Empty large title={`${plural(elsewhere, 'claim')} waiting for your decision`}><a href="#/approvals">Open Approvals</a> to decide; a claim you choose here opens in this panel.</Empty></aside>
    : <aside className="side side-empty"><Empty large title="Nothing is waiting for your decision">Choose a claim to see its expenses, receipts, policy exceptions and history here.</Empty></aside>;
  return <Work panel={scoped.length || creating || id || elsewhere ? panel : undefined} selected={creating || !!id}>
    <PageHead title="Claims" line={`${plural(scoped.length, 'claim')} ${whose}, ${waiting.length} waiting for approval, ${ready.length} approved and ready to pay`}
      action={onNewClaim && <button className="button primary head-action" onClick={onNewClaim}><Icon name="plus-circle" />New claim</button>} />
    <Tiles label="Claim totals" tiles={[
      { label: 'Claims', value: scoped.length, note: money(sum(scoped), state.business.currency) },
      { label: 'Approved', value: approved.length, note: `${paid.length} reimbursed · ${money(sum(approved), state.business.currency)}` },
      { label: 'Waiting for approval', value: waiting.length, note: money(sum(waiting), state.business.currency), wash: true },
    ]} />
    {state.actor.roles.employee && <AgentStrip proposals={proposals} reload={reload} idle={<><strong>Agents:</strong> nothing prepared for you right now. An agent with your key turns receipts into draft claims here for you to accept; it never submits, approves or pays. <a href="#/settings">Agent keys</a></>} />}
    {shown.length
      ? <ClaimsTable claims={shown} selected={open} view="claims" label="Claims" foot={<>
          <span>Showing {shown.length} of {plural(scoped.length, 'claim')}{query ? ` matching “${query.trim()}”` : ''}</span>
          {wide && <Choice label="Show" hideLabel className="field" value={scope} onChange={(e: any) => setScope(e.target.value)}><option value="all">All claims</option><option value="mine">My claims</option></Choice>}
        </>} />
      : <section className="panel"><Empty large title={query ? 'No claims match that search' : scope === 'mine' ? 'No claims yet' : 'No claims to show'}>{!query && scope === 'mine' && state.actor.roles.employee ? 'Start a claim, add each expense with its receipt, then submit it to your manager.' : null}</Empty>
          {wide && !query && <div className="table-foot"><span>Nothing here yet</span><Choice label="Show" hideLabel className="field" value={scope} onChange={(e: any) => setScope(e.target.value)}><option value="all">All claims</option><option value="mine">My claims</option></Choice></div>}
        </section>}
    {state.actor.roles.employee && <ReceiptInbox key={state.actor.email} state={state} onChanged={reload} />}
    {state.actor.roles.employee && !state.actor.delegate && <QuickExpense state={state} reload={reload} />}
    {state.actor.roles.employee && <SpendRequests state={state} reload={reload} />}
    {state.actor.roles.employee && <CashAdvances state={state} reload={reload} mode="mine" />}
  </Work>;
}
