import assert from 'node:assert/strict'
import { writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { api, PEOPLE, session } from './browser-journey.mjs'
import { issuerServer } from './fixtures/feed/server.mjs'

/** Native configuration and scheduled delivery through a real read-only SSH/SFTP issuer edge. */
export async function programFeedScreens(browser, root, server, evidence) {
  const issuer = await issuerServer()
  try {
    for (const width of [1440, 390]) {
      const owner = await session(browser, root, server.origin, 'owner', width), employee = await session(browser, root, server.origin, 'employee', width)
      const keyFile = join(root, '.cache', `synthetic-coaster-${width + 7000}.pem`)
      try {
        const issuerName = `Harbour card program ${width}`, last4 = width === 1440 ? '7440' : '7390', merchant = `Harbour rail ${width}`
        const state = await api(owner.context, server.origin, 'state'), category = state.categories.find(c => c.name === 'Travel')
        await api(owner.context, server.origin, 'statements/cards', { issuer: issuerName, last4, employee: PEOPLE.employee })
        await owner.page.goto(server.origin + '/app#/settings')
        const panel = owner.page.getByRole('region', { name: 'Scheduled card program feed', exact: true })
        await panel.getByText('Connect an SFTP program feed', { exact: true }).click()
        for (const [label, value] of Object.entries({ 'Issuer name': issuerName, 'SFTP host IPv4 address': issuer.credentials.host, 'SFTP port': issuer.credentials.port, 'SFTP username': issuer.credentials.username, 'Pinned host key fingerprint': issuer.credentials.hostKeyFingerprint, 'Delivery directory': issuer.credentials.directory, 'Posted date column': 'Date', 'Transaction ID column': 'Transaction', 'Merchant column': 'Merchant', 'Amount column': 'Amount', 'Card last four column': 'Card', 'Issuer sequence column': 'Sequence', 'Merchant category code column': 'MCC' })) await panel.getByLabel(label, { exact: true }).fill(String(value))
        await panel.getByLabel('Default expense category', { exact: true }).selectOption(category.id)
        await shot(owner.page, panel, evidence, 'program-feed-configuration', width)
        await writeFile(keyFile, issuer.credentials.privateKey, { mode: 0o600 })
        await panel.getByLabel('Issuer-authorized private key file', { exact: true }).setInputFiles(keyFile)
        await panel.getByLabel('I authorize scheduled read-only connections and imports from this issuer directory', { exact: true }).check()
        const [connected] = await Promise.all([owner.page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/feeds/program')), panel.getByRole('button', { name: 'Connect program feed', exact: true }).click()])
        assert.equal(connected.status(), 200, await connected.text())
        await rm(keyFile)
        await panel.getByRole('heading', { name: issuerName, exact: true }).waitFor()
        await shot(owner.page, panel, evidence, 'program-feed-connected', width)
        const name = `synthetic-coaster-${width + 7100}.csv`
        issuer.files.clear(); issuer.files.set(name, `Date,Merchant,Amount,Card,Transaction,MCC,Sequence\n2026-10-22,${merchant},27.40,${last4},synthetic-coaster-${width + 7200},4112,synthetic-coaster-${width + 7300}\n`)
        const tick = await server.scheduled(); assert.equal(tick.status, 200, await tick.text())
        await owner.page.reload()
        await panel.getByText(`Deliveries from ${issuerName}`, { exact: true }).click()
        await panel.getByText(new RegExp(`${name}.*1 charges`)).waitFor()
        await shot(owner.page, panel, evidence, 'program-feed-delivered', width)
        const feed = (await api(owner.context, server.origin, 'feeds/program')).feeds.find(f => f.issuer === issuerName)
        assert.ok(feed.lastSuccessAt); assert.equal(feed.error, null)
        const claims = (await api(employee.context, server.origin, 'state')).claims
        let found
        for (const claim of claims) { const detail = await api(employee.context, server.origin, `claims/${claim.id}`); if (detail.items.some(item => item.merchant === merchant)) { found = detail; break } }
        assert.ok(found)
        await employee.page.goto(server.origin + `/app#/claims/${found.claim.id}`)
        await employee.page.getByText(merchant, { exact: true }).first().waitFor()
        await shot(employee.page, employee.page.getByText(merchant, { exact: true }).first(), evidence, 'program-feed-expense', width)
        await panel.getByLabel('I confirm this feed must stop future connections and imports', { exact: true }).check()
        await panel.getByRole('button', { name: `Disconnect ${issuerName}`, exact: true }).click()
        await panel.getByRole('button', { name: `Disconnect ${issuerName}`, exact: true }).waitFor({ state: 'detached' })
        await shot(owner.page, panel, evidence, 'program-feed-disconnected', width)
        const reads = issuer.requests.length, again = await server.scheduled(); assert.equal(again.status, 200, await again.text()); assert.equal(issuer.requests.length, reads)
      } finally { await rm(keyFile, { force: true }); await owner.context.close(); await employee.context.close() }
    }
  } finally { await issuer.close() }
}
async function shot(page, target, evidence, name, width) {
  await target.scrollIntoViewIfNeeded()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} fits ${width}`)
  await page.screenshot({ path: join(evidence, `${name}-${width}.png`), fullPage: true })
}
