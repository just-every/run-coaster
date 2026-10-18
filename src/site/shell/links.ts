import { run } from '../run';

/** Where the run site's chrome points: /run, the docs, the contract, the hosted demo and the public source. It never links an instance-only route. */
export const links = { home: '/', run: '/run', docs: '/docs', contract: '/contract', demo: 'https://demo.run-coaster.com/', source: run.repository } as const;
export const docsPath = (slug: string) => `/docs/${slug}`;
