// A11Y-001 Verify shard: keyboard-only claim and approval journeys, then axe on every main screen at 1440 and 390.
import { chromium } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { command, fresh, freePort, start } from './browser-runtime.mjs'
import assert from 'node:assert/strict'
import { journey, session, setUp } from './browser-journey.mjs'
import { axeJourney, keyboardJourney } from './browser-accessibility.mjs'

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/keyboard-proof')
await mkdir(evidence, { recursive: true })
let root, server, browser
try {
  root = await fresh()
  await command(root, ['install'])
  const port = await freePort()
  await command(root, ['setup', '--owner-email', 'owner@harbourfinch.example', '--port', String(port)])
  server = await start(root, port)
  browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] })
  const owner = await session(browser, root, server.origin, 'owner', 1440)
  await setUp(owner, server.origin); await owner.context.close()
  const shots = []
  // A paid batch and decided claims give every main screen, detail panels included, real content to audit.
  await journey(browser, root, server.origin, 1440, evidence, shots)
  for (const width of [1440, 390]) await keyboardJourney(browser, root, server.origin, width, evidence, shots)
  for (const width of [1440, 390])
    assert.deepEqual([...await axeJourney(browser, root, server.origin, width)].sort(), ['approvals', 'batches', 'batches/:id', 'claims', 'claims/:id', 'move-in', 'settings'])
} finally {
  await browser?.close(); await server?.close()
  if (root) await rm(root, { recursive: true, force: true })
}
