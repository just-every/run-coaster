import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { api } from '../browser-journey.mjs'
import { proposalClient } from '../agent-door/proposals.mjs'
import { heldPolicy, autonomousPolicy } from '../../src/modules/agent-door/conformance/crypto.mjs'
import { contextDecision, contextParams, contextRefusal } from '../agent-door/context.mjs'

/** Inspect existing native read-approval screens, with no additional agent authority. */
export async function runAgentContextClassificationJourney({ owner, employee, finance, financeKey, server, evidence, batch }) {
  const client = proposalClient(fetch, server.origin, financeKey.token)
  const setPolicy = async document => {
    const response = await owner.context.request.put(server.origin + '/agents/api/policy', { headers: { origin: server.origin }, data: { document } })
    assert.equal(response.status(), 200)
  }
  const nativeContext = async () => {
    const response = await finance.context.request.get(server.origin + '/api/coaster/agent/context', { headers: { authorization: `Bearer ${financeKey.token}` } })
    assert.equal(response.status(), 200)
    return response.json()
  }
  const before = await api(finance.context, server.origin, 'state')
  const native = await nativeContext()
  assert.ok(native.approvedClaims.length > 0)
  assert.ok(native.proposals.some(p => p.id === batch.proposal.id))
  const autonomous = await client('tools/call', contextParams())
  contextDecision(autonomous, 'autonomous')
  assert.deepEqual(autonomous.result.structuredContent, native)
  await setPolicy(heldPolicy())
  const held = await client('tools/call', contextParams())
  contextRefusal(held, 'approval_required')
  contextDecision(held, 'approval')
  const handle = held.result._meta['com.runeditrun/approval']
  const foreign = await employee.context.request.get(handle.url)
  assert.equal(foreign.status(), 403)
  await finance.page.goto(handle.url)
  await finance.page.getByRole('button', { name: 'Approve', exact: true }).waitFor()
  await finance.page.getByText('Details', { exact: true }).click()
  assert.match(await finance.page.locator('main').innerText(), /sensitive/i)
  assert.ok(!(await finance.page.locator('main').innerText()).includes(native.approvedClaims[0].title), 'the approval screen discloses no expense title')
  const shot = async name => {
    for (const width of [1440, 390]) {
      await finance.page.setViewportSize({ width, height: 1000 })
      await finance.page.screenshot({ path: join(evidence, `${name}-${width}.png`), fullPage: true })
    }
    await finance.page.setViewportSize({ width: 1440, height: 1000 })
  }
  await shot('private-context-pending')
  await finance.page.getByRole('button', { name: 'Approve', exact: true }).click()
  await finance.page.locator('[data-approval-state="executed"]').waitFor()
  const retried = await client('tools/call', { ...contextParams(), requestState: held.result.requestState })
  assert.deepEqual(retried.result.structuredContent, native)
  assert.deepEqual(await api(finance.context, server.origin, 'state'), before, 'native read approval changes no proposal, claim or batch')
  await shot('private-context-approved')
  await setPolicy(autonomousPolicy())
  console.log('PROBE BASE-AGENT-006 native: sponsor approval screen at 1440 and 390 -> private context withheld, another person refused, named finance approval permits exact native readback without accepting a proposal')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await (await import('./browser-agent-resources.mjs')).runAgentResourceJourney({
    discover: (await import('./browser-agent-discovery.mjs')).runAgentDiscoveryJourney,
    classifyContext: runAgentContextClassificationJourney,
  })
}
