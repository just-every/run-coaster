// Shared by the root renderer and the no-JavaScript first-run document.
// Coaster's faces are declared in public/rer-theme.css; these preload the two Latin files every page paints with.
export const fontLinks = [
  { rel: 'preload', href: '/fonts/instrument-sans/instrument-sans-latin-wght-normal.woff2', as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
  { rel: 'preload', href: '/fonts/newsreader/newsreader-latin-opsz-normal.woff2', as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
] as const

export const fontHead = fontLinks.map(link => `<link ${Object.entries(link).map(([name, value]) => `${name.toLowerCase()}="${value}"`).join(' ')}>`).join('')
