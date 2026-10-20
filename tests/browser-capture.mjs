// CAPTURE-001: public receipt intake at desktop and phone widths.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { api, session } from './browser-journey.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export async function captureJourney(browser, root, origin, width, evidence, shots, files) {
  const employee = await session(browser, root, origin, 'employee', width)
  const { page, context } = employee
  try {
    await page.goto(origin + '/app#/claims')
    const inbox = page.getByRole('region', { name: 'Receipt inbox', exact: true })
    await inbox.getByLabel('Upload receipts', { exact: true }).waitFor()
    const before = (await api(context, origin, 'receipt-inbox')).receipts
    if (width === 1440) {
      // Browser drag/drop emits the same native File objects as a desktop drop.
      const payload = files.map(file => ({ name: file.name, type: file.mediaType, data: file.bytes.toString('base64') }))
      const transfer = await page.evaluateHandle(values => {
        const data = new DataTransfer()
        for (const value of values) {
          const binary = atob(value.data), bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
          data.items.add(new File([bytes], value.name, { type: value.type }))
        }
        return data
      }, payload)
      await inbox.getByRole('group', { name: 'Drop receipt files' }).dispatchEvent('drop', { dataTransfer: transfer })
      await transfer.dispose()
      await inbox.getByRole('status').filter({ hasText: `${files.length} of ${files.length} receipts saved` }).waitFor({ timeout: 120000 })
    } else {
      const camera = inbox.getByLabel('Photograph a receipt', { exact: true })
      assert.equal(await camera.getAttribute('capture'), 'environment')
      // File selection proves the phone upload door, not operation of a physical phone camera.
      const bytes = await readFile('tests/fixtures/receipts/bistro.png')
      await camera.setInputFiles({ name: 'phone-bistro.png', mimeType: 'image/png', buffer: bytes })
      files = [{ name: 'phone-bistro.png', mediaType: 'image/png', bytes }]
      await inbox.getByRole('status').filter({ hasText: '1 of 1 receipts saved' }).waitFor()
    }
    const saved = (await api(context, origin, 'receipt-inbox')).receipts.filter(receipt => !before.some(old => old.id === receipt.id))
    assert.equal(saved.length, files.length)
    for (const file of files) {
      const receipt = saved.find(row => row.name === file.name)
      assert.ok(receipt, file.name)
      assert.equal(receipt.state, 'needs-attention')
      assert.match(receipt.attentionReason, /reading.*not available/i)
      assert.equal(receipt.size, file.bytes.length)
      assert.equal(receipt.sha256, hash(file.bytes))
      const response = await context.request.get(origin + receipt.downloadUrl)
      assert.equal(response.status(), 200)
      assert.deepEqual(await response.body(), file.bytes)
      await inbox.getByRole('link', { name: file.name, exact: true }).waitFor()
    }
    // A refusal leaves all successful uploads intact and shows what the employee can do next.
    await inbox.getByLabel('Upload receipts', { exact: true }).setInputFiles({ name: 'too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(12_000_000) })
    await inbox.getByRole('alert').filter({ hasText: /too-large.png/ }).waitFor({ timeout: 30000 })
    assert.equal((await api(context, origin, 'receipt-inbox')).receipts.length, before.length + saved.length)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await inbox.locator('summary').first().click()
    await inbox.scrollIntoViewIfNeeded()
    const path = join(evidence, `capture-inbox-${width}.png`)
    await page.screenshot({ path, fullPage: true }); shots.push({ screen: 'CAPTURE-001 inbox with successful bulk and refused file', viewport: width, path })
    return { width, receipts: saved }
  } finally { await context.close() }
}

/** CAPTURE-001 / COA-012: same employee sees the complete inbox after restore. */
export async function assertRestoredInbox(context, origin, before) {
  const after = (await api(context, origin, 'receipt-inbox')).receipts
  const ordered = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id))
  assert.deepEqual(ordered(after), ordered(before))
  for (const receipt of after) {
    const response = await context.request.get(origin + receipt.downloadUrl)
    assert.equal(response.status(), 200)
    const body = await response.body()
    assert.equal(body.length, receipt.size)
    assert.equal(hash(body), receipt.sha256)
  }
}
