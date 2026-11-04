import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { command, fresh, freePort, start } from '../browser-runtime.mjs'
import { PEOPLE, api, inviteRestoredPerson, session, setUp } from '../browser-journey.mjs'
import { records, rows } from '../browser-archive.mjs'
import { autonomousPolicy } from '../../src/modules/agent-door/conformance/crypto.mjs'
import { claimArguments, linkedProposal, proposalClient } from '../agent-door/proposals.mjs'

const ownerAddress = 'owner' + '@' + 'harbourfinch.example'
const errorCode = result => result.result?._meta?.['com.runeditrun/error']?.code
export async function runAgentRoleParityJourney() {
  const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/agent-role-parity-proof')
  await mkdir(evidence, { recursive: true })
  let root, restored, server, browser
  const contexts = []
  const launch = () => chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] })
  const policy = async owner => assert.equal((await owner.context.request.put(server.origin + '/agents/api/policy', { headers: { origin: server.origin }, data: { document: autonomousPolicy() } })).status(), 200)
  const tool = async (client, name, args) => {
    const answer = await client(['tools', 'call'].join('/'), { name, arguments: args })
    assert.equal(answer.status, 200); assert.equal(answer.result?.isError, false, JSON.stringify(answer))
    return answer.result.structuredContent
  }
  const screens = async (person, name) => {
    // Behaviour assertions run at 1440; the same states are captured at both widths.
    for (const width of [1440, 390]) {
      await person.page.setViewportSize({ width, height: 1000 })
      await person.page.screenshot({ path: join(evidence, `${name}-${width}.png`), fullPage: true })
    }
    await person.page.setViewportSize({ width: 1440, height: 1000 })
  }
  const close = async () => {
    for (const context of contexts.splice(0)) await context.close()
    await browser?.close(); browser = undefined
    await server?.close(); server = undefined
  }
  try {
    root = await fresh(); const port = await freePort()
    await command(root, ['setup', '--owner-email', ownerAddress, '--port', String(port)])
    server = await start(root, port); browser = await launch()
    const owner = await session(browser, root, server.origin, 'owner', 1440); contexts.push(owner.context)
    await setUp(owner, server.origin); await policy(owner)
    const employee = await session(browser, root, server.origin, 'employee', 1440), manager = await session(browser, root, server.origin, 'manager', 1440), finance = await session(browser, root, server.origin, 'finance', 1440)
    contexts.push(employee.context, manager.context, finance.context)
    const employeeKey = await api(employee.context, server.origin, 'agent-keys', { label: 'synthetic-coaster-5370' })
    const employeeClient = proposalClient(fetch, server.origin, employeeKey.token)
    const state = await api(employee.context, server.origin, 'state')
    const args = claimArguments(state.categories.find(c => c.account_code === '6500').id, 'synthetic-coaster-5371')
    args.items[0].explanation = 'Synthetic role parity expense'
    const proposed = await linkedProposal(employeeClient, 'coaster.claims.propose', args)
    await employee.page.reload(); await employee.page.goto(server.origin + '/app#/claims')
    const strip = employee.page.getByRole('region', { name: 'Prepared for you', exact: true })
    await expect(strip).toContainText(args.title)
    await expect(strip).toContainText('12.34')
    await screens(employee, 'role-employee-proposal-allowed')
    await strip.getByRole('button', { name: 'Accept as draft', exact: true }).click()
    await employee.page.getByRole('heading', { name: args.title, exact: true }).waitFor()
    const accepted = await tool(employeeClient, 'coaster.proposals.get', { id: proposed.proposal.id })
    assert.equal(accepted.status, 'accepted')
    let claim = (await api(employee.context, server.origin, `claims/${accepted.result_id}`)).claim
    claim = await api(employee.context, server.origin, `claims/${claim.id}/submit`, { version: claim.version })
    claim = await api(manager.context, server.origin, `claims/${claim.id}/decision`, { version: claim.version, revision: claim.revision, decision: 'approved', acknowledge: true })
    const beforeRefusal = await api(employee.context, server.origin, 'state')
    const denied = await employeeClient(['tools', 'call'].join('/'), { name: 'coaster.batches.propose', arguments: { claims: [claim.id], idempotency_key: 'synthetic-coaster-5372' } })
    assert.equal(errorCode(denied), 'native_authority_required')
    assert.deepEqual(await api(employee.context, server.origin, 'state'), beforeRefusal)
    assert.deepEqual((await tool(employeeClient, 'coaster.workspace.get', {})).approvedClaims, [])
    await api(employee.context, server.origin, `agent-keys/${employeeKey.id}/revoke`, {})
    const financeKey = await api(finance.context, server.origin, 'agent-keys', { label: 'synthetic-coaster-5373' })
    const financeClient = proposalClient(fetch, server.origin, financeKey.token)
    const batch = await linkedProposal(financeClient, 'coaster.batches.propose', { claims: [claim.id], note: 'synthetic-coaster-5374' })
    await finance.page.reload(); await finance.page.goto(server.origin + '/app#/batches')
    const financeStrip = finance.page.getByRole('region', { name: 'Prepared for you', exact: true })
    await expect(financeStrip).toContainText('1 approved claim')
    await expect(financeStrip).toContainText('12.34')
    await screens(finance, 'role-finance-proposal-allowed')
    await financeStrip.getByRole('button', { name: 'Accept as draft batch', exact: true }).click()
    const acceptedBatch = await tool(financeClient, 'coaster.proposals.get', { id: batch.proposal.id })
    assert.equal(acceptedBatch.status, 'accepted')
    assert.equal((await api(finance.context, server.origin, `batches/${acceptedBatch.result_id}`)).batch.total_minor, 1234)
    const retained = [accepted, acceptedBatch]
    const oldCookie = (await employee.context.cookies(server.origin)).map(c => `${c.name}=${c.value}`).join('; ')
    await close()
    await command(root, ['export', '--output', 'exports/role-parity.rer'])
    const archive = join(evidence, 'role-parity.rer')
    await copyFile(join(root, 'exports/role-parity.rer'), archive)
    const portable = rows(await records(archive))
    assert.equal(portable.filter(r => r.table === 'c_agent_keys').length, 0, 'execution credentials are excluded')
    restored = await fresh(); const restoredPort = await freePort()
    await command(restored, ['setup', '--owner-email', ownerAddress, '--port', String(restoredPort)])
    await mkdir(join(restored, 'exports'), { recursive: true }); await copyFile(archive, join(restored, 'exports/source.rer'))
    await command(restored, ['import', '--input', 'exports/source.rer', '--yes'])
    await command(restored, ['export', '--output', 'exports/restored.rer'])
    assert.deepEqual(rows(await records(join(restored, 'exports/restored.rer'))), portable, 'real CLI restore retains exact proposals, financial records and numbered history')
    await command(restored, ['setup', '--owner-email', ownerAddress, '--port', String(restoredPort)])
    server = await start(restored, restoredPort); browser = await launch()
    assert.equal((await fetch(server.origin + '/api/coaster/state', { headers: { cookie: oldCookie } })).status, 401, 'old native authentication cannot cross installations')
    const restoredOwner = await session(browser, restored, server.origin, 'owner', 1440); contexts.push(restoredOwner.context)
    await policy(restoredOwner)
    for (const [as, oldKey, expected] of [['employee', employeeKey, retained[0]], ['finance', financeKey, retained[1]]]) {
      await inviteRestoredPerson(restoredOwner.context, server.origin, PEOPLE[as])
      const person = await session(browser, restored, server.origin, as, 1440); contexts.push(person.context)
      assert.equal((await proposalClient(fetch, server.origin, oldKey.token)(['tools', 'call'].join('/'), { name: 'coaster.proposals.get', arguments: { id: expected.id } })).status, 401)
      const freshKey = await api(person.context, server.origin, 'agent-keys', { label: 'synthetic-coaster-5375' })
      const client = proposalClient(fetch, server.origin, freshKey.token)
      for (const version of ['2025-11-25', '2026-07-28']) {
        const read = await tool(proposalClient(fetch, server.origin, freshKey.token, version), 'coaster.proposals.get', { id: expected.id })
        assert.deepEqual(read, expected, 'freshly authorized MCP projection retains the exact accepted evidence')
      }
      const native = await person.context.request.get(`${server.origin}/api/coaster/agent/proposals/${expected.id}`, { headers: { authorization: `Bearer ${freshKey.token}` } })
      assert.equal(native.status(), 200); assert.deepEqual(await native.json(), expected)
      if (as === 'employee') {
        // A retained key follows current roles. Native approval does not add
        // employee powers to an auditor, and the UI hides preparation controls.
        await api(restoredOwner.context, server.origin, ['settings', 'members'].join('/'), { email: PEOPLE.employee, name: 'Sam Taylor', auditor: true })
        const before = await api(person.context, server.origin, 'state')
        const issue = await person.context.request.post(server.origin + '/api/coaster/agent-keys', { headers: { origin: server.origin }, data: { label: 'synthetic-coaster-5376' } })
        assert.equal(issue.status(), 403)
        const forbidden = await client(['tools', 'call'].join('/'), { name: 'coaster.claims.propose', arguments: { ...args, idempotency_key: 'synthetic-coaster-5377' } })
        assert.equal(errorCode(forbidden), 'native_authority_required')
        assert.deepEqual(await tool(client, 'coaster.proposals.get', { id: expected.id }), expected)
        assert.deepEqual((await tool(client, 'coaster.workspace.get', {})).approvedClaims, [])
        assert.deepEqual(await api(person.context, server.origin, 'state'), before, 'downgraded key and key-issuance refusals write no native state')
        await person.page.reload(); await person.page.goto(server.origin + '/app#/claims')
        await expect(person.page.getByRole('region', { name: 'Prepared for you', exact: true })).toHaveCount(0)
        await expect(person.page.getByRole('button', { name: 'New claim', exact: true })).toHaveCount(0)
        await screens(person, 'role-auditor-preparation-refused')
      }
      await api(person.context, server.origin, `agent-keys/${freshKey.id}/revoke`, {})
    }
    console.log('PROBE BASE-AGENT-005 native screens: employee claim and finance batch -> native acceptance and exact amounts; employee batch refusal and retained auditor key -> no write or finance projection; native allowed and refused states captured at 1440 and 390')
    console.log('PROBE BASE-AGENT-005 restore: real CLI export, import and export -> identical portable rows; old sessions and keys refused; fresh native authentication and keys -> exact proposal readback under both MCP protocols')
  } finally {
    await close()
    if (restored) await rm(restored, { recursive: true, force: true })
    if (root) await rm(root, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runAgentRoleParityJourney()
