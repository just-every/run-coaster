import { Brand } from './Brand';
import { links } from './links';
import './styles.css';

/** The run site's header: the mark and name, then Docs, Contract and Source. */
export function SiteHeader({ current }: { current?: 'docs' }) {
  return (
    <header className="site-header">
      <div className="site-wrap site-header-row">
        <Brand />
        <nav className="site-nav" aria-label="Site">
          <a href={links.docs} aria-current={current === 'docs' ? 'page' : undefined}>Docs</a>
          <a href={links.contract}>Contract</a>
          <a href={links.source}>Source</a>
        </nav>
      </div>
    </header>
  );
}
