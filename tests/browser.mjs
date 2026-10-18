// Fresh-clone proof of the first release through the screens and the rer verbs:
// the journeys at 1440 and 390 wide with screenshots, then build, preview,
// deploy --dry-run, export, refused tampered archives, restore and reset.
import { queuedEntrypoint } from '@runeditrun/rer/queued-entry'
const queued = await queuedEntrypoint(import.meta.url, 'test:coaster-browser'); if (queued !== null) process.exit(queued)
import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { command, fresh, freePort, report, start } from './browser-runtime.mjs'
import { api, journey, ownerScreens, session, setUp } from './browser-journey.mjs'
import { records, rejectInconsistentArchives, rows } from './browser-archive.mjs'

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/coaster-browser-proof')
await mkdir(evidence, { recursive: true })
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
let root, second, server, browser
const shots = [], journeys = []
const launch = async () => { let installed = true; try { await access(chromium.executablePath()) } catch { installed = false } return chromium.launch({ headless: true, ...(installed ? {} : { channel: 'chrome' }) }) }
/** Everything the owner can see, with each claim's full history, for before/after restore comparison. */
async function everything(context, origin) {
  const state = await api(context, origin, 'state')
  const claims = []
  for (const c of state.claims) claims.push(await api(context, origin, `claims/${c.id}`))
  const batches = []
  for (const b of state.batches) batches.push(await api(context, origin, `batches/${b.id}`))
  return { claims, batches, imported: await api(context, origin, 'import'), members: state.members, categories: state.categories, business: state.business }
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
  const before = await everything(owner.context, server.origin)
  assert.equal(before.batches.length, 2); assert.ok(before.claims.every(c => c.claim.status === 'reimbursed'))
  await owner.context.close(); await browser.close(); browser = undefined; await server.close(); server = undefined

  // A setup rerun keeps every owner and record; the built Worker keeps the session boundary.
  await command(root, ['setup', '--owner-email', 'owner@harbourfinch.example', '--port', String(port)])
  await command(root, ['build'])
  server = await start(root, port, 'preview')
  assert.equal((await fetch(server.origin + '/health')).status, 200)
  assert.equal((await fetch(server.origin + '/api/coaster/state')).status, 401)
  await server.close(); server = undefined
  // Deploy refuses an installation whose owner cannot sign in; this owner has configured Resend (deploy.json). The dry
  // run builds and checks everything local, then, with no Cloudflare credentials, refuses rather than claim it read the
  // target's secrets (rer 0.2.58): what it still needs is only those credentials, never the owner's sign-in mail.
  const dry = await command(root, ['deploy', '--dry-run'], { expected: 3, env: { MAIL_API_KEY: 'synthetic-test-mail-api-key' } })
  assert.match(dry, /Your application is built/)
  assert.match(dry, /cannot read the target secret bindings without Cloudflare credentials/)
  assert.doesNotMatch(dry.slice(dry.indexOf('Needed for a real deploy')), /sign-in mail|MAIL_API_KEY/)
  const archive = join(evidence, 'installation.rer')
  await rm(archive, { force: true })
  await command(root, ['export', '--output', 'exports/installation.rer'])
  await copyFile(join(root, 'exports/installation.rer'), archive)
  await command(root, ['import', '--input', 'exports/installation.rer', '--yes'], { expected: 4 })

  // Restore into a second, empty installation.
  second = await fresh()
  await command(second, ['install'])
  const secondPort = await freePort()
  await command(second, ['setup', '--owner-email', 'restored-owner@harbourfinch.example', '--port', String(secondPort)])
  await mkdir(join(second, 'exports'), { recursive: true })
  const bytes = await readFile(archive)
  await writeFile(join(second, 'exports/corrupt.rer'), Buffer.concat([bytes.subarray(0, Math.floor(bytes.length / 2)), Buffer.from('\ncorrupt\n')]), { mode: 0o600 })
  assert.match(await command(second, ['import', '--input', 'exports/corrupt.rer', '--yes'], { expected: 2 }), /archive_json/)
  await rejectInconsistentArchives(second, archive)
  await copyFile(archive, join(second, 'exports/installation.rer'))
  await command(second, ['import', '--input', 'exports/installation.rer', '--yes'])
  await command(second, ['export', '--output', 'exports/restored.rer'])
  await copyFile(join(second, 'exports/restored.rer'), join(evidence, 'restored.rer'))
  server = await start(second, secondPort)
  browser = await launch()
  const restoredOwner = await session(browser, second, server.origin, 'owner', 1440)
  const after = await everything(restoredOwner.context, server.origin)
  assert.deepEqual(after, before, 'claims, revisions, decisions, receipts, batches, history and imported reports survive restore')
  const receipt = before.claims[0].receipts[0]
  const download = await restoredOwner.context.request.get(`${server.origin}/api/coaster/receipts/${receipt.id}`)
  assert.equal(createHash('sha256').update(await download.body()).digest('hex'), receipt.sha256, 'restored receipt bytes are exact')
  const jobs = after.imported.jobs
  assert.equal((await api(restoredOwner.context, server.origin, 'import/undo', { id: jobs[0].id, mappingVersion: jobs[0].mappingVersion })).job.state, 'undone', 'the restored owner can still undo the move-in')
  await restoredOwner.context.close(); await browser.close(); browser = undefined; await server.close(); server = undefined
  assert.deepEqual(rows(await records(join(evidence, 'restored.rer'))), rows(await records(archive)), 'every portable row survives export → restore → export')
  await command(second, ['reset', '--yes'])
  await writeFile(join(evidence, 'manifest.json'), JSON.stringify({ commit, business: 'Harbour & Finch Studio (synthetic)', scenario: 'Employee claim with receipts, mileage and an over-limit meal; manager return and approval; finance batch, export and payment; owner Expensify move-in and settings', screenshots: shots }, null, 2) + '\n')
  await report(evidence, { passed: true, commit, journeys, archive: 'export → refused corrupt and three inconsistent archives → restore → identical export; restored owner undid the move-in', screenshots: shots.length })
  console.log(`Browser and CLI proof passed at ${commit}; screenshots and files: ${evidence}`)
} finally {
  await browser?.close(); await server?.close()
  if (second) await rm(second, { recursive: true, force: true })
  if (root) await rm(root, { recursive: true, force: true })
}
