import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { api, PEOPLE, session } from './browser-journey.mjs'

/** Finance's statement-file reconciliation: differences, correction, explicit permanent close and read-only end state. */
export async function statementScreens(browser, root, origin, owner, evidence) {
  const category = (await api(owner.context, origin, 'state')).categories.find(c => c.name === 'Office supplies').id
  for (const width of [1440, 390]) {
    const issuer = `Synthetic Card ${width}`, finance = await session(browser, root, origin, 'finance', width), { page } = finance
    try {
      await api(owner.context, origin, 'statements/cards', { issuer, last4: '2222', employee: PEOPLE.employee })
      for (const name of ['reconcile-earlier.qfx', 'reconcile-september.ofx']) {
        const input = { format: name.endsWith('qfx') ? 'qfx' : 'ofx', name: `${width}-${name}`, issuer, category, content: await readFile(`tests/fixtures/statements/${name}`, 'utf8') }
        const preview = await api(finance.context, origin, 'statements/preview', input)
        await api(finance.context, origin, 'statements/commit', { ...input, fingerprint: preview.fingerprint })
      }
      const file = (await api(finance.context, origin, 'statements')).files.find(f => f.name === `${width}-reconcile-september.ofx`)
      await page.goto(origin + '/app#/settings')
      const section = page.getByRole('region', { name: 'Card statement reconciliation', exact: true })
      await section.locator('summary').filter({ hasText: 'Open a statement period' }).click()
      await section.getByLabel('Statement file', { exact: true }).selectOption(file.id)
      await section.getByLabel('Card last four', { exact: true }).fill('2222')
      await section.getByLabel('Opening balance', { exact: true }).fill('650.00')
      await section.getByRole('button', { name: 'Open statement period', exact: true }).click()
      const period = section.getByRole('region', { name: 'Statement period 2026-09-30 ····2222', exact: true })
      await period.getByText('Statement does not balance · The statement lines do not add up to its balance', { exact: true }).waitFor()
      assert.equal(await period.getByRole('button', { name: 'Close statement period', exact: true }).count(), 0)
      await period.scrollIntoViewIfNeeded(); await screenshot(page, evidence, 'statement-unbalanced', width)
      await period.locator('summary').filter({ hasText: 'Correct opening balance' }).click()
      await period.getByLabel('Corrected opening balance', { exact: true }).fill('600.00')
      await period.getByRole('button', { name: 'Save opening balance', exact: true }).click()
      await period.getByText('Statement does not balance · The statement lines do not add up to its balance', { exact: true }).waitFor({ state: 'detached' })
      const missing = period.locator('li').filter({ has: page.getByText('Missing charge · Bunnings Warehouse', { exact: true }) })
      await missing.getByLabel('Resolution note', { exact: true }).fill('Same Bunnings charge delivered earlier under another id; retained on the earlier statement report.')
      await missing.getByRole('button', { name: 'Resolve missing charge', exact: true }).click()
      await missing.getByText(/Resolved: Explained in writing/).waitFor()
      const credit = period.locator('li').filter({ has: page.getByText('Refund or credit · Officeworks refund', { exact: true }) })
      await credit.getByLabel('What this credit is for', { exact: true }).fill('Officeworks refunded returned stationery.')
      await credit.getByRole('button', { name: 'Acknowledge credit', exact: true }).click()
      await credit.getByText(/Resolved: Credit acknowledged/).waitFor()
      await period.getByRole('button', { name: 'Close statement period', exact: true }).waitFor()
      const confirmation = period.getByLabel('I have reviewed the differences and confirm this permanent close', { exact: true })
      assert.equal(await confirmation.isChecked(), false)
      await period.getByRole('button', { name: 'Close statement period', exact: true }).click()
      await period.getByRole('alert').filter({ hasText: 'Confirm the permanent close first.' }).waitFor()
      assert.equal((await api(finance.context, origin, 'statements/reconciliations')).statements.find(p => p.file === file.id).status, 'open')
      await period.scrollIntoViewIfNeeded(); await screenshot(page, evidence, 'statement-resolved', width)
      await confirmation.check()
      await period.getByRole('button', { name: 'Close statement period', exact: true }).click()
      await period.getByText(/The card liability account matches the statement balance: AUD 352.65/).waitFor()
      assert.equal(await period.getByRole('button').count(), 0, 'the closed period offers no write action')
      await period.locator('summary').filter({ hasText: 'Card liability ledger entries' }).click()
      await period.getByText('Debit: Card liability', { exact: false }).first().waitFor()
      await period.scrollIntoViewIfNeeded(); await screenshot(page, evidence, 'statement-closed', width)
      await page.reload()
      // There are two cards at the phone width; select this issuer's row rather than depending on file sort order.
      await section.locator('li').filter({ has: page.getByText(`${issuer} ····2222`, { exact: true }) }).getByRole('button').click()
      await section.getByText(/The card liability account matches the statement balance: AUD 352.65/).waitFor()
    } finally { await finance.context.close() }
  }
}

async function screenshot(page, evidence, name, width) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} fits ${width}px`)
  await page.screenshot({ path: join(evidence, `${name}-${width}.png`) })
}

/** The privacy slice uses the existing statement-file list and ordinary download links. */
export async function statementPrivacyScreens(browser, root, origin, imported, evidence) {
  for (const width of [1440, 390]) {
    const owner = await session(browser, root, origin, 'owner', width);
    try {
      await owner.page.goto(origin + '/app#/settings');
      const section = owner.page.getByRole('region', { name: 'Card statement reconciliation', exact: true });
      await section.locator('summary').filter({ hasText: 'Imported statement files' }).click();
      for (const file of imported) await section.getByRole('link', { name: file.name, exact: true }).waitFor();
      await section.scrollIntoViewIfNeeded();
      await screenshot(owner.page, evidence, 'statement-private-files', width);
    } finally { await owner.context.close(); }
  }
}
