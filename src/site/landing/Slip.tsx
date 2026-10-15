import type { ReactNode } from 'react';

/** A thermal receipt slip from paper.css: serrated top and bottom, soft curl, crisp print. */
export function Slip({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`slip land-slip ${className}`.trim()}>{children}</div>;
}

/** A numbered step disc, coral with a white numeral. */
export const Disc = ({ n }: { n: number }) => <span className="land-disc" aria-hidden="true">{n}</span>;

/** A grey tile holding a small line drawing, as receipt and mileage thumbnails are drawn. */
export const Tile = ({ children }: { children: ReactNode }) => <span className="land-tile" aria-hidden="true">{children}</span>;
