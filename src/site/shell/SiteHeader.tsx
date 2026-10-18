import { Brand } from './Brand';
import { links } from './links';

/** The run site's header: the lockup, then Docs, Contract and Source. The docs pages draw it smaller over a hairline. */
export function SiteHeader({ current }: { current?: 'docs' }) {
  return (
    <header className={`site-header${current === 'docs' ? ' site-header-docs' : ''}`}>
      <a className="skip-link" href="#main">Skip to content</a>
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
