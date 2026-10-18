import { useCallback, useEffect, useState } from 'react';
import { call, type D } from './api';
import { Claims } from './claims';
import { Approvals } from './approvals';
import { Batches } from './batches';
import { MoveIn } from './move-in';
import { Settings } from './settings';
import { FirstRun } from './first-run';
import { Empty } from './parts';
import { Rail, Topbar, Work, type Destination } from './shell';

type Place = { view: string; id?: string };
const readHash = (): Place => { const [view = 'claims', id] = (typeof location === 'undefined' ? '' : location.hash.replace(/^#\/?/, '')).split('/'); return { view: view || 'claims', id }; };
export const go = (view: string, id?: string) => { location.hash = `/${view}${id ? '/' + id : ''}`; };

/** Claims routed to this person for a decision, the count the rail's Approvals badge shows. */
export const waitingFor = (state: D) => state.claims.filter((c: D) => c.status === 'submitted' && c.approver_email === state.actor.email && c.employee_email !== state.actor.email);
/** The claim a screen opens on by itself at desktop widths: of the claims it lists, the one waiting longest for this
    person's decision. */
export const oldestWaiting = (state: D, listed: D[]): D | undefined => waitingFor(state).filter((c: D) => listed.includes(c)).sort((a: D, b: D) => a.updated_at.localeCompare(b.updated_at) || a.number - b.number)[0];

function destinations(state: D): Destination[] {
  const roles = state.actor.roles;
  return [
    { view: 'claims', label: 'Claims', icon: 'claims', show: true },
    { view: 'approvals', label: 'Approvals', icon: 'approvals', show: roles.manager, count: waitingFor(state).length },
    { view: 'batches', label: 'Batches', icon: 'batches', show: roles.finance },
    { view: 'move-in', label: 'Move in', icon: 'movein', show: roles.owner },
    { view: 'settings', label: 'Settings', icon: 'settings', show: true },
  ].filter(d => d.show);
}

/** The signed-in workspace: one shell, at most five destinations, each the work it names. */
export function App() {
  const [state, setState] = useState<D>(), [error, setError] = useState(''), [place, setPlace] = useState<Place>({ view: 'claims' });
  const [query, setQuery] = useState(''), [creating, setCreating] = useState(false);
  const reload = useCallback(async () => { const next = await call('state'); setState(next); setError(''); return next; }, []);
  useEffect(() => {
    const update = () => setPlace(readHash());
    update(); window.addEventListener('hashchange', update);
    reload().catch(e => setError(e.message));
    return () => window.removeEventListener('hashchange', update);
  }, [reload]);
  if (!state) return <div className="app"><Rail /><div className="workspace"><Work><section className="panel section">{error ? <p role="alert">{error} · <a href="/signin">Sign in</a></p> : <p className="muted">Opening your claims…</p>}</section></Work></div></div>;
  const nav = destinations(state), current = nav.some(d => d.view === place.view) ? place.view : 'not-found';
  const search = (text: string) => { setQuery(text); if (text && current !== 'claims' && current !== 'approvals') go('claims'); };
  const startClaim = state.actor.roles.employee && state.business ? () => { setCreating(true); go('claims'); } : undefined;
  const props = { state, reload, id: place.id, query };
  return <div className="app">
    <Rail state={state} nav={nav} current={current} />
    <div className="workspace">
      <Topbar state={state} query={query} onSearch={search} onNewClaim={startClaim} />
      {!state.business && !['settings', 'not-found'].includes(current) ? <FirstRun state={state} /> : <>
        {current === 'claims' && <Claims {...props} creating={creating} onCreating={setCreating} onNewClaim={startClaim} />}
        {current === 'approvals' && <Approvals {...props} />}
        {current === 'batches' && <Batches {...props} />}
        {current === 'move-in' && <MoveIn {...props} />}
      </>}
      {current === 'settings' && <Settings {...props} />}
      {current === 'not-found' && <Work><section className="panel"><Empty large title="Page not found">That part of Coaster does not exist or is not open to you. <a href="#/claims">Back to claims</a></Empty></section></Work>}
    </div>
  </div>;
}
