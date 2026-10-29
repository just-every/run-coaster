// Accessibility is checked on the surviving native browser journey.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const axeSource = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')

/** Expanded states added by later clauses retain A11Y-001's complete default rule set. */
export async function assertAccessible(page, state) {
  if (!await page.evaluate(() => Boolean(window.axe))) await page.addScriptTag({ content: axeSource })
  const violations = await page.evaluate(async () => (await window.axe.run(document)).violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target) })))
  assert.deepEqual(violations, [], `A11Y-001 axe on ${state}`)
}
