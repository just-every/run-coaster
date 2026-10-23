// Shared by the root renderer and the no-JavaScript first-run document.
// Coaster's faces are declared in public/rer-theme.css; these preload the two Latin files every page paints with (Archivo headings, Inter text)
// and link /fonts/fonts.css, the rest of Coaster's look (the theme holds only what rer's theme reader takes).
export const fontLinks = [
  { rel: 'preload', href: '/fonts/archivo/archivo-latin-wdth-normal.woff2', as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
  { rel: 'preload', href: '/fonts/inter/inter-latin-wght-normal.woff2', as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
  { rel: 'stylesheet', href: '/fonts/fonts.css' },
] as const

export const fontHead = fontLinks.map(link => `<link ${Object.entries(link).map(([name, value]) => `${name.toLowerCase()}="${value}"`).join(' ')}>`).join('')
