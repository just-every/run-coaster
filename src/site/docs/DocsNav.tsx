import { Icon } from '../../ui/icons';
import { docsPath } from '../shell/links';
import { docsSections } from './pages';

/** The sections and their pages, the current one marked. `idPrefix` keeps the sidebar's and the phone menu's ids apart. */
function DocsNavList({ current, idPrefix }: { current?: string; idPrefix: string }) {
  return (
    <>
      {docsSections.map((section, index) => (
        <div className="docs-nav-group" key={section.title}>
          <p className="docs-nav-section" id={`${idPrefix}-${index}`}>{section.title}</p>
          <ul aria-labelledby={`${idPrefix}-${index}`}>
            {section.pages.map(page => (
              <li key={page.slug}><a href={docsPath(page.slug)} aria-current={page.slug === current ? 'page' : undefined}>{page.title}</a></li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/** The navigation beside the page on wide screens. Without a current page it is the docs home's, and "All docs" is current. */
export function DocsSidebar({ current }: { current?: string }) {
  return (
    <nav className="docs-sidebar" aria-label="Docs">
      <a className="docs-sidebar-home" href="/docs" aria-current={current ? undefined : 'page'}>All docs</a>
      <DocsNavList current={current} idPrefix="docs-sidebar" />
    </nav>
  );
}

/** The same navigation on phones: one pill that unfolds the whole list, with no script. */
export function DocsMenu({ current, label }: { current: string; label: string }) {
  return (
    <nav className="docs-menu" aria-label="Docs menu">
      <details>
        <summary><Icon name="lines" /><span className="docs-menu-name">Docs menu</span><span className="docs-menu-current">{label}</span></summary>
        <div className="docs-menu-list"><a className="docs-sidebar-home" href="/docs">All docs</a><DocsNavList current={current} idPrefix="docs-menu" /></div>
      </details>
    </nav>
  );
}
