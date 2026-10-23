import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { batchNumber, clock, day, initials, type D } from './api';
import { Icon } from './icons';
import { Initials } from './parts';

export type Destination = { view: string; label: string; icon: string; count?: number };

const roleWords = (actor: D) => {
  const roles = (actor.roles.owner ? ['employee', 'manager', 'finance', 'auditor'] : ['employee', 'manager', 'finance', 'admin', 'cardAdmin', 'bookkeeper', 'auditor']).filter(r => actor.roles[r]).map(r => r === 'cardAdmin' ? 'Card admin' : r[0].toUpperCase() + r.slice(1));
  return `${actor.roles.owner ? 'Owner · ' : ''}${roles.join(', ')}`;
};

function Brand() {
  return <a className="brand" href="/app#/claims"><img className="brand-mark" src="/brand/mark.svg" alt="" /><span className="brand-name" data-rer-name>Coaster</span></a>;
}

/** The white rail: the mark and wordmark, the destinations with their green marker, who is signed in at its foot.
    On phones the same navigation becomes the bottom tab row. */
export function Rail({ state, nav = [], current }: { state?: D; nav?: Destination[]; current?: string }) {
  const paid = state?.batches.find((b: D) => b.status === 'reimbursed');
  return <aside className="rail" aria-label="Workspace">
    <Brand />
    {state && <nav className="nav" aria-label="Coaster">
      {nav.map(d => <a key={d.view} href={`#/${d.view}`} className={current === d.view ? 'active' : undefined} aria-current={current === d.view ? 'page' : undefined}>
        <Icon name={d.icon} /><span>{d.label}</span>{d.count ? <span className="nav-count" aria-hidden="true" title={`${d.count} waiting`}>{d.count}</span> : null}
      </a>)}
    </nav>}
    {state && <div className="rail-foot">
      <div className="who-am-i"><Initials name={state.actor.name || state.actor.email} me /><div><p>{state.actor.name || state.actor.email}<small>{roleWords(state.actor)}</small>{state.business && <small>{state.business.name}</small>}</p></div></div>
      {paid && <p className="rail-business"><Icon name="bank" /><span>{batchNumber(paid.number)} paid<br /><span className="muted">{day(paid.paid_on)}</span></span></p>}
    </div>}
  </aside>;
}

/** The top bar: search across claims, today's date and time, and the one ink action. */
export function Topbar({ state, query, onSearch, onNewClaim, onActing }: { state: D; query: string; onSearch: (text: string) => void; onNewClaim?: () => void; onActing: (address: string) => void }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(timer); }, []);
  const menu = useRef<HTMLDetailsElement>(null), name = state.actor.name || state.actor.email, delegate = state.actor.delegate;
  const me = delegate?.email ?? state.actor.email, workFor = state.delegates.filter((g: D) => g.delegate_email === me && g.grantor_email !== state.actor.email);
  const choose = (address: string) => { if (menu.current) menu.current.open = false; onActing(address); };
  return <header className="topbar">
    <Brand />
    <label className="search"><Icon name="search" /><span className="visually-hidden">Search claims</span><input type="search" placeholder="Find a person, claim title or number" value={query} onChange={e => onSearch(e.target.value)} /></label>
    <p className="today" aria-label="Today"><span>{day(now.toISOString())}</span><span>{clock(now)}</span></p>
    {onNewClaim && <button className="button primary" onClick={onNewClaim}><Icon name="plus-circle" />New claim</button>}
    <details className="account-menu" ref={menu}><summary data-tooltip="Account menu" aria-label={`${initials(name)}, signed in as ${state.actor.email}`}><Initials name={name} me /></summary>
      <div className="account-card"><p>{name}</p><small>{state.actor.email}</small><small>{roleWords(state.actor)}</small>{state.business && <small>{state.business.name}</small>}
        {delegate && <small>Acting as {delegate.name}, {delegate.level === 'full' ? 'Full' : 'Submit only'} delegate</small>}
        {(delegate || workFor.length > 0) && <div className="act-for"><small>Work as a delegate for</small>
          {delegate && <button className="button small" onClick={() => choose('')}>My own work</button>}
          {workFor.map((g: D) => <button key={g.id} className="button small" onClick={() => choose(g.grantor_email)}>{state.names[g.grantor_email] ?? g.grantor_email}</button>)}
        </div>}
      </div>
    </details>
  </header>;
}

/** True at the widths where the panel sits beside the work (shell.css: 1024 px and wider). */
export function useDesktop() {
  const query = '(min-width: 1024px)';
  const [desktop, setDesktop] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query), update = () => setDesktop(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return desktop;
}

/** True inside a selected panel that replaces the column on phones (shell.css), where it is the page's main content. */
const Replacing = createContext(false);

/** A work panel: complementary beside the column, or, where it replaces the column on phones, the page's main
    landmark with its name as the screen-reader page title (A11Y-001). Only the role changes across the breakpoint,
    never the element, so a panel keeps what the person has entered when the width crosses 1024 px. */
export function Side({ className, label, children }: { className: string; label: string; children: ReactNode }) {
  const main = useContext(Replacing);
  return <section className={className} role={main ? 'main' : 'complementary'} aria-label={label}>
    {main && <h1 className="visually-hidden">{label}</h1>}{children}
  </section>;
}

/** The work area: the main column and, when there is one, the panel at its right (the pick's exception panel). On
    phones a selected panel replaces the hidden column and is the page's main landmark. */
export function Work({ children, panel, wide = false, selected = false, className = '' }: { children: ReactNode; panel?: ReactNode; wide?: boolean; selected?: boolean; className?: string }) {
  const layout = panel ? wide ? ' with-wide-panel' : ' with-panel' : '';
  const desktop = useDesktop();
  return <div className={`content${layout}${selected ? ' has-selection' : ''}`}>
    <main className={`work ${className}`.trim()}>{children}</main>
    <Replacing.Provider value={!!panel && selected && !desktop}>{panel}</Replacing.Provider>
  </div>;
}
