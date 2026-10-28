// rer's hydration checker can resolve a different Playwright release from the
// browser suites. Install its own pinned shell too; never assume the revisions
// are interchangeable or let hydration discover the missing browser at the end.
import { spawnSync } from 'node:child_process'
import { checkoutPlaywright } from '@runeditrun/rer/internal/cli/browser-runtime.mjs'

const { cli } = checkoutPlaywright(process.cwd())
const result = spawnSync(process.execPath, [cli, 'install', '--only-shell', 'chromium'], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
