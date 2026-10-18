import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { contractPageHtml } from '../base/contract-page';
import { runPageHtml, siteNotFoundHtml, type SiteBuild, type SiteContext } from '../base/run-site';
import { fontLinks } from '../base/font-head';
import { identity } from '../identity';
import { DocsArticle } from './docs/DocsArticle';
import { DocsIndex } from './docs/DocsIndex';
import { docsLead, docsPages } from './docs/pages';
import { keepWhole } from './landing/keep-whole';
import { Landing } from './landing/Landing';
import { run } from './run';

// Code cards get their Copy button only when script runs; without it the command is still there to select. A card
// whose shown code carries a prompt or comment names the exact command in data-copy.
const COPY = "document.querySelectorAll('.docs-copy').forEach(b=>{b.hidden=false;b.addEventListener('click',async()=>{const c=b.closest('[data-copy]');try{await navigator.clipboard.writeText(c?c.dataset.copy:b.closest('.docs-code').querySelector('code').textContent);b.textContent='Copied';setTimeout(()=>{b.textContent='Copy'},1600)}catch{}})})";

const SHARE_IMAGE = `${identity.runSite}/site/share.jpg`;

/**
 * The run site (run-coaster.com), written by `rer build --site`: the homepage, whose Run Coaster opens the Run page at
 * `/run`; the docs at `/docs` and `/docs/<slug>`, rendered from the repository's docs/*.md; `/contract`, rendered from
 * CONTRACT.md; and the not-found page. Every page is static and links to no instance-only route; only the docs pages
 * and the homepage carry a script, for Copy.
 */
export function sitePages({ styles, contract }: SiteContext): SiteBuild {
  const document = (title: string, description: string, body: ReactElement, script = '') => '<!doctype html>' + renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={description} />
        <meta name="theme-color" content="#ffffff" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Coaster" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:image" content={SHARE_IMAGE} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="icon" type="image/svg+xml" href="/favicon-32.svg" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        {fontLinks.map(link => <link key={link.href} {...link} />)}
        <link rel="stylesheet" href={identity.theme} />
        {styles.map(href => <link key={href} rel="stylesheet" href={href} />)}
      </head>
      <body>{body}{script ? <script dangerouslySetInnerHTML={{ __html: script }} /> : null}</body>
    </html>,
  );
  return {
    pages: [
      { path: '/', html: keepWhole(document('Coaster: snap the receipt, Coaster does the rest', 'Free, open source expense management: receipts read, cards matched, approvals chased, employees paid by ACH and the books synced. An alternative to Expensify, SAP Concur and Emburse.', <Landing />, COPY)) },
      { path: '/run', html: runPageHtml(identity, run, contract) },
      ...(contract ? [{ path: '/contract', html: contractPageHtml(identity, run, contract) }] : []),
      { path: '/docs', html: document('Docs · Coaster', docsLead, <DocsIndex />) },
      ...docsPages.map(page => ({ path: `/docs/${page.slug}`, html: document(`${page.title} · Coaster docs`, page.summary, <DocsArticle slug={page.slug} />, COPY) })),
      { path: '/404', html: siteNotFoundHtml(identity, run, contract) },
    ],
    assets: ['rer-theme.css', 'fonts', 'brand', 'site', 'favicon.ico', 'favicon-32.svg', 'favicon-32.png', 'apple-touch-icon.png'],
  };
}
