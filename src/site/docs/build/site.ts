import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DocsBody, DocsSection } from '../types.ts';
import { docsDirectory, manifestPath, readManifest } from './manifest.ts';
import { renderMarkdown } from './render.ts';
import { agentCatalogue, catalogueStart, catalogueEnd, renderAgentCatalogue, type AgentSurface } from '../../../coaster/agent-door/documentation.ts';

// The whole docs site from the tree as it is: every page in docs/site.json rendered, every link to another docs page and
// every anchor checked, and nothing that names a build machine's paths. Any problem fails the build with the full list.

export type DocsSite = { sections: DocsSection[]; bodies: Record<string, DocsBody>; files: string[] };

/** An absolute path on the build machine must never reach a published page. */
const machinePath = /(?<![\w.@~-])\/(?:Users|home|private|tmp|var|Volumes|root)\/[^\s"'`<\\]*/g;

export function buildDocs(root: string): DocsSite {
  const sections = readManifest(root);
  const pages = sections.flatMap(section => section.pages);
  const surfaceFile = join(root, 'agent-surface.json');
  const surface = JSON.parse(readFileSync(surfaceFile, 'utf8')) as AgentSurface;
  const catalogue = agentCatalogue(surface);
  const fixtures = catalogue.fixtureFiles.map(file => join(root, file));
  for (const fixture of fixtures) {
    if (!statSync(fixture).isFile()) throw new Error('Agent catalogue: verification reference is not a test module');
  }
  const files = [join(root, manifestPath), surfaceFile, ...fixtures,
    ...['tools.ts', 'resources.ts', 'prompts.ts', 'documentation.ts'].map(file => join(root, 'src/coaster/agent-door', file))];
  const rendered = new Map(pages.map(page => {
    const file = join(root, docsDirectory, page.file);
    files.push(file);
    const markdown = readFileSync(file, 'utf8');
    return [page.slug, renderMarkdown(page.slug === 'agents' ? renderAgentCatalogue(markdown, surface).replace(catalogueStart, '').replace(catalogueEnd, '') : markdown)] as const;
  }));
  const problems: string[] = [];
  for (const page of pages) {
    const { html, links, problems: own } = rendered.get(page.slug)!;
    const report = (problem: string) => problems.push(`${docsDirectory}/${page.file}: ${problem}`);
    own.forEach(report);
    for (const href of links) {
      if (/^(?:https?:|mailto:)/i.test(href)) continue;
      const local = /^\/docs(?:\/([^#?/]+))?\/?(?:#(.+))?$/.exec(href);
      const inPage = /^#(.+)$/.exec(href);
      if (inPage) {
        if (!rendered.get(page.slug)!.ids.includes(inPage[1])) report(`links to ${href}, which is not a heading on this page`);
      } else if (!local) report(`links to ${href}; link to other pages as /docs/<slug>, or use a full https:// address`);
      else if (local[1] && !rendered.has(local[1])) report(`links to ${href}, but docs/site.json has no page "${local[1]}"`);
      else if (local[2] && !(local[1] ? rendered.get(local[1])!.ids : []).includes(local[2])) report(`links to ${href}, which is not a heading on that page`);
    }
    for (const leak of new Set(html.match(machinePath) ?? [])) report(`contains ${leak}, a build machine path`);
  }
  if (problems.length) throw new Error(`Docs: ${problems.length} problem(s) in the Markdown:\n- ${problems.join('\n- ')}`);
  const bodies = Object.fromEntries(pages.map(page => {
    const { html, toc } = rendered.get(page.slug)!;
    return [page.slug, { html, toc }];
  }));
  return { sections, bodies, files };
}
