import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { command, fresh, freePort, start } from '../browser-runtime.mjs'
import { api, inviteRestoredPerson, session, setUp } from '../browser-journey.mjs'
import { records, rows } from '../browser-archive.mjs'
import { autonomousPolicy } from '../../src/modules/agent-door/conformance/crypto.mjs'
import { claimArguments, linkedProposal, proposalClient, readProposal } from '../agent-door/proposals.mjs'

const ownerAddress = 'owner' + '@' + 'harbourfinch.example'
export async function runAgentResourceJourney({ discover } = {}) {
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
    const setPolicy = async (person, document = autonomousPolicy()) => {
      const response = await person.context.request.put(server.origin + '/agents/api/policy', { headers: { origin: server.origin }, data: { document } })
      assert.equal(response.status(), 200)
    }
    await setPolicy(owner)
    const employeeKey = await api(employee.context, server.origin, 'agent-keys', { label: 'synthetic-coaster-3520' })
    const financeKey = await api(finance.context, server.origin, 'agent-keys', { label: 'synthetic-coaster-3521' })
    const employeeClient = proposalClient(fetch, server.origin, employeeKey.token), financeClient = proposalClient(fetch, server.origin, financeKey.token)
    if (discover) await discover({ browser, server, client: employeeClient, evidence })
    const shot = async (person, region, name) => {
      assert.equal(await person.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      for (const width of [1440, 390]) {
        await person.page.setViewportSize({ width, height: 1000 })
        await region.scrollIntoViewIfNeeded()
        await region.screenshot({ path: join(evidence, `${name}-${width}.png`) })
      }
      await person.page.setViewportSize({ width: 1440, height: 1000 })
    }
    const prepare = async (person, key, client, path, name, args) => {
      await setPolicy(owner, { ...autonomousPolicy(), rules: [{ id: 'preparation', class: '*', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }] })
      const idempotency = crypto.randomUUID()
      const send = () => fetch(server.origin + '/api/coaster/agent/' + path, { method: 'POST', headers: {
        authorization: `Bearer ${key.token}`, origin: server.origin, 'content-type': 'application/json', 'idempotency-key': idempotency,
      }, body: JSON.stringify(args) })
      const before = (await api(person.context, server.origin, 'state')).proposals.length
      const pending = await send(), held = await pending.json()
      assert.equal(pending.status, 202, JSON.stringify(held))
      assert.equal(held.code, 'approval_required'); assert.equal(held.payload, undefined)
      assert.equal((await api(person.context, server.origin, 'state')).proposals.length, before)
      await person.page.goto(held.approval.url)
      await person.page.getByRole('button', { name: 'Approve', exact: true }).waitFor()
      assert.equal(await person.page.locator('[data-approval-state]').getAttribute('data-approval-state'), 'pending')
      assert.match(await person.page.getByRole('main').innerText(), /expires/i)
      await shot(person, person.page.getByRole('main'), 'company-' + path + '-approval')
      await person.page.getByRole('button', { name: 'Approve', exact: true }).click()
      await person.page.locator('[data-approval-state="executed"]').waitFor()
      const response = await send(), proposal = await response.json()
      assert.equal(response.status, 200, JSON.stringify(proposal))
      assert.equal(proposal.status, 'proposed'); assert.equal(proposal.result_id, null)
      // A retry through the other transport has the same sponsor, key and retained result.
      const linked = await linkedProposal(client, name, args, idempotency)
      assert.deepEqual(linked.proposal, proposal)
      assert.equal((await api(person.context, server.origin, 'state')).proposals.length, before + 1)
      await setPolicy(owner)
      return linked
    }
    const state = await api(employee.context, server.origin, 'state')
    const args = claimArguments(state.categories.find(c => c.account_code === '6500').id, 'synthetic-coaster-3522')
    args.items[0].receipt = { name: 'synthetic-coaster-3523.png', base64: (await readFile('tests/fixtures/receipts/bistro.png')).toString('base64') }
    const claim = await prepare(employee, employeeKey, employeeClient, 'claims', 'coaster.claims.propose', args)
    assert.deepEqual(readProposal(await employeeClient('resources/read', { uri: claim.uri })), claim.proposal)
    const screen = (await api(employee.context, server.origin, 'state')).proposals.find(p => p.id === claim.proposal.id)
    for (const [key, value] of Object.entries(screen)) assert.deepEqual(claim.proposal[key], value)
    await employee.page.reload(); await employee.page.goto(server.origin + '/app#/claims')
    const prepared = employee.page.getByRole('region', { name: 'Prepared for you', exact: true })
    await prepared.getByRole('button', { name: 'Accept as draft', exact: true }).waitFor()
    assert.match(await prepared.innerText(), /synthetic-coaster-3522/)
    assert.match(await prepared.innerText(), /12\.34/)
    await shot(employee, prepared, 'linked-claim-proposal')
    await prepared.getByRole('button', { name: 'Accept as draft', exact: true }).click()
    await employee.page.getByRole('heading', { name: args.title, exact: true }).waitFor()
    const accepted = readProposal(await employeeClient('resources/read', { uri: claim.uri }))
    assert.equal(accepted.status, 'accepted')
    let c = (await api(employee.context, server.origin, `claims/${accepted.result_id}`)).claim
    assert.equal(c.status, 'draft')
    c = await api(employee.context, server.origin, `claims/${c.id}/submit`, { version: c.version })
    c = await api(manager.context, server.origin, `claims/${c.id}/decision`, { version: c.version, revision: c.revision, decision: 'approved' })
    const batch = await prepare(finance, financeKey, financeClient, 'batches', 'coaster.batches.propose', { claims: [c.id], note: 'synthetic-coaster-3524' })
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
    const linkedBefore = [accepted, acceptedBatch]
    for (const context of contexts.splice(0)) await context.close()
    await browser.close(); browser = undefined; await server.close(); server = undefined
    await command(root, ['export', '--output', 'exports/agent-proposals.rer'])
    const archive = join(evidence, 'agent-proposals.rer')
    await copyFile(join(root, 'exports/agent-proposals.rer'), archive)
    const before = rows(await records(archive))
    assert.equal(before.filter(r => r.table === 'c_proposals').length, 2)
    assert.equal(before.filter(r => r.table === 'c_agent_keys').length, 0, 'archives contain no personal agent credentials')
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
    // Restore brings evidence, never native sign-in or reusable agent authority.
    for (const [as, oldKey, expected] of [['employee', employeeKey, linkedBefore[0]], ['finance', financeKey, linkedBefore[1]]]) {
      const email = as + '@' + 'dev.localhost'
      await inviteRestoredPerson(restoredOwner.context, server.origin, email)
      const person = await session(browser, restored, server.origin, as, 1440); contexts.push(person.context)
      assert.equal((await proposalClient(fetch, server.origin, oldKey.token)('resources/read', { uri: `coaster://proposals/${expected.id}` })).status, 401)
      const freshKey = await api(person.context, server.origin, 'agent-keys', { label: 'synthetic-coaster-3525' })
      const client = proposalClient(fetch, server.origin, freshKey.token)
      assert.deepEqual(readProposal(await client('resources/read', { uri: `coaster://proposals/${expected.id}` })), expected)
      const oldRest = await fetch(`${server.origin}/api/coaster/agent/proposals/${expected.id}`, { headers: { authorization: `Bearer ${oldKey.token}` } })
      assert.equal(oldRest.status, 401)
      const native = await person.context.request.get(`${server.origin}/api/coaster/agent/proposals/${expected.id}`, { headers: { authorization: `Bearer ${freshKey.token}` } })
      assert.equal(native.status(), 200); assert.deepEqual(await native.json(), expected)
    }
    console.log('PROBE BASE-AGENT-003 native and restore: linked claim and batch screens at 1440 and 390 -> matching proposal evidence; real CLI restore -> exact portable records, fresh native sign-in and keys required')
    console.log('PROBE BASE-AGENT-007 screens and restore: REST company approval and linked native claim and batch proposals at 1440 and 390 -> pending then executed preparation, separate human draft acceptance; CLI restore -> exact portable proposal and financial evidence, old REST keys refused and fresh keys read the same projections')
  } finally {
    for (const context of contexts) await context.close()
    await browser?.close(); await server?.close()
    if (restored) await rm(restored, { recursive: true, force: true })
    if (root) await rm(root, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runAgentResourceJourney()
