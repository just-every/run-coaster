import type { DocsTocEntry } from './types';

/** The page's h2s; a page with fewer than two gets no contents list. */
const headings = (toc: DocsTocEntry[]) => toc.filter(entry => entry.depth === 2);

function TocList({ toc }: { toc: DocsTocEntry[] }) {
  return <ul>{headings(toc).map(entry => <li key={entry.id}><a href={`#${entry.id}`}>{entry.text}</a></li>)}</ul>;
}

/** "On this page", beside the article on wide screens. */
export function DocsToc({ toc }: { toc: DocsTocEntry[] }) {
  if (headings(toc).length < 2) return null;
  return <nav className="docs-toc" aria-labelledby="docs-toc-title"><p className="docs-toc-title" id="docs-toc-title">On this page</p><TocList toc={toc} /></nav>;
}

/** The same list above the article on narrower screens, folded until asked for. */
export function DocsTocCompact({ toc }: { toc: DocsTocEntry[] }) {
  if (headings(toc).length < 2) return null;
  return <details className="docs-toc-compact"><summary>On this page</summary><TocList toc={toc} /></details>;
}
