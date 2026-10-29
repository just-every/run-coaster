// Native CAPTURE-004 terminal-disposition screens and private restoration evidence.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { api, session, PEOPLE } from '../browser-journey.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

/** Four small real originals cover discard, delegated discard and different-file merge. */
export async function receiptDispositionScreens(browser, root, origin, width, evidence, shots) {
  const employee = await session(browser, root, origin, 'employee', width)
  const { page, context } = employee
  try {
    await page.goto(origin + '/app#/claims')
    const inbox = page.getByRole('region', { name: 'Receipt inbox', exact: true })
    const photograph = async state => {
      const path = join(evidence, `receipt-custody-${state}-${width}.png`)
      await page.screenshot({ path, fullPage: false })
      shots.push({ screen: `CAPTURE-004 ${state}`, viewport: width, path })
    }
    const saved = []
    for (const [index, fixture] of ['bistro', 'hotel', 'officeworks', 'uber'].entries()) {
      const bytes = await readFile(`tests/fixtures/receipts/${fixture}.png`)
      const name = `custody-${width}-${index}.png`
      const camera = width === 390 && index === 0
      const input = inbox.getByLabel(camera ? 'Photograph a receipt' : 'Upload receipts', { exact: true })
      if (camera) assert.equal(await input.getAttribute('capture'), 'environment')
      await input.setInputFiles({ name, mimeType: 'image/png', buffer: bytes })
      await inbox.getByRole('link', { name, exact: true }).waitFor()
      const receipt = (await api(context, origin, 'receipt-inbox')).receipts.find(row => row.name === name)
      assert.ok(receipt)
      assert.equal(receipt.state, 'needs-attention')
      assert.equal(receipt.source, camera ? 'camera' : 'upload')
      assert.equal(receipt.size, bytes.length)
      assert.equal(receipt.sha256, hash(bytes))
      const response = await context.request.get(origin + receipt.downloadUrl)
      assert.equal(response.status(), 200)
      assert.deepEqual(await response.body(), bytes)
      const row = inbox.locator('.receipt-inbox-list > li').filter({ has: page.getByRole('link', { name, exact: true }) })
      await row.getByText('File provenance', { exact: true }).click()
      assert.equal(await row.locator('dd').nth(0).innerText(), `${bytes.length.toLocaleString()} bytes · image/png`)
      assert.equal(await row.locator('.receipt-fingerprint').innerText(), hash(bytes))
      await row.getByText('File provenance', { exact: true }).click()
      saved.push(receipt)
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    // CAPTURE-004: a reasoned discard moves the original to private history.
    const target = saved[0], reason = 'Sam Taylor (EMPLOYEE@DEV.LOCALHOST) kept this duplicate for the records.'
    const active = inbox.getByRole('region', { name: 'Active receipts', exact: true })
    const row = active.locator('.receipt-inbox-list > li').filter({ has: page.getByRole('link', { name: target.name, exact: true }) })
    await row.locator('summary').filter({ hasText: `Discard ${target.name}` }).click()
    await row.getByLabel('Reason', { exact: true }).fill(reason)
    await row.getByRole('button', { name: 'Discard receipt', exact: true }).click()
    const discarded = inbox.getByRole('region', { name: 'Discarded receipts', exact: true })
    await discarded.getByRole('link', { name: target.name, exact: true }).waitFor()
    assert.equal(await active.getByRole('link', { name: target.name, exact: true }).count(), 0)
    await discarded.getByRole('region', { name: `Disposition of ${target.name}`, exact: true }).getByText(reason, { exact: true }).waitFor()
    const kept = (await api(context, origin, 'receipt-inbox')).receipts.find(receipt => receipt.id === target.id)
    assert.deepEqual([kept.disposition, kept.lifecycleSequence, kept.lifecycle[0].reason], ['discarded', 1, reason])
    assert.deepEqual(kept.history, target.history)
    assert.equal(hash(await (await context.request.get(origin + kept.downloadUrl)).body()), target.sha256)
    await discarded.scrollIntoViewIfNeeded()
    await photograph('discarded')
    // CAPTURE-004: merging a duplicate retires it into another original, which is left exactly as it was.
    const [duplicate, keeper] = saved.slice(2), mergeReason = 'Sam Taylor (EMPLOYEE@DEV.LOCALHOST) merged this scan; kept this duplicate for the records.'
    assert.notEqual(duplicate.sha256, keeper.sha256, 'a merge of different files states its reason')
    const duplicateRow = active.locator('.receipt-inbox-list > li').filter({ has: page.getByRole('link', { name: duplicate.name, exact: true }) })
    await duplicateRow.locator('summary').filter({ hasText: `Merge ${duplicate.name} into another receipt` }).click()
    await duplicateRow.getByLabel('Receipt to keep', { exact: true }).selectOption(keeper.id)
    await duplicateRow.getByRole('button', { name: 'Merge receipt', exact: true }).click()
    await duplicateRow.getByRole('alert').getByText(/Reason is required unless both receipts are identical/).waitFor()
    await duplicateRow.getByLabel('Reason for merging', { exact: true }).fill(mergeReason)
    await duplicateRow.getByRole('button', { name: 'Merge receipt', exact: true }).click()
    const mergedRegion = inbox.getByRole('region', { name: 'Merged receipts', exact: true })
    await mergedRegion.getByRole('link', { name: duplicate.name, exact: true }).waitFor()
    assert.equal(await active.getByRole('link', { name: duplicate.name, exact: true }).count(), 0)
    await mergedRegion.getByRole('region', { name: `Disposition of ${duplicate.name}`, exact: true }).getByText(mergeReason, { exact: true }).waitFor()
    const after = (await api(context, origin, 'receipt-inbox')).receipts
    const gone = after.find(receipt => receipt.id === duplicate.id)
    assert.deepEqual([gone.disposition, gone.lifecycleSequence, gone.lifecycle[0].kind, gone.lifecycle[0].survivorId, gone.lifecycle[0].reason], ['merged', 1, 'merged', keeper.id, mergeReason])
    assert.deepEqual(after.find(receipt => receipt.id === keeper.id), keeper, 'the surviving original is untouched')
    assert.equal(hash(await (await context.request.get(origin + gone.downloadUrl)).body()), duplicate.sha256)
    await mergedRegion.scrollIntoViewIfNeeded()
    await photograph('merged')
    if (width === 1440) {
      // Retain a real delegated disposition in the CLI restore fixture too.
      const grant = await api(context, origin, 'delegates', { delegate: PEOPLE.manager, level: 'full' })
      const delegate = await session(browser, root, origin, 'manager', width)
      try {
        const response = await delegate.context.request.post(`${origin}/api/coaster/receipt-inbox/${saved[1].id}/discard`, {
          headers: { origin, 'x-coaster-acting-for': PEOPLE.employee }, data: { expectedSequence: 0, reason },
        })
        assert.equal(response.status(), 200)
        const delegated = (await response.json()).receipt
        assert.deepEqual([delegated.lifecycle[0].actorEmail, delegated.lifecycle[0].onBehalfOf], [PEOPLE.manager, PEOPLE.employee])
      } finally { await delegate.context.close() }
      await api(context, origin, `delegates/${grant.id}/revoke`, {})
    }
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

/** ERASURE-001 / CAPTURE-004: full expanded reasons are in the actual CLI archive. */
export async function expandedReasonJourney(browser, root, origin, owner) {
  const employee = await session(browser, root, origin, 'employee', 390)
  const delegate = await session(browser, root, origin, 'finance', 390)
  try {
    await api(owner.context, origin, 'settings/members', { email: PEOPLE.finance, name: 'Z', employee: true, finance: true })
    await api(employee.context, origin, 'delegates', { delegate: PEOPLE.finance, level: 'submit' })
    const png = await readFile('tests/fixtures/receipts/bistro.png'), ids = []
    for (const acting of [false, true]) {
      const uploaded = await employee.context.request.post(`${origin}/api/coaster/receipt-inbox`, { headers: { origin }, multipart: { source: 'upload', file: { name: `expanded-${acting}.png`, mimeType: 'image/png', buffer: png } } })
      assert.equal(uploaded.status(), 200)
      const original = (await uploaded.json()).receipt; ids.push(original.id)
      const response = await (acting ? delegate.context : employee.context).request.post(`${origin}/api/coaster/receipt-inbox/${original.id}/discard`, { headers: { origin, ...(acting ? { 'x-coaster-acting-for': PEOPLE.employee } : {}) }, data: { expectedSequence: 0, reason: 'Z'.repeat(1000) } })
      assert.equal(response.status(), 200)
    }
    await delegate.context.close()
    await api(owner.context, origin, 'settings/members', { email: PEOPLE.finance, name: 'Z', employee: true, finance: true, active: false })
    const erased = await api(owner.context, origin, 'settings/members/erase', { email: PEOPLE.finance })
    assert.equal(erased.removed.discardReasons, 2)
    for (const receipt of (await api(employee.context, origin, 'receipt-inbox')).receipts.filter(r => ids.includes(r.id))) {
      assert.equal(receipt.lifecycle[0].reason, erased.label.repeat(1000))
      assert.equal(Buffer.byteLength(receipt.lifecycle[0].reason), 22000)
    }
    await api(owner.context, origin, 'settings/members', { email: 'form@harbourfinch.example', name: 'Form', employee: true, active: false })
    const later = await api(owner.context, origin, 'settings/members/erase', { email: 'form@harbourfinch.example' })
    assert.equal(later.removed.discardReasons, 0)
    for (const receipt of (await api(employee.context, origin, 'receipt-inbox')).receipts.filter(r => ids.includes(r.id)))
      assert.equal(receipt.lifecycle[0].reason, erased.label.repeat(1000), 'later erasure protects earlier real tokens')
  } finally { await employee.context.close(); await delegate.context.close() }
}


/** Role access never exposes private originals, disposition reasons or inbox history. */
export async function assertReceiptRolePrivacy(browser, root, origin, receipts, owner) {
  for (const as of ['owner', 'manager', 'finance']) {
    const person = await session(browser, root, origin, as, 1440)
    try {
      assert.deepEqual((await api(person.context, origin, 'receipt-inbox')).receipts, [])
      await person.page.goto(origin + '/app#/claims')
      for (const receipt of receipts) {
        assert.equal((await person.context.request.get(origin + receipt.downloadUrl)).status(), 404)
        assert.equal(await person.page.getByRole('link', { name: receipt.name, exact: true }).count(), 0)
      }
    } finally { await person.context.close() }
  }
  const history = JSON.stringify(await api(owner.context, origin, 'history'))
  assert.ok(!history.includes('kept this duplicate for the records'))
  for (const receipt of receipts) assert.ok(!history.includes(receipt.name))
  const pack = await owner.context.request.get(`${origin}/api/coaster/audit-pack?from=2026-01-01&to=2026-12-31`)
  assert.equal(pack.status(), 200)
  assert.ok(!(await pack.body()).includes(Buffer.from('kept this duplicate for the records')), 'audit packs omit private disposition reasons')
}
