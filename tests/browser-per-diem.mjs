import assert from 'node:assert/strict'
import { join } from 'node:path'
import { api, session } from './browser-journey.mjs'

/** CLAIM-002 through the native employee form and manager decision, at desktop and phone widths. */
export async function perDiemJourney(browser, root, origin, owner, width, evidence, shots) {
  const employee = await session(browser, root, origin, 'employee', width)
  const manager = await session(browser, root, origin, 'manager', width)
  const finance = await session(browser, root, origin, 'finance', width)
  const shot = async (page, name) => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `CLAIM-002 no horizontal overflow: ${name} ${width}`)
    const path = join(evidence, `CLAIM-002-${name}-${width}.jpg`)
    await page.screenshot({ path, fullPage: true, type: 'jpeg', quality: 80 })
    shots.push({ screen: `CLAIM-002 ${name}`, viewport: width, path })
  }
  try {
    const { page } = employee, title = `Chicago conference allowance ${width}`
    const state = await api(employee.context, origin, 'state'), fx = state.business.currency === 'USD' ? 1 : 1.5
    await page.getByRole('navigation', { name: 'Coaster' }).getByRole('link', { name: 'Claims', exact: true }).click()
    await page.getByRole('button', { name: 'New claim' }).click()
    await page.getByLabel('Claim title', { exact: true }).fill(title)
    await page.getByRole('button', { name: 'Start claim' }).click()
    await page.getByRole('heading', { name: title }).waitFor()
    await page.getByRole('button', { name: 'Add expense', exact: true }).click()
    await page.getByLabel('Type', { exact: true }).selectOption('per_diem')
    await page.getByLabel('Date', { exact: true }).fill('2026-06-08')
    await page.getByLabel('Travel end date', { exact: true }).fill('2026-06-11')
    await page.getByLabel('Find per diem location', { exact: true }).fill('Chicago')
    await page.getByLabel('Published location', { exact: true }).selectOption({ label: 'Chicago · Cook / Lake · IL · US' })
    await page.getByLabel('Lunch 2026-06-09', { exact: true }).check()
    if (fx !== 1) await page.getByLabel('Exchange rate (optional)', { exact: true }).fill(String(fx))
    await page.getByRole('button', { name: 'Calculate per diem', exact: true }).click()
    await page.getByText('Per diem allowance: $296.00', { exact: true }).waitFor()
    await page.getByText('Daily rates and provided meals', { exact: true }).click()
    await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Travel' })
    await shot(page, 'form')
    await page.locator('form.item-form').getByRole('button', { name: 'Add expense', exact: true }).click()
    await page.locator('form.item-form').waitFor({ state: 'detached' })
    await page.getByText('Daily rates and provided meals', { exact: true }).click()
    await shot(page, 'saved')
    const savedState = await api(employee.context, origin, 'state'), claim = savedState.claims.find(c => c.title === title)
    let detail = await api(employee.context, origin, `claims/${claim.id}`)
    assert.equal(detail.items[0].amount_minor, 29600 * fx)
    assert.deepEqual(detail.items[0].per_diem.days.map(d => d.mieMinor), [6900, 6600, 9200, 6900])
    await page.getByRole('button', { name: 'Submit for approval', exact: true }).click()
    await page.locator('.detail .badge', { hasText: 'Submitted' }).waitFor()
    await manager.page.goto(`${origin}/app#/approvals/${claim.id}`)
    await manager.page.getByRole('heading', { name: title }).waitFor()
    await manager.page.getByText('Daily rates and provided meals', { exact: true }).click()
    await shot(manager.page, 'approver')
    await manager.page.getByRole('button', { name: 'Approve', exact: true }).click()
    await manager.page.locator('.detail .badge', { hasText: 'Approved' }).waitFor()
    detail = await api(employee.context, origin, `claims/${claim.id}`)
    assert.deepEqual(detail.revisions[0].snapshot.items[0].per_diem, detail.items[0].per_diem)
    const batch = await api(finance.context, origin, 'batches', { claims: [claim.id] })
    const reviewed = await api(finance.context, origin, `batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 29600 * fx })
    const released = await api(owner.context, origin, `batches/${batch.id}/release`, { version: reviewed.version })
    await api(finance.context, origin, `batches/${batch.id}/paid`, { version: released.version, reference: `CONF-${width}`, paidOn: '2026-06-15' })
    await employee.page.reload()
    await employee.page.locator('.detail .badge', { hasText: 'Reimbursed' }).waitFor()
    await shot(employee.page, 'reimbursed')
    // The changed settings hint and available export field are visible in their existing screens.
    await owner.page.setViewportSize({ width, height: 1000 })
    await owner.page.goto(`${origin}/app#/settings`)
    await owner.page.getByLabel('Company per diem per day', { exact: true }).waitFor()
    await shot(owner.page, 'settings')
    await owner.page.goto(`${origin}/app#/batches`)
    await owner.page.getByRole('heading', { name: 'Exports', exact: true }).waitFor()
    await shot(owner.page, 'exports')
    return { clause: 'CLAIM-002', width, claim: claim.id, totalMinor: 29600 * fx, dailyMinor: [6900, 6600, 9200, 6900] }
  } finally { await employee.context.close(); await manager.context.close(); await finance.context.close() }
}
