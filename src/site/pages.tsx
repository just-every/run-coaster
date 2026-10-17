import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { contractPageHtml } from '../base/contract-page';
import { runPageHtml, siteNotFoundHtml, type SiteBuild, type SiteContext } from '../base/run-site';
import { fontLinks } from '../base/font-head';
import { identity } from '../identity';
import { DocsArticle } from './docs/DocsArticle';
import { DocsIndex } from './docs/DocsIndex';
import { docsLead, docsPages } from './docs/pages';
import { Landing } from './landing/Landing';
import { run } from './run';

/**
 * The run site (run-coaster.com), written by `rer build --site`: the homepage, whose Run Coaster opens the Run page at
 * `/run`; the docs at `/docs` and `/docs/<slug>`, rendered from the repository's docs/*.md; `/contract`, rendered from CONTRACT.md; and the not-found page.
 * Every page is static, carries no script and links to no instance-only route.
 */
export function sitePages({ styles, contract }: SiteContext): SiteBuild {
  const document = (title: string, description: string, body: ReactElement) => '<!doctype html>' + renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={description} />
        <meta name="theme-color" content="#FCFBF7" />
        <link rel="icon" type="image/svg+xml" href="/brand/mark.svg" />
        {fontLinks.map(link => <link key={link.href} {...link} />)}
        <link rel="stylesheet" href="/rer-theme.css" />
        <link rel="stylesheet" href="/paper.css" />
        {styles.map(href => <link key={href} rel="stylesheet" href={href} />)}
      </head>
      <body>{body}</body>
    </html>,
  );
  return {
    pages: [
      { path: '/', html: document('Coaster — Receipts in, everyone paid back', identity.tagline, <Landing />) },
      { path: '/run', html: runPageHtml(identity, run, contract) },
      ...(contract ? [{ path: '/contract', html: contractPageHtml(identity, run, contract) }] : []),
      { path: '/docs', html: document('Docs · Coaster', docsLead, <DocsIndex />) },
      ...docsPages.map(page => ({ path: `/docs/${page.slug}`, html: document(`${page.title} · Coaster docs`, page.summary, <DocsArticle slug={page.slug} />) })),
      { path: '/404', html: siteNotFoundHtml(identity, run, contract) },
    ],
    assets: ['rer-theme.css', 'paper.css', 'fonts', 'brand'],
  };
}
