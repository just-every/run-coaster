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

import { desktopEdge } from './fixtures/desktop.mjs'

test('ACCT-007 Desktop scheduled SOAP catalog, posting replay and isolated error retry use the native role fences and immutable audit history',async()=>{
  const {agency}=await import('./harness.mjs'),h=await harness()
  try {
    const t=await agency(h),root=['accounting','desktop'].join('/'),edge=await desktopEdge(h)
    const admin=await h.person('synthetic-coaster-90@example.invalid',{admin:true}),book=await h.person('synthetic-coaster-91@example.invalid',{bookkeeper:true})
    const unchanged=async(run)=>{const before=await h.db.prepare('SELECT count(*) AS n FROM c_events').first();await run();assert.deepEqual(await h.db.prepare('SELECT count(*) AS n FROM c_events').first(),before)}
    await unchanged(()=>h.post(root+'/connect',{consent:true,company:'C:\\synthetic-coaster-1.QBW'},book,403))
    await unchanged(()=>h.post(root+'/sync',{},admin,403))
    await h.post(root+'/connect',{company:'C:\\synthetic-coaster-1.QBW'},admin,400)
    const connected=await h.post(root+'/connect',{consent:true,company:'C:\\synthetic-coaster-1.QBW'},admin)
    assert.match(connected.configuration,/<RunEveryNMinutes>60/);assert.ok(!connected.configuration.includes(connected.password))
    assert.match(await edge.soap('authenticate',{strUserName:'wrong',strPassword:connected.password}),/nvu/)
    await edge.open(connected.configuration,connected.password);await edge.drain()
    let state=await h.get(root,book);assert.deepEqual([...new Set(state.catalog.map(c=>c.kind))].sort(),['Account','Class','Customer','Employee','Vendor'])
    const map=async(name,id,kind='Account')=>h.post(root+'/mappings',{name,listId:id,kind},book)
    await map('account:6300','synthetic-coaster-1');await map('payable','synthetic-coaster-2');await map('bank','synthetic-coaster-3');await map('vendor:sam@harbourfinch.example','synthetic-coaster-6','Vendor')
    await unchanged(()=>h.post(root+'/mappings',{name:'payable',kind:'Account',listId:'synthetic-coaster-1'},admin,403))
    let claim=await h.post('claims',{title:'synthetic-coaster-92'},t.sam)
    claim=await h.post(`claims/${claim.id}/items`,{version:claim.version,kind:'receipt',date:'2026-09-10',merchant:'synthetic-coaster-93',amount:'42.00',category:t.c.meals,explanation:'synthetic-coaster-94'},t.sam)
    claim=await h.post(`claims/${claim.id}/submit`,{version:claim.version},t.sam)
    claim=await h.post(`claims/${claim.id}/decision`,{version:claim.version,revision:claim.revision,decision:'approved',acknowledge:true},t.priya)
    let batch=await h.post('batches',{claims:[claim.id]},t.morgan)
    batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:4200},t.jordan)
    const card=await h.post('statements/cards',{issuer:'synthetic-coaster-96',last4:'1111',employee:'sam@harbourfinch.example'})
    const input={format:'csv',name:'synthetic-coaster-97.csv',issuer:'synthetic-coaster-96',category:t.c.meals,content:'Date,Merchant,Amount,Id\n2026-09-12,synthetic-coaster-98,12.30,synthetic-coaster-99',mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',transactionId:'Id',wholeFileLast4:'1111'}}
    const imported=await h.post('statements/commit',{...input,fingerprint:(await h.post('statements/preview',input,t.morgan)).fingerprint},t.morgan)
    const cardDetail=await h.get('claims/'+imported.claims[0],t.sam),item=cardDetail.items[0]
    let cardClaim=await h.post(`claims/${cardDetail.claim.id}/items`,{version:cardDetail.claim.version,item:item.id,kind:'receipt',date:item.spent_on,merchant:item.merchant,amount:'12.30',category:t.c.meals,explanation:'synthetic-coaster-100'},t.sam)
    cardClaim=await h.post(`claims/${cardClaim.id}/submit`,{version:cardClaim.version},t.sam)
    await h.post(`claims/${cardClaim.id}/decision`,{version:cardClaim.version,revision:cardClaim.revision,decision:'approved',acknowledge:true},t.priya)
    await map('card:'+card.id,'synthetic-coaster-3')
    const file=(await h.get('statements')).files.find(f=>f.name===input.name)
    const opened=await h.post(`statements/${file.id}/reconcile`,{last4:'1111',openingBalance:'10.00',statementBalance:'22.30'},t.morgan)
    const closed=await h.post(`statements/reconciliations/${opened.id}/close`,{},t.morgan)
    const journal=closed.ledger.entries.find(e=>e.kind==='opening')
    await map('account:'+journal.debit_account,'synthetic-coaster-1');await map('account:'+journal.credit_account,'synthetic-coaster-3')
    // Web Connector's own hourly run queues the reviewed batch without pressing manual sync.
    await edge.open(connected.configuration,connected.password);await edge.drain('BillAdd')
    assert.match(edge.sent.find(r=>r.kind==='CreditCardChargeAdd').request,/<Amount>12.30<\/Amount>/)
    assert.match(edge.sent.find(r=>r.kind==='JournalEntryAdd').request,/<Amount>10.00<\/Amount>/)
    assert.equal(edge.sent.filter(r=>r.kind==='JournalEntryAdd').length,1,'purchase lines already represented by card charges are not journaled again')
    state=await h.get(root,book);const failed=state.requests.find(r=>r.kind==='BillAdd');assert.equal(failed.status,'failed');assert.equal(failed.message,'Account is inactive')
    const before=edge.sent.length
    await h.post(root+'/retry/'+failed.id,{},book)
    // Continue through the protocol; only the explicitly failed financial request is retried.
    await edge.open(connected.configuration,connected.password);await edge.drain()
    const bills=edge.sent.slice(before).filter(r=>!r.kind.endsWith('Query'));assert.equal(bills.length,1);assert.equal(bills[0].id,failed.id);assert.match(bills[0].request,/<Amount>42.00<\/Amount>/)
    assert.equal((await h.get(`batches/${batch.id}`,t.morgan)).batch.total_minor,4200)
    await edge.open(connected.configuration,connected.password);await edge.drain();assert.equal(edge.sent.filter(r=>r.kind==='BillAdd').length,2,'one failed attempt and one success, never another posting')
    batch=await h.paid(batch.id,batch.version,{reference:'synthetic-coaster-95',paidOn:'2026-09-11'},t.jordan)
    await edge.open(connected.configuration,connected.password);await edge.drain()
    assert.equal(edge.sent.filter(r=>r.kind==='BillPaymentCheckAdd').length,1);assert.match(edge.sent.find(r=>r.kind==='BillPaymentCheckAdd').request,/<PaymentAmount>42.00<\/PaymentAmount>/)
    await edge.open(connected.configuration,connected.password);await edge.drain();assert.equal(edge.sent.filter(r=>r.kind==='BillPaymentCheckAdd').length,1)
    const lines=(await h.get('history')).lines.filter(l=>l.action.startsWith('desktop-'))
    assert.ok(lines.some(l=>l.action==='desktop-connected'&&l.actor_email==='synthetic-coaster-90@example.invalid'))
    assert.ok(lines.some(l=>l.action==='desktop-sync-started'&&l.channel==='schedule'))
    assert.ok(lines.every((l,i)=>!i||l.seq>lines[i-1].seq));assert.ok(lines.every(l=>l.at&&'agent'in l))
    await assert.rejects(()=>h.db.prepare("UPDATE c_events SET action='changed' WHERE action='desktop-connected'").run(),/permanent/)
    await assert.rejects(()=>h.db.prepare("DELETE FROM c_events WHERE action='desktop-connected'").run(),/permanent/)
    await h.post(root+'/disconnect',{},admin)
    assert.equal((await h.get(root,book)).connected,false)
    assert.match(await edge.soap('authenticate',{strUserName:connected.configuration.match(/<UserName>(.*?)<\/UserName>/)[1],strPassword:connected.password}),/nvu/)
  } finally {await h.close()}
})
