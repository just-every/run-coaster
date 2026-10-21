// A11Y-001: the claim/correction/approval journey uses keyboard input only, and axe finds nothing on any main screen.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { api, session } from './browser-journey.mjs'
import { keyboardReceipt } from './fixtures/keyboard-receipt.mjs'

async function tabTo(page, target) {
  // A person acts in the foreground tab; Chromium can suppress native file choosers in a background tab.
  await page.bringToFront()
  await target.waitFor({ state: 'visible' })
  for (let count = 0; count < 160; count++) {
    if (await target.evaluate(el => el === document.activeElement)) {
      assert.ok(await target.evaluate(el => {
        const style = getComputedStyle(el), cell = el.closest('td')
        return (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0)
          || style.boxShadow !== 'none' || (cell && getComputedStyle(cell).boxShadow !== 'none')
      }), 'the keyboard target has a visible focus indicator')
      return
    }
    await page.keyboard.press('Tab')
  }
  assert.fail(`Keyboard cannot reach ${await target.evaluate(el => el.outerHTML.slice(0, 160))}`)
}

async function activate(page, target) { await tabTo(page, target); await page.keyboard.press('Enter') }
async function type(page, target, value) {
  await tabTo(page, target)
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText(value)
}
const button = (page, name) => page.getByRole('button', { name, exact: true })
const field = (page, name) => page.getByLabel(name, { exact: true })

export async function keyboardJourney(browser, root, origin, width, evidence, shots) {
  const employee = await session(browser, root, origin, 'employee', width)
  const manager = await session(browser, root, origin, 'manager', width)
  const page = employee.page, title = `Denver client travel by keyboard ${width}`
  const purchase = width === 1440
    ? { merchant: 'Denver Airport Transit', amount: '24.60', minor: 2460, reference: 'TRAIN-1001' }
    : { merchant: 'Union Station Taxi', amount: '38.60', minor: 3860, reference: 'TAXI-2001' }
  const photograph = async (screen, current) => {
    assert.equal(await current.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    const path = join(evidence, `keyboard-${screen}-${width}.png`)
    await current.screenshot({ path }); shots.push({ screen: `A11Y-001 ${screen}`, viewport: width, path })
  }
  try {
    await activate(page, button(page, 'New claim'))
    await type(page, field(page, 'Claim title'), title)
    await activate(page, button(page, 'Start claim'))
    await page.getByRole('heading', { name: title, exact: true }).waitFor()
    await activate(page, button(page, 'Add expense'))
    await type(page, field(page, 'Merchant'), purchase.merchant)
    await type(page, field(page, 'Amount'), purchase.amount)
    await type(page, field(page, 'Description'), 'Client workshop transport')
    await tabTo(page, field(page, 'Category'))
    await page.keyboard.press('t')
    await page.keyboard.press('Tab')
    await tabTo(page, field(page, 'Receipt photo or PDF'))
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Space')])
    await chooser.setFiles({ name: `${purchase.reference}.pdf`, mimeType: 'application/pdf', buffer: await keyboardReceipt({ ...purchase, date: await field(page, 'Date').inputValue() }) })
    await activate(page, page.locator('form.item-form').getByRole('button', { name: 'Add expense', exact: true }))
    await page.locator('form.item-form').waitFor({ state: 'detached' })
    await tabTo(page, button(page, 'Submit for approval'))
    await photograph('claim', page)
    await page.keyboard.press('Enter')
    await page.locator('.detail .badge', { hasText: 'Submitted' }).waitFor()

    // Browser navigation refreshes the other person's snapshot; application actions use only the keyboard.
    await manager.page.reload()
    await activate(manager.page, manager.page.getByRole('navigation', { name: 'Coaster' }).getByRole('link', { name: 'Approvals', exact: true }))
    await tabTo(manager.page, manager.page.getByRole('link', { name: new RegExp(title) }))
    await photograph('claim-link', manager.page)
    await manager.page.keyboard.press('Enter')
    await tabTo(manager.page, manager.page.getByRole('radio', { name: 'Approve', exact: true }))
    await manager.page.keyboard.press('ArrowDown')
    await type(manager.page, field(manager.page, 'Reason (required if returning or rejecting)'), 'Please name the client in the description')
    await tabTo(manager.page, button(manager.page, 'Return for correction'))
    await photograph('return', manager.page)
    await manager.page.keyboard.press('Enter')
    await manager.page.locator('.detail .badge', { hasText: 'Returned' }).waitFor()

    await page.reload()
    await page.locator('.detail .badge', { hasText: 'Returned' }).waitFor()
    await activate(page, button(page, `Change ${purchase.merchant}`))
    await type(page, field(page, 'Description'), 'Harbour & Finch client workshop transport')
    await activate(page, button(page, 'Save expense'))
    await page.locator('form.item-form').waitFor({ state: 'detached' })
    await activate(page, button(page, 'Resubmit for approval'))
    await page.locator('.detail .badge', { hasText: 'Submitted' }).waitFor()
    await manager.page.reload()
    await manager.page.locator('.detail .badge', { hasText: 'Submitted' }).waitFor()
    await tabTo(manager.page, button(manager.page, 'Approve'))
    await photograph('approval', manager.page)
    await manager.page.keyboard.press('Enter')
    await manager.page.locator('.detail .badge', { hasText: 'Approved' }).waitFor()
    const id = new URL(manager.page.url()).hash.split('/').at(-1)
    const detail = await api(employee.context, origin, `claims/${id}`)
    assert.deepEqual([detail.claim.status, detail.claim.revision, detail.claim.total_minor], ['approved', 2, purchase.minor])
    assert.equal(detail.revisions.length, 2)
    assert.equal(detail.items[0].description, 'Harbour & Finch client workshop transport')
    assert.deepEqual(detail.decisions.map(d => d.decision), ['returned', 'approved'])
    await photograph('approved', manager.page)
    console.log(`A11Y-001 keyboard-only claim, correction and approval passed at ${width}`)
  } catch (error) {
    await photograph('employee-failure', page)
    await photograph('manager-failure', manager.page)
    throw error
  } finally { await employee.context.close(); await manager.context.close() }
}

const axeSource = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')

/** A11Y-001: axe-core's complete default rule set (WCAG 2.0-2.2 A/AA and best practices) reports no violation on
    any main screen each person opens at this width: every destination in their rail, plus claim and batch detail. */
export async function axeJourney(browser, root, origin, width, people = ['owner', 'employee', 'manager', 'finance']) {
  const screens = new Set()
  for (const as of people) {
    const { context, page } = await session(browser, root, origin, as, width)
    try {
      await context.addInitScript({ content: axeSource })
      await page.reload()
      const state = await api(context, origin, 'state'), roles = state.actor.roles
      const views = ['claims', ...(state.claims[0] ? [`claims/${state.claims[0].id}`] : []),
        ...(roles.manager || roles.finance ? ['approvals'] : []),
        ...(roles.finance ? ['batches', ...(state.batches[0] ? [`batches/${state.batches[0].id}`] : [])] : []),
        ...(roles.owner ? ['move-in'] : []), 'settings']
      for (const view of views) {
        await page.goto(`${origin}/app#/${view}`)
        await page.waitForLoadState('networkidle')
        await page.waitForFunction(() => !/Opening[^.]*…/.test(document.body.innerText))
        const violations = await page.evaluate(async () => (await window.axe.run(document)).violations
          .map(v => `${v.id} (${v.impact}): ${v.nodes.map(n => n.target.join(' ')).join(', ')}`))
        assert.deepEqual(violations, [], `A11Y-001 axe on ${view} as ${as} at ${width}`)
        screens.add(view.replace(/\/.+$/, '/:id'))
      }
    } finally { await context.close() }
  }
  console.log(`A11Y-001 axe found no violation on ${[...screens].join(', ')} at ${width}`)
  return screens
}
