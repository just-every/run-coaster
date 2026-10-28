// The human journey through Coaster's screens, one person per browser context.
import assert from 'node:assert/strict'
import { assertAccessible } from './browser-accessibility.mjs'
import { addTextMetadata } from './fixtures/receipt-metadata.mjs'
import { inspectReceiptSignals } from './browser-receipt-signals.mjs'
import { inspectPolicyReview } from './browser-policy-review.mjs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { signIn } from './browser-runtime.mjs'

export const PEOPLE = { employee: 'employee@dev.localhost', manager: 'manager@dev.localhost', finance: 'finance@dev.localhost' }

/** A signed-in browser context for a dev persona or the owner; the owner finishes first-run setup once. */
export async function session(browser, root, origin, as, width) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, acceptDownloads: true })
  await signIn(context, origin, as === 'owner' ? 'owner@harbourfinch.example' : PEOPLE[as])
  const page = await context.newPage()
  await page.goto(origin + '/app')
  if (page.url().endsWith('/setup')) {
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Finish setup' }).click()
    await page.waitForURL(/\/app/)
  }
  await page.getByRole('navigation', { name: 'Coaster' }).waitFor()
  return { context, page }
}

export async function api(context, origin, path, body) {
  const response = body === undefined ? await context.request.get(`${origin}/api/coaster/${path}`) : await context.request.post(`${origin}/api/coaster/${path}`, { headers: { origin }, data: body })
  const value = await response.json()
  assert.equal(response.status(), 200, `${path}: ${JSON.stringify(value)}`)
  return value
}

/** The synthetic Harbour & Finch Studio: policy, categories and three dev personas with roles. */
export async function setUp(owner, origin) {
  await api(owner.context, origin, 'settings/business', { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', perDiem: '', receiptThreshold: '' })
  await api(owner.context, origin, 'settings/mileage-rates', { effectiveFrom: '2000-01-01', rate: '0.88' })
  for (const [name, accountCode, taxCode, limit] of [['Meals', '6300', 'GST', '120.00'], ['Travel', '6200', 'GST', ''], ['Car', '6400', 'GST Free', ''], ['Office supplies', '6500', 'GST', '']])
    await api(owner.context, origin, 'settings/categories', { name, accountCode, taxCode, limit })
  await api(owner.context, origin, 'settings/members', { email: PEOPLE.manager, name: 'Priya Nair', employee: true, manager: true })
  await api(owner.context, origin, 'settings/members', { email: PEOPLE.finance, name: 'Morgan Lee', employee: true, finance: true, release: true, approver: PEOPLE.manager })
  await api(owner.context, origin, 'settings/members', { email: PEOPLE.employee, name: 'Sam Taylor', employee: true, approver: PEOPLE.manager })
  for (const email of Object.values(PEOPLE)) await api(owner.context, origin, 'settings/members/invite', { email })
}

/** A fixture receipt made unique per run (a trailing note after the PNG end), so each width's receipts are distinct evidence. */
async function variant(name, tag, software) {
  const dir = join(tmpdir(), 'coaster-receipts'); await mkdir(dir, { recursive: true })
  const path = join(dir, `${name}-${tag}.png`)
  const original = await readFile(`tests/fixtures/receipts/${name}.png`)
  await writeFile(path, Buffer.concat([software ? addTextMetadata(original, 'Software', software) : original, Buffer.from(`\n${tag}\n`)]))
  return path
}
const PLAN = { 1440: { bistro: '64.50', rockpool: '180.00', km: '142' } }
const minor = text => Math.round(Number(text) * 100)

const nav = (page, name) => page.getByRole('navigation', { name: 'Coaster' }).getByRole('link', { name, exact: true }).click()
const fill = (page, label, value) => page.getByLabel(label, { exact: true }).fill(String(value))
const shot = async (page, evidence, name, width, shots) => { await assertAccessible(page, name); const path = join(evidence, `${name}-${width}.jpg`); await page.screenshot({ path, fullPage: true, type: 'jpeg', quality: 85 }); shots.push({ screen: name, viewport: width, path }) }
async function noOverflow(page, width) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `No page overflow at ${width}px on ${page.url()}`) }

async function addExpense(page, { kind = 'Purchase with receipt', merchant, amount, distance, category, receipt, explanation }) {
  await page.getByRole('button', { name: 'Add expense', exact: true }).click()
  await page.getByLabel('Type', { exact: true }).selectOption({ label: kind })
  if (distance) { await fill(page, 'Route', merchant); await fill(page, 'Distance (mi)', distance) }
  else { await fill(page, 'Merchant', merchant); await fill(page, 'Amount', amount) }
  await page.getByLabel('Category', { exact: true }).selectOption({ label: category })
  if (receipt) await page.getByLabel('Receipt photo or PDF', { exact: true }).setInputFiles(receipt)
  if (explanation) await fill(page, 'Explanation for your approver', explanation)
  await page.locator('form.item-form').getByRole('button', { name: 'Add expense', exact: true }).click()
  await page.locator('form.item-form').waitFor({ state: 'detached' })
}

/** Employee claim → manager return → correction → approval → finance batch, export and payment, at one width. */
export async function journey(browser, root, origin, width, evidence, shots) {
  const people = {}
  try {
    for (const as of ['employee', 'manager', 'finance']) people[as] = await session(browser, root, origin, as, width)
    const { employee, manager, finance } = people, title = `Sydney client workshop ${width}`, plan = PLAN[width]
    const total = minor(plan.bistro) + minor(plan.rockpool) + Math.floor((Number(plan.km) * 100 * 88 + 50) / 100)
    // An agent prepares a draft from an emailed receipt; the employee sees it waiting.
    const key = await api(employee.context, origin, 'agent-keys', { label: 'Receipt inbox agent' })
    const categories = (await api(employee.context, origin, 'state')).categories, travel = categories.find(c => c.name === 'Travel').id
    const proposal = await (await fetch(`${origin}/api/coaster/agent/claims`, { method: 'POST', headers: { authorization: `Bearer ${key.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: `Uber receipts ${width}`, note: 'Forwarded from the receipts inbox', items: [{ kind: 'receipt', date: '2026-04-28', merchant: 'Uber', amount: '38.60', allocations: [{ category: travel }], receipt: { name: 'uber.png', base64: (await readFile(await variant('uber', width))).toString('base64') } }] }) })).json()
    assert.equal(proposal.status, 'proposed')

    const page = employee.page
    await page.reload(); await nav(page, 'Claims')
    await page.getByText(`Uber receipts ${width}`).waitFor()
    await page.getByRole('button', { name: 'New claim' }).click()
    await fill(page, 'Claim title', title)
    await page.getByRole('button', { name: 'Start claim' }).click()
    await page.getByRole('heading', { name: title }).waitFor()
    await addExpense(page, { merchant: 'Harbour View Bistro', amount: plan.bistro, category: 'Meals', receipt: await variant('bistro', width) })
    await addExpense(page, { merchant: 'Rockpool Dining', amount: plan.rockpool, category: 'Meals', receipt: await variant('hotel', width, 'Adobe Photoshop 2026'), explanation: 'Client dinner for four, agreed with Priya' })
    await addExpense(page, { kind: 'Mileage at the rate for its date', merchant: 'Studio to client', distance: plan.km, category: 'Car' })
    await page.getByText('Over the Meals limit of AUD 120.00').waitFor()
    await page.getByRole('button', { name: 'Submit for approval' }).click()
    await page.locator('.detail .badge', { hasText: 'Submitted' }).waitFor()
    await noOverflow(page, width)
    await shot(page, evidence, 'claim-employee', width, shots)

    await manager.page.reload(); await nav(manager.page, 'Approvals')
    await manager.page.getByRole('link', { name: new RegExp(title) }).click()
    await manager.page.getByRole('heading', { name: title }).waitFor()
    await fill(manager.page, 'Reason (required if returning or rejecting)', 'The bistro receipt shows a different date; attach the right one')
    await manager.page.getByRole('radio', { name: 'Return for correction' }).check()
    await manager.page.getByRole('button', { name: 'Return for correction' }).click()
    await manager.page.locator('.detail .badge', { hasText: 'Returned' }).waitFor()

    await page.reload(); await page.getByRole('heading', { name: title }).waitFor()
    await page.getByText('Returned for correction').waitFor()
    await page.getByRole('button', { name: 'Change Harbour View Bistro' }).click()
    await page.getByLabel('Replace receipt (the earlier one stays in the history)', { exact: true }).setInputFiles(await variant('officeworks', width))
    await page.getByRole('button', { name: 'Save expense' }).click()
    await page.locator('form.item-form').waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Resubmit for approval' }).click()
    await page.locator('.detail .badge', { hasText: 'Submitted' }).waitFor()
    await page.locator('.metadata').getByText('Revision 2').waitFor()
    await noOverflow(page, width)
    await shot(page, evidence, 'claim-resubmitted', width, shots)
    await page.goto(origin + '/app#/claims')
    await page.getByRole('link', { name: new RegExp(title) }).waitFor()
    await noOverflow(page, width)
    await shot(page, evidence, 'claims-list', width, shots)

    await manager.page.reload(); await manager.page.getByRole('heading', { name: title }).waitFor()
    const advice = await inspectPolicyReview(manager, origin, new URL(manager.page.url()).hash.split('/').at(-1), width, evidence, shots)
    const claimId = new URL(manager.page.url()).hash.split('/').at(-1)
    await inspectReceiptSignals(manager, origin, claimId, width, evidence, shots)
    await manager.page.getByRole('checkbox', { name: /I reviewed the/ }).check()
    await noOverflow(manager.page, width)
    await shot(manager.page, evidence, 'approvals', width, shots)
    await manager.page.getByRole('button', { name: 'Approve', exact: true }).click()
    await manager.page.locator('.detail .badge', { hasText: 'Approved' }).waitFor()
    assert.deepEqual(await inspectPolicyReview(manager, origin, new URL(manager.page.url()).hash.split('/').at(-1), width, evidence, shots, 'approved'), advice)

    await finance.page.reload(); await nav(finance.page, 'Batches')
    await finance.page.getByRole('checkbox', { name: new RegExp(title) }).check()
    await finance.page.getByRole('button', { name: /^Create batch/ }).click()
    await finance.page.getByText(/^Reconciled:/).waitFor()
    await finance.page.getByRole('checkbox', { name: /I checked the reimbursements/ }).check()
    await finance.page.getByRole('button', { name: 'Approve batch' }).click()
    const downloading = finance.page.waitForEvent('download')
    await finance.page.getByRole('link', { name: 'Download accounting CSV' }).click()
    const download = await downloading, csvPath = join(evidence, `accounting-${width}.csv`)
    await download.saveAs(csvPath)
    const csv = await readFile(csvPath, 'utf8'), [head, ...rows] = csv.trim().split('\r\n').map(r => r.slice(1, -1).split('","'))
    assert.equal(rows.length, 3)
    assert.equal(Math.round(rows.reduce((n, r) => n + Number(r[head.indexOf('amount')]) * 100, 0)), total)
    assert.ok(rows.some(r => r[head.indexOf('policy_exceptions')] === 'over-limit'))
    // PAY-004: the owner gave Morgan release access and Morgan signed in minutes ago, so one release opens payment.
    await finance.page.getByRole('button', { name: 'Release payment' }).click()
    await finance.page.getByText(/^Released by Morgan Lee/).waitFor()
    await fill(finance.page, 'Payment reference', `CBA-${width}`)
    await finance.page.getByRole('button', { name: 'Record payment' }).click()
    await finance.page.getByText(`reference CBA-${width}`).first().waitFor()
    await noOverflow(finance.page, width)
    await shot(finance.page, evidence, 'batches', width, shots)
    await finance.page.goto(origin + `/app#/claims/${claimId}`); await finance.page.reload()
    await inspectReceiptSignals(finance, origin, claimId, width, evidence, shots, 'reviewed-after-payment', true)
    return { width, claim: title, totalMinor: total }
  } catch (error) {
    for (const [as, { page }] of Object.entries(people)) await page.screenshot({ path: join(evidence, `failure-${as}-${width}.png`), fullPage: true }).catch(() => {})
    throw error
  } finally {
    for (const { context } of Object.values(people)) await context.close()
  }
}

/** The owner's screens: the Expensify move-in (imported once) and settings. */
export async function ownerScreens(owner, origin, width, evidence, shots, importNow) {
  const page = owner.page
  await page.setViewportSize({ width, height: 1000 })
  await page.reload(); await nav(page, 'Move in')
  if (importNow) {
    await page.getByLabel('Expensify CSV', { exact: true }).setInputFiles('tests/fixtures/expensify-report-template.csv')
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await page.getByRole('button', { name: 'Import 3 reports' }).click()
    await page.getByText('Imported 3 reports with 6 expenses.').waitFor()
  }
  await page.getByRole('cell', { name: 'Melbourne pitch' }).waitFor()
  await noOverflow(page, width)
  await shot(page, evidence, 'move-in', width, shots)
  // ADMIN-001: departments, the new roles and the escalation chain sit beside People on the same screen.
  if (importNow) {
    const sales = await api(owner.context, origin, 'settings/departments', { name: 'Sales', head: PEOPLE.manager })
    await api(owner.context, origin, 'settings/escalation-chains', { department: sales.id, steps: [{ kind: 'department-head' }, { kind: 'finance', email: PEOPLE.finance }] })
    await api(owner.context, origin, 'settings/members', { email: PEOPLE.employee, name: 'Sam Taylor', employee: true, approver: PEOPLE.manager, department: sales.id })
    await page.reload()
  }
  await nav(page, 'Settings')
  await page.getByRole('heading', { name: 'People', exact: true }).waitFor()
  await page.getByRole('heading', { name: 'Departments', exact: true }).waitFor()
  await page.getByRole('heading', { name: 'Escalation chains', exact: true }).waitFor()
  await page.getByRole('cell', { name: 'Sales', exact: true }).waitFor()
  for (const role of ['Admin (people, settings and workflows; not payments)', 'Card admin (assigns and freezes cards)', 'Bookkeeper (external; exports and ledger fixes)']) await page.getByLabel(role, { exact: true }).waitFor()
  await noOverflow(page, width)
  await shot(page, evidence, 'settings', width, shots)
  // REPORT-001 by department (ADMIN-001): Sales groups the employee's spend and drills to a line that opens its receipt.
  const spend = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Spend', exact: true }) })
  await spend.getByLabel('Group by', { exact: true }).selectOption('department')
  await spend.getByLabel('Spent from', { exact: true }).fill('2000-01-01'); await spend.getByLabel('Spent until', { exact: true }).fill('2099-12-31')
  await spend.getByRole('button', { name: 'Show spend', exact: true }).click()
  await spend.getByRole('button', { name: 'Sales', exact: true }).click()
  await spend.getByRole('cell', { name: 'Sam Taylor' }).first().waitFor()
  assert.ok(await spend.getByRole('link', { name: 'Open', exact: true }).count() > 0, 'a Sales line opens its receipt')
  await noOverflow(page, width)
  await shot(page, evidence, 'spend-department', width, shots)
}

/** ERASURE-001 in the screens: the owner deactivates the employee, erases them from Settings and reads the receipt. */
export async function eraseEmployee({ context, page }, origin, numbers, evidence, shots) {
  await api(context, origin, 'settings/members', { email: PEOPLE.employee, name: 'Sam Taylor', employee: true, approver: PEOPLE.manager, active: false })
  await page.goto(origin + '/app')
  await nav(page, 'Settings')
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('row', { name: /Sam Taylor \(inactive\)/ }).getByRole('button', { name: 'Erase', exact: true }).click()
  await page.getByRole('status').filter({ hasText: /Sam Taylor is now Former member [0-9a-f]{8}/ }).waitFor()
  await page.getByText('Erasure receipts').waitFor()
  await shot(page, evidence, 'erasure', 1440, shots)
  const receipt = (await api(context, origin, 'retention')).erasures[0]
  assert.deepEqual(receipt.retained.claims.map(c => [c.claim, c.status]), numbers.map(n => [`CL-${String(n).padStart(4, '0')}`, 'reimbursed']), 'the paid claims stay, listed on the receipt')
  assert.ok(receipt.retained.receiptSha256.length > 0)
  const state = await api(context, origin, 'state')
  assert.ok(state.members.every(m => m.email !== PEOPLE.employee && m.name !== 'Sam Taylor'))
  assert.ok(state.claims.filter(c => c.employee_email === receipt.retained.subject).every(c => c.status === 'reimbursed' && c.employee_name === receipt.label))
  return receipt
}
