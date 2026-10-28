import { proveCardEvidenceReminders, proveCardEvidenceCompletion, proveCardEvidenceEscalations } from './card-chases.mjs';
// Complete business journeys through the public HTTP API
// with real native sessions, workerd and D1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { agency, harness, receipt } from './harness.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sum = (csv, column) => { const [head, ...rows] = csv.trim().split('\r\n').map(r => r.split('","').map(x => x.replace(/^"|"$/g, ''))); const i = head.indexOf(column); return Math.round(rows.reduce((n, r) => n + Number(r[i]) * 100, 0)) }

async function withAgency(run, options) {
  const h = await harness(options)
  try { await run(h, await agency(h)) } finally { await h.close() }
}
/** A claim with expenses; each expense may carry a receipt fixture. Returns the claim detail. */
async function claim(h, cookie, title, items) {
  let c = await h.post('claims', { title }, cookie)
  for (const item of items) {
    let receiptId
    if (item.receiptFixture) { const r = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...(await receipt(item.receiptFixture)) }, cookie); c = r.claim; receiptId = r.receipt }
    c = await h.post(`claims/${c.id}/items`, { version: c.version, receipt: receiptId, ...item, receiptFixture: undefined }, cookie)
  }
  return h.get(`claims/${c.id}`, cookie)
}
/** That hour of that day on Central time, as the hourly Cron Trigger would fire it. */
const central = (day, hour) => {
  const guess = Date.parse(`${day}T${String(hour).padStart(2, '0')}:17:00Z`)
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map(x => [x.type, x.value]))
  return new Date(guess - (Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - guess))
}
const submit = (h, cookie, d) => h.post(`claims/${d.claim.id}/submit`, { version: d.claim.version }, cookie)
const approve = async (h, cookie, c, extra = {}) => h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved', ...extra }, cookie)

test('PAY-004 the owner sets dual release over $5,000 and a Friday schedule; a $7,200 batch waits for a second releaser, own-claim and stale-sign-in releases are refused, and batch, payment and ledger totals agree', () => withAgency(async (h, t) => {
  await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'USD', timezone: 'America/Chicago' })
  await h.post('settings/payment-controls', { dualReleaseOver: '5000.00', payWeekday: 'Friday' }, t.jordan, 403)
  assert.deepEqual(await h.post('settings/payment-controls', { dualReleaseOver: '5000.00', payWeekday: 'Friday' }), { dualReleaseOverMinor: 500000, payWeekday: 'Friday', advanceAccount: '' })
  await h.post('settings/payment-controls', { payWeekday: 'Caturday' }, h.owner, 400)
  // The owner gives release access to finance only.
  await h.post('settings/members', { email: 'sam@harbourfinch.example', name: 'sam', employee: true, release: true, approver: 'priya@harbourfinch.example' }, h.owner, 400)
  for (const [address, roles] of [['morgan@harbourfinch.example', { employee: true, finance: true, approver: 'priya@harbourfinch.example' }], ['jordan@harbourfinch.example', { employee: true, manager: true, finance: true }]])
    await h.post('settings/members', { email: address, name: address.split('@')[0], ...roles, release: true })
  const riley = await h.person('riley@harbourfinch.example', { finance: true })

  const sam = await claim(h, t.sam, 'Client summit travel', [{ kind: 'receipt', date: '2026-10-19', merchant: 'Hilton Chicago', amount: '4000.00', allocations: [{ category: t.c.travel }], receiptFixture: 'hotel', explanation: 'Three nights for the summit team' }])
  const own = await claim(h, t.morgan, 'Finance conference', [{ kind: 'receipt', date: '2026-10-19', merchant: 'United Airlines', amount: '3200.00', allocations: [{ category: t.c.travel }], receiptFixture: 'uber', explanation: 'Flights for the audit conference' }])
  const a = await approve(h, t.priya, await submit(h, t.sam, sam), { acknowledge: true }), m = await approve(h, t.priya, await submit(h, t.morgan, own), { acknowledge: true })
  assert.deepEqual([a.status, m.status], ['approved', 'approved'])

  // The Friday schedule opens the draft batch at the first hourly run at or after 9:00 Central, once, and never on Thursday.
  const cron = async (day, hour) => (await h.mf.getWorker()).scheduled({ scheduledTime: central(day, hour), cron: '17 * * * *' })
  await cron('2026-10-22', 9); await cron('2026-10-23', 8)
  assert.equal((await h.get('state', t.jordan)).batches.length, 0, 'no batch on Thursday or before 9:00 on Friday')
  await cron('2026-10-23', 9); await cron('2026-10-23', 10)
  const batches = (await h.get('state', t.jordan)).batches
  assert.equal(batches.length, 1, 'one batch for the pay day')
  let batch = batches[0]
  assert.deepEqual([batch.status, batch.created_by, batch.total_minor, batch.released_at], ['draft', 'pay schedule', 720000, null], 'the schedule opens a draft and never releases')
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 720000 }, t.jordan)
  await h.post(`batches/${batch.id}/paid`, { version: batch.version, reference: 'ACH-1023', paidOn: '2026-10-23' }, t.jordan, 409)

  const lines = async () => (await h.db.prepare('SELECT COUNT(*) AS n FROM c_events').first()).n, before = await lines()
  await h.post(`batches/${batch.id}/release`, { version: batch.version }, riley, 403)
  assert.match((await h.send(`/api/coaster/batches/${batch.id}/release`, { version: batch.version }, t.morgan)).value.error, /own claim/, 'a releaser with their own claim in the batch is refused')
  // A sign-in older than 10 minutes cannot release; signing in again can.
  await h.db.prepare("UPDATE oa_sessions SET created_at=created_at-660000 WHERE operator_id=(SELECT id FROM oa_operators WHERE lower(email)='jordan@harbourfinch.example')").run()
  const stale = await h.send(`/api/coaster/batches/${batch.id}/release`, { version: batch.version }, t.jordan)
  assert.equal(stale.status, 401); assert.match(stale.value.error, /Sign in again to release/)
  assert.equal(await lines(), before, 'refused releases wrote nothing')
  assert.equal((await h.send('/auth/magic-link', { email: 'jordan@harbourfinch.example' })).status, 202)
  const jordan = await h.confirmMail('jordan@harbourfinch.example')

  batch = await h.post(`batches/${batch.id}/release`, { version: batch.version }, jordan)
  assert.deepEqual([batch.first_released_by, batch.released_at], ['jordan@harbourfinch.example', null], 'over $5,000 the first release waits for a second releaser')
  await h.post(`batches/${batch.id}/paid`, { version: batch.version, reference: 'ACH-1023', paidOn: '2026-10-23' }, jordan, 409)
  assert.match((await h.send(`/api/coaster/batches/${batch.id}/release`, { version: batch.version }, jordan)).value.error, /second, different person/)
  batch = await h.post(`batches/${batch.id}/release`, { version: batch.version }, h.owner)
  assert.equal(batch.released_by, 'owner@harbourfinch.example')
  batch = await h.post(`batches/${batch.id}/paid`, { version: batch.version, reference: 'ACH-1023', paidOn: '2026-10-23' }, jordan)
  assert.equal(batch.status, 'reimbursed')
  // Batch, payment file and ledger export agree to the cent.
  assert.equal(sum((await h.send(`/api/coaster/batches/${batch.id}/reimbursements.csv`, undefined, jordan)).text, 'amount'), 720000)
  assert.equal(sum((await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`, undefined, jordan)).text, 'amount'), 720000)

  // Each schedule change, release grant, scheduled batch and release is its own history line, in order, that nothing edits.
  const history = (await h.get('history')).lines, at = action => history.filter(l => l.action === action)
  assert.deepEqual(at('payment-controls-set').map(l => [l.actor_email, l.detail.dualReleaseOverMinor, l.detail.payWeekday]), [['owner@harbourfinch.example', 500000, 'Friday']])
  assert.deepEqual(at('release-granted').map(l => l.detail.email), ['morgan@harbourfinch.example', 'jordan@harbourfinch.example'])
  const created = at('batch-created')[0], first = at('batch-release-first')[0], released = at('batch-released')[0]
  assert.deepEqual([created.actor_email, created.channel, created.detail.payDay], ['pay schedule', 'schedule', '2026-10-23'])
  assert.deepEqual([first.actor_email, first.channel, released.actor_email, released.detail.firstReleasedBy], ['jordan@harbourfinch.example', 'app', 'owner@harbourfinch.example', 'jordan@harbourfinch.example'])
  assert.ok(Date.parse(released.at) - Date.parse(released.detail.recentSignIn) < 600000, 'the release names the recent sign-in it relied on')
  assert.ok(at('payment-controls-set')[0].seq < at('release-granted')[0].seq && created.seq < first.seq && first.seq < released.seq && released.seq < at('batch-reimbursed')[0].seq)
  await assert.rejects(h.db.prepare("UPDATE c_events SET actor_email='mallory@example.com' WHERE seq=?").bind(released.seq).run(), /history is permanent/)
}))

/** The files of a stored ZIP by name, read through its central directory, each checked against its CRC-32. */
function unzip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length), files = {}
  let end = bytes.length - 22
  while (v.getUint32(end, true) !== 0x06054b50) end--
  let at = v.getUint32(end + 16, true)
  for (let n = v.getUint16(end + 10, true); n > 0; n--) {
    assert.equal(v.getUint32(at, true), 0x02014b50)
    const size = v.getUint32(at + 20, true), nameLength = v.getUint16(at + 28, true), offset = v.getUint32(at + 42, true)
    const start = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true), data = bytes.subarray(start, start + size)
    assert.equal(crc32(data), v.getUint32(at + 16, true))
    files[bytes.subarray(at + 46, at + 46 + nameLength).toString()] = data
    at += 46 + nameLength + v.getUint16(at + 30, true) + v.getUint16(at + 32, true)
  }
  return files
}

test('DATA-001 the claim-to-batch journey sends data only through the declared mail adapter until the owner links Auth, and then only the declared link and sign-in data reaches Auth', () => withAgency(async (h, t) => {
  const d = await claim(h, t.sam, 'Brisbane visit', [{ kind: 'receipt', date: '2026-06-02', merchant: 'Hotel Ibis', amount: '236.00', allocations: [{ category: t.c.travel }], receiptFixture: 'hotel' }])
  let c = await submit(h, t.sam, d)
  await h.post(`claims/${c.id}/comments`, { body: 'Which client was this for?', asks: 'sam@harbourfinch.example' }, t.priya)
  c = await approve(h, t.priya, c)
  let batch = await h.post('batches', { claims: [c.id] }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 23600 }, t.jordan)
  assert.equal((await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`, undefined, t.jordan)).status, 200)
  await h.paid(batch.id, batch.version, { reference: 'ACH-0603', paidOn: '2026-06-03' }, t.jordan)
  assert.equal((await h.get(`claims/${c.id}`, t.sam)).claim.status, 'reimbursed', 'the core flow works with no optional provider connected')

  // Each outbound host belongs to a flow seed.json declares; with Auth named but not linked, only mail leaves.
  const declared = new Set(JSON.parse(await readFile('seed.json', 'utf8')).externals.map(e => e.id))
  const authHost = new URL(h.auth.issuer).host
  const flowOf = { 'api.resend.com': 'mail-provider', [authHost]: 'identity-provider' }
  assert.ok(h.outbound.length >= 6, 'invitations and the question were mailed')
  assert.deepEqual([...new Set(h.outbound.map(r => `${r.method} ${r.url}`))], ['POST https://api.resend.com/emails'])
  const receiptBytes = (await readFile('tests/fixtures/receipts/hotel.png')).toString('base64').slice(0, 64)
  for (const message of h.messages) {
    assert.equal(message.attachments, undefined, 'no receipt or file leaves by mail')
    assert.ok(!JSON.stringify(message).includes(receiptBytes))
  }

  // The owner connects Auth: a fresh email proof approves the link, Auth calls back, the owner turns on Auth sign-in and signs in through it.
  const linkedFrom = h.outbound.length
  await h.send('/auth/magic-link', { email: 'owner@harbourfinch.example' })
  const fresh = await h.confirmMail('owner@harbourfinch.example')
  assert.equal((await h.send('/auth/dependencies/relink', { issuer: h.auth.issuer, interface: 'oidc-provider@1' }, fresh)).status, 200)
  assert.equal((await h.auth.link(h)).status, 200)
  assert.equal((await h.send('/auth/settings/identity', { idpSignIn: true }, fresh)).status, 200)
  const signedIn = await h.auth.signIn(h, 'owner@harbourfinch.example', 'Rose Owner')
  assert.equal(signedIn.status, 303)
  const session = signedIn.headers.getSetCookie().map(v => v.split(';')[0]).find(v => /operator_session/.test(v))
  assert.equal((await h.get('state', session)).actor.email, 'owner@harbourfinch.example', 'the email Auth returned signs the owner in')

  // Only Auth's declared link handshake and OpenID Connect exchange left, and none of it carries Coaster's records.
  const sent = h.outbound.slice(linkedFrom).filter(r => !r.url.startsWith('https://api.resend.com/'))
  for (const request of h.outbound) assert.ok(declared.has(flowOf[new URL(request.url).host]), `undeclared outbound ${request.method} ${request.url}`)
  assert.deepEqual([...new Set(sent.map(r => `${r.method} ${new URL(r.url).pathname}`))].sort(), ['GET /.well-known/openid-configuration', 'GET /.well-known/rer-provider', 'GET /jwks', 'POST /redeem', 'POST /token'])
  const claimsOf = jwt => Object.keys(JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')))
  const redeem = JSON.parse(sent.find(r => r.url.endsWith('/redeem')).body)
  assert.deepEqual(Object.keys(redeem).sort(), ['callback', 'client_assertion', 'client_assertion_type', 'code', 'interface', 'origin'])
  assert.deepEqual(claimsOf(redeem.client_assertion).sort(), ['aud', 'callback', 'code', 'exp', 'iat', 'interface', 'iss', 'jti', 'sector_id', 'sub'])
  const token = new URLSearchParams(sent.find(r => r.url.endsWith('/token')).body)
  assert.deepEqual([...token.keys()].sort(), ['client_assertion', 'client_assertion_type', 'client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri'])
  assert.deepEqual(claimsOf(token.get('client_assertion')).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'sub'])
  for (const request of sent) {
    if (request.method === 'GET') assert.equal(request.body, '', `${request.url} sends no body`)
    for (const record of ['harbourfinch.example', 'Hotel Ibis', 'Brisbane visit', 'Which client', 'ACH-0603', receiptBytes]) assert.ok(!decodeURIComponent(request.body).includes(record), `${request.url} carries no ${record}`)
  }
}, { identityProvider: 'https://auth.harbourfinch.example' }))

test('FOLLOWUP-001 reminders chase receipts, drafts, holds, questions and decisions on the business days finance sets, never on a holiday or in quiet hours, and stop once done', () => withAgency(async (h, t) => {
  await proveCardEvidenceReminders();
  await proveCardEvidenceCompletion();
  await h.post('settings/reminders', { days: '2, 5, 10', quietFrom: '20', quietUntil: '8' }, t.sam, 403)
  await h.post('settings/reminders', { days: '5, 2', quietFrom: '20', quietUntil: '8' }, t.jordan, 400)
  await h.post('settings/reminders', { days: '2, 5, 10', quietFrom: '20', quietUntil: '8' }, t.jordan)
  const SAM = 'sam@harbourfinch.example', ALEX = 'alex@harbourfinch.example'
  // Sam's draft needs a receipt; Alex's claim waits for Priya, who asks Alex a question; Priya holds Sam's mileage.
  const draft = await claim(h, t.sam, 'Supplies', [{ kind: 'receipt', date: '2026-10-30', merchant: 'Officeworks', amount: '80.00', allocations: [{ category: t.c.office }] }])
  let pending = await submit(h, t.alex, await claim(h, t.alex, 'Hotel', [{ kind: 'receipt', date: '2026-10-29', merchant: 'Hotel Ibis', amount: '150.00', allocations: [{ category: t.c.travel }], receiptFixture: 'hotel' }]))
  const asked = await h.post(`claims/${pending.id}/comments`, { body: 'Which client?', asks: ALEX }, t.priya)
  const split = await submit(h, t.sam, await claim(h, t.sam, 'Visits', [{ kind: 'receipt', date: '2026-10-28', merchant: 'Bistro', amount: '40.00', allocations: [{ category: t.c.meals }], receiptFixture: 'bistro' }, { kind: 'mileage', date: '2026-10-28', merchant: 'Studio to site', distance: '10', allocations: [{ category: t.c.car }] }]))
  await approve(h, t.priya, split, { hold: [(await h.get(`claims/${split.id}`, t.sam)).items[1].id], reason: 'Which site?' })
  const heldId = (await h.get(`claims/${split.id}`, t.priya)).revisions.at(-1).snapshot.split.heldClaim
  const number = c => `CL-${String(c.number).padStart(4, '0')}`

  const sydney = (day, hour) => {
    const guess = Date.parse(`${day}T${String(hour).padStart(2, '0')}:17:00Z`)
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map(x => [x.type, x.value]))
    return new Date(guess - (Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - guess))
  }
  const worker = await h.mf.getWorker()
  const tick = async (day, hour = 9) => { const before = h.messages.length; await worker.scheduled({ scheduledTime: sydney(day, hour), cron: '17 * * * *' }); return h.messages.slice(before).map(m => [m.to[0], m.subject]).sort() }

  // Monday 2 November: everything open is noted; two business days later each is reminded once, never in quiet hours.
  assert.deepEqual(await tick('2026-11-02'), [])
  assert.deepEqual(await tick('2026-11-03'), [], 'one business day is not yet two')
  assert.deepEqual(await tick('2026-11-04', 6), [], 'quiet hours until 08:00')
  const first = await tick('2026-11-04')
  assert.deepEqual(first, [
    [ALEX, `Reminder: Answer the question on ${number(pending)}`],
    ['priya@harbourfinch.example', `Reminder: Decide ${number(pending)}`],
    [SAM, `Reminder: Answer the hold on ${number(await h.get(`claims/${heldId}`, t.sam).then(d => d.claim))}`],
    [SAM, `Reminder: Attach the receipt for Officeworks`],
    [SAM, `Reminder: Submit ${number(draft.claim)}`],
  ].sort())
  assert.match(h.messages.findLast(m => m.subject.startsWith('Reminder: Decide')).text, new RegExp(`/app#/claims/${pending.id}$`), 'the reminder links straight to the claim')
  assert.deepEqual(await tick('2026-11-04', 10), [], 'each step is sent once')

  // Resolve some: Alex answers, then retracts the claim (the approver's reminders stop); Sam attaches the receipt.
  await h.post(`claims/${pending.id}/comments`, { body: 'Harbour Bank', parent: asked.comment }, t.alex)
  pending = await h.post(`claims/${pending.id}/retract`, { version: (await h.get(`claims/${pending.id}`, t.alex)).claim.version, reason: 'Wrong dates' }, t.alex)
  const withReceipt = await h.post(`claims/${draft.claim.id}/receipts`, { version: draft.claim.version, item: draft.items[0].id, ...(await receipt('officeworks')) }, t.sam)
  assert.ok(withReceipt.receipt)
  assert.deepEqual(await tick('2026-11-09'), [[SAM, `Reminder: Answer the hold on ${number(await h.get(`claims/${heldId}`, t.sam).then(d => d.claim))}`], [SAM, `Reminder: Submit ${number(draft.claim)}`]].sort(), 'five business days: only what is still open')

  // Veterans Day (Wednesday 11 November) is not a business day; Alex's retracted draft is reminded the day after.
  assert.deepEqual(await tick('2026-11-11'), [])
  assert.deepEqual(await tick('2026-11-12'), [[ALEX, `Reminder: Submit ${number(pending)}`]])

  // Sam resubmits the held claim alone: its reminders stop, while the drafts reach their next steps.
  const heldDetail = await h.get(`claims/${heldId}`, t.sam)
  await h.post(`claims/${heldId}/submit`, { version: heldDetail.claim.version }, t.sam)
  assert.deepEqual(await tick('2026-11-17'), [[ALEX, `Reminder: Submit ${number(pending)}`], [SAM, `Reminder: Submit ${number(draft.claim)}`]], 'Sam at ten business days, Alex at five since 9 November')
  // Sam submits the draft: nothing chases Sam any more.
  await submit(h, t.sam, await h.get(`claims/${draft.claim.id}`, t.sam))
  assert.deepEqual((await tick('2026-12-01')).filter(([to]) => to === SAM), [])
  assert.deepEqual((await h.get(`claims/${draft.claim.id}`, t.sam)).events.filter(e => e.action === 'reminder-sent').map(e => [e.actor_email, e.detail.item.split(':')[0], e.detail.step, e.detail.businessDays]), [['reminder', 'receipt', 1, 2], ['reminder', 'unsubmitted', 1, 2], ['reminder', 'unsubmitted', 2, 5], ['reminder', 'unsubmitted', 3, 10]], 'each reminder is a history line on its claim')
}))

test('FOLLOWUP-002 an approval past its service level escalates to the approver\'s manager and then finance, a draft past its last reminder to the employee\'s manager and then finance, each recorded, until done', () => withAgency(async (h, t) => {
  await proveCardEvidenceEscalations();
  const JORDAN = 'jordan@harbourfinch.example', MORGAN = 'morgan@harbourfinch.example', PRIYA = 'priya@harbourfinch.example'
  await h.post('settings/members', { email: PRIYA, name: 'priya', employee: true, manager: true, approver: JORDAN })
  await h.post('settings/reminders', { days: '2, 5, 10', quietFrom: '20', quietUntil: '8', serviceLevel: '3', escalateAfter: '2' }, t.sam, 403)
  await h.post('settings/reminders', { days: '2, 5, 10', quietFrom: '20', quietUntil: '8', serviceLevel: '0', escalateAfter: '2' }, t.jordan, 400)
  await h.post('settings/reminders', { days: '2, 5, 10', quietFrom: '20', quietUntil: '8', serviceLevel: '3', escalateAfter: '2' }, t.jordan)
  let pending = await submit(h, t.alex, await claim(h, t.alex, 'Hotel', [{ kind: 'receipt', date: '2026-10-29', merchant: 'Hotel Ibis', amount: '150.00', allocations: [{ category: t.c.travel }], receiptFixture: 'hotel' }]))
  const draft = await claim(h, t.sam, 'Paper', [{ kind: 'receipt', date: '2026-10-30', merchant: 'Officeworks', amount: '64.95', allocations: [{ category: t.c.office }], receiptFixture: 'officeworks' }])
  const queue = (await h.get('state', t.priya)).claims.find(c => c.id === pending.id)
  assert.deepEqual([queue.waiting_business_days, queue.over_service_level, (await h.get('state', t.priya)).business.service_level_days], [0, false, 3], 'the queue shows the wait against the service level')

  const sydney = (day, hour) => {
    const guess = Date.parse(`${day}T${String(hour).padStart(2, '0')}:17:00Z`)
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map(x => [x.type, x.value]))
    return new Date(guess - (Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - guess))
  }
  const worker = await h.mf.getWorker()
  const tick = async day => { const before = h.messages.length; await worker.scheduled({ scheduledTime: sydney(day, 9), cron: '17 * * * *' }); return h.messages.slice(before).filter(m => m.subject.startsWith('Escalated: ')).map(m => [m.to, m.subject]) }
  const decide = `Escalated: Decide CL-${String(pending.number).padStart(4, '0')}`, submitDraft = `Escalated: Submit CL-${String(draft.claim.number).padStart(4, '0')}`

  // Seen Monday 2 November; three business days is the service level, the fourth escalates to Priya's manager, two more to finance.
  assert.deepEqual(await tick('2026-11-02'), [])
  assert.deepEqual(await tick('2026-11-05'), [], 'three business days is within the service level')
  assert.deepEqual(await tick('2026-11-06'), [[[JORDAN], decide]])
  assert.deepEqual(await tick('2026-11-09'), [])
  assert.deepEqual(await tick('2026-11-10'), [[[JORDAN, MORGAN], decide]])
  const history = (await h.get(`claims/${pending.id}`, t.jordan)).events.filter(e => e.action === 'escalated').map(e => [e.actor_email, e.detail.level, e.detail.to, e.detail.owedBy, e.detail.businessDays])
  assert.deepEqual(history, [['escalation', 1, [JORDAN], PRIYA, 4], ['escalation', 2, [JORDAN, MORGAN], PRIYA, 6]])

  // Priya approves: that escalation stops. Sam's draft runs out of reminders at 10 business days (17 Nov, past Veterans Day)
  // and escalates two business days later to Sam's manager Priya, then two more to finance.
  await approve(h, t.priya, pending)
  assert.deepEqual(await tick('2026-11-17'), [])
  assert.deepEqual(await tick('2026-11-19'), [[[PRIYA], submitDraft]])
  assert.deepEqual(await tick('2026-11-23'), [[[JORDAN, MORGAN], submitDraft]])
  await submit(h, t.sam, await h.get(`claims/${draft.claim.id}`, t.sam))
  assert.deepEqual(await tick('2026-11-30'), [], 'nothing left to escalate')
}))

test('CLAIM-004 a paid $1,000 advance against $830 of expenses leaves $170 owed back, against $1,200 reimburses $200, and an unreturned excess past 120 days reaches the overdue list and the accountable plan', () => withAgency(async (h, t) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const ago = n => new Date(Date.parse(today + 'T00:00:00Z') - n * 86_400_000).toISOString().slice(0, 10)
  await h.post('settings/payment-controls', { advanceAccount: '1250' })
  // Each advance routes to the approving manager, who cannot be the employee; finance records it paid outside Coaster.
  const advance = async (cookie, paidOn) => {
    let a = await h.post('advances', { purpose: 'Chicago trade show', amount: '1000.00' }, cookie)
    await h.post(`advances/${a.id}/paid`, { version: a.version, reference: 'early', paidOn }, t.morgan, 409)
    a = await h.post(`advances/${a.id}/decision`, { version: a.version, decision: 'approved' }, t.priya)
    await h.post(`advances/${a.id}/paid`, { version: a.version, reference: 'self', paidOn }, cookie, 403)
    return h.post(`advances/${a.id}/paid`, { version: a.version, reference: `ACH-${a.advance}`, paidOn }, t.morgan)
  }
  const own = await h.post('advances', { purpose: 'Own trip', amount: '50.00' }, t.priya, 409)
  assert.match(own.error, /approving manager/)
  await h.post('settings/members',{email:'alex@harbourfinch.example',name:'alex',employee:true,contractor:true,approver:'priya@harbourfinch.example'})
  const sams = await advance(t.sam, ago(130)), alexs = await advance(t.alex, today)
  assert.deepEqual([sams.status, sams.amount_minor, sams.returnDueOn, sams.owedMinor], ['paid', 100000, ago(10), 100000])

  const link = async (cookie, d, a) => (await h.post(`claims/${d.claim.id}/advance`, { version: d.claim.version, advance: a.id }, cookie), h.get(`claims/${d.claim.id}`, cookie))
  let samClaim = await claim(h, t.sam, 'Chicago trade show', [
    { kind: 'receipt', date: ago(75), merchant: 'Hilton Chicago', amount: '500.00', allocations: [{ category: t.c.travel }], receiptFixture: 'hotel' },
    { kind: 'receipt', date: ago(3), merchant: 'FedEx Office', amount: '330.00', allocations: [{ category: t.c.office }], receiptFixture: 'officeworks' }])
  let alexClaim = await claim(h, t.alex, 'Chicago trade show', [
    { kind: 'receipt', date: ago(4), merchant: 'Hertz', amount: '1100.00', allocations: [{ category: t.c.travel }], receiptFixture: 'uber' },
    { kind: 'receipt', date: ago(3), merchant: 'Bistro', amount: '100.00', allocations: [{ category: t.c.meals }], receiptFixture: 'bistro' }])
  await h.post(`claims/${alexClaim.claim.id}/advance`, { version: alexClaim.claim.version, advance: sams.id }, t.alex, 403)
  samClaim = await link(t.sam, samClaim, sams); alexClaim = await link(t.alex, alexClaim, alexs)
  await h.post(`claims/${alexClaim.claim.id}/advance`, { version: alexClaim.claim.version, advance: alexs.id }, t.sam, 403)
  assert.equal(samClaim.advance.advance, sams.advance)
  const a = await approve(h, t.priya, await submit(h, t.sam, samClaim)), b = await approve(h, t.priya, await submit(h, t.alex, alexClaim))

  const lapsed=(await h.get('accountable-plan',t.morgan)).lapsed.find(x=>x.item===samClaim.items[0].id)
  assert.equal(lapsed.daysAfterSpend,75)
  await h.post(`claims/${a.id}/items/${lapsed.item}/accountable-plan`,{reason:'Trip filed after the accountable-plan window'},t.morgan)
  // $830 against $1,000: nothing more to pay and $170 owed back; $1,200 against $1,000: $200 reimbursed and nothing owed.
  const settled = async () => Object.fromEntries((await h.get('advances', t.morgan)).advances.map(x => [x.id, [x.applied_minor, x.reimburseMinor, x.owedMinor]]))
  assert.deepEqual(await settled(), { [sams.id]: [83000, 0, 17000], [alexs.id]: [100000, 20000, 0] })
  assert.deepEqual((await h.get(`claims/${a.id}`, t.priya)).advance.owedMinor, 17000)
  let batch = await h.post('batches', { claims: [a.id, b.id] }, t.morgan)
  assert.equal(batch.total_minor, 20000)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 20000 }, t.jordan)
  await h.paid(batch.id, batch.version, { reference: 'ACH-0901', paidOn: today }, t.jordan)
  const table = async file => { const [head, ...rows] = (await h.send(`/api/coaster/batches/${batch.id}/${file}`, undefined, t.jordan)).text.trim().split('\r\n').map(r => r.slice(1, -1).split('","')); return rows.map(r => Object.fromEntries(head.map((k, i) => [k, r[i]]))) }
  const people = await table('reimbursements.csv'), lines = await table('accounting.csv')
  assert.deepEqual(people.map(p => [p.employee, p.amount]).sort(), [['alex@harbourfinch.example', '200.00'], ['sam@harbourfinch.example', '0.00']])
  assert.deepEqual(lines.filter(l => l.type === 'advance').map(l => [l.employee, l.category, l.account_code, l.amount, l.description]).sort(), [
    ['alex@harbourfinch.example', 'Cash advance applied', '1250', '-1000.00', `Cash advance ${alexs.advance} applied`], ['sam@harbourfinch.example', 'Cash advance applied', '1250', '-830.00', `Cash advance ${sams.advance} applied`]])
  assert.equal(Math.round(lines.reduce((n, l) => n + Number(l.amount) * 100, 0)), 20000)
  assert.equal(lines.find(l=>l.merchant==='Hilton Chicago').taxable,'true')
  assert.ok(people.some(p=>p.employee==='alex@harbourfinch.example'&&p.form_1099_review==='true'))

  // Sam's $170 was due back 120 days after the advance was paid: it is on the overdue list and the accountable plan.
  const overdue = await h.get('advances', t.morgan)
  assert.deepEqual(overdue.overdue.map(x => [x.advance, x.employee_email, x.owedMinor, x.returnDueOn, x.daysOverdue]), [[sams.advance, 'sam@harbourfinch.example', 17000, ago(10), 10]])
  const plan = await h.get('accountable-plan', t.morgan)
  assert.deepEqual(plan.excessOverdue.map(x => [x.advance, x.owedMinor]), [[sams.advance, 17000]])
  assert.deepEqual((await h.get('advances', t.sam)).advances.map(x => [x.advance, x.owedMinor, x.overdue]), [[sams.advance, 17000, true]])
  // Finance records the returned excess, never more than is owed; once returned it leaves both lists.
  let s = (await h.get('advances', t.morgan)).advances.find(x => x.id === sams.id)
  await h.post(`advances/${sams.id}/return`, { version: s.version, amount: '170.01', returnedOn: today, reference: 'DEP-1' }, t.morgan, 409)
  await h.post(`advances/${sams.id}/return`, { version: s.version, amount: '170.00', returnedOn: today, reference: 'DEP-1' }, t.sam, 403)
  s = await h.post(`advances/${sams.id}/return`, { version: s.version, amount: '170.00', returnedOn: today, reference: 'DEP-1' }, t.morgan)
  assert.deepEqual([s.owedMinor, s.overdue, s.returns.map(r => [r.amount_minor, r.reference])], [0, false, [[17000, 'DEP-1']]])
  assert.deepEqual([(await h.get('advances', t.morgan)).overdue, (await h.get('accountable-plan', t.morgan)).excessOverdue], [[], []])
  const history = (await h.get('history')).lines.filter(l => l.action.startsWith('advance-') && (l.detail.advance === sams.id))
  assert.deepEqual(history.map(l => [l.action, l.actor_email]), [['advance-requested', 'sam@harbourfinch.example'], ['advance-approved', 'priya@harbourfinch.example'], ['advance-paid', 'morgan@harbourfinch.example'], ['advance-linked', 'sam@harbourfinch.example'], ['advance-returned', 'morgan@harbourfinch.example']])
}))

test('CLAIM-009 finance pays a monthly stipend to every employee and caps a yearly allowance; employees claim against the cap, set recurring expenses and see what is left; a deactivated member\'s stipend stops', () => withAgency(async (h, t) => {
  const SAM = 'sam@harbourfinch.example', ALEX = 'alex@harbourfinch.example', JORDAN = 'jordan@harbourfinch.example', PRIYA = 'priya@harbourfinch.example'
  await h.post('settings/business', { name: 'Harbour & Finch Studio', timezone: 'America/Chicago', perDiem: '75.00', receiptThreshold: '75.00' })
  const phone = (await h.post('settings/categories', { name: 'Phone', accountCode: '6600', taxCode: 'NONE' })).id
  // An approval rule is on: a stipend has no receipt, so it still goes to the employee's approver (APPROVE-004).
  await h.post('settings/approval-rule', { enabled: true, limit: '100.00' })
  const stipend = { name: 'Phone stipend', type: 'stipend', category: phone, period: 'monthly', amount: '75.00', tax: 'taxable', startsOn: '2026-06-01' }
  await h.post('allowances', stipend, t.sam, 403)
  await h.post('allowances', { ...stipend, tax: undefined }, t.jordan, 400)
  await h.post('allowances', stipend, t.jordan)
  const home = (await h.post('allowances', { name: 'Home office', type: 'cap', period: 'yearly', amount: '500.00', startsOn: '2026-01-01' }, t.jordan)).all.find(a => a.name === 'Home office')
  await h.post('recurring', { merchant: 'Figma', description: 'Design seat', category: t.c.office, period: 'monthly', amount: '20.00', startsOn: '2026-06-01' }, t.sam)

  const worker = await h.mf.getWorker()
  const tick = day => worker.scheduled({ scheduledTime: central(day, 9), cron: '17 * * * *' })
  const stipends = async email => (await h.get('state')).claims.filter(c => c.employee_email === email && c.title.startsWith('Phone stipend · ')).map(c => [c.title, c.status, c.total_minor]).sort()
  await tick('2026-06-01'); await tick('2026-06-01')
  // One claim a period for each employee, submitted to their approver without a receipt; Jordan has no approver, so theirs waits as a draft.
  assert.deepEqual(await stipends(SAM), [['Phone stipend · 2026-06', 'submitted', 7500]])
  const june = (await h.get('state', t.sam)).claims.find(c => c.title === 'Phone stipend · 2026-06')
  const juneDetail = await h.get(`claims/${june.id}`, t.priya)
  assert.equal(june.approver_email, PRIYA)
  assert.deepEqual(juneDetail.items.map(i => [i.kind, i.spent_on, i.amount_minor, i.receipt_id, i.description, i.allocations[0].category_id]), [['stipend', '2026-06-01', 7500, null, 'Monthly stipend for 2026-06 · taxable pay', phone]])
  assert.deepEqual(juneDetail.revisions[0].snapshot.exceptions, [])
  assert.deepEqual(juneDetail.events.map(e => [e.actor_email, e.action]), [['allowance', 'stipend-created'], ['allowance', 'claim-submitted']])
  assert.deepEqual((await h.get('state', t.jordan)).claims.filter(c => c.employee_email === JORDAN).map(c => [c.title, c.status]), [['Phone stipend · 2026-06', 'draft']])
  // Sam's recurring subscription opens one draft for the month asking for its receipt.
  const figma = (await h.get('state', t.sam)).claims.filter(c => c.title.startsWith('Figma'))
  assert.deepEqual(figma.map(c => [c.title, c.status, c.total_minor]), [['Figma · 2026-06', 'draft', 2000]])
  assert.deepEqual((await h.get(`claims/${figma[0].id}`, t.sam)).items.map(i => [i.kind, i.receipt_id, i.description]), [['receipt', null, 'Design seat · Monthly recurring expense: receipt requested']])

  await tick('2026-07-01')
  await h.post('settings/members', { email: ALEX, name: 'alex', employee: true, approver: PRIYA, active: false })
  await tick('2026-08-01')
  assert.deepEqual(await stipends(SAM), [['Phone stipend · 2026-06', 'submitted', 7500], ['Phone stipend · 2026-07', 'submitted', 7500], ['Phone stipend · 2026-08', 'submitted', 7500]])
  assert.deepEqual((await stipends(ALEX)).map(c => c[0]), ['Phone stipend · 2026-06', 'Phone stipend · 2026-07'], 'no stipend once deactivated')

  // Three months of stipends are approved, batched and reimbursed like any claim.
  const sams = (await h.get('state', t.sam)).claims.filter(c => c.title.startsWith('Phone stipend · '))
  for (const c of sams) await approve(h, t.priya, c)
  let batch = await h.post('batches', { claims: sams.map(c => c.id) }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 22500 }, t.jordan)
  assert.equal(sum((await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`, undefined, t.jordan)).text, 'amount'), 22500)
  await h.paid(batch.id, batch.version, { reference: 'ACH-0815', paidOn: '2026-08-15' }, t.jordan)
  assert.deepEqual((await h.get('state', t.sam)).claims.filter(c => c.title.startsWith('Phone stipend · ')).map(c => c.status), ['reimbursed', 'reimbursed', 'reimbursed'])

  // $320 then $250 against the $500 home-office cap: the second is reimbursed $180 and the $70 over is flagged.
  const left = async () => (await h.get('allowances?day=2026-08-20', t.sam)).mine.find(a => a.name === 'Home office').remaining_minor
  assert.equal(await left(), 50000)
  const desk = await claim(h, t.sam, 'Desk', [{ kind: 'receipt', date: '2026-08-03', merchant: 'IKEA', amount: '320.00', allocations: [{ category: t.c.office }], receiptFixture: 'officeworks', allowance: home.id }])
  assert.equal(desk.claim.total_minor, 32000)
  assert.equal(await left(), 18000)
  const chair = await claim(h, t.sam, 'Chair', [{ kind: 'receipt', date: '2026-08-10', merchant: 'Herman Miller', amount: '250.00', allocations: [{ category: t.c.office }], receiptFixture: 'hotel', allowance: home.id }])
  assert.deepEqual([chair.claim.total_minor, chair.items[0].amount_minor, chair.items[0].claimed_minor, chair.items[0].allocations.map(a => a.amount_minor)], [18000, 18000, 25000, [18000]])
  await h.post(`claims/${chair.claim.id}/submit`, { version: chair.claim.version }, t.sam, 409)
  await h.post(`claims/${chair.claim.id}/items`, { version: chair.claim.version, item: chair.items[0].id, kind: 'receipt', date: '2026-08-10', merchant: 'Herman Miller', amount: '250.00', allocations: [{ category: t.c.office }], receipt: chair.items[0].receipt_id, allowance: home.id, explanation: 'Chair for the home office' }, t.sam)
  const sent = await submit(h, t.sam, await h.get(`claims/${chair.claim.id}`, t.sam))
  assert.deepEqual((await h.get(`claims/${sent.id}`, t.priya)).revisions[0].snapshot.exceptions.map(e => [e.code, e.message]), [['over-allowance', 'Claimed $250.00 against Home office; only $180.00 was left for 2026, so $70.00 is not reimbursed']])
  assert.equal(await left(), 0)
  const more = await h.post('claims', { title: 'Lamp' }, t.sam)
  await h.post(`claims/${more.id}/items`, { version: more.version, kind: 'receipt', date: '2026-08-12', merchant: 'Target', amount: '30.00', allocations: [{ category: t.c.office }], allowance: home.id }, t.sam, 400)
  // Employees see their own allowances and recurring expenses; finance sees every allowance.
  const mine = await h.get('allowances?day=2026-08-20', t.sam)
  assert.deepEqual(mine.mine.map(a => a.name).sort(), ['Home office', 'Phone stipend'])
  assert.deepEqual([mine.all, mine.recurring.map(r => r.merchant)], [[], ['Figma']])
  assert.deepEqual((await h.get('allowances', t.jordan)).all.map(a => a.name).sort(), ['Home office', 'Phone stipend'])
}))

test('AUTO-001 expenses file themselves into a report by month or trip and submit on the owner\'s weekly schedule; an expense missing its receipt stays behind with its reminder', () => withAgency(async (h, t) => {
  const SAM = 'sam@harbourfinch.example', PRIYA = 'priya@harbourfinch.example'
  await h.post('settings/business', { name: 'Harbour & Finch Studio', timezone: 'America/Chicago', perDiem: '75.00', receiptThreshold: '75.00' })
  await h.post('settings/auto-submit', { schedule: 'weekly' }, t.sam, 403)
  await h.post('settings/auto-submit', { schedule: 'hourly' }, h.owner, 400)
  assert.deepEqual(await h.post('settings/auto-submit', { schedule: 'weekly' }), { schedule: 'weekly' })
  // Five compliant expenses with their own receipts and one $320 flight without its receipt, in the first week of June.
  const png = text => ({ name: `${text}.png`, source: 'upload', base64: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]).toString('base64') })
  const add = (date, merchant, amount, category, receiptFile) => h.post('expenses', { kind: 'receipt', date, merchant, amount, allocations: [{ category }], receiptFile }, t.sam)
  await add('2026-06-01', 'Blue Bottle', '18.40', t.c.meals, png('blue-bottle'))
  await add('2026-06-02', 'Lyft', '42.10', t.c.travel, png('lyft'))
  await add('2026-06-02', 'Delta', '320.00', t.c.travel)
  await add('2026-06-03', 'Staples', '64.95', t.c.office, png('staples'))
  await add('2026-06-04', 'Sweetgreen', '23.75', t.c.meals, png('sweetgreen'))
  const report = await add('2026-06-05', 'FedEx Office', '88.20', t.c.office, png('fedex'))
  assert.deepEqual([report.title, report.status, report.total_minor], ['Expenses · 2026-06', 'draft', 1840 + 4210 + 32000 + 6495 + 2375 + 8820])
  // An expense linked to an approved trip request files into that trip's report; a claim built by hand is left alone.
  const trip = await h.post('requests', { title: 'Austin offsite', estimate: '900.00' }, t.sam)
  await h.post(`requests/${trip.id}/decision`, { version: trip.version, decision: 'approved' }, t.priya)
  const tripReport = await h.post('expenses', { kind: 'receipt', date: '2026-06-03', merchant: 'Hotel Van Zandt', amount: '412.00', allocations: [{ category: t.c.travel }], request: trip.id, receiptFile: png('van-zandt') }, t.sam)
  assert.deepEqual([tripReport.title, tripReport.total_minor], ['Austin offsite', 41200])
  const byHand = await claim(h, t.sam, 'Client lunch', [{ kind: 'receipt', date: '2026-06-03', merchant: 'Uchi', amount: '58.00', allocations: [{ category: t.c.meals }] }])

  const worker = await h.mf.getWorker()
  const tick = (day, hour = 9) => worker.scheduled({ scheduledTime: central(day, hour), cron: '17 * * * *' })
  const mine = async () => (await h.get('state', t.sam)).claims.filter(c => c.employee_email === SAM).map(c => [c.title, c.status, c.total_minor]).sort()
  await tick('2026-06-05'); await tick('2026-06-08', 8)
  assert.deepEqual((await mine()).map(c => c[1]), ['draft', 'draft', 'draft'], 'nothing submits before 9:00 on the scheduled day')
  await tick('2026-06-08'); await tick('2026-06-08', 10)
  // Monday 8 June at 9:00 Central: five submitted to Sam's approver; the flight waits in a new report for June.
  assert.deepEqual(await mine(), [['Austin offsite', 'submitted', 41200], ['Client lunch', 'draft', 5800], ['Expenses · 2026-06', 'draft', 32000], ['Expenses · 2026-06', 'submitted', 1840 + 4210 + 6495 + 2375 + 8820]])
  const sent = (await h.get('state', t.sam)).claims.find(c => c.title === 'Expenses · 2026-06' && c.status === 'submitted')
  const detail = await h.get(`claims/${sent.id}`, t.priya)
  assert.equal(sent.approver_email, PRIYA)
  assert.deepEqual(detail.items.map(i => i.merchant), ['Blue Bottle', 'Lyft', 'Staples', 'Sweetgreen', 'FedEx Office'])
  assert.deepEqual([detail.revisions[0].submitted_by, detail.revisions[0].snapshot.exceptions], ['schedule', []])
  const split = detail.events.find(e => e.action === 'auto-report-split')
  assert.deepEqual(split.detail.held.map(x => [x.merchant, x.reasons]), [['Delta', ['No receipt for an expense over $75.00']]])
  const held = (await h.get('state', t.sam)).claims.find(c => c.title === 'Expenses · 2026-06' && c.status === 'draft')
  // The next expense for June joins the report still open, and the flight keeps being chased for its receipt.
  assert.equal((await add('2026-06-09', 'Uber', '21.30', t.c.travel, png('uber-9'))).id, held.id)
  const before = h.messages.length
  await tick('2026-06-09', 10)
  assert.ok(h.messages.slice(before).some(m => m.to.includes(SAM) && m.subject === 'Reminder: Attach the receipt for Delta'), 'the held flight is still chased for its receipt')
}))

test('RETAIN-001 paid and rejected claims past the owner\'s retention are proposed, removed only on confirmation with a receipt, and a legal hold blocks expiry until released', () => withAgency(async (h, t) => {
  const ALEX = 'alex@harbourfinch.example'
  await h.post('settings/business', { name: 'Harbour & Finch Studio', timezone: 'America/Chicago', perDiem: '75.00', receiptThreshold: '75.00' })
  await h.post('settings/retention', { years: 1 }, t.jordan, 403)
  await h.post('settings/retention', { years: 0 }, h.owner, 400)
  await h.post('settings/retention', { years: 1 })
  // A paid claim with a comment, a rejected claim, an approved but unpaid claim and a draft.
  const paid = await approve(h, t.priya, await submit(h, t.sam, await claim(h, t.sam, 'Client visit', [{ kind: 'receipt', date: '2026-05-04', merchant: 'Hotel Ibis', amount: '180.00', allocations: [{ category: t.c.travel }], receiptFixture: 'hotel' }])))
  await h.post(`claims/${paid.id}/comments`, { body: 'Thanks for the folio' }, t.priya)
  let batch = await h.post('batches', { claims: [paid.id] }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 18000 }, t.jordan)
  await h.paid(batch.id, batch.version, { reference: 'ACH-0510', paidOn: '2026-05-10' }, t.jordan)
  const paidReceipt = (await h.get(`claims/${paid.id}`)).items[0].receipt_id
  const sent = await submit(h, t.alex, await claim(h, t.alex, 'Gym', [{ kind: 'receipt', date: '2026-05-05', merchant: 'Equinox', amount: '60.00', allocations: [{ category: t.c.office }] }]))
  const rejected = await h.post(`claims/${sent.id}/decision`, { revision: sent.revision, version: sent.version, decision: 'rejected', reason: 'Personal' }, t.priya)
  const unpaid = await approve(h, t.priya, await submit(h, t.sam, await claim(h, t.sam, 'Taxi', [{ kind: 'receipt', date: '2026-05-06', merchant: 'Uber', amount: '20.10', allocations: [{ category: t.c.travel }], receiptFixture: 'uber' }])))
  const draft = (await claim(h, t.alex, 'Supplies', [{ kind: 'receipt', date: '2026-05-07', merchant: 'Staples', amount: '12.00', allocations: [{ category: t.c.office }] }])).claim

  // A legal hold on Alex, placed only by the owner.
  await h.post('legal-holds', { scope: 'person', member: ALEX, reason: 'Wage claim' }, t.jordan, 403)
  const hold = (await h.post('legal-holds', { scope: 'person', member: ALEX, reason: 'Wage claim' })).holds[0]
  const worker = await h.mf.getWorker()
  const tick = days => worker.scheduled({ scheduledTime: Date.now() + days * 86_400_000, cron: '17 * * * *' })
  await tick(300)
  assert.equal((await h.get('retention')).proposal, null, 'nothing is proposed inside the retention period')
  await tick(370); await tick(371)
  let state = await h.get('retention')
  assert.deepEqual(state.proposal.claims.map(u => [u.batch, u.claims.map(c => c.id)]), [[batch.id, [paid.id]]], 'the held person\'s rejected claim and the unpaid claim are not proposed')
  assert.equal((await h.get(`claims/${paid.id}`)).claim.status, 'reimbursed', 'a proposal removes nothing')
  await h.post(`retention/${state.proposal.id}/confirm`, {}, t.jordan, 403)
  const receiptOne = await h.post(`retention/${state.proposal.id}/confirm`, {})
  assert.deepEqual(receiptOne.expired.map(e => [e.claim, e.status, e.totalMinor, e.expenseDates, e.receiptSha256]), [[`CL-${String(paid.number).padStart(4, '0')}`, 'reimbursed', 18000, { from: '2026-05-04', to: '2026-05-04' }, [sha(await readFile('tests/fixtures/receipts/hotel.png'))]]])
  assert.deepEqual([receiptOne.confirmedBy, receiptOne.retentionYears, receiptOne.skipped], ['owner@harbourfinch.example', 1, []])
  await h.get(`claims/${paid.id}`, h.owner, 404)
  assert.equal((await h.send(`/api/coaster/receipts/${paidReceipt}`, undefined, h.owner)).status, 404, 'the receipt bytes are gone')
  await h.get(`batches/${batch.id}`, t.jordan, 404)
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_comments').first()).n, 0)
  assert.deepEqual((await h.get('history?q=claim-expired')).lines.map(l => [l.actor_email, l.detail.claim]), [['retention', `CL-${String(paid.number).padStart(4, '0')}`]])
  assert.equal((await h.get('retention')).receipts.length, 1)
  // The expired receipt can still never be reimbursed again.
  const again = await approve(h, t.priya, await submit(h, t.sam, await claim(h, t.sam, 'Client visit again', [{ kind: 'receipt', date: '2026-05-04', merchant: 'Hotel Ibis', amount: '180.00', allocations: [{ category: t.c.travel }], receiptFixture: 'hotel' }])), { acknowledge: true })
  const refused = await h.send('/api/coaster/batches', { claims: [again.id] }, t.morgan)
  assert.equal(refused.status, 409); assert.match(refused.value.error, /since removed under the retention policy/)

  // Releasing the hold lets the rejected claim be proposed and expired; open and unpaid claims stay.
  await h.post(`legal-holds/${hold.id}/release`, {})
  await tick(372)
  state = await h.get('retention')
  assert.deepEqual(state.proposal.claims.map(u => u.claims.map(c => c.id)), [[rejected.id]])
  await h.post('legal-holds', { scope: 'period', from: '2026-05-01', to: '2026-05-31', reason: 'May audit' })
  const receiptTwo = await h.post(`retention/${state.proposal.id}/confirm`, {})
  assert.deepEqual([receiptTwo.expired, receiptTwo.skipped.map(s => s.reason)], [[], ['legal hold: May audit']], 'a hold placed after the proposal still blocks it')
  const period = (await h.get('retention')).holds.find(x => x.scope === 'period')
  await h.post(`legal-holds/${period.id}/release`, {})
  await tick(373)
  const third = (await h.get('retention')).proposal
  assert.deepEqual((await h.post(`retention/${third.id}/confirm`, {})).expired.map(e => e.status), ['rejected'])
  await h.get(`claims/${rejected.id}`, h.owner, 404)
  for (const c of [unpaid, draft]) assert.ok((await h.get(`claims/${c.id}`, c === draft ? t.alex : h.owner)).claim)
  for (const table of ['c_events', 'c_receipts', 'c_revisions', 'c_decisions']) await assert.rejects(h.db.prepare(`DELETE FROM ${table}`).run(), /permanent/, `${table} stays permanent outside a confirmed expiry`)
}))

// A single expense lifecycle carries identity, custody, revisions, delegation,
// policy, money and audit evidence all the way to the employee's paid claim.
test('A proposed receipt becomes a corrected, reviewed and paid claim exactly once, with private drafts and immutable evidence', () => withAgency(async (h,t) => {
  await h.post('settings/business',{name:'Taken over',timezone:'Australia/Sydney'},t.sam,403)
  const key=await h.post('agent-keys',{label:'Receipt preparation'},t.sam),bearer={authorization:`Bearer ${key.token}`}
  const proposal=await h.send('/api/coaster/agent/claims',{title:'Client workshop',items:[{kind:'receipt',date:'2026-06-10',merchant:'Workshop supplies',amount:'180.00',allocations:[{category:t.c.meals,amount:'100.00'},{category:t.c.travel,amount:'80.00'}],receipt:await receipt('bistro')}]},'',bearer)
  assert.equal(proposal.status,200)
  await h.post(`proposals/${proposal.value.id}/accept`,{},t.alex,403)
  let c=(await h.post(`proposals/${proposal.value.id}/accept`,{},t.sam)).claim
  await h.post(`proposals/${proposal.value.id}/accept`,{},t.sam,409)
  for(const path of [`/api/coaster/claims/${c.id}/submit`,`/api/coaster/claims/${c.id}/decision`]) assert.equal((await h.send(path,{version:c.version},'',bearer)).status,401)
  for(const who of [t.alex,t.priya,t.morgan])await h.get(`claims/${c.id}`,who,403)
  const initial=await h.get(`claims/${c.id}`,t.sam),original=initial.receipts[0]
  assert.equal(original.sha256,sha(await readFile('tests/fixtures/receipts/bistro.png')))
  const originalDownload=await h.mf.dispatchFetch(h.origin+`/api/coaster/receipts/${original.id}`,{headers:{cookie:t.sam}})
  assert.deepEqual(Buffer.from(await originalDownload.arrayBuffer()),await readFile('tests/fixtures/receipts/bistro.png'))
  // Invalid money and a cross-origin write leave the current revision untouched.
  await h.post(`claims/${c.id}/items`,{version:c.version,kind:'receipt',date:'2026-02-30',merchant:'Bad purchase',amount:'-4',allocations:[{category:t.c.office}]},t.sam,400)
  assert.equal((await h.send(`/api/coaster/claims/${c.id}/submit`,{version:c.version},t.sam,{origin:'https://foreign.example'})).status,403)
  assert.deepEqual((await h.get(`claims/${c.id}`,t.sam)).claim,c)
  c=await h.post(`claims/${c.id}/submit`,{version:c.version},t.sam)
  c=await h.post(`claims/${c.id}/retract`,{version:c.version,reason:'Checking the original receipt'},t.sam)
  c=await h.post(`claims/${c.id}/submit`,{version:c.version},t.sam)
  await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved'},t.jordan,403)
  await h.post(`claims/${c.id}/decision`,{version:c.version-1,revision:c.revision,decision:'approved'},t.priya,409)
  const {receiptAddress,deliverMail}=await import('./fixtures/receipt-email.mjs')
  await h.post('settings/receipt-email',{address:receiptAddress,consent:true})
  const question=await h.post(`claims/${c.id}/comments`,{body:'Which client?',asks:'sam@harbourfinch.example'},t.priya)
  const mail=h.messages.findLast(m=>m.to.includes('sam@harbourfinch.example'))
  const reply=Buffer.from(`From: sam@harbourfinch.example\r\nTo: ${receiptAddress}\r\nSubject: Re: ${mail.subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nHarbour Bank workshop`)
  await deliverMail(h,Buffer.from(reply.toString().replace('Harbour Bank workshop','Forged answer')),'unknown@example.net')
  assert.equal((await h.get('state',t.priya)).claims.find(x=>x.id===c.id).open_questions,1,'a forged From cannot answer a private question')
  await deliverMail(h,reply,'sam@harbourfinch.example')
  await deliverMail(h,reply,'sam@harbourfinch.example')
  assert.equal((await h.get(`claims/${c.id}`,t.priya)).comments.filter(x=>x.parent_id===question.comment).length,1,'email replay never duplicates an answer')
  assert.equal((await h.get('state',t.priya)).claims.find(x=>x.id===c.id).open_questions,0)
  c=await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'returned',reason:'Replace with the correct supplier receipt'},t.priya)
  const grant=await h.post('delegates',{delegate:'alex@harbourfinch.example',level:'submit'},t.sam),headers={'x-coaster-acting-for':'sam@harbourfinch.example'}
  const upload=await h.send(`/api/coaster/claims/${c.id}/receipts`,{version:c.version,item:initial.items[0].id,...await receipt('officeworks')},t.alex,headers)
  assert.equal(upload.status,200)
  const delegated=await h.send(`/api/coaster/claims/${c.id}/submit`,{version:upload.value.claim.version},t.alex,headers)
  assert.equal(delegated.status,200);c=delegated.value
  let d=await h.get(`claims/${c.id}`,t.priya)
  assert.equal(d.revisions.length,3);assert.equal(d.receipts.length,2)
  assert.equal(d.revisions.at(-1).submitted_by,'alex@harbourfinch.example')
  assert.equal(d.revisions[0].snapshot.items[0].receipt.id,original.id)
  c=await approve(h,t.priya,c)
  c=await h.post(`claims/${c.id}/unapprove`,{version:c.version,to:'approver',reason:'Check the category split'},t.priya)
  c=await approve(h,t.priya,c)
  await h.post(`delegates/${grant.id}/revoke`,{},t.sam)
  assert.equal((await h.send('/api/coaster/claims',{title:'After revocation'},t.alex,headers)).status,403)
  const financeKey=await h.post('agent-keys',{label:'Month-end preparation'},t.morgan)
  const bp=await h.send('/api/coaster/agent/batches',{claims:[c.id]},'',{authorization:'Bearer '+financeKey.token})
  assert.equal(bp.status,200)
  let batch=(await h.post(`proposals/${bp.value.id}/accept`,{},t.morgan)).batch
  await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:batch.total_minor+1},t.morgan,409)
  batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:c.total_minor},t.morgan)
  await h.post(`claims/${c.id}/unapprove`,{version:(await h.get(`claims/${c.id}`,t.sam)).claim.version,to:'employee',reason:'Too late'},h.owner,409)
  for(const format of ['accounting','reimbursements'])assert.equal(sum((await h.send(`/api/coaster/batches/${batch.id}/${format}.csv`,undefined,t.morgan)).text,'amount'),batch.total_minor)
  const frozen=(await h.get(`claims/${c.id}`,t.sam)).revisions
  await h.paid(batch.id,batch.version,{reference:'ACH-WORKSHOP',paidOn:'2026-06-12'},t.morgan)
  d=await h.get(`claims/${c.id}`,t.sam)
  assert.equal(d.claim.status,'reimbursed');assert.deepEqual(d.revisions,frozen)
  assert.ok(d.events.some(e=>e.action==='claim-returned'));assert.ok(d.events.some(e=>e.action==='claim-unapproved'))
  // A second claim with the same original can never enter a second batch.
  const again=await claim(h,t.alex,'Same supplier receipt',[{kind:'receipt',date:'2026-06-10',merchant:'Workshop supplies again',amount:'180.00',allocations:[{category:t.c.travel}],receiptFixture:'officeworks',explanation:'Finance to check duplicate'}])
  const duplicate=await approve(h,t.priya,await submit(h,t.alex,again),{acknowledge:true})
  await h.post('batches',{claims:[duplicate.id]},t.morgan,409)
  assert.deepEqual((await h.get(`claims/${c.id}`,t.sam)).revisions,frozen)
  await h.post(`agent-keys/${key.id}/revoke`,{},t.sam)
  assert.equal((await h.send('/api/coaster/agent/context',undefined,'',bearer)).status,401)

  // A leave replacement completes only the kept expense, then releases the hold.
  const day=offset=>new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+offset*86400000))
  const away=await h.post('delegations',{delegate:'jordan@harbourfinch.example',startsOn:day(-1),endsOn:day(3)},t.priya)
  const visits=await claim(h,t.sam,'Two client visits',[{kind:'mileage',date:'2026-06-13',merchant:'North client',distance:'10',allocations:[{category:t.c.car}]},{kind:'mileage',date:'2026-06-14',merchant:'South client',distance:'12',allocations:[{category:t.c.car}]}])
  let routed=await submit(h,t.sam,visits)
  assert.equal(routed.approver_email,'jordan@harbourfinch.example')
  await h.post(`claims/${routed.id}/decision`,{version:routed.version,revision:routed.revision,decision:'approved'},t.priya,403)
  routed=await approve(h,t.jordan,routed,{hold:[visits.items[1].id],reason:'Confirm the second route'})
  const split=await h.get(`claims/${routed.id}`,t.sam),heldId=split.revisions.at(-1).snapshot.split.heldClaim
  assert.equal(split.revisions[0].snapshot.items.length,2)
  assert.equal(split.items.length,1)
  const held=await h.get(`claims/${heldId}`,t.sam)
  const released=await h.post(`claims/${heldId}/release`,{version:held.claim.version,reason:'Route confirmed'},t.jordan)
  assert.equal(released.status,'approved')
  await h.post(`delegations/${away.id}/revoke`,{},t.priya)
  let reassigned=await submit(h,t.alex,await claim(h,t.alex,'Replacement approver',[{kind:'mileage',date:'2026-06-15',merchant:'West client',distance:'8',allocations:[{category:t.c.car}]}]))
  reassigned=await h.post(`claims/${reassigned.id}/reassign`,{version:reassigned.version,approver:'jordan@harbourfinch.example',reason:'Priya travelling'})
  assert.equal((await approve(h,t.jordan,reassigned)).status,'approved')
  await h.post('settings/approval-rule',{enabled:true,limit:'100.00'})
  const eligible=await claim(h,t.alex,'Compliant taxi',[{kind:'receipt',date:'2026-06-16',merchant:'Compliant taxi',amount:'12.00',receiptFixture:'uber',allocations:[{category:t.c.travel}]}])
  assert.equal((await submit(h,t.alex,eligible)).status,'approved','the owner rule completes a compliant expense without a human decision')

}))

test('Finance closes the books with reconciled exports, spend, budgets, reports and an independent audit', () => withAgency(async (h, t) => {
  const one = await claim(h, t.sam, 'Perth pitch', [{ kind: 'receipt', date: '2026-06-04', merchant: 'Qantas', amount: '412.00', allocations: [{ category: t.c.travel, amount: '400.00' }, { category: t.c.meals, amount: '12.00' }], receiptFixture: 'hotel' }])
  const two = await claim(h, t.alex, 'Studio paper', [{ kind: 'receipt', date: '2026-06-05', merchant: 'Officeworks', amount: '64.95', allocations: [{ category: t.c.office }], receiptFixture: 'officeworks' }])
  const a = await approve(h, t.priya, await submit(h, t.sam, one)), b = await approve(h, t.priya, await submit(h, t.alex, two))
  let batch = await h.post('batches', { claims: [a.id, b.id] }, t.morgan)
  const total = 41200 + 6495
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: total }, t.jordan)
  const file = async (path, cookie = t.jordan, status = 200) => { const r = await h.mf.dispatchFetch(`${h.origin}/api/coaster/${path}`, { headers: { cookie } }); assert.equal(r.status, status, path); return r }
  const rowsOf = text => text.trim().split('\r\n').map(r => r.split('","').map(x => x.replace(/^"|"$/g, '')))

  // A saved template picks, orders and names the columns; only finance saves one.
  const columns = [{ field: 'date', header: 'Date' }, { field: 'account_code', header: 'Account' }, { field: 'amount', header: 'Amount' }, { field: 'receipt_sha256', header: 'Receipt SHA-256' }, { field: 'receipt_link', header: 'Receipt' }]
  await h.post('export-templates', { name: 'Ledger import', kind: 'accounting', columns }, t.sam, 403)
  await h.post('export-templates', { name: 'Ledger import', kind: 'accounting', columns: [{ field: 'password' }] }, t.morgan, 400)
  const template = await h.post('export-templates', { name: 'Ledger import', kind: 'accounting', columns }, t.morgan)
  const custom = rowsOf(await (await file(`batches/${batch.id}/accounting.csv?template=${template.id}`)).text())
  assert.deepEqual(custom[0], ['Date', 'Account', 'Amount', 'Receipt SHA-256', 'Receipt'])
  assert.equal(custom.length, 1 + 3)
  assert.equal(Math.round(custom.slice(1).reduce((n, r) => n + Number(r[2]) * 100, 0)), total)
  const hotel = await readFile('tests/fixtures/receipts/hotel.png')
  const linked = custom.find(r => r[3] === sha(hotel))
  assert.ok(linked[4].startsWith(`${h.origin}/api/coaster/receipts/`))
  assert.equal(sha(Buffer.from(await (await file(linked[4].slice(h.origin.length + '/api/coaster/'.length))).arrayBuffer())), sha(hotel), 'the link opens the very receipt the hash names')
  const standard = rowsOf(await (await file(`batches/${batch.id}/accounting.csv`)).text())
  assert.ok(['receipt_sha256', 'receipt_link', 'amount'].every(c => standard[0].includes(c)), 'the default template keeps every field')

  // XLSX: the same lines as numbers in a workbook.
  const book = await file(`batches/${batch.id}/accounting.xlsx?template=${template.id}`)
  assert.equal(book.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  const sheet = unzip(Buffer.from(await book.arrayBuffer()))['xl/worksheets/sheet1.xml'].toString()
  assert.match(sheet, /<t xml:space="preserve">Receipt SHA-256<\/t>/)
  const amounts = [...sheet.matchAll(/<c r="C\d+"><v>([\d.]+)<\/v><\/c>/g)].map(m => Number(m[1]))
  assert.equal(Math.round(amounts.reduce((n, v) => n + v * 100, 0)), total)
  const people = unzip(Buffer.from(await (await file(`batches/${batch.id}/reimbursements.xlsx`)).arrayBuffer()))['xl/worksheets/sheet1.xml'].toString()
  assert.match(people, /sam@harbourfinch\.example/)

  // IIF, checked by a fixture validator: each bill balances, splits post to the category accounts, totals match.
  const iif = (await (await file(`batches/${batch.id}/accounting.iif`)).text()).trim().split('\r\n').map(l => l.split('\t'))
  assert.deepEqual(iif.slice(0, 3).map(l => l[0]), ['!TRNS', '!SPL', '!ENDTRNS'])
  let open = null, splits = 0
  const bills = []
  for (const l of iif.slice(3)) {
    if (l[0] === 'TRNS') { assert.equal(open, null); open = { amount: Math.round(Number(l[6]) * 100), lines: 0, account: l[4], name: l[5], doc: l[7] } }
    else if (l[0] === 'SPL') { open.amount += Math.round(Number(l[6]) * 100); open.lines++; splits += Math.round(Number(l[6]) * 100); assert.ok(['6200', '6300', '6500'].includes(l[4]), l[4]) }
    else { assert.equal(l[0], 'ENDTRNS'); assert.equal(open.amount, 0, 'each bill balances'); bills.push(open); open = null }
  }
  assert.equal(splits, total)
  assert.deepEqual(bills.map(x => [x.account, x.name, x.doc, x.lines]), [['Accounts Payable', 'sam', 'CL-0001', 2], ['Accounts Payable', 'alex', 'CL-0002', 1]])
  await file(`batches/${batch.id}/reimbursements.iif`, t.jordan, 404)

  // A period: every batch reviewed in it; finance and auditors only.
  const period = rowsOf(await (await file('exports/accounting.csv?from=2026-01-01&to=2099-12-31')).text())
  assert.equal(Math.round(period.slice(1).reduce((n, r) => n + Number(r[period[0].indexOf('amount')]) * 100, 0)), total)
  assert.equal(rowsOf(await (await file('exports/accounting.csv?from=2020-01-01&to=2020-12-31')).text()).length, 1, 'a period with no reviewed batch has only the header')
  await file('exports/accounting.csv?from=2026-02-01&to=2026-01-01', t.jordan, 400)
  await file('exports/accounting.csv?from=2026-01-01&to=2099-12-31', t.sam, 403)
  const events = (await h.get(`batches/${batch.id}`, t.jordan)).events.filter(e => e.action === 'batch-exported').map(e => e.detail.format)
  assert.deepEqual(events, ['csv', 'csv', 'xlsx', 'xlsx', 'iif'])

  // The same reviewed expenses drive the dashboard, reports, queue and auditor.
  const spend=await h.get('spend?by=employee&from=2026-01-01&to=2026-12-31',t.morgan)
  assert.equal(spend.totalMinor,total)
  assert.equal(spend.groups.reduce((n,g)=>n+g.approvedMinor+g.pendingMinor,0),total)
  const auditor=await h.person('audit@harbourfinch.example',{auditor:true})
  const history=await h.get('history?q=CL-'+String(a.number).padStart(4,'0'),auditor)
  assert.ok(history.lines.some(e=>e.action==='claim-submitted'))
  assert.ok(history.lines.some(e=>e.action==='claim-approved'))
  await h.get('spend?by=employee&from=2026-01-01&to=2026-12-31',t.sam,403)
  const range='from=2026-01-01&to=2099-12-31'
  assert.equal((await h.get('reports/aging?'+range,t.morgan)).totals.amountMinor,total)
  for(const report of ['cycle-time','receipts','unsubmitted','exceptions']){
    const value=await h.get('reports/'+report+'?'+range,t.morgan)
    assert.ok(Array.isArray(value.rows),report+' is derived from these expenses')
    assert.equal((await h.send('/api/coaster/reports/'+report+'?'+range+'&format=csv',undefined,t.morgan)).status,200)
  }
  const budget={name:'Client travel',scope:'category',scopeKey:t.c.travel,period:'yearly',amount:'400.00',owner:'priya@harbourfinch.example',thresholds:'80,100',policyRule:true}
  await h.post('budgets',budget,t.sam,403)
  await h.post('budgets',budget,t.morgan)
  const actual=(await h.get('budgets?day=2026-06-30',t.morgan)).find(b=>b.name===budget.name)
  assert.equal(actual.actualMinor,40000)
  await (await h.mf.getWorker()).scheduled({scheduledTime:central('2026-06-30',9),cron:'17 * * * *'})
  assert.ok(h.messages.some(m=>m.subject==='Budget alert: Client travel at 100%'))
  const messages=h.messages.filter(m=>m.subject.startsWith('Budget alert:')).length
  await (await h.mf.getWorker()).scheduled({scheduledTime:central('2026-06-30',10),cron:'17 * * * *'})
  assert.equal(h.messages.filter(m=>m.subject.startsWith('Budget alert:')).length,messages)
  // Audit sampling is an owner-selected policy, not a hard-coded test threshold.
  await h.post('settings/audit-sample',{percent:'100'},t.morgan)
  const exceptional=await claim(h,t.sam,'Review missing evidence',[{kind:'receipt',date:'2026-06-06',merchant:'Cash taxi',amount:'12.00',allocations:[{category:t.c.travel}],explanation:'Driver gave no receipt'}])
  let flagged=await submit(h,t.sam,exceptional)
  let queue=await h.get('exceptions',t.morgan),queued=queue.open.find(e=>e.claim===flagged.id)
  assert.ok(queued)
  await h.post('exceptions/review',{claim:queued.claim,revision:queued.revision,item:queued.item,code:queued.code,note:'Driver confirmed cash payment'},t.morgan)
  flagged=await approve(h,t.priya,flagged,{acknowledge:true})
  queue=await h.get('exceptions',t.morgan)
  const sample=queue.samples.find(x=>x.claim_id===flagged.id);assert.ok(sample)
  await h.post('audit-samples/finding',{claim:sample.claim_id,revision:sample.revision,outcome:'clean',finding:'Receipt exception reviewed'},t.morgan)
  assert.equal((await h.get('exceptions',t.morgan)).samples.find(x=>x.claim_id===flagged.id).outcome,'clean')
  await h.paid(batch.id,batch.version,{reference:'LEDGER-CLOSE',paidOn:'2026-06-30'},t.morgan)
  assert.equal((await h.get('reports/aging?'+range,t.morgan)).totals.amountMinor,flagged.total_minor)
  const audit=await h.send('/api/coaster/audit-pack?from=2026-01-01&to=2026-12-31',undefined,auditor)
  assert.equal(audit.status,200)
  assert.ok((await h.get('history',auditor)).lines.some(e=>e.action==='batch-reimbursed'))
  await h.post('claims',{title:'Auditors cannot write'},auditor,403)
}))

test('Migration previews exact source bytes, preserves read-only history, flags reclaims, undoes and reimports each incumbent', () => withAgency(async(h,t)=>{
  // Different column mappings exercise one migration behaviour in one installed business.
  // Imported history must never create payable claims.
  const sources=[
    {source:'certify',file:'certify-expenses.csv',receipts:['CE-501.png:officeworks','CE-502.png:hotel']},
    {source:'chromeriver',date:'MM/DD/YYYY',file:'chromeriver-expenses.csv',receipts:['LI-9001.png:bistro']},
    {source:'ramp',file:'ramp-transactions.csv',receipts:['RT-1001.png:uber','RT-1002.png:bistro']},
    {source:'brex',csv:'Transaction ID,Posted Date,Card Member Email,Merchant,Amount,Currency,Memo,Category,GL Account,Receipt File\nBX-1,2026-04-10,sam@harbourfinch.example,Delta,320.00,USD,Flight,Airfare,6200,\n'},
    {source:'navan',date:'MM/DD/YYYY',csv:'Transaction ID,Transaction Date,Employee Email,Merchant,Amount,Currency,Description,Expense Type,GL Code,Receipt File\nNV-1,04/12/2026,alex@harbourfinch.example,Hilton,412.00,USD,Offsite,Lodging,6250,\n'},
  ]
  await h.post('settings/business',{name:'Harbour & Finch US',timezone:'America/Chicago',currency:'USD',receiptThreshold:'75.00'})
  for(const source of sources){
    const input={source:source.source,filename:source.file??source.source+'.csv',csv:source.csv??await readFile('tests/fixtures/'+source.file,'utf8'),mapping:{date:source.date??'YYYY-MM-DD'},receipts:await Promise.all((source.receipts??[]).map(async entry=>{const[name,fixture]=entry.split(':');return{name,base64:(await readFile('tests/fixtures/receipts/'+fixture+'.png')).toString('base64')}}))}
    const before=await h.get('import')
    const preview=await h.post('import/preview',input)
    assert.deepEqual(preview.summary.errors,[])
    assert.deepEqual(await h.get('import'),before,'preview writes nothing')
    await h.post('import/commit',{...input,csv:input.csv.replace(/2026/, '2025'),fingerprint:preview.fingerprint},h.owner,409)
    const committed=await h.post('import/commit',{...input,fingerprint:preview.fingerprint})
    assert.equal(committed.job.state,'completed')
    const history=(await h.get('import')).history.filter(r=>r.source===source.source)
    assert.ok(history.length>0)
    const status=await h.post('import/status',{source:source.source,id:committed.job.id,mappingVersion:committed.mappingVersion})
    assert.ok(status.originals.some(r=>r.sha256===sha(Buffer.from(input.csv))))
    const sample=history.find(r=>r.amountMinor>0)
    if(sample){const reclaim=await claim(h,sample.employee==='alex@harbourfinch.example'?t.alex:t.sam,'Imported purchase again',[{kind:'receipt',date:sample.date,merchant:sample.merchant,amount:(sample.amountMinor/100).toFixed(2),allocations:[{category:t.c.travel}]}]);assert.ok(reclaim.exceptions.some(e=>e.code==='possible-duplicate'))}
    assert.equal((await h.post('import/undo',{source:source.source,id:committed.job.id,mappingVersion:committed.mappingVersion})).job.state,'undone')
    assert.equal((await h.get('import')).history.filter(r=>r.source===source.source).length,0)
    const again=await h.post('import/preview',input)
    assert.equal((await h.post('import/commit',{...input,fingerprint:again.fingerprint})).job.state,'completed')
  }
}))

test('A US business pre-approves an itemized client trip, prices dated mileage and published per diem, then reimburses its exact tax and split lines',async()=>{
  const h=await harness()
  try{
    await h.post('settings/business',{name:'Harbour & Finch US',timezone:'America/Chicago',salesTaxAccount:'2200',salesTaxCode:'TAX',preapprovalThreshold:'500.00'})
    const business=(await h.get('state')).business
    assert.equal(business.currency,'USD')
    assert.ok(business.timezone.startsWith('America/'))
    const category=async(name,account,extra={})=>(await h.post('settings/categories',{name,accountCode:account,taxCode:'NONE',...extra})).id
    const t={c:{travel:await category('Travel','6200'),car:await category('Car','6400'),lodging:await category('Lodging','6210'),meals:await category('Meals','6300',{limit:'120.00',perPersonLimit:'75.00',requiredFields:'Client'})}}
    t.priya=await h.person('priya@harbourfinch.example',{employee:true,manager:true})
    t.sam=await h.person('sam@harbourfinch.example',{employee:true},'priya@harbourfinch.example')
    t.morgan=await h.person('morgan@harbourfinch.example',{finance:true})
    const trip=await h.post('requests',{title:'Chicago client workshop',purpose:'Four days with the client',estimate:'2400.00'},t.sam)
    let c=await h.post('claims',{title:'Chicago client workshop'},t.sam)
    const hotel=await h.post(`claims/${c.id}/receipts`,{version:c.version,...await receipt('hotel')},t.sam);c=hotel.claim
    const lodging={version:c.version,kind:'receipt',date:'2026-06-08',merchant:'Chicago Hotel',amount:'1046.00',salesTax:'7.25',receipt:hotel.receipt,request:trip.id,fields:{Client:'Harbour Bank'},allocations:[{category:t.c.lodging,description:'Room',amount:'867.00'},{category:t.c.lodging,description:'Room tax',amount:'104.04'},{category:t.c.meals,description:'Dining',amount:'52.71'},{category:t.c.travel,description:'Parking',amount:'15.00'}]}
    await h.post(`claims/${c.id}/items`,lodging,t.sam,409,'an unapproved request cannot authorize spending')
    await h.post(`requests/${trip.id}/decision`,{version:trip.version,decision:'approved'},t.sam,403)
    await h.post(`requests/${trip.id}/decision`,{version:trip.version,decision:'approved'},t.priya)
    await h.post(`claims/${c.id}/items`,{...lodging,allocations:[{category:t.c.lodging,amount:'100.00'}]},t.sam,400)
    c=await h.post(`claims/${c.id}/items`,lodging,t.sam)
    c=await h.post(`claims/${c.id}/items`,{version:c.version,kind:'receipt',date:'2026-06-07',merchant:'Missing hotel receipt',amount:'10.00',allocations:[{category:t.c.lodging}]},t.sam)
    let missingHotel=await h.get(`claims/${c.id}`,t.sam)
    const missing=missingHotel.items.find(i=>i.merchant==='Missing hotel receipt')
    assert.ok(missingHotel.exceptions.some(e=>e.item===missing.id&&e.code==='missing-receipt'),'lodging needs a receipt even for a small purchase')
    c=await h.post(`claims/${c.id}/items/remove`,{version:c.version,item:missing.id},t.sam)
    const dinner=await h.post(`claims/${c.id}/receipts`,{version:c.version,...await receipt('bistro')},t.sam);c=dinner.claim
    const meal={version:c.version,kind:'receipt',date:'2026-06-09',merchant:'Client dinner',amount:'320.00',receipt:dinner.receipt,explanation:'Client dinner for four, agreed in advance',attendees:[{kind:'employee',name:'sam',email:'sam@harbourfinch.example'},{kind:'guest',name:'Dana'},{kind:'guest',name:'Lee'},{kind:'guest',name:'Pat'}],allocations:[{category:t.c.meals}]}
    c=await h.post(`claims/${c.id}/items`,meal,t.sam)
    await h.post(`claims/${c.id}/submit`,{version:c.version},t.sam,409,'required client information is enforced')
    let d=await h.get(`claims/${c.id}`,t.sam)
    c=await h.post(`claims/${c.id}/items`,{...meal,version:c.version,item:d.items[1].id,fields:{Client:'Harbour Bank'}},t.sam)
    for(const date of ['2025-12-30','2026-01-02'])c=await h.post(`claims/${c.id}/items`,{version:c.version,kind:'mileage',date,merchant:'Client visit '+date,distance:'186',allocations:[{category:t.c.car}]},t.sam)
    const locations=(await h.get('per-diem/locations?method=gsa',t.sam)).locations,location=locations.find(r=>r.label.startsWith('Chicago'))
    assert.ok(location)
    const perDiem={method:'gsa',locationId:location.id,endDate:'2026-06-11',component:'mie',providedMeals:[{date:'2026-06-09',meals:['lunch']}]}
    const prior=(await h.get(`claims/${c.id}`,t.sam)).claim
    const quote=await h.post('per-diem/quote',{date:'2026-06-08',perDiem},t.sam)
    assert.deepEqual((await h.get(`claims/${c.id}`,t.sam)).claim,prior,'quoting writes no expense')
    assert.equal(quote.totalMinor,quote.days.reduce((n,day)=>n+day.mieMinor,0))
    assert.ok(quote.days[0].mieMinor<quote.days[0].mieRateMinor,'travel days receive a reduced allowance')
    assert.ok(quote.days[1].deductionMinor>0,'a provided lunch reduces the allowance')
    assert.ok(quote.days.every(day=>day.source.startsWith('https://www.gsa.gov/')))
    c=await h.post(`claims/${c.id}/items`,{version:c.version,kind:'per_diem',date:'2026-06-08',perDiem:{...perDiem,totalMinor:1,days:[]},allocations:[{category:t.c.travel}]},t.sam)
    d=await h.get(`claims/${c.id}`,t.sam)
    assert.deepEqual(d.items.at(-1).per_diem,quote,'the server prices the published allowance')
    for(const item of d.items.filter(i=>i.kind==='mileage')){
      const rate=business.mileage_rates.filter(r=>r.effective_from<=item.spent_on).at(-1).rate_thousandths
      assert.equal(item.amount_minor,Math.floor((186*rate+5)/10))
    }
    assert.equal(d.items[0].allocations.reduce((n,a)=>n+a.amount_minor,0)+d.items[0].sales_tax_minor,d.items[0].amount_minor)
    assert.ok(d.exceptions.some(e=>e.code==='over-per-person'))
    c=await submit(h,t.sam,d)
    const frozen=(await h.get(`claims/${c.id}`,t.priya)).revisions
    await h.post('settings/business',{name:business.name,currency:'USD',timezone:business.timezone,perDiem:'200.00'})
    await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved'},t.priya,409)
    c=await approve(h,t.priya,c,{acknowledge:true})
    assert.deepEqual((await h.get(`claims/${c.id}`,t.sam)).revisions,frozen,'later settings never rewrite the submitted trip')
    let batch=await h.post('batches',{claims:[c.id]},t.morgan)
    batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:c.total_minor},t.morgan)
    const csv=(await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`,undefined,t.morgan)).text
    assert.equal(sum(csv,'amount'),c.total_minor)
    assert.match(csv,/"Sales tax","2200","TAX"/)
    assert.ok(csv.includes(quote.days[0].source),'the accounting file carries the published daily provenance')
    await h.paid(batch.id,batch.version,{reference:'CHICAGO-TRIP',paidOn:'2026-06-15'},t.morgan)
    assert.equal((await h.get(`claims/${c.id}`,t.sam)).claim.status,'reimbursed')
  }finally{await h.close()}
})
