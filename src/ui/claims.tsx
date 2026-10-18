import { useState } from 'react';
import { call, claimNumber, money, type D } from './api';
import { Badge, Empty, Field, Form, Choice } from './parts';
import { Icon } from './icons';
import { ClaimPanel } from './claim-panel';
import { Proposals } from './proposals';
import { go } from './app';

export type ViewProps = { state: D; reload: () => Promise<D>; id?: string };

/** One row of the claims list: number and amount, title, person, status in words. */
export function ClaimRow({ claim, selected, view }: { claim: D; selected: boolean; view: string }) {
  return <li><a className={`claim${selected ? ' selected' : ''}`} href={`#/${view}/${claim.id}`} aria-current={selected ? 'true' : undefined}>
    <span className="claim-top"><span className="claim-id">{claimNumber(claim.number)}</span><span className="amount">{money(claim.total_minor, claim.currency)}</span></span>
    <span className="claim-title">{claim.title}</span>
    <span className="claim-person">{claim.employee_name}</span>
    <Badge status={claim.status} />
  </a></li>;
}

export function Claims({ state, reload, id }: ViewProps) {
  const [creating, setCreating] = useState(false), [query, setQuery] = useState(''), [scope, setScope] = useState('mine');
  const wide = state.actor.roles.finance || state.actor.roles.owner;
  const shown = state.claims.filter((c: D) => (scope === 'all' || c.employee_email === state.actor.email) && `${claimNumber(c.number)} ${c.title} ${c.employee_name}`.toLowerCase().includes(query.trim().toLowerCase()));
  const proposals = state.proposals.filter((p: D) => p.kind === 'claim' && p.status === 'proposed');
  return <>
    <section className={`panel claims${id ? ' has-selection' : ''}`} aria-label="Claims">
      <div className="claims-tools">
        {state.actor.roles.employee && (creating
          ? <Form label="Start claim" className="record-form-inline" onSubmit={async v => { const claim = await call('claims', { title: v.title }); await reload(); setCreating(false); go('claims', claim.id); }} secondary={<button type="button" className="button" onClick={() => setCreating(false)}>Cancel</button>}>
              <Field label="Claim title" name="title" placeholder="Denver client trip" autoFocus />
            </Form>
          : <button className="button primary new" onClick={() => setCreating(true)}><Icon name="plus" />New claim</button>)}
        <div className="search-row">
          <label className="search"><Icon name="search" /><span className="visually-hidden">Search claims</span><input type="search" placeholder="Search claims…" value={query} onChange={e => setQuery(e.target.value)} /></label>
          {wide && <Choice label="Show" hideLabel className="field field-compact" value={scope} onChange={(e: any) => setScope(e.target.value)}><option value="mine">My claims</option><option value="all">All claims</option></Choice>}
        </div>
      </div>
      {proposals.length > 0 && <Proposals proposals={proposals} reload={reload} />}
      {shown.length
        ? <ul className="claim-list">{shown.map((c: D) => <ClaimRow key={c.id} claim={c} selected={c.id === id} view="claims" />)}</ul>
        : <Empty large title={query ? 'No claims match that search' : scope === 'mine' ? 'No claims yet' : 'No claims to show'}>{!query && scope === 'mine' && state.actor.roles.employee ? 'Start a claim, add each expense with its receipt, then submit it to your manager.' : null}</Empty>}
    </section>
    {id ? <ClaimPanel key={id} id={id} state={state} reload={reload} back="claims" /> : <section className="panel detail detail-empty"><Empty large title="Choose a claim">Its expenses, receipts, decisions and history open here.</Empty></section>}
  </>;
}
