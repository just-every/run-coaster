// Native claim-to-payment and published per diem at both widths, followed by
// immutable archive recovery and the folded receipt, card and provider journeys.
// The emitted production Worker is built once by verify:app and shared by CI.
import { queuedEntrypoint } from '@runeditrun/rer/queued-entry'
const queued = await queuedEntrypoint(import.meta.url, 'test:coaster-browser'); if (queued !== null) process.exit(queued)
import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { command, fresh, freePort, report, start, startCli } from './browser-runtime.mjs'
import { PEOPLE, api, eraseEmployee, journey, ownerScreens, session, setUp } from './browser-journey.mjs'
import { perDiemJourney } from './browser-per-diem.mjs'
import { captureJourney, assertRestoredInbox } from './browser-capture.mjs'
import { prepareArchiveData } from './archive-data.mjs'
import { concurJourney, expensifyJourney } from './journeys/screens-installation-concur.mjs'
import { cutoverJourney, cutoverCarryJourney } from './journeys/screens-installation-cutover.mjs'
import { captureJourney as installationReceiptScreens, expandedReasonJourney } from './journeys/screens-installation-receipts.mjs'
import { captureFiles } from './fixtures/capture-files.mjs'
import { assertRestoredReceiptBytes, records, rejectInconsistentArchives, rows } from './browser-archive.mjs'

// Every phase remains reachable through this public browser test entry point.
const phases = {
  matching: async () => (await import('./journeys/browser-matching.mjs')).runMatchingJourney(),
  capture: async () => {
    const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/receipt-custody-proof')
    await (await import('./journeys/browser-receipt-custody.mjs')).runReceiptCustodyJourney({evidence})
  },
  cash: async () => (await import('./journeys/browser-cash-attachment.mjs')).runCashAttachmentJourney({evidence:resolve(process.env.COASTER_EVIDENCE??'.cache/cash-attachment-proof')}),
  'receipt-agents': async () => (await import('./journeys/browser-receipt-agents.mjs')).runReceiptAgentJourney(),
  'policy-agent': async () => (await import('./journeys/browser-policy-agent.mjs')).runPolicyAgentJourney(),
  signals: async () => (await import('./journeys/browser-signal-investigation.mjs')).runSignalJourney(),
  desktop: async () => (await import('./journeys/browser-desktop-connection.mjs')).runDesktopConnectionJourney(),
}
const selected = process.env.COASTER_BROWSER_JOURNEY
assert.ok(!selected || selected === 'core' || Object.hasOwn(phases,selected),'unknown browser journey')
if(selected && selected !== 'core') { await phases[selected](); process.exit(0) }

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/coaster-browser-proof')
await mkdir(evidence, { recursive: true })
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
let root, second, server, browser
const shots = [], journeys = []
const launch = () => chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] })
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
  root = await fresh({clone:true})
  await command(root, ['install'])
  const port = await freePort()
  await command(root, ['setup', '--owner-email', 'owner@harbourfinch.example', '--port', String(port)])
  await command(root, ['check'])
  await command(root, ['describe'])
  server = await startCli(root, port)
  assert.equal((await fetch(server.origin+'/health')).status,200)
  browser=await launch()
  for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage()
    await page.goto(server.siteOrigin+'/contract')
    await page.screenshot({path:join(evidence,`contract-summary-${width}.png`)})
    const citation=page.locator('tr[data-id="CAPTURE-004"]')
    await citation.scrollIntoViewIfNeeded()
    await citation.screenshot({path:join(evidence,`contract-evidence-${width}.png`)})
    await context.close()
  }
  await browser.close();browser=undefined
  await server.close(); server=undefined
  server = await start(root, port)
  const health=await fetch(server.origin+'/health');assert.equal(health.status,200)
  const healthy=await health.json();assert.equal(healthy.status,'ok');assert.equal(healthy.ok,true)
  assert.deepEqual(Object.keys(healthy.deployment).sort(),['fingerprint','sourceSha','versionId'])
  const home=await fetch(server.origin);assert.equal(home.status,200)
  assert.ok((await home.text()).includes(JSON.parse(await readFile('src/branding.json','utf8')).name))
  assert.equal((await fetch(server.origin+'/api/coaster/state')).status,401)
  for(const path of ['/missing','/api/missing'])assert.equal((await fetch(server.origin+path)).status,404)
  browser = await launch()
  const owner = await session(browser, root, server.origin, 'owner', 1440)
  await setUp(owner, server.origin)
  for(const width of [1440,390])journeys.push(await journey(browser,root,server.origin,width,evidence,shots))
  await ownerScreens(owner, server.origin, 1440, evidence, shots, true)
  await ownerScreens(owner,server.origin,390,evidence,shots,false)
  for(const width of [1440,390])journeys.push(await perDiemJourney(browser,root,server.origin,owner,width,evidence,shots))
  for(const width of [1440,390])await concurJourney(owner,server.origin,width,evidence,shots)
  for(const width of [1440,390])await expensifyJourney(owner,server.origin,width,evidence,shots)
  for(const width of [1440,390]){
    await cutoverJourney(owner,server.origin,width,evidence,shots)
    await cutoverCarryJourney(browser,root,owner,server.origin,width,evidence,shots)
  }
  const installationReceipts=await captureFiles()
  for(const width of [1440,390])await installationReceiptScreens(browser,root,server.origin,width,evidence,shots,installationReceipts.files)
  await expandedReasonJourney(browser,root,server.origin,owner)
  // The retained phone smoke also reads private provenance and discards its original.
  await captureJourney(browser, root, server.origin, 390, evidence, shots)
  const captureEmployee = await session(browser, root, server.origin, 'employee', 1440)
  await prepareArchiveData(owner,captureEmployee,server.origin,server.providers)
  const capturedInbox = (await api(captureEmployee.context, server.origin, 'receipt-inbox')).receipts
  await captureEmployee.context.close()
  const before = await everything(owner.context, server.origin)
  assert.equal(before.batches.length, 6); assert.ok(before.claims.every(c => c.claim.status === 'reimbursed'))
  await owner.context.close(); await browser.close(); browser = undefined; await server.close(); server = undefined

  // Repeated setup, the actual build/preview verbs and the credential-free dry-run refusal.
  await command(root,['setup','--owner-email','owner@harbourfinch.example','--port',String(port)])
  await command(root,['build'])
  server=await startCli(root,port,'preview')
  assert.equal((await fetch(server.origin+'/health')).status,200)
  assert.equal((await fetch(server.origin+'/api/coaster/state')).status,401)
  await server.close();server=undefined
  const dry=await command(root,['deploy','--dry-run'],{expected:3,env:{MAIL_API_KEY:'synthetic-test-mail-api-key',MAIL_FROM:'Coaster <synthetic-coaster-1@coaster.local>'}})
  assert.match(dry,/Your application is built/)
  assert.match(dry,/cannot read the target secret bindings without Cloudflare credentials/)
  assert.doesNotMatch(dry.slice(dry.indexOf('Needed for a real deploy')),/sign-in mail|MAIL_API_KEY/)
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
  const secondPort = await freePort()
  await command(second, ['setup', '--owner-email', 'owner@harbourfinch.example', '--port', String(secondPort)])
  await mkdir(join(second, 'exports'), { recursive: true })
  const bytes = await readFile(archive)
  await writeFile(join(second, 'exports/corrupt.rer'), Buffer.concat([bytes.subarray(0, Math.floor(bytes.length / 2)), Buffer.from('\ncorrupt\n')]), { mode: 0o600 })
  await command(second, ['export', '--output', 'exports/before-corrupt.rer'])
  const beforeCorrupt = rows(await records(join(second, 'exports/before-corrupt.rer')))
  const corrupt = await command(second, ['import', '--input', 'exports/corrupt.rer', '--yes'], { expected: 2 })
  assert.match(corrupt, /Restore refused: the archive is damaged or incomplete/)
  assert.match(corrupt, /Re-export from the original installation with rer export --output/)
  assert.match(corrupt, /Keep the original archive until recovery succeeds/)
  await rejectInconsistentArchives(second, archive)
  await copyFile(archive, join(second, 'exports/installation.rer'))
  await copyFile(later, join(second, 'exports/after-erasure.rer'))
  assert.match(await command(second, ['import', '--input', 'exports/installation.rer', '--journal', 'exports/after-erasure.rer', '--yes'], { expected: 4 }), /erasure_epoch/, 'the archive made before the erasure is refused, naming the erasure')
  await command(second, ['export', '--output', 'exports/after-refusals.rer'])
  assert.deepEqual(rows(await records(join(second,'exports/after-refusals.rer'))),beforeCorrupt,'all three refused restores leave the empty installation unchanged')
  await command(second, ['import', '--input', 'exports/installation.rer', '--yes'])
  // Native accounts stay with each installation; setup claims the new owner
  // after restore, and the owner invites the restored employee again.
  await command(second,['setup','--owner-email','owner@harbourfinch.example','--port',String(secondPort)])
  await command(second, ['export', '--output', 'exports/restored.rer'])
  await copyFile(join(second, 'exports/restored.rer'), join(evidence, 'restored.rer'))
  server = await start(second, secondPort)
  browser = await launch()
  const restoredOwner = await session(browser, second, server.origin, 'owner', 1440)
  const after = await everything(restoredOwner.context, server.origin)
  assert.deepEqual(after, before, 'claims, revisions, decisions, receipts, batches with their releases (PAY-004), history (AUDIT-001) and imported reports survive restore')
  await assertRestoredReceiptBytes(restoredOwner.context, server.origin, before.claims)
  const invitation=await restoredOwner.context.request.post(server.origin+'/auth/invite',{headers:{origin:server.origin},data:{email:PEOPLE.employee,displayName:'Sam Taylor',role:'member',returnTo:'/app'}})
  assert.equal(invitation.status(),202)
  const restoredEmployee = await session(browser, second, server.origin, 'employee', 1440)
  await assertRestoredInbox(restoredEmployee.context, server.origin, capturedInbox)
  await restoredEmployee.context.close()
  const job = after.imported.jobs.find(j => j.source === 'expensify' && j.state === 'completed')
  assert.ok(job, 'the completed Expensify move-in survives alongside undone Concur jobs')
  assert.equal((await api(restoredOwner.context, server.origin, 'import/undo', { source: job.source, id: job.id, mappingVersion: job.mappingVersion })).job.state, 'undone', 'the restored owner can still undo the move-in')
  await restoredOwner.context.close(); await browser.close(); browser = undefined; await server.close(); server = undefined
  assert.deepEqual(rows(await records(join(evidence, 'restored.rer'))), rows(await records(archive)), 'every portable row, every history line included (AUDIT-001), survives export → restore → export')
  await command(second, ['reset', '--yes'])
  await writeFile(join(evidence, 'manifest.json'), JSON.stringify({ commit, business: 'Harbour & Finch Studio (synthetic)', scenario: 'Employee claim with receipts, mileage and an over-limit meal; manager return and approval; finance batch, export and payment; owner Expensify move-in and settings', screenshots: shots }, null, 2) + '\n')
  await report(evidence, { passed: true, commit, journeys, archive: 'export → employee erased → refused corrupt, inconsistent and pre-erasure archives → restore and setup upgrade → identical export; restored owner undid the move-in', screenshots: shots.length })
  console.log(`Browser and CLI proof passed at ${commit}; screenshots and files: ${evidence}`)
} finally {
  await browser?.close(); await server?.close()
  if (second) await rm(second, { recursive: true, force: true })
  if (root) await rm(root, { recursive: true, force: true })
}

if(!selected)for(const run of Object.values(phases))await run()
