import { run } from '../run';

/** Where the run site's chrome points: the docs and the public source. It never links an instance-only route. */
export const links = { home: '/', run: '/run', docs: '/docs', source: run.repository } as const;
export const docsPath = (slug: string) => `/docs/${slug}`;
