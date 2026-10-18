import { useId, useRef, useState, type ReactNode } from 'react';
import { initials, statusTone, statusWords, type D } from './api';
import { Icon } from './icons';

type Option = { value: string; label: string };
/** A labelled field; any hint is linked by aria-describedby so the label stays exact. */
export function Field({ label, name = label, type = 'text', defaultValue, required = true, options, hint, ...rest }: { label: string; name?: string; type?: string; defaultValue?: any; required?: boolean; options?: Option[]; hint?: string; [key: string]: any }) {
  const id = useId(), hintId = hint ? id + '-hint' : undefined;
  if (type === 'checkbox') return <label className="check"><input type="checkbox" name={name} defaultChecked={!!defaultValue} {...rest} /> {label}</label>;
  const common = { id, name, required, 'aria-describedby': hintId, ...rest };
  const control = options
    ? <select {...common} defaultValue={defaultValue ?? ''}>{!required || defaultValue === undefined ? <option value="">Choose…</option> : null}{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
    : type === 'textarea' ? <textarea {...common} defaultValue={defaultValue} />
    : <input {...common} type={type} defaultValue={defaultValue} />;
  return <div className={type === 'textarea' ? 'field field-wide' : 'field'}><label className="field-label" htmlFor={id}>{label}</label>{control}{hint && <span className="field-hint" id={hintId}>{hint}</span>}</div>;
}

/** A form whose primary action reports its own error beside it and never loses what was typed. */
export function Form({ children, onSubmit, label, className = '', secondary }: { children: ReactNode; onSubmit: (values: D, form: HTMLFormElement) => Promise<any>; label: string; className?: string; secondary?: ReactNode }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <form className={`record-form ${className}`.trim()} onSubmit={async e => {
    e.preventDefault();
    const form = e.currentTarget, values: D = {};
    new FormData(form).forEach((v, k) => { values[k] = v; });
    form.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(box => { values[box.name] = box.checked; });
    setBusy(true); setError('');
    try { await onSubmit(values, form); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }}>{children}<div className="form-end"><button className="button primary" disabled={busy}>{busy ? 'Working…' : label}</button>{secondary}{error && <p className="form-error" role="alert">{error}</p>}</div></form>;
}

/** Status in words with a shape and its colour family (green done, amber waiting, red failed), never colour alone. */
const badgeIcons: Record<string, string> = { submitted: 'clock', draft: 'document', proposed: 'document', approved: 'check', reimbursed: 'check', accepted: 'check', batched: 'check', returned: 'back', rejected: 'cross', declined: 'cross' };
export function Badge({ status, words, tone = statusTone[status] ?? 'quiet' }: { status: string; words?: string; tone?: string }) {
  return <span className={`chip badge badge-${status} tone-${tone}`}><Icon name={badgeIcons[status] ?? 'clock'} /><span>{words ?? statusWords[status] ?? status}</span></span>;
}

/** A person's initials in a round chip, as the pick's table and rail draw people. */
export function Initials({ name, me = false }: { name?: string | null; me?: boolean }) {
  return <span className={me ? 'initials me' : 'initials'} aria-hidden="true">{initials(name)}</span>;
}

/** A screen's heavy title and the counting line under it; `action` repeats the top bar's action on phones. */
export function PageHead({ title, line, action }: { title: string; line?: ReactNode; action?: ReactNode }) {
  return <div className="page-head"><div><h1>{title}</h1>{line && <p>{line}</p>}</div>{action}</div>;
}

/** Three plain tiles; the one marked `wash` is the screen's single lime tile. */
export function Tiles({ tiles, label }: { tiles: { label: string; value: ReactNode; note?: ReactNode; wash?: boolean }[]; label: string }) {
  return <section className="tiles" aria-label={label}>{tiles.map(t => <div key={t.label} className={t.wash ? 'tile wash' : 'tile'}><p className="tile-label">{t.label}</p><strong className="tile-value">{t.value}</strong>{t.note && <span className="tile-note">{t.note}</span>}</div>)}</section>;
}

/** A select with an explicit label, so its name is the label alone (not its options). */
export function Choice({ label, hideLabel = false, className = 'field', children, ...rest }: { label: string; hideLabel?: boolean; className?: string; children: ReactNode; [key: string]: any }) {
  const id = useId();
  return <div className={className}><label htmlFor={id} className={hideLabel ? 'visually-hidden' : 'field-label'}>{label}</label><select id={id} {...rest}>{children}</select></div>;
}

export function Warning({ children }: { children: ReactNode }) {
  return <span className="warning"><span className="warning-mark" aria-hidden="true">!</span><span>{children}</span></span>;
}

/** Exact machine facts kept out of the work view; Escape closes and returns focus. */
export function Details({ label = 'Details', children }: { label?: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  return <details ref={ref} className="disclosure" onKeyDown={e => { if (e.key === 'Escape' && ref.current?.open) { ref.current.open = false; ref.current.querySelector('summary')?.focus(); } }}><summary>{label}</summary><div className="disclosure-body">{children}</div></details>;
}

/** Nothing here yet; `large` is the panel-filling state with the mark's tile and a heavy title. */
export function Empty({ title, children, large = false }: { title: string; children?: ReactNode; large?: boolean }) {
  return <div className={large ? 'empty empty-large' : 'empty'}>{large && <span className="empty-icon" aria-hidden="true"><img src="/brand/mark.svg" alt="" /></span>}<p className="empty-title">{title}</p>{children && <p className="muted">{children}</p>}</div>;
}

export function Section({ title, children, actions, className = '', label }: { title: string; children: ReactNode; actions?: ReactNode; className?: string; label?: string }) {
  return <section className={`panel section ${className}`.trim()} aria-label={label}><div className="section-head"><h2>{title}</h2>{actions}</div>{children}</section>;
}
