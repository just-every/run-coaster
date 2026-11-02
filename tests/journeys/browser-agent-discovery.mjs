import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { verifyPrompts } from '../agent-door/discovery.mjs'

/** The built public documentation and the authenticated MCP registry agree. */
export async function runAgentDiscoveryJourney({ browser, server, client, evidence }) {
  const discovery = (await client('server/discover')).result
  const prompts = await verifyPrompts(client)
  const tools = (await client('tools/list')).result.tools
  const resources = (await client('resources/templates/list')).result.resourceTemplates
  const surface = JSON.parse(await readFile('agent-surface.json', 'utf8'))
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  try {
    const page = await context.newPage()
    const response = await page.goto(server.siteOrigin + '/docs/agents')
    assert.equal(response.status(), 200)
    const tableAfter = name => page.getByRole('heading', { name, exact: true }).locator('xpath=following-sibling::div[contains(@class,"docs-table")][1]')
    const cells = async table => table.locator('tbody tr').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent.trim())))
    const capacity = tableAfter('Installation capacity')
    const limits = discovery._meta['com.runeditrun/limits']
    assert.deepEqual(await cells(capacity), [
      ['Admitted authenticated MCP requests per agent per minute', String(limits.requestsPerMinute)],
      ['Maximum MCP request body in bytes', String(limits.maxBodyBytes)],
    ], 'built capacity documentation agrees with the live production discovery')
    const listedTools = await cells(tableAfter('Tools by job'))
    assert.deepEqual(listedTools.map(row => row[1]), tools.map(tool => tool.name), 'published docs offer exactly the live tools')
    for (const [index, row] of listedTools.entries()) {
      const tool = tools[index]
      assert.equal(row[0], tool.title)
      assert.equal(row[2], tool._meta['com.runeditrun/scope'])
      assert.deepEqual(row[3].split(', '), tool._meta['com.runeditrun/classes'])
    }
    const listedTemplates = await cells(tableAfter('Resource templates'))
    assert.deepEqual(listedTemplates.map(row => row[1]), resources.map(resource => resource.uriTemplate), 'published docs offer exactly the live templates')
    const listedPrompts = await cells(tableAfter('Specialist prompt jobs'))
    assert.deepEqual(listedPrompts.map(row => row[1]), prompts.list.map(prompt => prompt.name))
    assert.deepEqual(listedPrompts.map(row => row[2]), prompts.list.map(prompt => prompt.description))
    const witnesses = await cells(tableAfter('Class witnesses'))
    for (const tool of tools) for (const cls of tool._meta['com.runeditrun/classes']) {
      const row = witnesses.find(row => row[0] === tool.name && row[1] === cls)
      assert.ok(row, `published class witness for ${tool.name} ${cls}`)
      const cases = row[2].split(', ')
      assert.ok(cases.length)
      for (const id of cases) assert.ok(surface.journey.some(step => step.id === id && step.tool === tool.name && step.expect.some(item => item.class === cls)), 'each documented class points to its checked conformance fixture')
    }
    const journeyTable = page.locator('table').filter({ has: page.getByRole('columnheader', { name: 'Native condition', exact: true }) })
    const journeys = await cells(journeyTable)
    assert.deepEqual(journeys.map(row => row[0]), surface.journey.map(step => step.id))
    for (const row of journeys) {
      const fixture = surface.journey.find(step => step.id === row[0])
      assert.equal(row[1], fixture.tool)
      assert.deepEqual(row[2].split(', '), fixture.expect.map(item => item.class))
    }
    const automatic = journeys.find(row => row[0] === 'foreign-claim'), manual = journeys.find(row => row[0] === 'manual-foreign-claim')
    assert.ok(automatic[2].includes('external')); assert.match(automatic[3], /ECB/)
    assert.ok(!manual[2].includes('external')); assert.match(manual[3], /no provider request/)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.getByRole('heading', { name: 'MCP catalogue', exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(evidence, `agent-discovery-${width}.png`), fullPage: true })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'docs page fits the viewport')
    }
    console.log('PROBE BASE-AGENT-013 1: built /docs/agents and authenticated MCP lists -> exact tool, resource template and prompt catalogue equality at 1440 and 390')
    console.log('PROBE BASE-AGENT-013 2: published class witnesses -> every native class has a checked journey reference; automatic FX external, explicit manual rate has no provider class')
    console.log(`PROBE BASE-AGENT-011 documentation: built /docs/agents at 1440 and 390 -> live discovery equality: ${limits.requestsPerMinute} admitted requests per agent per minute, ${limits.maxBodyBytes} body bytes`)
  } finally { await context.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await (await import('./browser-agent-resources.mjs')).runAgentResourceJourney({ discover: runAgentDiscoveryJourney })
}
