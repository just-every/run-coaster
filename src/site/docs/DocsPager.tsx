import { Icon } from '../../ui/icons';
import { docsPath } from '../shell/links';
import type { DocsPageMeta } from './types';

/** The previous and next pages in reading order, as two slips torn at the foot. */
export function DocsPager({ previous, next }: { previous?: DocsPageMeta; next?: DocsPageMeta }) {
  if (!previous && !next) return null;
  return (
    <nav className="docs-pager" aria-label="Previous and next pages">
      {previous && <a className="slip slip-foot docs-pager-card" href={docsPath(previous.slug)} rel="prev"><span className="docs-back"><Icon name="arrow" /></span><span className="docs-pager-text"><span className="docs-pager-label">Previous</span><span className="docs-pager-title">{previous.title}</span></span></a>}
      {next && <a className="slip slip-foot docs-pager-card docs-pager-next" href={docsPath(next.slug)} rel="next"><span className="docs-pager-text"><span className="docs-pager-label">Next</span><span className="docs-pager-title">{next.title}</span></span><Icon name="arrow" /></a>}
    </nav>
  );
}
