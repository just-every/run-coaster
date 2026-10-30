import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { build } from 'esbuild';

const styles = ['/fonts/fonts.css', '/rer-theme.css', ...['base', 'shell', 'work', 'panel', 'pages'].map(name => `/app/${name}.css`)];
const types = { '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

/** Compile the production App. Only its HTML entry and public assets are served by Playwright. */
export async function payrollBrowserRuntime() {
  const bundle = await build({
    stdin: {
      contents: "import {createRoot} from 'react-dom/client'; import {App} from './src/ui/app.tsx'; createRoot(document.getElementById('root')).render(<App />);",
      resolveDir: process.cwd(), sourcefile: 'payroll-browser-entry.tsx', loader: 'tsx',
    },
    bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Coaster payroll browser proof</title>${styles.map(href => `<link rel="stylesheet" href="${href}">`).join('')}</head><body><div id="root"></div><script type="module" src="/payroll-browser-app.js"></script></body></html>`;
  const publicRoot = resolve('public');
  return async function attach(context, h) {
    const forwarded = [], unexpected = [];
    const split = h.owner.indexOf('=');
    assert.ok(split > 0, 'harness provides a real native-session cookie');
    await context.addCookies([{ name: h.owner.slice(0, split), value: h.owner.slice(split + 1), url: h.origin, httpOnly: true, sameSite: 'Lax' }]);
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== h.origin) { unexpected.push(request.url()); await route.abort('blockedbyclient'); return; }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
        forwarded.push({ method: request.method(), path: url.pathname });
        await route.continue(); // Real HTTP to the Miniflare Worker; no API response is intercepted.
        return;
      }
      if (url.pathname === '/app') { await route.fulfill({ status: 200, contentType: 'text/html', body: html }); return; }
      if (url.pathname === '/payroll-browser-app.js') { await route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle.outputFiles[0].text }); return; }
      const path = resolve(publicRoot, '.' + decodeURIComponent(url.pathname));
      assert.ok(path.startsWith(publicRoot + sep), 'static asset stays under the actual public directory');
      try { await route.fulfill({ status: 200, contentType: types[extname(path)] ?? 'application/octet-stream', body: await readFile(path) }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await route.continue(); }
    });
    return { forwarded, unexpected };
  };
}

/** The same real tooltip must appear immediately on focus and after its hover delay. */
export async function tooltipProof(page, control) {
  await control.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await control.focus();
  const focused = await control.evaluate(element => {
    const tip = getComputedStyle(element, '::after');
    return { content: tip.content, visibility: tip.visibility, opacity: tip.opacity };
  });
  assert.ok(focused.content && !['none', 'normal', '""'].includes(focused.content), 'focused icon control exposes tooltip text');
  assert.equal(focused.visibility, 'visible', 'tooltip is immediately visible on focus');
  assert.equal(focused.opacity, '1');
  await control.evaluate(element => element.blur());
  await page.mouse.move(0, 0);
  await control.hover();
  assert.equal(await control.evaluate(element => getComputedStyle(element, '::after').visibility), 'hidden', 'hover tooltip waits before appearing');
  await page.waitForTimeout(350);
  assert.equal(await control.evaluate(element => getComputedStyle(element, '::after').visibility), 'visible', 'hover tooltip appears after the short delay');
  await page.mouse.move(0, 0);
}

export async function noOverflow(page) {
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  assert.ok(dimensions.document <= dimensions.viewport + 1, `page fits its viewport: ${JSON.stringify(dimensions)}`);
}
