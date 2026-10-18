// The pieces every drawing on the homepage is made of: real text in HTML and CSS (styles/kit.css), never screenshots.
// Sizes are design pixels times --p, so a drawing can scale as one piece where the layout needs it.
import type { CSSProperties, ReactNode } from 'react';

/** The one Coaster mark (public/brand/mark.svg). */
export const Mark = ({ className = 'mark' }: { className?: string }) => <img className={className} src="/brand/mark.svg" alt="" width="64" height="64" />;

/** Coaster as the author of a message: the mark on a white tile. */
export const CoasterAvatar = ({ className = '' }: { className?: string }) => <span className={`av av-coaster ${className}`.trim()} aria-hidden="true"><Mark /></span>;

/** A person as initials ("JP"); Jordan is always the sunflower chip. */
export const Initials = ({ children, tone = 'sun', className = '' }: { children: string; tone?: 'sun' | 'mint' | 'tile'; className?: string }) => <span className={`av av-${tone} ${className}`.trim()} aria-hidden="true">{children}</span>;

export const Tick = ({ className = 'tick' }: { className?: string }) => <svg className={className} viewBox="0 0 16 16" aria-hidden="true"><path d="m2.8 8.7 3.3 3.2 7.1-7.4" /></svg>;

/** A filled round state: green done with a check, red failure, grey pending. */
export function Dot({ tone = 'done', className = '' }: { tone?: 'done' | 'fail' | 'wait' | 'alert'; className?: string }) {
  return <svg className={`dot dot-${tone} ${className}`.trim()} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="12" />
    {tone === 'done' && <path d="m7 12.4 3.3 3.2 6.6-6.9" />}
    {tone === 'alert' && <path d="M12 6.5v7M12 17.4v.1" />}
  </svg>;
}

/** A rounded state pill: mint done, red failure, amber waiting, grey tag, outline. */
export function Pill({ tone = 'mint', tick = false, children, className = '' }: { tone?: 'mint' | 'red' | 'amber' | 'tag' | 'line' | 'sun'; tick?: boolean; children: ReactNode; className?: string }) {
  return <span className={`pill pill-${tone} ${className}`.trim()}>{children}{tick && <Tick />}</span>;
}

const POINTER = 'M2 1.5v21.2l5.6-5.4 3.7 8.4 3.9-1.7-3.7-8.3h7.9z';
/** A collaborator's cursor: Megan's green arrow on lime, Dana's dark arrow on lime, Jordan's dark arrow on sunflower. */
export function Cursor({ who, className = '', style }: { who: 'Megan' | 'Dana' | 'Jordan'; className?: string; style?: CSSProperties }) {
  return <span className={`cursor cursor-${who.toLowerCase()} ${className}`.trim()} style={style} aria-hidden="true">
    <svg viewBox="0 0 22 28"><path d={POINTER} /></svg><span>{who}</span>
  </span>;
}

/** A pale yellow sticky note in handwriting. */
export const Sticky = ({ children, className = '' }: { children: ReactNode; className?: string }) => <p className={`sticky ${className}`.trim()}><span>{children}</span><svg viewBox="0 0 120 12" aria-hidden="true"><path d="M3 9c26-5 64-7 113-6" /></svg></p>;

/** The three-stroke green spark doodle. `turn` rotates it in degrees. */
export const Spark = ({ className = '', turn = 0 }: { className?: string; turn?: number }) => <svg className={`spark ${className}`.trim()} viewBox="0 0 40 40" style={{ rotate: `${turn}deg` }} aria-hidden="true"><path d="M8 4l5 9M21 2l-1.5 11M33 9l-8 7" /></svg>;

/** A dashed or dotted green connector, drawn in its own design-pixel box, with an arrowhead at the end of `d`. */
export function Connector({ d, head, w, h, className = '', dotted = false, style }: { d: string; head?: string; w: number; h: number; className?: string; dotted?: boolean; style?: CSSProperties }) {
  return <svg className={`conn ${dotted ? 'conn-dotted' : ''} ${className}`.trim()} viewBox={`0 0 ${w} ${h}`} style={{ ...style, '--w': w, '--h': h } as CSSProperties} aria-hidden="true" fill="none">
    <path d={d} />{head && <path className="conn-head" d={head} />}
  </svg>;
}

const ICONS: Record<string, ReactNode> = {
  mail: <><rect x="3" y="5.5" width="18" height="13" rx="2" /><path d="m3.6 7 8.4 6.2L20.4 7" /></>,
  camera: <><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.6-2.2h5.2L16.2 7h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" /><circle cx="12" cy="12.8" r="3.4" /></>,
  chat: <><path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 15V6.5A1.5 1.5 0 0 1 5 5z" /></>,
  car: <><path d="M5.5 11.5 7.3 7a1.8 1.8 0 0 1 1.7-1.1h6a1.8 1.8 0 0 1 1.7 1.1l1.8 4.5" /><rect x="3.5" y="11.5" width="17" height="5.5" rx="1.6" /><path d="M6 17v2M18 17v2M7 14.3h1.6M15.4 14.3H17" /></>,
  card: <><rect x="3" y="5.5" width="18" height="13" rx="2.2" /><path d="M3 10h18M6.5 14.5h4" /></>,
  doc: <><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5A.5.5 0 0 1 6.5 20V4a.5.5 0 0 1 .5-.5z" /><path d="M14 3.5v4h4M9.5 12h5M9.5 15.5h5" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  plus: <><path d="M12 6v12M6 12h12" /></>,
  arrow: <><path d="M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5" /></>,
  down: <><path d="M12 5v13.5M6.5 13l5.5 5.5 5.5-5.5" /></>,
  list: <><path d="M7 3.5h10a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" /><path d="M9 8.5h6M9 12h6M9 15.5h4" /></>,
};
export const Icon = ({ name, className = '' }: { name: keyof typeof ICONS | string; className?: string }) => <svg className={`icon ${className}`.trim()} viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>;

/** A map pin. */
export const Pin = ({ className = '' }: { className?: string }) => <svg className={`pin ${className}`.trim()} viewBox="0 0 24 32" aria-hidden="true"><path d="M12 31s10-11.6 10-19A10 10 0 0 0 2 12c0 7.4 10 19 10 19z" /><circle cx="12" cy="12" r="4.2" /></svg>;

/** A section's stage-and-date eyebrow, its two-line heading (the second line in the gradient) and its lead. */
export function Heading({ id, eyebrow, first, second, lead, align = 'left', className = '' }: { id: string; eyebrow?: string; first: string; second: string; lead?: ReactNode; align?: 'left' | 'center'; className?: string }) {
  return <header className={`head head-${align} ${className}`.trim()}>
    {eyebrow && <p className="eyebrow">{eyebrow}</p>}
    <h2 id={id}><span className="h-first">{first}</span> <span className="h-second">{second}</span></h2>
    {lead && <p className="lead">{lead}</p>}
  </header>;
}

/** A homepage section: one id, labelled by its heading, inside the page's width. */
export const Section = ({ id, label, className = '', children }: { id: string; label?: string; className?: string; children: ReactNode }) => <section id={id} className={`sec sec-${id} ${className}`.trim()} aria-labelledby={label ?? `${id}-title`}><div className="site-wrap">{children}</div></section>;
