import type { ReactNode } from 'react';

/** One differentiator: an eyebrow, a plain headline, one or two lines, and one small slip. `flip` puts the slip first. */
export function Feature({ id, eyebrow, title, children, drawing, flip = false }: { id: string; eyebrow: string; title: string; children: ReactNode; drawing: ReactNode; flip?: boolean }) {
  return (
    <section id={id} className={`land-feature${flip ? ' land-feature-flip' : ''}`} aria-labelledby={`${id}-title`}>
      <div className="site-wrap land-feature-grid">
        <div className="land-copy">
          <p className="site-eyebrow">{eyebrow}</p>
          <h2 id={`${id}-title`} className="land-h2">{title}</h2>
          <p className="land-body">{children}</p>
        </div>
        <div className="land-drawing">{drawing}</div>
      </div>
    </section>
  );
}
