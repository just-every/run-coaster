import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { agency, harness } from './harness.mjs'
import { captureFiles, captureFolio } from './fixtures/capture-files.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const SAM = 'sam@harbourfinch.example'

async function upload(h,cookie,name,bytes,{ source = 'upload', headers = {}, extra, files, status = 200 } = {}) {
  const form = new FormData()
  form.append('file',new Blob([bytes],{ type: 'application/octet-stream' }),name)
  form.append('source',source)
  if (extra) for (const [key,value] of Object.entries(extra)) form.append(key,value)
  if (files) form.append('file',new Blob([bytes]),'another.png')
  const encoded = new Request(`${h.origin}/api/coaster/receipt-inbox`, { method: 'POST', headers: { origin: h.origin, cookie, ...headers }, body: form })
  const response = await h.mf.dispatchFetch(encoded.url, { method: 'POST', headers: Object.fromEntries(encoded.headers), body: await encoded.arrayBuffer() })
  const value = await response.json()
  assert.equal(response.status,status,JSON.stringify(value))
  return value.receipt ?? value
}

async function download(h,cookie,id,status = 200,headers = {}) {
  const response = await h.mf.dispatchFetch(`${h.origin}/api/coaster/receipt-inbox/${id}`,{ headers: { cookie,...headers } })
  assert.equal(response.status,status,'receipt download status')
  if (status !== 200) return
  assert.match(response.headers.get('cache-control'),/no-store/)
  assert.equal(response.headers.get('x-content-type-options'),'nosniff')
  return { bytes: Buffer.from(await response.arrayBuffer()),mediaType: response.headers.get('content-type') }
}

test('CAPTURE-001 thirty mixed uploads retain exact originals and provenance in a private inbox, including an 8 MB three-page PDF and HEIC; one refusal leaves valid files intact',async () => {
  const h = await harness()
  try {
    const team = await agency(h), before = Date.now()
    const { files,oversized } = await captureFiles()
    const uploaded = []
    for (let index = 0; index < 30; index++) {
      const input = files[index], name = input.name
      const receipt = await upload(h,team.sam,name,input.bytes,{ source: index === 0 ? 'camera' : 'upload' })
      assert.deepEqual([receipt.name,receipt.mediaType,receipt.size,receipt.sha256,receipt.uploadedBy],[name,input.mediaType,input.bytes.length,sha(input.bytes),SAM])
      assert.ok(Date.parse(receipt.uploadedAt) >= before && Date.parse(receipt.uploadedAt) <= Date.now())
      assert.equal(receipt.state,'needs-attention')
      assert.match(receipt.attentionReason,/manual|manually/i,'no reader is misrepresented as a successful read')
      assert.equal(receipt.source,index === 0 ? 'camera' : 'upload')
      assert.ok(receipt.history.some(event => event.state === 'received'))
      assert.equal(receipt.history.at(-1).state,receipt.state)
      for (const [eventIndex,event] of receipt.history.entries()) {
        assert.deepEqual([event.sequence,event.actorEmail,event.onBehalfOf,event.channel],[eventIndex + 1,SAM,null,'app'])
        assert.ok(Date.parse(event.at) >= Date.parse(receipt.uploadedAt))
      }
      uploaded.push({ receipt,input })
      if (index === 9) {
        const refused = await upload(h,team.sam,oversized.name,oversized.bytes,{ status: 413 })
        assert.match(refused.error,/10 MB/)
      }
    }
    const inbox = await h.get('receipt-inbox',team.sam)
    assert.equal(inbox.receipts.length,30)
    assert.deepEqual(new Set(inbox.receipts.map(r => r.id)),new Set(uploaded.map(({receipt}) => receipt.id)))
    const bucket = await h.mf.getR2Bucket('COASTER_RECEIPTS')
    for (const { receipt,input } of uploaded) {
      const downloaded = await download(h,team.sam,receipt.id)
      assert.deepEqual(downloaded.bytes,input.bytes)
      assert.equal(downloaded.mediaType,input.mediaType)
      const evidence = await h.db.prepare('SELECT * FROM c_capture_receipts WHERE id=?').bind(receipt.id).first()
      assert.deepEqual([evidence.sha256,evidence.size,evidence.uploaded_by,evidence.name,evidence.media_type,evidence.uploaded_at],[sha(input.bytes),input.bytes.length,SAM,receipt.name,input.mediaType,receipt.uploadedAt])
      assert.deepEqual(Buffer.from(await (await bucket.get(evidence.object_key)).arrayBuffer()),input.bytes)
    }
    for (const cookie of [team.alex,team.priya,team.morgan,h.owner]) {
      assert.deepEqual((await h.get('receipt-inbox',cookie)).receipts,[])
      await download(h,cookie,uploaded[0].receipt.id,404)
    }
    const globalHistory = await h.get('history?q=receipt-1')
    assert.equal(globalHistory.lines.length,0,'private inbox filenames do not leak into the global audit history')
    assert.deepEqual((await h.get('state',team.sam)).claims,[],'capture does not manufacture a claim')
    const key = await h.post('agent-keys',{ label: 'Receipt preparer' },team.sam)
    assert.equal((await h.send('/api/coaster/receipt-inbox',undefined,'',{ authorization: `Bearer ${key.token}` })).status,401)
    await download(h,'',uploaded[0].receipt.id,401)
  } finally { await h.close() }
})

test('CAPTURE-001 inclusive size boundary, rejected signatures and forged uploads, legacy claim receipts and immediate deactivation',async () => {
  const h = await harness()
  try {
    const team = await agency(h), png = await readFile('tests/fixtures/receipts/bistro.png')
    const boundary = await upload(h,team.sam,'maximum.pdf',await captureFolio(10_000_000))
    assert.equal((await download(h,team.sam,boundary.id)).bytes.length,10_000_000)
    await upload(h,team.sam,'over.pdf',Buffer.alloc(10_000_001),{ status: 413 })
    await upload(h,team.sam,'disguised.png',Buffer.from('This is not an image'),{ status: 415 })
    await upload(h,team.sam,'empty.jpg',Buffer.alloc(0),{ status: 400 })
    await upload(h,team.sam,'two.png',png,{ files: true,status: 400 })
    await upload(h,team.sam,'forged.png',png,{ extra: { uploadedBy: 'owner@harbourfinch.example',owner: 'alex@harbourfinch.example' },status: 400 })
    await upload(h,team.sam,'cross-origin.png',png,{ headers: { origin: 'https://elsewhere.example' },status: 403 })
    assert.equal((await h.get('receipt-inbox',team.sam)).receipts.length,1)
    const grant = await h.post('delegates',{ delegate: 'alex@harbourfinch.example',level: 'submit' },team.sam)
    const actingForSam = { 'x-coaster-acting-for': SAM }
    const delegated = await upload(h,team.alex,'delegated.png',png,{ headers: actingForSam })
    assert.equal(delegated.uploadedBy,'alex@harbourfinch.example')
    assert.ok(delegated.history.every(event => event.actorEmail === 'alex@harbourfinch.example' && event.onBehalfOf === SAM && event.channel === 'app'))
    assert.deepEqual((await h.get('receipt-inbox',team.alex)).receipts,[])
    await download(h,team.alex,delegated.id,404)
    assert.deepEqual((await download(h,team.alex,delegated.id,200,actingForSam)).bytes,png)
    await h.post(`delegates/${grant.id}/revoke`,{},team.sam)
    await upload(h,team.alex,'revoked-delegate.png',png,{ headers: actingForSam,status: 403 })
    let claim = await h.post('claims',{ title: 'Legacy receipt remains available' },team.sam)
    const legacy = await h.post(`claims/${claim.id}/receipts`,{ version: claim.version,name: 'legacy.png',base64: png.toString('base64') },team.sam)
    const legacyDownload = await h.mf.dispatchFetch(`${h.origin}/api/coaster/receipts/${legacy.receipt}`,{ headers: { cookie: team.sam } })
    assert.equal(legacyDownload.status,200)
    assert.deepEqual(Buffer.from(await legacyDownload.arrayBuffer()),png)
    await h.post('settings/members',{ email: SAM,name: 'sam',employee: true,active: false })
    await h.get('receipt-inbox',team.sam,403)
    await download(h,team.sam,boundary.id,403)
    await upload(h,team.sam,'after-deactivation.png',png,{ status: 403 })
    const alexReceipt = await upload(h,team.alex,'alex.png',png)
    const operators = (await h.send('/auth/operators',undefined,h.owner)).value
    const alex = (Array.isArray(operators) ? operators : operators.operators).find(p => p.email === 'alex@harbourfinch.example')
    assert.equal((await h.send('/auth/operator/status',{ operatorId: alex.id,status: 'inactive' },h.owner)).status,200)
    await h.get('receipt-inbox',team.alex,401)
    await download(h,team.alex,alexReceipt.id,401)
    await upload(h,team.alex,'after-account-deactivation.png',png,{ status: 401 })
  } finally { await h.close() }
})

const discardBody = (reason = 'Personal copy retained for the audit', expectedSequence = 0) => ({ reason, expectedSequence })
const discardPath = id => `receipt-inbox/${id}/discard`

test('CAPTURE-004 / AUDIT-001 private terminal discard preserves originals and reader history; native employee and both live delegate levels work; malformed, foreign, stale and concurrent writes are refused', async () => {
  const h = await harness()
  try {
    const t = await agency(h), png = await readFile('tests/fixtures/receipts/bistro.png')
    const first = await upload(h, t.sam, 'private-original.png', png)
    const before = await h.get('receipt-inbox', t.sam)
    for (const reason of [undefined, null, '', '  ', 5, {}, 'x'.repeat(1001)])
      await h.post(discardPath(first.id), { reason, expectedSequence: 0 }, t.sam, 400)
    await h.post(discardPath(first.id), { ...discardBody(), owner: SAM }, t.sam, 400)
    await h.post(discardPath(first.id), { reason: 'Missing sequence' }, t.sam, 400)
    await h.post(discardPath(first.id), discardBody('Stale view', 1), t.sam, 409)
    await h.post(discardPath(first.id), discardBody(), t.alex, 404)
    for (const [address, roles] of [['finance-only', { finance: true }], ['approver-only', { manager: true }], ['auditor-only', { auditor: true }]]) {
      const cookie = await h.person(`${address}@harbourfinch.example`, roles)
      await h.post(discardPath(first.id), discardBody(), cookie, 403)
      await download(h, cookie, first.id, 403)
    }
    await h.post(discardPath(first.id), discardBody(), h.owner, 403)
    await h.post(discardPath(first.id), discardBody(), '', 401)
    assert.equal((await h.send(`/api/coaster/${discardPath(first.id)}`, discardBody(), t.sam, { origin: 'https://elsewhere.example' })).status, 403)
    const key = await h.post('agent-keys', { label: 'Capture only' }, t.sam)
    assert.equal((await h.send(`/api/coaster/${discardPath(first.id)}`, discardBody(), '', { authorization: `Bearer ${key.token}` })).status, 401)
    assert.deepEqual(await h.get('receipt-inbox', t.sam), before, 'every refusal leaves all receipt evidence unchanged')
    const hold = (await h.post('legal-holds', { scope: 'person', member: SAM, reason: 'Records review' })).holds[0]
    const discarded = (await h.post(discardPath(first.id), discardBody('  Private duplicate copy  '), t.sam)).receipt
    assert.equal(discarded.disposition, 'discarded')
    assert.deepEqual(discarded.history, first.history, 'processing state stays separate from disposition')
    assert.deepEqual(discarded.lifecycle.map(e => [e.sequence, e.kind, e.reason, e.actorEmail, e.onBehalfOf, e.channel]), [[1, 'discarded', 'Private duplicate copy', SAM, null, 'app']])
    assert.ok(discarded.lifecycle[0].at >= first.uploadedAt)
    assert.deepEqual((await download(h, t.sam, first.id)).bytes, png)
    for (const seq of [0, 1]) await h.post(discardPath(first.id), discardBody('Replay', seq), t.sam, 409)
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const r = await h.mf.dispatchFetch(`${h.origin}/api/coaster/${discardPath(first.id)}`, { method, headers: { cookie: t.sam, origin: h.origin, 'content-type': 'application/json' }, body: JSON.stringify(discardBody()) })
      assert.ok(r.status >= 400)
    }
    for (const sql of ["UPDATE c_capture_lifecycle SET reason='changed' WHERE receipt_id=?", 'DELETE FROM c_capture_lifecycle WHERE receipt_id=?'])
      await assert.rejects(h.db.prepare(sql).bind(first.id).run(), /permanent/)
    await h.post(`legal-holds/${hold.id}/release`, {})
    const repeat = await upload(h, t.sam, 'same-original-again.png', png)
    assert.notEqual(repeat.id, first.id)
    assert.deepEqual([repeat.disposition, repeat.lifecycleSequence], ['active', 0])
    const competing = await Promise.all([1, 2].map(n => h.send(`/api/coaster/${discardPath(repeat.id)}`, discardBody(`Concurrent ${n}`), t.sam)))
    assert.deepEqual(competing.map(r => r.status).sort(), [200, 409])
    assert.equal((await h.get('receipt-inbox', t.sam)).receipts.find(r => r.id === repeat.id).lifecycle.length, 1)
    for (const level of ['submit', 'full']) {
      const grant = await h.post('delegates', { delegate: 'alex@harbourfinch.example', level }, t.sam)
      const receipt = await upload(h, t.sam, `${level}.png`, png), headers = { 'x-coaster-acting-for': SAM }
      const r = await h.send(`/api/coaster/${discardPath(receipt.id)}`, discardBody(`Delegated ${level}`), t.alex, headers)
      assert.equal(r.status, 200)
      assert.deepEqual([r.value.receipt.lifecycle[0].actorEmail, r.value.receipt.lifecycle[0].onBehalfOf], ['alex@harbourfinch.example', SAM])
      assert.deepEqual((await download(h, t.alex, receipt.id, 200, headers)).bytes, png)
      await h.post(`delegates/${grant.id}/revoke`, {}, t.sam)
      assert.equal((await h.send(`/api/coaster/${discardPath(receipt.id)}`, discardBody(), t.alex, headers)).status, 403)
    }
    assert.deepEqual((await h.get('receipt-inbox', h.owner)).receipts, [])
    const history = JSON.stringify(await h.get('history'))
    assert.ok(!history.includes('Private duplicate copy') && !history.includes('private-original.png'))
    const pack = await h.mf.dispatchFetch(`${h.origin}/api/coaster/audit-pack?from=2026-01-01&to=2026-12-31`, { headers: { cookie: h.owner } })
    assert.equal(pack.status, 200)
    assert.ok(!Buffer.from(await pack.arrayBuffer()).includes(Buffer.from('Private duplicate copy')), 'stored ZIP audit entries omit private reasons')
    assert.deepEqual((await h.get('state', t.sam)).claims, [])
    assert.ok(!JSON.stringify(await h.get('retention')).includes(first.id), 'discard starts no expiry proposal')
  } finally { await h.close() }
})

test('CAPTURE-004 authority is checked again after the request starts; revoked sign-in and deactivated delegates write nothing', async () => {
  const h = await harness()
  try {
    const t = await agency(h), png = await readFile('tests/fixtures/receipts/bistro.png')
    const receipt = await upload(h, t.sam, 'waiting-body.png', png)
    const grant = await h.post('delegates', { delegate: 'alex@harbourfinch.example', level: 'submit' }, t.sam)
    let finish
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"expectedSequence":0,"reason":"'))
      finish = () => { controller.enqueue(new TextEncoder().encode('Delayed reason"}')); controller.close() }
    } })
    const pending = h.mf.dispatchFetch(`${h.origin}/api/coaster/${discardPath(receipt.id)}`, { method: 'POST', headers: { cookie: t.alex, origin: h.origin, 'content-type': 'application/json', 'x-coaster-acting-for': SAM }, body, duplex: 'half' })
    // Hold the public HTTP body open after native authorization, then revoke it.
    await new Promise(resolve => setTimeout(resolve, 1000))
    await h.post(`delegates/${grant.id}/revoke`, {}, t.sam)
    finish()
    assert.equal((await pending).status, 409)
    assert.deepEqual((await h.get('receipt-inbox', t.sam)).receipts[0].lifecycle, [])
    await h.post('delegates', { delegate: 'alex@harbourfinch.example', level: 'full' }, t.sam)
    await h.post('settings/members', { email: 'alex@harbourfinch.example', name: 'alex', employee: true, active: false })
    assert.equal((await h.send(`/api/coaster/${discardPath(receipt.id)}`, discardBody(), t.alex, { 'x-coaster-acting-for': SAM })).status, 403)
    assert.equal((await h.send('/auth/signout', {}, t.sam)).status, 204)
    await h.post(discardPath(receipt.id), discardBody(), t.sam, 401)
    assert.equal(await h.db.prepare('SELECT COUNT(*) AS n FROM c_capture_lifecycle').first('n'), 0)
  } finally { await h.close() }
})

test('ERASURE-001 / CAPTURE-004 preserves discarded originals and reasons with employee and delegate names and any-case addresses replaced', async () => {
  const h = await harness()
  try {
    const t = await agency(h), png = await readFile('tests/fixtures/receipts/bistro.png')
    await h.post('settings/members', { email: SAM, name: 'Sam Taylor', employee: true })
    await h.post('settings/members', { email: 'alex@harbourfinch.example', name: 'Alex Assistant', employee: true })
    const receipt = await upload(h, t.sam, 'kept-discarded.png', png)
    await h.post('delegates', { delegate: 'alex@harbourfinch.example', level: 'submit' }, t.sam)
    const reason = 'Sam Taylor (SAM@HARBOURFINCH.EXAMPLE) asked Alex Assistant (ALEX@HARBOURFINCH.EXAMPLE) to keep this duplicate.'
    assert.equal((await h.send(`/api/coaster/${discardPath(receipt.id)}`, discardBody(reason), t.alex, { 'x-coaster-acting-for': SAM })).status, 200)
    await h.post('settings/members', { email: 'alex@harbourfinch.example', name: 'Alex Assistant', employee: true, active: false })
    const alex = await h.post('settings/members/erase', { email: 'alex@harbourfinch.example' })
    let kept = (await h.get('receipt-inbox', t.sam)).receipts[0]
    assert.ok(kept.lifecycle[0].reason.includes(alex.label) && kept.lifecycle[0].reason.includes(alex.retained.subject))
    assert.equal(kept.lifecycle[0].actorEmail, alex.retained.subject)
    await h.post('settings/members', { email: SAM, name: 'Sam Taylor', employee: true, active: false })
    const sam = await h.post('settings/members/erase', { email: SAM })
    assert.deepEqual(sam.retained.receiptSha256, [sha(png)])
    const row = await h.db.prepare('SELECT * FROM c_capture_lifecycle WHERE receipt_id=?').bind(receipt.id).first()
    assert.ok(row.reason.includes(sam.label) && row.reason.includes(sam.retained.subject) && row.reason.includes('keep this duplicate'))
    assert.equal(row.on_behalf_of, sam.retained.subject)
    assert.ok(!/Sam Taylor|Alex Assistant|sam@harbourfinch\.example|alex@harbourfinch\.example/i.test(JSON.stringify(row)))
    const original = await h.db.prepare('SELECT * FROM c_capture_receipts WHERE id=?').bind(receipt.id).first()
    const bucket = await h.mf.getR2Bucket('COASTER_RECEIPTS')
    assert.deepEqual(Buffer.from(await (await bucket.get(original.object_key)).arrayBuffer()), png)
  } finally { await h.close() }
})
