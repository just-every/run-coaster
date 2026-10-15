import { useId, useRef, useState, type ReactNode } from 'react';
import { statusWords, type D } from './api';
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

/** Status in words with a shape, never colour alone. */
const badgeIcons: Record<string, string> = { submitted: 'clock', draft: 'document', proposed: 'document', approved: 'check', reimbursed: 'check', accepted: 'check', batched: 'batches', returned: 'back', rejected: 'cross', declined: 'cross' };
export function Badge({ status, words }: { status: string; words?: string }) {
  return <span className={`chip badge badge-${status}`}><Icon name={badgeIcons[status] ?? 'clock'} />{words ?? statusWords[status] ?? status}</span>;
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

/** Nothing here yet; `large` is the panel-filling state with its document tile and serif title. */
export function Empty({ title, children, large = false }: { title: string; children?: ReactNode; large?: boolean }) {
  return <div className={large ? 'empty empty-large' : 'empty'}>{large && <span className="empty-icon" aria-hidden="true"><Icon name="document" /></span>}<p className="empty-title">{title}</p>{children && <p className="muted">{children}</p>}</div>;
}

export function Section({ title, children, actions, className = '' }: { title: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return <section className={`panel section ${className}`.trim()}><div className="section-head"><h2>{title}</h2>{actions}</div>{children}</section>;
}
