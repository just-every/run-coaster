#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';

const mode = process.argv[2];
if (!['write', 'check'].includes(mode) || process.argv.length !== 3) {
  console.error('Usage: node scripts/agent-docs.mjs write|check');
  process.exit(2);
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cache = join(root, '.cache');
mkdirSync(cache, { recursive: true });
const temporary = mkdtempSync(join(cache, 'agent-docs-'));
try {
  // Bundle local TypeScript imports; installed packages keep their normal Node resolution.
  const modulePath = join(temporary, 'documentation.mjs');
  await build({ absWorkingDir: root, entryPoints: ['src/coaster/agent-door/documentation.ts'], outfile: modulePath,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
  const { renderAgentCatalogue, agentFixtureFiles } = await import(pathToFileURL(modulePath).href);
  const surface = JSON.parse(readFileSync(join(root, 'agent-surface.json'), 'utf8'));
  for (const file of agentFixtureFiles(surface)) {
    if (!statSync(join(root, file)).isFile()) throw new Error('Agent catalogue: verification reference is not a test module');
  }
  const file = join(root, 'docs/agents.md');
  const before = readFileSync(file, 'utf8');
  const after = renderAgentCatalogue(before, surface);
  if (mode === 'write') {
    if (after !== before) writeFileSync(file, after);
    console.log('Agent catalogue written to docs/agents.md');
  } else {
    if (after !== before) throw new Error('docs/agents.md catalogue is stale; run node scripts/agent-docs.mjs write');
    console.log('Agent catalogue matches the native registry and conformance fixtures');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  stop();
  rmSync(temporary, { recursive: true, force: true });
}
