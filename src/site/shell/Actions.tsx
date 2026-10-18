import { links } from './links';

const Arrow = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5" /></svg>;

/** Run Coaster (to /run) and its text links: the hosted demo and the docs. The closing drops the demo. */
export function Actions({ demo = true }: { demo?: boolean }) {
  return (
    <div className="site-actions">
      <a className="site-pill" href={links.run}>Run Coaster<Arrow /></a>
      {demo && <a className="site-link" href={links.demo}>Try the demo</a>}
      <a className="site-link" href={links.docs}>Read the docs</a>
    </div>
  );
}
