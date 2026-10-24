// Fresh-clone proof of the first release through the screens and the rer verbs:
// the journeys at 1440 and 390 wide with screenshots, then build, preview,
// deploy --dry-run, export, refused tampered archives, restore and reset.
import { queuedEntrypoint } from '@runeditrun/rer/queued-entry'
const queued = await queuedEntrypoint(import.meta.url, 'test:coaster-browser'); if (queued !== null) process.exit(queued)
import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { command, fresh, freePort, report, start } from './browser-runtime.mjs'
import { PEOPLE, api, eraseEmployee, journey, ownerScreens, session, setUp } from './browser-journey.mjs'
import { perDiemJourney } from './browser-per-diem.mjs'
import { cutoverJourney, cutoverCarryJourney } from './browser-cutover.mjs'
import { captureJourney, assertRestoredInbox, expandedReasonJourney } from './browser-capture.mjs'
import { captureFiles } from './fixtures/capture-files.mjs'
import { concurJourney, expensifyJourney } from './browser-concur.mjs'
import { assertRestoredReceiptBytes, records, rejectInconsistentArchives, rows } from './browser-archive.mjs'

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/coaster-browser-proof')
await mkdir(evidence, { recursive: true })
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const archiveSlice = process.env.COASTER_ARCHIVE_REFUSALS ?? '0/1'
assert.match(archiveSlice, /^\d+\/[1-9]\d*$/, 'archive refusal slice is part/of')
const [part, of] = archiveSlice.split('/').map(Number)
assert.ok(Number.isSafeInteger(part) && Number.isSafeInteger(of) && part < of, 'archive refusal slice is in range')
let root, second, server, browser
const shots = [], journeys = []
const launch = () => chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] })
/** Everything the owner can see, with each claim's full history, for before/after restore comparison. */
async function everything(context, origin) {
  const state = await api(context, origin, 'state')
  const claims = []
  for (const c of state.claims) claims.push(await api(context, origin, `claims/${c.id}`))
  const batches = []
  for (const b of state.batches) batches.push(await api(context, origin, `batches/${b.id}`))
  const imported = await api(context, origin, 'import')
  // SQLite rowids are installation-local; compare the complete job records by their portable identity.
  imported.jobs.sort((a, b) => a.id.localeCompare(b.id))
  const cutover = await api(context, origin, 'import/cutover'); cutover.imports.sort((a,b)=>a.id.localeCompare(b.id));
  return { claims, batches, imported, cutover, members: state.members, categories: state.categories, business: state.business }
}
try {
  root = await fresh()
  await command(root, ['install'])
  const port = await freePort()
  await command(root, ['setup', '--owner-email', 'owner@harbourfinch.example', '--port', String(port)])
  await command(root, ['check'])
  await command(root, ['describe'])
  server = await start(root, port)
  browser = await launch()
  const owner = await session(browser, root, server.origin, 'owner', 1440)
  await setUp(owner, server.origin)
  for (const width of [1440, 390]) journeys.push(await journey(browser, root, server.origin, width, evidence, shots))
  await ownerScreens(owner, server.origin, 1440, evidence, shots, true)
  await ownerScreens(owner, server.origin, 390, evidence, shots, false)
  for (const width of [1440, 390]) journeys.push(await perDiemJourney(browser, root, server.origin, owner, width, evidence, shots))
  for (const width of [1440, 390]) await concurJourney(owner, server.origin, width, evidence, shots)
  for (const width of [1440, 390]) await expensifyJourney(owner, server.origin, width, evidence, shots)
  for (const width of [1440, 390]) { await cutoverJourney(owner, server.origin, width, evidence, shots); await cutoverCarryJourney(browser, root, owner, server.origin, width, evidence, shots) }
  const captureInputs = await captureFiles()
  for (const width of [1440, 390]) await captureJourney(browser, root, server.origin, width, evidence, shots, captureInputs.files)
  await expandedReasonJourney(browser, root, server.origin, owner)
  const captureEmployee = await session(browser, root, server.origin, 'employee', 390)
  const capturedInbox = (await api(captureEmployee.context, server.origin, 'receipt-inbox')).receipts
  await captureEmployee.context.close()
  const before = await everything(owner.context, server.origin)
  assert.equal(before.batches.length, 6); assert.ok(before.claims.every(c => c.claim.status === 'reimbursed'))
  await owner.context.close(); await browser.close(); browser = undefined; await server.close(); server = undefined

  // A setup rerun keeps every owner and record; the built Worker keeps the session boundary.
  await command(root, ['setup', '--owner-email', 'owner@harbourfinch.example', '--port', String(port)])
  await command(root, ['build'])
  server = await start(root, port, 'preview')
  assert.equal((await fetch(server.origin + '/health')).status, 200)
  assert.equal((await fetch(server.origin + '/api/coaster/state')).status, 401)
  await server.close(); server = undefined
  // Deploy refuses an installation whose owner cannot sign in; this owner supplies the Resend sender input. The dry
  // run builds and checks everything local, then, with no Cloudflare credentials, refuses rather than claim it read the
  // target's secrets (rer 0.2.58): what it still needs is only those credentials, never the owner's sign-in mail.
  const dry = await command(root, ['deploy', '--dry-run'], { expected: 3, env: { MAIL_API_KEY: 'synthetic-test-mail-api-key', MAIL_FROM: 'Coaster <coaster@harbourfinch.com>' } })
  assert.match(dry, /Your application is built/)
  assert.match(dry, /cannot read the target secret bindings without Cloudflare credentials/)
  assert.doesNotMatch(dry.slice(dry.indexOf('Needed for a real deploy')), /sign-in mail|MAIL_API_KEY/)
  const archive = join(evidence, 'installation.rer')
  await rm(archive, { force: true })
  await command(root, ['export', '--output', 'exports/installation.rer'])
  await copyFile(join(root, 'exports/installation.rer'), archive)
  await command(root, ['import', '--input', 'exports/installation.rer', '--yes'], { expected: 4 })

  // ERASURE-001: the owner erases the departed employee in the screens; the later archive holds no trace of them and,
  // supplied as the journal, makes an empty destination refuse the archive made before the erasure.
  server = await start(root, port)
  browser = await launch()
  const erasing = await session(browser, root, server.origin, 'owner', 1440)
  const erasure = await eraseEmployee(erasing, server.origin, before.claims.filter(c => c.claim.employee_email === PEOPLE.employee).map(c => c.claim.number).sort((a, b) => a - b), evidence, shots)
  await erasing.context.close(); await browser.close(); browser = undefined; await server.close(); server = undefined
  await command(root, ['export', '--output', 'exports/after-erasure.rer'])
  const later = join(evidence, 'after-erasure.rer')
  await copyFile(join(root, 'exports/after-erasure.rer'), later)
  const laterRows = JSON.stringify(rows(await records(later)))
  assert.ok(!laterRows.includes(PEOPLE.employee) && laterRows.includes(erasure.retained.subject), 'the later archive carries the opaque subject, never the address')

  // Restore into a second, empty installation.
  second = await fresh()
  await command(second, ['install'])
  const secondPort = await freePort()
  await command(second, ['setup', '--owner-email', 'restored-owner@harbourfinch.example', '--port', String(secondPort)])
  await mkdir(join(second, 'exports'), { recursive: true })
  const bytes = await readFile(archive)
  await writeFile(join(second, 'exports/corrupt.rer'), Buffer.concat([bytes.subarray(0, Math.floor(bytes.length / 2)), Buffer.from('\ncorrupt\n')]), { mode: 0o600 })
  await command(second, ['export', '--output', 'exports/before-corrupt.rer'])
  const beforeCorrupt = rows(await records(join(second, 'exports/before-corrupt.rer')))
  const corrupt = await command(second, ['import', '--input', 'exports/corrupt.rer', '--yes'], { expected: 2 })
  assert.match(corrupt, /Restore refused: the archive is damaged or incomplete/)
  assert.match(corrupt, /Re-export from the original installation with rer export --output/)
  assert.match(corrupt, /Keep the original archive until recovery succeeds/)
  await command(second, ['export', '--output', 'exports/after-corrupt.rer'])
  assert.deepEqual(rows(await records(join(second, 'exports/after-corrupt.rer'))), beforeCorrupt, 'a damaged archive restores nothing and writes no data')
  await rejectInconsistentArchives(second, archive, { part, of })
  await copyFile(archive, join(second, 'exports/installation.rer'))
  await copyFile(later, join(second, 'exports/after-erasure.rer'))
  assert.match(await command(second, ['import', '--input', 'exports/installation.rer', '--journal', 'exports/after-erasure.rer', '--yes'], { expected: 4 }), /erasure_epoch/, 'the archive made before the erasure is refused, naming the erasure')
  await command(second, ['import', '--input', 'exports/installation.rer', '--yes'])
  await command(second, ['export', '--output', 'exports/restored.rer'])
  await copyFile(join(second, 'exports/restored.rer'), join(evidence, 'restored.rer'))
  server = await start(second, secondPort)
  browser = await launch()
  const restoredOwner = await session(browser, second, server.origin, 'owner', 1440)
  const after = await everything(restoredOwner.context, server.origin)
  assert.deepEqual(after, before, 'claims, revisions, decisions, receipts, batches with their releases (PAY-004), history (AUDIT-001) and imported reports survive restore')
  await assertRestoredReceiptBytes(restoredOwner.context, server.origin, before.claims)
  const restoredEmployee = await session(browser, second, server.origin, 'employee', 390)
  await assertRestoredInbox(restoredEmployee.context, server.origin, capturedInbox)
  await restoredEmployee.context.close()
  const job = after.imported.jobs.find(j => j.source === 'expensify' && j.state === 'completed')
  assert.ok(job, 'the completed Expensify move-in survives alongside undone Concur jobs')
  assert.equal((await api(restoredOwner.context, server.origin, 'import/undo', { source: job.source, id: job.id, mappingVersion: job.mappingVersion })).job.state, 'undone', 'the restored owner can still undo the move-in')
  await restoredOwner.context.close(); await browser.close(); browser = undefined; await server.close(); server = undefined
  assert.deepEqual(rows(await records(join(evidence, 'restored.rer'))), rows(await records(archive)), 'every portable row, every history line included (AUDIT-001), survives export → restore → export')
  await command(second, ['reset', '--yes'])
  await writeFile(join(evidence, 'manifest.json'), JSON.stringify({ commit, business: 'Harbour & Finch Studio (synthetic)', scenario: 'Employee claim with receipts, mileage and an over-limit meal; manager return and approval; finance batch, export and payment; owner Expensify move-in and settings', screenshots: shots }, null, 2) + '\n')
  await report(evidence, { passed: true, commit, journeys, archive: 'export → employee erased → refused corrupt, three inconsistent and the pre-erasure archive with the later journal → restore → identical export; restored owner undid the move-in', screenshots: shots.length })
  console.log(`Browser and CLI proof passed at ${commit}; screenshots and files: ${evidence}`)
} finally {
  await browser?.close(); await server?.close()
  if (second) await rm(second, { recursive: true, force: true })
  if (root) await rm(root, { recursive: true, force: true })
}
