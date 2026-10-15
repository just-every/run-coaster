import { Icon } from '../../ui/icons';
import { docsPath } from '../shell/links';
import { SiteFooter } from '../shell/SiteFooter';
import { SiteHeader } from '../shell/SiteHeader';
import { DocsSidebar } from './DocsNav';
import { docsLead, docsSections } from './pages';
import './styles.css';

/** The docs home at /docs: the sidebar, then each section's pages as receipt slips in reading order. */
export function DocsIndex() {
  return (
    <div className="site docs">
      <SiteHeader current="docs" />
      <div className="site-wrap docs-shell docs-shell-index">
        <DocsSidebar />
        <main id="main" className="docs-main">
          <header className="docs-page-head">
            <p className="site-eyebrow docs-eyebrow">Coaster</p>
            <h1 className="docs-title">Docs</h1>
            <p className="docs-lead">{docsLead}</p>
          </header>
          {docsSections.map((section, index) => (
            <section className="docs-index-section" key={section.title} aria-labelledby={`docs-section-${index}`}>
              <h2 className="site-eyebrow docs-index-title" id={`docs-section-${index}`}>{section.title}</h2>
              <ul className="docs-index-grid">
                {section.pages.map(page => (
                  <li key={page.slug}><a className="slip docs-index-card" href={docsPath(page.slug)}><span className="docs-index-card-title">{page.title}<Icon name="arrow" /></span><span className="docs-index-card-line">{page.summary}</span></a></li>
                ))}
              </ul>
            </section>
          ))}
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
