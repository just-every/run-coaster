// Real API, native sessions, D1 and scheduled Worker; only Intuit's network edge is faked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness } from './harness.mjs'
import { qboFixture, qboFixtureId as fixture } from './fixtures/qbo.mjs'

const base = 'accounting/qbo'

test('CODE-001 QuickBooks consent is session-bound; daily metadata changes and archived choices reach the real catalog without manual sync', async () => {
  const edge = qboFixture()
  let accountStarted, releaseAccount, pause = false
  const started = new Promise(resolve => { accountStarted = resolve })
  const released = new Promise(resolve => { releaseAccount = resolve })
  const h = await harness({ qboEdge: async request => {
    if (pause && new URL(request.url).searchParams.get('query')?.startsWith('SELECT * FROM Account ')) { accountStarted(); await released }
    return edge.fetch(request)
  }, bindings: edge.bindings })
  try {
    await h.post('settings/business', { name: fixture(804), currency: 'USD', timezone: 'UTC' })
    const finance = await h.person(`${fixture(805)}@example.invalid`, { finance: true })
    const employee = await h.person(`${fixture(806)}@example.invalid`, { employee: true })
    const managerAddress = `${fixture(807)}@example.invalid`
    await h.person(managerAddress, { manager: true })
    const bookkeeper = await h.person(`${fixture(808)}@example.invalid`, { bookkeeper: true })
    const admin = await h.person(`${fixture(809)}@example.invalid`, { admin: true })
    for (const person of [employee, bookkeeper]) await h.post(`${base}/connect`, { consent: true }, person, 403)
    await h.post(`${base}/connect`, {}, finance, 400)
    assert.equal((await h.send(`/api/coaster/${base}/connect`, { consent: true }, finance, { origin: 'https://unrelated.example' })).status, 403)
    const adminStart = await h.post(`${base}/connect`, { consent: true }, admin)
    assert.ok(adminStart.authorizationUrl)
    const start = await h.post(`${base}/connect`, { consent: true }, finance)
    const authorization = new URL(start.authorizationUrl)
    assert.equal(authorization.origin, 'https://appcenter.intuit.com')
    assert.equal(authorization.searchParams.get('scope'), 'com.intuit.quickbooks.accounting')
    assert.equal(h.outbound.filter(r => new URL(r.url).hostname.endsWith('.intuit.com')).length, 0, 'starting consent makes no provider request')
    const callback = new URL(authorization.searchParams.get('redirect_uri'))
    assert.equal(callback.origin, h.origin)
    callback.search = new URLSearchParams({ state: authorization.searchParams.get('state'), code: fixture(802), realmId: fixture(803) }).toString()
    await h.get(`${base}/callback?state=${fixture(899)}`, finance, 409)
    await h.get(callback.pathname.replace('/api/coaster/', '') + callback.search, h.owner, 409)
    assert.equal(edge.rotation, 0, 'a different native session never exchanges the code')
    const completed = await h.send(callback.pathname + callback.search, undefined, finance)
    assert.equal(completed.status, 303)
    await h.get(callback.pathname.replace('/api/coaster/', '') + callback.search, finance, 409)
    assert.equal(edge.rotation, 1, 'the authorization code is consumed once')
    let status = await h.get(base, bookkeeper)
    assert.equal(status.realm, fixture(803)); assert.equal(status.connected, true)
    await h.post(`${base}/refresh`, {}, employee, 403)
    await h.post(`${base}/refresh`, {}, admin, 403)
    await h.post(`${base}/refresh`, {}, bookkeeper)
    let catalog = await h.get('coding', employee)
    const dimension = kind => catalog.dimensions.find(d => d.source === 'quickbooks' && d.kind === kind)
    for (const kind of ['account', 'class', 'location', 'department', 'customer', 'vendor', 'project']) assert.ok(dimension(kind), kind)
    const classId = dimension('class').id, project = catalog.values.find(v => v.dimension_id === dimension('project').id)
    const oldClass = catalog.values.find(v => v.source_id === fixture(851))
    assert.deepEqual((await h.get(`coding/options?dimension=${classId}`, employee)).map(v => v.source_id), [fixture(851)])
    catalog = await h.post('coding/values', { id: project.id, owner: managerAddress, version: catalog.version })
    status = await h.get(base)
    await h.post(`${base}/schedule`, { hour: 2, version: status.version }, admin, 403)
    await h.post(`${base}/schedule`, { hour: 2, version: status.version }, bookkeeper, 403)
    status = await h.post(`${base}/schedule`, { hour: 2, version: status.version }, finance)
    const worker = await h.mf.getWorker(), tick = iso => worker.scheduled({ scheduledTime: new Date(iso), cron: '17 * * * *' })
    edge.generation = 1
    const before = h.outbound.length
    await tick('2031-06-10T01:17:00Z')
    assert.equal(h.outbound.length, before, 'no refresh before the configured business-time hour')
    await Promise.all([tick('2031-06-10T02:17:00Z'), tick('2031-06-10T02:17:00Z')])
    let choices = await h.get(`coding/options?dimension=${classId}`, employee)
    assert.deepEqual(choices.map(v => v.source_id).sort(), [fixture(851), fixture(852)], 'the daily trigger discovers a new class')
    assert.equal(h.outbound.slice(before).filter(r => new URL(r.url).searchParams.get('query')?.startsWith('SELECT * FROM Class ')).length, 1, 'overlapping daily callbacks fetch one snapshot')
    const after = h.outbound.length
    await tick('2031-06-10T03:17:00Z')
    assert.equal(h.outbound.length, after, 'a successful day refreshes once')
    edge.generation = 2
    await tick('2031-06-11T02:17:00Z')
    choices = await h.get(`coding/options?dimension=${classId}`, employee)
    assert.deepEqual(choices.map(v => v.source_id), [fixture(852)], 'inactive ledger classes stop being offered')
    catalog = await h.get('coding', employee)
    assert.equal(catalog.values.find(v => v.id === oldClass.id).active, 0)
    assert.equal(catalog.values.find(v => v.id === project.id).owner_email, managerAddress, 'provider refresh preserves native project ownership')
    assert.equal(catalog.values.filter(v => v.source_id === fixture(852)).length, 1, 'refreshes never duplicate provider choices')
    const unchanged = catalog
    edge.failEntity = 'Vendor'
    await h.post(`${base}/refresh`, {}, finance, 502)
    assert.deepEqual(await h.get('coding', employee), unchanged, 'a late failed entity leaves the full earlier catalog intact')
    assert.match((await h.get(base)).error, /HTTP 503/)
    edge.failEntity = ''; edge.redirect = true
    await h.post(`${base}/refresh`, {}, finance, 502)
    assert.deepEqual(await h.get('coding', employee), unchanged)
    edge.redirect = false
    await h.post(`${base}/refresh`, {}, finance)
    const history = await h.get('history')
    const exposed = JSON.stringify([await h.get(base), await h.get('coding'), history])
    for (const secret of [edge.bindings.QBO_CLIENT_SECRET, fixture(802), edge.lastRefresh, fixture(830 + edge.rotation)]) assert.ok(!exposed.includes(secret), 'no credentials in status, catalog or numbered history')
    const qboRequests = h.outbound.filter(r => new URL(r.url).hostname.endsWith('.intuit.com'))
    assert.ok(qboRequests.every(r => new URL(r.url).pathname.endsWith('/query') || new URL(r.url).pathname.endsWith('/tokens/bearer')), 'the adapter posts no claims, receipts or financial entries')
    const pending = new URL((await h.post(`${base}/connect`, { consent: true }, finance)).authorizationUrl)
    status = await h.get(base)
    await h.post(`${base}/disconnect`, { consent: true, version: status.version }, employee, 403)
    await h.post(`${base}/disconnect`, { consent: true, version: status.version }, finance)
    assert.equal((await h.get(base)).connected, false)
    assert.deepEqual(await h.get(`coding/options?dimension=${classId}`, employee), [])
    const ended = h.outbound.length
    await tick('2031-06-12T02:17:00Z')
    assert.equal(h.outbound.length, ended, 'disconnect stops scheduled traffic')
    await h.get(`${base}/callback?${new URLSearchParams({ state: pending.searchParams.get('state'), code: fixture(802), realmId: fixture(803) })}`, finance, 409)
    assert.equal(h.outbound.length, ended, 'disconnect invalidates pending consent callbacks')
    const reconnect = await h.post(`${base}/connect`, { consent: true }, finance)
    assert.equal((await h.send(edge.callback(reconnect.authorizationUrl), undefined, finance)).status, 303)
    pause = true
    const refreshing = h.post(`${base}/refresh`, {}, finance, 409)
    await started
    status = await h.get(base)
    await h.post(`${base}/disconnect`, { consent: true, version: status.version }, finance)
    const stopped = h.outbound.length
    releaseAccount()
    await refreshing
    assert.equal(h.outbound.length, stopped, 'a disconnected in-flight refresh sends no later page or entity request')
    assert.deepEqual(await h.get(`coding/options?dimension=${classId}`, employee), [], 'the in-flight response cannot reactivate disconnected choices')
  } finally { await h.close() }
})
