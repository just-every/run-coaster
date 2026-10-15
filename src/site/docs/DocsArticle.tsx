import { SiteFooter } from '../shell/SiteFooter';
import { SiteHeader } from '../shell/SiteHeader';
import { DocsMenu, DocsSidebar } from './DocsNav';
import { DocsPager } from './DocsPager';
import { DocsToc, DocsTocCompact } from './DocsToc';
import { docsNeighbours, getDocsPage } from './pages';
import './styles.css';

/** One docs page: the section sidebar, the article rendered from Markdown at build time, and "On this page". */
export function DocsArticle({ slug }: { slug: string }) {
  const page = getDocsPage(slug);
  if (!page) throw new Error(`docs/site.json has no page "${slug}"`);
  const { previous, next } = docsNeighbours(slug);
  return (
    <div className="site docs">
      <SiteHeader current="docs" />
      <div className="site-wrap docs-shell">
        <DocsSidebar current={slug} />
        <main id="main" className="docs-main">
          <DocsMenu current={slug} label={page.title} />
          <article className="docs-article" aria-labelledby="docs-title">
            <header className="docs-page-head">
              <p className="site-eyebrow docs-eyebrow">{page.section}</p>
              <h1 id="docs-title" className="docs-title">{page.title}</h1>
            </header>
            <DocsTocCompact toc={page.toc} />
            <div className="docs-prose" dangerouslySetInnerHTML={{ __html: page.html }} />
          </article>
          <DocsPager previous={previous} next={next} />
        </main>
        <DocsToc toc={page.toc} />
      </div>
      <SiteFooter />
    </div>
  );
}
