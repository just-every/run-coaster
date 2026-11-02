import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { api } from '../browser-journey.mjs'
import { proposalClient } from '../agent-door/proposals.mjs'

/** Issue through the actual native setting; do not put the one-time secret in screenshots. */
export async function issueEventKey(person, origin, label, evidence) {
  await person.page.goto(origin + '/app#/settings')
  const region = person.page.getByRole('region', { name: 'Agent keys', exact: true })
  const consent = region.getByRole('checkbox', { name: 'Allow this key to read retained events for records I can access', exact: true })
  await consent.waitFor()
  assert.equal(await consent.isChecked(), false, 'event consent is off initially')
  await region.getByRole('textbox', { name: 'Agent name', exact: true }).fill(label + '-preparation')
  await region.getByRole('button', { name: 'Make agent key', exact: true }).click()
  const secret = region.getByRole('textbox', { name: 'Copy this key now; Coaster shows it only once.', exact: true })
  await secret.waitFor()
  const oldToken = await secret.inputValue()
  assert.equal((await proposalClient(fetch, origin, oldToken)('tools/call', { name: 'coaster.events.list', arguments: {} })).status, 403)
  await region.getByRole('textbox', { name: 'Agent name', exact: true }).fill(label)
  await consent.check()
  for (const width of [1440, 390]) {
    await person.page.setViewportSize({ width, height: 1000 })
    await region.scrollIntoViewIfNeeded()
    await region.screenshot({ path: join(evidence, `${label}-event-consent-${width}.png`), mask: [secret] })
  }
  await person.page.setViewportSize({ width: 1440, height: 1000 })
  await region.getByRole('button', { name: 'Make agent key', exact: true }).click()
  await region.getByText('Event reading allowed', { exact: false }).waitFor()
  assert.equal(await consent.isChecked(), false, 'the form resets to no consent for the next key')
  const token = await secret.inputValue()
  assert.notEqual(token, oldToken)
  const key = (await api(person.context, origin, 'state')).agentKeys.find(k => k.label === label)
  assert.ok(key)
  assert.deepEqual(JSON.parse(key.scopes), ['proposals:read', 'proposals:write', 'events:read'])
  return { id: key.id, label, token }
}
export async function runAgentEventJourney() {
  const { runAgentResourceJourney } = await import('./browser-agent-resources.mjs')
  const { runAgentDiscoveryJourney } = await import('./browser-agent-discovery.mjs')
  await runAgentResourceJourney({ discover: runAgentDiscoveryJourney, events: true, issueKey: issueEventKey })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runAgentEventJourney()
