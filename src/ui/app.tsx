import { useCallback, useEffect, useRef, useState } from 'react';
import { call, type D } from './api';
import { Icon } from './icons';
import { Claims } from './claims';
import { Approvals } from './approvals';
import { Batches } from './batches';
import { MoveIn } from './move-in';
import { Settings } from './settings';
import { FirstRun } from './first-run';
import { Empty } from './parts';

type Place = { view: string; id?: string };
const readHash = (): Place => { const [view = 'claims', id] = (typeof location === 'undefined' ? '' : location.hash.replace(/^#\/?/, '')).split('/'); return { view: view || 'claims', id }; };
export const go = (view: string, id?: string) => { location.hash = `/${view}${id ? '/' + id : ''}`; };

function destinations(roles: D) {
  return [
    { view: 'claims', label: 'Claims', icon: 'claims', show: true },
    { view: 'approvals', label: 'Approvals', icon: 'approvals', show: roles.manager },
    { view: 'batches', label: 'Batches', icon: 'batches', show: roles.finance },
    { view: 'move-in', label: 'Move in', icon: 'movein', show: roles.owner },
    { view: 'settings', label: 'Settings', icon: 'settings', show: true },
  ].filter(d => d.show);
}

/** The masthead: the mark and name, and who is signed in (on phones, behind their initial). */
function Masthead({ actor }: { actor?: D }) {
  const roles = actor ? ['employee', 'manager', 'finance'].filter(r => actor.roles[r]).map(r => r[0].toUpperCase() + r.slice(1)) : [];
  const who = actor && <><span className="account-email">{actor.email}</span><span className="muted"> · {actor.roles.owner ? 'Owner, ' : ''}{roles.join(', ')}</span></>;
  return <header className="app-header">
    <a className="brand" href="/app#/claims"><img className="brand-mark" src="/brand/mark.svg" alt="" /><span data-rer-name>Coaster</span></a>
    {actor && <p className="account">{who}</p>}
    {actor && <details className="account-menu"><summary aria-label={`Signed in as ${actor.email}`}><span aria-hidden="true">{(actor.name || actor.email)[0].toUpperCase()}</span></summary><p className="account-card">{who}</p></details>}
  </header>;
}

/** The destinations; on phones a row of tabs that keeps the current one in view. */
function Nav({ nav, current }: { nav: { view: string; label: string; icon: string }[]; current: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [current]);
  return <nav className="nav" aria-label="Coaster" ref={ref}>
    {nav.map(d => <a key={d.view} href={`#/${d.view}`} className={current === d.view ? 'active' : undefined} aria-current={current === d.view ? 'page' : undefined}><Icon name={d.icon} />{d.label}</a>)}
  </nav>;
}

/** The signed-in workspace: one shell, at most five destinations, each the work it names. */
export function App() {
  const [state, setState] = useState<D>(), [error, setError] = useState(''), [place, setPlace] = useState<Place>({ view: 'claims' });
  const reload = useCallback(async () => { const next = await call('state'); setState(next); setError(''); return next; }, []);
  useEffect(() => {
    const update = () => setPlace(readHash());
    update(); window.addEventListener('hashchange', update);
    reload().catch(e => setError(e.message));
    return () => window.removeEventListener('hashchange', update);
  }, [reload]);
  if (!state) return <div className="app"><Masthead /><main className="layout layout-single"><section className="panel section">{error ? <p role="alert">{error} · <a href="/signin">Sign in</a></p> : <p className="muted">Opening your claims…</p>}</section></main></div>;
  const nav = destinations(state.actor.roles), current = nav.some(d => d.view === place.view) ? place.view : 'not-found';
  const props = { state, reload, id: place.id };
  return <div className="app">
    <Masthead actor={state.actor} />
    <div className={`layout ${state.business && (current === 'claims' || current === 'approvals') ? 'layout-split' : 'layout-wide'}`}>
      <Nav nav={nav} current={current} />
      {!state.business && !['settings', 'not-found'].includes(current) ? <FirstRun state={state} /> : <>
        {current === 'claims' && <Claims {...props} />}
        {current === 'approvals' && <Approvals {...props} />}
        {current === 'batches' && <Batches {...props} />}
        {current === 'move-in' && <MoveIn {...props} />}
      </>}
      {current === 'settings' && <Settings {...props} />}
      {current === 'not-found' && <main className="panel main-wide"><Empty large title="Page not found">That part of Coaster does not exist or is not open to you. <a href="#/claims">Back to claims</a></Empty></main>}
    </div>
  </div>;
}
