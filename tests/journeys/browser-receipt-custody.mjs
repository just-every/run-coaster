// Private receipt custody through native screens and the installation archive door.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { command, fresh, freePort, start } from '../browser-runtime.mjs'
import { PEOPLE, api, session, setUp, inviteRestoredPerson } from '../browser-journey.mjs'
import { records, rows, tampered, rejectCaptureLifecycleArchives } from '../browser-archive.mjs'
import { receiptDispositionScreens, assertRestoredInbox, expandedReasonJourney, assertReceiptRolePrivacy } from './screens-receipt-custody.mjs'

const launch = () => chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--use-mock-keychain', '--password-store=basic', '--no-sandbox'] })

/** Run inside the surviving receipt journey; this module registers no tests. */
export async function runReceiptCustodyJourney({ evidence = resolve('.cache/coaster-browser-proof/receipt-custody') } = {}) {
  await mkdir(evidence, { recursive: true })
  const shots = []
  let root, second, server, browser
  try {
    root = await fresh()
    const port = await freePort()
    await command(root, ['setup', '--owner-email', 'owner@harbourfinch.example', '--port', String(port)])
    server = await start(root, port)
    browser = await launch()
    const owner = await session(browser, root, server.origin, 'owner', 1440)
    try {
      await setUp(owner, server.origin)
      const originals = []
      for (const width of [1440, 390]) {
        const captured = await receiptDispositionScreens(browser, root, server.origin, width, evidence, shots)
        originals.push(...captured.receipts)
      }
      await assertReceiptRolePrivacy(browser, root, server.origin, originals, owner)
      await expandedReasonJourney(browser, root, server.origin, owner)
    } finally { await owner.context.close() }
    const employee = await session(browser, root, server.origin, 'employee', 390)
    let captured
    try { captured = (await api(employee.context, server.origin, 'receipt-inbox')).receipts }
    finally { await employee.context.close() }
    await browser.close(); browser = undefined
    await server.close(); server = undefined
    await command(root, ['export', '--output', 'exports/capture.rer'])
    const archive = join(root, 'exports/capture.rer')

    second = await fresh()
    const secondPort = await freePort()
    await command(second, ['setup', '--owner-email', 'owner@harbourfinch.example', '--port', String(secondPort)])
    await mkdir(join(second, 'exports'), { recursive: true })
    await command(second, ['export', '--output', 'exports/empty.rer'])
    const empty = rows(await records(join(second, 'exports/empty.rer')))
    await writeFile(join(second, 'exports/inconsistent.rer'), await tampered(archive, 'c_capture_receipts', row => { row.size += 1 }), { mode: 0o600 })
    assert.match(await command(second, ['import', '--input', 'exports/inconsistent.rer', '--yes'], { expected: 4 }), /coaster_capture_bytes/)
    await command(second, ['export', '--output', 'exports/after-refusal.rer'])
    assert.deepEqual(rows(await records(join(second, 'exports/after-refusal.rer'))), empty, 'inconsistent R2/D1 receipt archive writes nothing')
    await rejectCaptureLifecycleArchives(second, archive)
    await copyFile(archive, join(second, 'exports/capture.rer'))
    await command(second, ['import', '--input', 'exports/capture.rer', '--yes'])
    await command(second, ['export', '--output', 'exports/restored.rer'])
    assert.deepEqual(rows(await records(join(second, 'exports/restored.rer'))), rows(await records(archive)), 'receipt rows and original R2 payloads survive restore')
    server = await start(second, secondPort)
    browser = await launch()
    const destinationOwner=await session(browser,second,server.origin,'owner',1440)
    await inviteRestoredPerson(destinationOwner.context,server.origin,PEOPLE.employee)
    await destinationOwner.context.close()
    const restored = await session(browser, second, server.origin, 'employee', 390)
    try { await assertRestoredInbox(restored.context, server.origin, captured) }
    finally { await restored.context.close() }

    // Erasure removes employee identity while preserving every original and its hash.
    const erasing = await session(browser, second, server.origin, 'owner', 1440)
    let erased
    try {
      await api(erasing.context, server.origin, 'settings/members', { email: PEOPLE.employee, name: 'Sam Taylor', employee: true, active: false })
      erased = await api(erasing.context, server.origin, 'settings/members/erase', { email: PEOPLE.employee })
      assert.deepEqual(erased.retained.receiptSha256, [...new Set(captured.map(r => r.sha256))].sort())
    } finally { await erasing.context.close() }
    await browser.close(); browser = undefined
    await server.close(); server = undefined
    await command(second, ['export', '--output', 'exports/erased.rer'])
    const erasedRows = rows(await records(join(second, 'exports/erased.rer')))
    for (const row of erasedRows.filter(row => ['c_capture_receipts', 'c_capture_receipt_events', 'c_capture_lifecycle'].includes(row.table)))
      assert.ok(!JSON.stringify(row).includes(PEOPLE.employee), 'erasure removes employee identity from inbox provenance/history')
    const dispositions = erasedRows.filter(row => row.table === 'c_capture_lifecycle')
    assert.equal(dispositions.length, 7, 'three discards, two merges and two expanded-reason discards')
    const reasoned = dispositions.filter(item => item.row.reason.includes('kept this duplicate'))
    assert.equal(reasoned.length, 5, 'every ordinary discard and merge retains its redacted reason')
    for (const { row } of reasoned) {
      assert.ok(row.reason.includes(erased.label) && row.reason.includes(erased.retained.subject))
      assert.ok(!/Sam Taylor|employee@dev\.localhost/i.test(row.reason))
      assert.ok(row.reason.includes('kept this duplicate for the records'))
    }
    return { shots, receipts: captured.length }
  } finally {
    try { await browser?.close() }
    finally {
      try { await server?.close() }
      finally {
        if (second) await rm(second, { recursive: true, force: true })
        if (root) await rm(root, { recursive: true, force: true })
      }
    }
  }
}
