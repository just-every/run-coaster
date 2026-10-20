// Focused CAPTURE-001 browser/CLI journey; the full Verify wall imports the same journey.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { command, fresh, freePort, start } from './browser-runtime.mjs'
import { PEOPLE, api, session, setUp } from './browser-journey.mjs'
import { captureJourney, assertRestoredInbox } from './browser-capture.mjs'
import { captureFiles } from './fixtures/capture-files.mjs'
import { records, rows, tampered } from './browser-archive.mjs'

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/capture-proof')
await mkdir(evidence, { recursive: true })
const launch = () => chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] })
let root, second, server, browser
try {
  root = await fresh()
  await command(root, ['install'])
  const port = await freePort()
  await command(root, ['setup', '--owner-email', 'owner@harbourfinch.example', '--port', String(port)])
  server = await start(root, port); browser = await launch()
  const owner = await session(browser, root, server.origin, 'owner', 1440)
  await setUp(owner, server.origin)
  const { files } = await captureFiles(), shots = []
  for (const width of [1440, 390]) await captureJourney(browser, root, server.origin, width, evidence, shots, files)
  const employee = await session(browser, root, server.origin, 'employee', 390)
  const captured = (await api(employee.context, server.origin, 'receipt-inbox')).receipts
  await employee.context.close(); await owner.context.close()
  await browser.close(); browser = undefined; await server.close(); server = undefined
  await command(root, ['export', '--output', 'exports/capture.rer'])
  const archive = join(root, 'exports/capture.rer')
  await copyFile(archive, join(evidence, 'capture.rer'))

  second = await fresh()
  await command(second, ['install'])
  const secondPort = await freePort()
  await command(second, ['setup', '--owner-email', 'owner@harbourfinch.example', '--port', String(secondPort)])
  await mkdir(join(second, 'exports'), { recursive: true })
  await command(second, ['export', '--output', 'exports/empty.rer'])
  const empty = rows(await records(join(second, 'exports/empty.rer')))
  await writeFile(join(second, 'exports/inconsistent.rer'), await tampered(archive, 'c_capture_receipts', row => { row.size += 1 }), { mode: 0o600 })
  assert.match(await command(second, ['import', '--input', 'exports/inconsistent.rer', '--yes'], { expected: 4 }), /coaster_capture_bytes/)
  await command(second, ['export', '--output', 'exports/after-refusal.rer'])
  assert.deepEqual(rows(await records(join(second, 'exports/after-refusal.rer'))), empty, 'inconsistent R2/D1 receipt archive writes nothing')
  await copyFile(archive, join(second, 'exports/capture.rer'))
  await command(second, ['import', '--input', 'exports/capture.rer', '--yes'])
  await command(second, ['export', '--output', 'exports/restored.rer'])
  assert.deepEqual(rows(await records(join(second, 'exports/restored.rer'))), rows(await records(archive)), 'receipt rows and original R2 payloads survive restore')
  server = await start(second, secondPort); browser = await launch()
  const restored = await session(browser, second, server.origin, 'employee', 390)
  await assertRestoredInbox(restored.context, server.origin, captured)
  await restored.context.close()
  // Existing ERASURE-001 removes new provenance addresses too; preserved originals keep their hashes.
  const erasing = await session(browser, second, server.origin, 'owner', 1440)
  await api(erasing.context, server.origin, 'settings/members', { email: PEOPLE.employee, name: 'Sam Taylor', employee: true, active: false })
  const erased = await api(erasing.context, server.origin, 'settings/members/erase', { email: PEOPLE.employee })
  assert.deepEqual(erased.retained.receiptSha256, [...new Set(captured.map(r => r.sha256))].sort())
  await erasing.context.close(); await browser.close(); browser = undefined; await server.close(); server = undefined
  await command(second, ['export', '--output', 'exports/erased.rer'])
  const erasedRows = rows(await records(join(second, 'exports/erased.rer')))
  for (const row of erasedRows.filter(row => ['c_capture_receipts', 'c_capture_receipt_events'].includes(row.table)))
    assert.ok(!JSON.stringify(row).includes(PEOPLE.employee), 'erasure removes employee identity from inbox provenance/history')
  console.log('CAPTURE-001 focused browser intake at 1440/390, refusal, exact R2 archive round trip, inconsistent archive refusal and erasure passed')
} finally {
  await browser?.close(); await server?.close()
  if (second) await rm(second, { recursive: true, force: true })
  if (root) await rm(root, { recursive: true, force: true })
}
