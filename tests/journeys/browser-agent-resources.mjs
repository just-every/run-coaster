import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { command, fresh, freePort, start } from '../browser-runtime.mjs'
import { api, inviteRestoredPerson, session, setUp } from '../browser-journey.mjs'
import { records, rows } from '../browser-archive.mjs'
import { assertEventArchive, assertRestoredEvents, proposalEvents } from '../agent-events-archive.mjs'
import { autonomousPolicy } from '../../src/modules/agent-door/conformance/crypto.mjs'
import { claimArguments, linkedProposal, proposalClient, readProposal } from '../agent-door/proposals.mjs'
import { unzip } from './operations-support.mjs'

const ownerAddress = 'owner' + '@' + 'harbourfinch.example'
// Misleading agent names are plain text everywhere they are shown.
const employeeLabel = 'synthetic-coaster-3520 <i>approved by Priya Nair</i>', financeLabel = 'synthetic-coaster-3521'
const day = offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10), period = `from=${day(-2)}&to=${day(2)}`
export async function runAgentResourceJourney({ discover, events = false, issueKey } = {}) {
  const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/agent-resource-proof')
  await mkdir(evidence, { recursive: true })
  let root, restored, server, browser
  const contexts = []
  try {
    root = await fresh(); const port = await freePort()
    await command(root, ['setup', '--owner-email', ownerAddress, '--port', String(port)])
    server = await start(root, port, { site: Boolean(discover) })
    browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] })
    const owner = await session(browser, root, server.origin, 'owner', 1440); contexts.push(owner.context)
    await setUp(owner, server.origin)
    const employee = await session(browser, root, server.origin, 'employee', 1440), manager = await session(browser, root, server.origin, 'manager', 1440), finance = await session(browser, root, server.origin, 'finance', 1440)
    contexts.push(employee.context, manager.context, finance.context)
    const setPolicy = async person => {
      const response = await person.context.request.put(server.origin + '/agents/api/policy', { headers: { origin: server.origin }, data: { document: autonomousPolicy() } })
      assert.equal(response.status(), 200)
    }
    await setPolicy(owner)
    const employeeKey = issueKey ? await issueKey(employee, server.origin, employeeLabel, evidence) : await api(employee.context, server.origin, 'agent-keys', { label: employeeLabel })
    const financeKey = issueKey ? await issueKey(finance, server.origin, financeLabel, evidence) : await api(finance.context, server.origin, 'agent-keys', { label: financeLabel })
    const employeeClient = proposalClient(fetch, server.origin, employeeKey.token), financeClient = proposalClient(fetch, server.origin, financeKey.token)
    if (discover) await discover({ browser, server, client: employeeClient, evidence })
    const state = await api(employee.context, server.origin, 'state')
    const args = claimArguments(state.categories.find(c => c.account_code === '6500').id, 'synthetic-coaster-3522')
    args.items[0].receipt = { name: 'synthetic-coaster-3523.png', base64: (await readFile('tests/fixtures/receipts/bistro.png')).toString('base64') }
    const claim = await linkedProposal(employeeClient, 'coaster.claims.propose', args)
    assert.deepEqual(readProposal(await employeeClient('resources/read', { uri: claim.uri })), claim.proposal)
    const screen = (await api(employee.context, server.origin, 'state')).proposals.find(p => p.id === claim.proposal.id)
    for (const [key, value] of Object.entries(screen)) assert.deepEqual(claim.proposal[key], value)
    await employee.page.reload(); await employee.page.goto(server.origin + '/app#/claims')
    const prepared = employee.page.getByRole('region', { name: 'Prepared for you', exact: true })
    await prepared.getByRole('button', { name: 'Accept as draft', exact: true }).waitFor()
    assert.match(await prepared.innerText(), /synthetic-coaster-3522/)
    assert.match(await prepared.innerText(), /12\.34/)
    const shot = async (person, region, name) => {
      assert.equal(await person.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      for (const width of [1440, 390]) {
        await person.page.setViewportSize({ width, height: 1000 })
        await region.scrollIntoViewIfNeeded()
        await region.screenshot({ path: join(evidence, `${name}-${width}.png`) })
      }
      await person.page.setViewportSize({ width: 1440, height: 1000 })
    }
    // Assert the desktop journey once; capture the same changed screens at both widths.
    const reads = async (person, locator, expected, name, before = async () => {}) => {
      for (const width of [1440, 390]) {
        await person.page.setViewportSize({ width, height: 1000 })
        await before()
        await locator.first().waitFor()
        await locator.first().evaluate(element => element.scrollIntoView({ block: 'center' }))
        if (width === 1440) {
          await expect.poll(async () => (await locator.allInnerTexts()).map(t => t.trim()), { message: `${name} at ${width}` }).toEqual(expected)
          assert.equal(await person.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} fits at ${width}`)
        }
        await person.page.screenshot({ path: join(evidence, `${name}-${width}.png`) })
      }
      await person.page.setViewportSize({ width: 1440, height: 1000 })
    }
    await shot(employee, prepared, 'linked-claim-proposal')
    await prepared.getByRole('button', { name: 'Accept as draft', exact: true }).click()
    await employee.page.getByRole('heading', { name: args.title, exact: true }).waitFor()
    await reads(employee, employee.page.getByRole('region', { name: 'Details', exact: true }).locator('li', { hasText: 'Prepared by' }), [`Prepared by ${employeeLabel} for Sam Taylor, accepted by Sam Taylor`], 'record-claim-attribution')
    const accepted = readProposal(await employeeClient('resources/read', { uri: claim.uri }))
    assert.equal(accepted.status, 'accepted')
    let c = (await api(employee.context, server.origin, `claims/${accepted.result_id}`)).claim
    assert.equal(c.status, 'draft')
    c = await api(employee.context, server.origin, `claims/${c.id}/submit`, { version: c.version })
    c = await api(manager.context, server.origin, `claims/${c.id}/decision`, { version: c.version, revision: c.revision, decision: 'approved' })
    const batch = await linkedProposal(financeClient, 'coaster.batches.propose', { claims: [c.id], note: 'synthetic-coaster-3524' })
    assert.deepEqual(readProposal(await financeClient('resources/read', { uri: batch.uri })), batch.proposal)
    await finance.page.reload(); await finance.page.goto(server.origin + '/app#/batches')
    const batchPrepared = finance.page.getByRole('region', { name: 'Prepared for you', exact: true })
    await batchPrepared.getByRole('button', { name: 'Accept as draft batch', exact: true }).waitFor()
    assert.match(await batchPrepared.innerText(), /1 approved claim/)
    assert.match(await batchPrepared.innerText(), /12\.34/)
    await shot(finance, batchPrepared, 'linked-batch-proposal')
    await batchPrepared.getByRole('button', { name: 'Accept as draft batch', exact: true }).click()
    const acceptedBatch = readProposal(await financeClient('resources/read', { uri: batch.uri }))
    assert.equal(acceptedBatch.status, 'accepted')
    const nativeBatch = await api(finance.context, server.origin, `batches/${acceptedBatch.result_id}`)
    assert.equal(nativeBatch.batch.status, 'draft')
    assert.equal(nativeBatch.batch.total_minor, 1234)
    await finance.page.goto(server.origin + `/app#/batches/${acceptedBatch.result_id}`)
    await reads(finance, finance.page.locator('.panel-amount'), [`1 claim · 1 person · prepared by ${financeLabel} for Morgan Lee, accepted by Morgan Lee`], 'record-batch-attribution')
    const acceptedState = await api(finance.context, server.origin, 'state')
    for (const rpcId of [3808, 3809]) {
      const replay = await financeClient('tools/call', batch.params, rpcId)
      assert.equal(replay.id, rpcId)
      assert.equal(replay.result?.isError, false, JSON.stringify(replay))
      assert.deepEqual(replay.result.structuredContent, batch.proposal, 'accepted batch retry retains the original proposed outcome')
      assert.deepEqual(replay.result.content, batch.result.content, 'accepted batch retry retains the original resource link')
      assert.deepEqual(readProposal(await financeClient('resources/read', { uri: batch.uri })), acceptedBatch, 'resource read returns current accepted state')
      assert.deepEqual(await api(finance.context, server.origin, `batches/${acceptedBatch.result_id}`), nativeBatch, 'retry appends no native batch history or reservations')
      assert.deepEqual(await api(finance.context, server.origin, 'state'), acceptedState, 'retry creates no second proposal or batch and changes no claim')
    }
    const batchPanel = finance.page.locator('.batch-detail')
    await batchPanel.getByRole('heading', { name: /RB-.*12\.34/ }).waitFor()
    assert.match(await batchPanel.innerText(), /Draft/)
    assert.match(await batchPanel.innerText(), /synthetic-coaster-3522/)
    await shot(finance, batchPanel, 'accepted-batch-replay')
    // Activity and the audit pack carry the same attribution; company policy never appears as the accepter.
    await finance.page.goto(server.origin + '/app#/settings')
    const activity = (query, expected, name) => reads(finance, finance.page.locator('.audit-lines li > span'), expected, name, async () => {
      await finance.page.getByLabel('Claim, batch, person or words', { exact: true }).fill(query)
      await finance.page.getByRole('button', { name: 'Search history', exact: true }).click()
    })
    await (activity('claim-proposed', [`Claim proposed by ${employeeLabel} for Sam Taylor`], 'activity-claim-proposed'))
    await (activity('proposal-accepted', [`Prepared by ${employeeLabel} for Sam Taylor and accepted by Sam Taylor`, `Prepared by ${financeLabel} for Morgan Lee and accepted by Morgan Lee`], 'activity-proposal-accepted'))
    const download = async person => {
      const response = await person.context.request.get(`${server.origin}/api/coaster/audit-pack?${period}`)
      assert.equal(response.status(), 200)
      const files = unzip(Buffer.from(await response.body()))
      const manifest = JSON.parse(files['manifest.json'])
      const history = files['history.csv'].toString().trim().split('\r\n').filter(r => /,"(claim-proposed|batch-proposed|proposal-accepted)",/.test(r)).map(r => r.match(/,"((?:[^"]|"")*)","((?:[^"]|"")*)"$/).slice(1)).sort()
      return { manifest: manifest.claims.map(c => [c.id, c.preparedBy, c.payment?.preparedBy ?? null]), history }
    }
    const packBefore = await download(finance)
    assert.equal(packBefore.manifest[0][1].label, `${employeeLabel} for Sam Taylor`)
    assert.deepEqual(packBefore.manifest[0][1].decidedBy, { email: 'employee@dev.localhost', name: 'Sam Taylor' })
    assert.equal(packBefore.manifest[0][2].label, `${financeLabel} for Morgan Lee`)
    assert.equal(packBefore.history.length, 4)
    const linkedBefore = [accepted, acceptedBatch]
    const eventBefore = events ? [await proposalEvents(employeeClient), await proposalEvents(financeClient)] : []
    if (events) for (const [index, seen] of eventBefore.entries()) {
      assert.equal(seen.length, 1)
      assert.equal(seen[0].uri, `coaster://proposals/${linkedBefore[index].id}`)
      assert.deepEqual(Object.keys(seen[0]).sort(), ['actor', 'at', 'id', 'type', 'uri'])
      assert.equal(seen[0].actor.agent.id, [employeeKey, financeKey][index].id)
    }
    for (const context of contexts.splice(0)) await context.close()
    await browser.close(); browser = undefined; await server.close(); server = undefined
    await command(root, ['export', '--output', 'exports/agent-proposals.rer'])
    const archive = join(evidence, 'agent-proposals.rer')
    await copyFile(join(root, 'exports/agent-proposals.rer'), archive)
    const before = rows(await records(archive))
    assert.equal(before.filter(r => r.table === 'c_proposals').length, 2)
    assert.deepEqual(before.filter(r => r.table === 'c_proposals').map(r => r.row.status), ['accepted', 'accepted'])
    assert.equal(before.filter(r => r.table === 'c_batches').length, 1)
    assert.equal(before.find(r => r.table === 'c_batches').row.status, 'draft')
    assert.equal(before.filter(r => r.table === 'c_agent_keys').length, 0, 'archives contain no personal agent credentials')
    if (events) assertEventArchive(before, eventBefore.flat(), [employeeKey, financeKey])
    restored = await fresh(); const restoredPort = await freePort()
    await command(restored, ['setup', '--owner-email', ownerAddress, '--port', String(restoredPort)])
    await mkdir(join(restored, 'exports'), { recursive: true }); await copyFile(archive, join(restored, 'exports/source.rer'))
    await command(restored, ['import', '--input', 'exports/source.rer', '--yes'])
    await command(restored, ['export', '--output', 'exports/restored.rer'])
    assert.deepEqual(rows(await records(join(restored, 'exports/restored.rer'))), before, 'real CLI restore preserves every portable proposal and financial record')
    await command(restored, ['setup', '--owner-email', ownerAddress, '--port', String(restoredPort)])
    server = await start(restored, restoredPort)
    browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] })
    const restoredOwner = await session(browser, restored, server.origin, 'owner', 1440); contexts.push(restoredOwner.context)
    await setPolicy(restoredOwner)
    assert.deepEqual(await download(restoredOwner), packBefore, 'the regenerated audit pack carries the same attribution after real CLI restore')
    // Restore brings evidence, never native sign-in or reusable agent authority.
    for (const [index, [as, oldKey, expected]] of [['employee', employeeKey, linkedBefore[0]], ['finance', financeKey, linkedBefore[1]]].entries()) {
      const email = as + '@' + 'dev.localhost'
      await inviteRestoredPerson(restoredOwner.context, server.origin, email)
      const person = await session(browser, restored, server.origin, as, 1440); contexts.push(person.context)
      assert.equal((await proposalClient(fetch, server.origin, oldKey.token)('resources/read', { uri: `coaster://proposals/${expected.id}` })).status, 401)
      const freshKey = await api(person.context, server.origin, 'agent-keys', { label: 'synthetic-coaster-3525', eventsRead: events })
      const client = proposalClient(fetch, server.origin, freshKey.token)
      if (events) await assertRestoredEvents(client, eventBefore[index], proposalClient(fetch, server.origin, oldKey.token))
      assert.deepEqual(readProposal(await client('resources/read', { uri: `coaster://proposals/${expected.id}` })), expected)
      const native = await person.context.request.get(`${server.origin}/api/coaster/agent/proposals/${expected.id}`, { headers: { authorization: `Bearer ${freshKey.token}` } })
      assert.equal(native.status(), 200); assert.deepEqual(await native.json(), expected)
      if (as === 'finance') {
        assert.deepEqual(await api(person.context, server.origin, `batches/${expected.result_id}`), nativeBatch, 'freshly authenticated restore retains exact accepted draft-batch evidence and history')
      }
    }
    console.log('PROBE BASE-AGENT-008 5-6: employee and finance preparations -> record, activity and audit pack read agent for person with the native accepter named separately at 1440 and 390, identical after real CLI restore')
    if (events) console.log('PROBE BASE-AGENT-010 native and restore: actual unchecked and opted-in key issuance and proposal screens at 1440 and 390, then real CLI export and import -> exact retained event ids and attribution, no archived keys, old credentials refused, fresh native authentication and opted-in keys required')
    console.log('PROBE BASE-AGENT-003 native and restore: linked claim and batch screens at 1440 and 390 -> matching proposal evidence; real CLI restore -> exact portable records, fresh native sign-in and keys required')
    console.log('PROBE BASE-AGENT-012 browser and restore: native batch acceptance and new-id MCP retries -> original outcome and link, one unchanged draft batch at 1440 and 390; real CLI restore -> exact accepted proposal and financial evidence with fresh authentication and keys')
  } finally {
    for (const context of contexts) await context.close()
    await browser?.close(); await server?.close()
    if (restored) await rm(restored, { recursive: true, force: true })
    if (root) await rm(root, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runAgentResourceJourney()
