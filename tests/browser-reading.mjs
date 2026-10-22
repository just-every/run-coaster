import { assertAccessible } from './browser-accessibility.mjs'
// The browser's paid network edge is synthetic. Actual model quality is proved separately by receipt-reading-quality.mjs.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { api, session } from './browser-journey.mjs'

export async function readingEdge() {
  const label = JSON.parse(await readFile('tests/fixtures/receipts/reader/synthetic-coaster-1001.json', 'utf8'))
  const edge = { fail: false }
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* consume the real model request without recording originals or credentials */ }
    if (edge.fail) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'synthetic-coaster-6001' } })); return }
    const fields = Object.fromEntries(Object.entries(label.values).map(([name, value]) => [name, { value: name === 'lineItems' ? value.map(item => ({ ...item, confidence: .99, regions: label.regions.lineItems })) : value, confidence: .99, regions: label.regions[name] }]))
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: 'completed', model: 'gpt-4.1-2025-04-14', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(fields) }] }], usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { ...edge, get fail() { return edge.fail }, set fail(value) { edge.fail = value }, url: `http://127.0.0.1:${server.address().port}/v1`, label, async close() { await new Promise(resolve => server.close(resolve)) } }
}

export async function readingScreens(browser, root, origin, evidence, edge) {
  for (const width of [1440, 390]) {
    const owner = await session(browser, root, origin, 'owner', width), employee = await session(browser, root, origin, 'employee', width)
    try {
      await owner.page.goto(origin + '/app#/settings')
      const settings = owner.page.getByRole('heading', { name: 'Receipt reading', exact: true }).locator('..').locator('..')
      await settings.getByRole('button', { name: 'Manage receipt reading', exact: true }).click()
      await settings.getByLabel('Enable receipt reading', { exact: true }).check()
      await settings.getByLabel('I authorize sending explicitly selected receipts to the configured AI provider', { exact: true }).check()
      await shot(owner.page, settings, evidence, 'reading-settings', width)
      await settings.getByRole('button', { name: 'Save receipt reading', exact: true }).click()
      await settings.getByRole('button', { name: 'Save receipt reading', exact: true }).waitFor()
      await employee.page.goto(origin + '/app#/claims')
      const inbox = employee.page.getByRole('region', { name: 'Receipt inbox', exact: true }), name = `synthetic-coaster-${width + 6000}.png`
      await inbox.getByLabel('Upload receipts', { exact: true }).setInputFiles({ name, mimeType: 'image/png', buffer: await readFile('tests/fixtures/receipts/reader/synthetic-coaster-1001.png') })
      const row = inbox.locator('.receipt-inbox-list > li').filter({ has: employee.page.getByRole('link', { name, exact: true }) })
      await row.getByText(`Read ${name}`, { exact: true }).click()
      const consent = row.getByLabel('I authorize sending this original to the configured AI provider for receipt reading and coding suggestions', { exact: true })
      assert.equal(await consent.isChecked(), false)
      await row.getByRole('button', { name: 'Read receipt', exact: true }).click()
      await row.getByRole('alert').filter({ hasText: 'Explicit consent' }).waitFor()
      await consent.check()
      edge.fail = true
      await row.getByRole('button', { name: 'Read receipt', exact: true }).click()
      await row.getByRole('button', { name: 'Read receipt again', exact: true }).waitFor()
      await shot(employee.page, row, evidence, 'reading-failed', width)
      edge.fail = false
      await row.getByRole('button', { name: 'Read receipt again', exact: true }).click()
      await row.getByRole('button', { name: 'Show total on page 1', exact: true }).waitFor()
      await shot(employee.page, row, evidence, 'reading-values', width)
      await row.getByRole('button', { name: 'Show total on page 1', exact: true }).click()
      const image = row.getByRole('img', { name: 'Original receipt showing Total', exact: true })
      await image.waitFor(); await image.evaluate(img => img.complete ? Promise.resolve() : new Promise(resolve => img.onload = resolve))
      await shot(employee.page, row.getByRole('region', { name: 'Receipt field evidence' }), evidence, 'reading-region', width)
      await row.getByRole('button', { name: 'Close field evidence', exact: true }).click()
      await row.getByText('Correct receipt values', { exact: true }).click()
      await row.getByLabel('Correct total', { exact: true }).fill('60.00')
      await row.getByRole('button', { name: 'Save receipt corrections', exact: true }).click()
      await row.getByText('Subtotal, sales tax and tip do not equal the final total', { exact: true }).first().waitFor()
      await shot(employee.page, row, evidence, 'reading-conflict', width)
      await row.getByLabel('Correct total', { exact: true }).fill(edge.label.values.total)
      await row.getByRole('button', { name: 'Save receipt corrections', exact: true }).click()
      await row.getByText('Reading history', { exact: true }).click()
      await row.getByText(/corrected/).first().waitFor()
      await shot(employee.page, row, evidence, 'reading-corrected', width)
      await row.getByText('My standing matching choice', { exact: true }).click()
      const standing = row.getByRole('button', { name: 'Save my reading matching choice', exact: true }).locator('..').locator('..')
      const standingChoice = standing.getByLabel('Choose matching for my future read originals when the required fields are confident', { exact: true })
      assert.equal(await standingChoice.isChecked(), false)
      await standingChoice.check(); await standing.getByLabel('I understand when these receipts will be shared', { exact: true }).check()
      await standing.getByRole('button', { name: 'Save my reading matching choice', exact: true }).click()
      await shot(employee.page, standing, evidence, 'reading-standing-choice', width)
      await standingChoice.uncheck(); await standing.getByRole('button', { name: 'Save my reading matching choice', exact: true }).click()
      const match = row.getByRole('button', { name: 'Use reviewed reading for card matching', exact: true }).locator('..').locator('..')
      await match.getByLabel('I understand when this receipt will be shared', { exact: true }).check()
      await match.getByRole('button', { name: 'Use reviewed reading for card matching', exact: true }).click()
      await shot(employee.page, row, evidence, 'reading-matching-choice', width)
      const uploaded = (await api(employee.context, origin, 'receipt-inbox')).receipts.find(receipt => receipt.name === name)
      assert.equal(uploaded.matchChoice.enabled, true); assert.equal(uploaded.matchChoice.details.totalMinor, 5828)
      await row.getByRole('button', { name: 'Prepare expense from reviewed reading', exact: true }).click()
      const expense = row.getByRole('heading', { name: 'Expense from receipt reading', exact: true }).locator('..').locator('..')
      assert.equal(await expense.getByLabel('Amount paid', { exact: true }).inputValue(), edge.label.values.total)
      assert.equal(await expense.getByLabel('Paid to', { exact: true }).inputValue(), edge.label.values.merchant)
      await shot(employee.page, expense, evidence, 'reading-expense-prefill', width)
      await expense.getByLabel('Expense category', { exact: true }).selectOption({ label: 'Meals' })
      await expense.getByLabel('Conversion rate', { exact: true }).fill('1.52')
      await expense.getByRole('button', { name: 'Add to report', exact: true }).click()
      await employee.page.waitForURL(/#\/claims\//)
      const detail = await api(employee.context, origin, `claims/${new URL(employee.page.url()).hash.split('/').at(-1)}`)
      assert.ok(detail.items.some(item => item.merchant === edge.label.values.merchant && item.original_minor === 5828 && item.original_currency === 'USD'))
      await shot(employee.page, employee.page.getByRole('button', { name: `Change ${edge.label.values.merchant}`, exact: true }).last().locator('..').locator('..').locator('..'), evidence, 'reading-expense-saved', width)
    } finally { edge.fail = false; await owner.context.close(); await employee.context.close() }
  }
}
async function shot(page, target, evidence, name, width) {
  await assertAccessible(page, `${name} at ${width}`)
  await target.scrollIntoViewIfNeeded()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} fits ${width}`)
  await page.screenshot({ path: join(evidence, `${name}-${width}.png`), fullPage: true })
  await page.screenshot({ path: join(evidence, `${name}-${width}-viewport.png`), fullPage: false })
  await target.screenshot({ path: join(evidence, `${name}-${width}-detail.png`) })
}
