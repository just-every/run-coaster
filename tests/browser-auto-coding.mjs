import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { api, PEOPLE, session } from './browser-journey.mjs'

/** Rules, human decisions and measured acceptance in the real native screens. */
export async function automaticCodingScreens(browser, root, origin, evidence) {
  for (const width of [1440, 390]) {
    const owner = await session(browser, root, origin, 'owner', width), employee = await session(browser, root, origin, 'employee', width)
    try {
      const merchant = `Skyline Air ${width}`, issuer = `Harbour travel ${width}`, last4 = width === 1440 ? '1440' : '0390'
      const state = await api(owner.context, origin, 'state'), travel = state.categories.find(c => c.name === 'Travel'), office = state.categories.find(c => c.name === 'Office supplies')
      await owner.page.goto(origin + '/app#/settings')
      const controls = owner.page.getByRole('region', { name: 'Automatic coding', exact: true })
      await controls.getByLabel('Exact merchant', { exact: true }).fill(merchant)
      await controls.getByLabel('Suggested category', { exact: true }).selectOption(travel.id)
      await controls.getByLabel('Suggested memo', { exact: true }).fill('Travel booked for a client visit')
      await controls.getByLabel('Suggested category', { exact: true }).scrollIntoViewIfNeeded()
      await shot(owner.page, evidence, 'automatic-coding-rule', width)
      await controls.getByRole('button', { name: 'Save merchant rule', exact: true }).click()
      await controls.getByText('Merchant rule saved.', { exact: true }).waitFor()
      await api(owner.context, origin, 'statements/cards', { issuer, last4, employee: PEOPLE.employee })
      async function charge(n) {
        const input = { format: 'csv', name: `synthetic-coaster-${width + n}.csv`, issuer, category: office.id, content: `Date,Merchant,Amount,Id\n2026-10-02,${merchant},${40 + n}.00,synthetic-coaster-${width + n}`, mapping: { dateFormat: 'YYYY-MM-DD', sign: 'purchases-positive', postedDate: 'Date', description: 'Merchant', amount: 'Amount', transactionId: 'Id', wholeFileLast4: last4 } }
        const preview = await api(owner.context, origin, 'statements/preview', input)
        const imported = await api(owner.context, origin, 'statements/commit', { ...input, fingerprint: preview.fingerprint })
        const detail = await api(employee.context, origin, `claims/${imported.claims[0]}`)
        return { claim: detail.claim, item: detail.items.find(i => i.merchant === merchant && i.amount_minor === (40 + n) * 100) }
      }
      const first = await charge(1)
      assert.equal(first.item.allocations[0].category_id, travel.id)
      await employee.page.goto(origin + `/app#/claims/${first.claim.id}`)
      await employee.page.reload()
      let coding = employee.page.getByLabel(`Coding suggestions for ${merchant}`, { exact: true }).first()
      await coding.getByText('Coding suggestions and decisions', { exact: true }).click()
      await coding.getByText('Finance merchant rule', { exact: false }).first().waitFor()
      await coding.scrollIntoViewIfNeeded(); await shot(employee.page, evidence, 'automatic-coding-suggestion', width)
      await coding.getByRole('button', { name: 'Accept coding', exact: true }).click()
      await coding.getByText('Accepted', { exact: true }).waitFor()
      await coding.scrollIntoViewIfNeeded(); await shot(employee.page, evidence, 'automatic-coding-accepted', width)
      const second = await charge(2)
      await employee.page.goto(origin + `/app#/claims/${second.claim.id}`)
      await employee.page.reload()
      await employee.page.getByRole('button', { name: `Change ${merchant}`, exact: true }).last().click()
      const form = employee.page.locator('form.item-form')
      await form.getByLabel('Category', { exact: true }).selectOption(office.id)
      await form.getByRole('button', { name: 'Save expense', exact: true }).click()
      await form.waitFor({ state: 'detached' })
      coding = employee.page.getByLabel(`Coding suggestions for ${merchant}`, { exact: true }).last()
      await coding.getByText('Coding suggestions and decisions', { exact: true }).click()
      await coding.getByText('Overridden', { exact: true }).waitFor()
      await coding.scrollIntoViewIfNeeded(); await shot(employee.page, evidence, 'automatic-coding-overridden', width)
      await owner.page.reload()
      await controls.getByRole('heading', { name: 'Acceptance rates', exact: true }).scrollIntoViewIfNeeded()
      await controls.getByText(`Rule · ${merchant}`, { exact: true }).waitFor()
      await shot(owner.page, evidence, 'automatic-coding-rates', width)
      const rates = await api(owner.context, origin, 'coding/automatic/rates'), rate = rates.rules.find(r => r.merchant === merchant)
      assert.equal(rate.accepted, 1); assert.equal(rate.overridden, 1)
      // Uploaded originals have their own private coding door, explicitly entered rather than OCR.
      await employee.page.goto(origin + '/app#/claims')
      const inbox = employee.page.getByRole('region', { name: 'Receipt inbox', exact: true }), name = `synthetic-coaster-${width + 100}.png`
      await inbox.getByLabel('Upload receipts', { exact: true }).setInputFiles({ name, mimeType: 'image/png', buffer: await readFile('tests/fixtures/receipts/bistro.png') })
      const receipt = inbox.locator('.receipt-inbox-list > li').filter({ has: employee.page.getByRole('link', { name, exact: true }) })
      await receipt.getByText(`Coding for ${name}`, { exact: true }).click()
      await receipt.getByLabel('Merchant on this receipt', { exact: true }).fill(merchant)
      await receipt.getByRole('button', { name: 'Suggest receipt coding', exact: true }).click()
      await receipt.getByRole('button', { name: 'Accept receipt coding', exact: true }).waitFor()
      await receipt.getByRole('button', { name: 'Accept receipt coding', exact: true }).scrollIntoViewIfNeeded(); await shot(employee.page, evidence, 'automatic-coding-receipt', width)
      await receipt.getByRole('button', { name: 'Accept receipt coding', exact: true }).click()
      await receipt.getByText('Accepted coding', { exact: true }).waitFor()
      await receipt.getByText('Accepted coding', { exact: true }).scrollIntoViewIfNeeded(); await shot(employee.page, evidence, 'automatic-coding-receipt-accepted', width)
      const correctedName = `synthetic-coaster-${width + 101}.png`
      await inbox.getByLabel('Upload receipts', { exact: true }).setInputFiles({ name: correctedName, mimeType: 'image/png', buffer: await readFile('tests/fixtures/receipts/bistro.png') })
      const corrected = inbox.locator('.receipt-inbox-list > li').filter({ has: employee.page.getByRole('link', { name: correctedName, exact: true }) })
      await corrected.getByText(`Coding for ${correctedName}`, { exact: true }).click()
      await corrected.getByLabel('Merchant on this receipt', { exact: true }).fill(merchant)
      await corrected.getByRole('button', { name: 'Suggest receipt coding', exact: true }).click()
      await corrected.getByText('Correct receipt coding', { exact: true }).click()
      await corrected.getByLabel('Receipt category', { exact: true }).selectOption(office.id)
      await corrected.getByRole('button', { name: 'Save corrected receipt coding', exact: true }).scrollIntoViewIfNeeded(); await shot(employee.page, evidence, 'automatic-coding-receipt-correction', width)
      await corrected.getByRole('button', { name: 'Save corrected receipt coding', exact: true }).click()
      await corrected.getByText('Corrected coding', { exact: true }).waitFor()
      await corrected.getByText('Saved correction:', { exact: false }).waitFor()
      await corrected.getByText('Corrected coding', { exact: true }).scrollIntoViewIfNeeded(); await shot(employee.page, evidence, 'automatic-coding-receipt-corrected', width)
    } finally { await owner.context.close(); await employee.context.close() }
  }
}

async function shot(page, evidence, name, width) {
  await page.screenshot({ path: join(evidence, `${name}-${width}.png`) })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} fits ${width}px`)
}
