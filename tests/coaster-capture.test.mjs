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
  let pause = false, observed, resume
  const h = await harness({ d1Barrier: async () => {
    if (pause) { pause = false; observed(); await new Promise(resolve => { resume = resolve }) }
    return new Response('open')
  } })
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
    // The shortest valid name exercises the exact expansion bound, including a delegate.
    const bea = await h.person('bea@harbourfinch.example', { employee: true }, 'priya@harbourfinch.example')
    const a = await h.person('short-a@harbourfinch.example', { employee: true })
    await h.post('settings/members', { email: 'short-a@harbourfinch.example', name: 'A', employee: true })
    await h.post('delegates', { delegate: 'short-a@harbourfinch.example', level: 'submit' }, bea)
    const expandedIds = []
    for (const delegated of [false, true]) {
      const original = await upload(h, bea, `expanded-${delegated}.png`, png)
      expandedIds.push(original.id)
      const result = await h.send(`/api/coaster/${discardPath(original.id)}`, discardBody('A'.repeat(1000)), delegated ? a : bea, delegated ? { 'x-coaster-acting-for': 'bea@harbourfinch.example' } : {})
      assert.equal(result.status, 200)
    }
    await h.post('settings/members', { email: 'short-a@harbourfinch.example', name: 'A', employee: true, active: false })
    const erasedA = await h.post('settings/members/erase', { email: 'short-a@harbourfinch.example' })
    assert.equal(erasedA.removed.discardReasons, 2)
    const expanded = (await h.get('receipt-inbox', bea)).receipts.filter(r => expandedIds.includes(r.id))
    for (const r of expanded) {
      assert.equal(r.lifecycle[0].reason, erasedA.label.repeat(1000))
      assert.equal(r.lifecycle[0].reason.length, 22000)
      assert.equal(Buffer.byteLength(r.lifecycle[0].reason), 22000)
    }
    await h.post('settings/members', { email: 'form@harbourfinch.example', name: 'Form', employee: true, active: false })
    const erasedForm = await h.post('settings/members/erase', { email: 'form@harbourfinch.example' })
    assert.equal(erasedForm.removed.discardReasons, 0)
    for (const r of (await h.get('receipt-inbox', bea)).receipts) assert.equal(r.lifecycle[0].reason, erasedA.label.repeat(1000))
    await h.post('settings/members', { email: 'race-subject@harbourfinch.example', name: 'Race Subject', employee: true, active: false })
    const beforeRead = await upload(h, bea, 'before-read.png', png), duringRead = await upload(h, bea, 'during-read.png', png)
    await h.post(discardPath(beforeRead.id), discardBody('Race Subject original copy'), bea)
    const read = new Promise(resolve => { observed = resolve }); pause = true
    const erasing = h.send('/api/coaster/settings/members/erase', { email: 'race-subject@harbourfinch.example' }, h.owner)
    await read
    await h.post(discardPath(duringRead.id), discardBody('Race Subject concurrent copy'), bea)
    resume()
    assert.equal((await erasing).status, 409, 'a real public write between D1 read and commit invalidates the erasure snapshot')
    assert.equal(await h.db.prepare('SELECT name FROM c_members WHERE email=?').bind('race-subject@harbourfinch.example').first('name'), 'Race Subject')
    const reloaded = await h.post('settings/members/erase', { email: 'race-subject@harbourfinch.example' })
    assert.equal(reloaded.removed.discardReasons, 2)
  } finally { resume?.(); await h.close() }
})

const mergeBody = (survivorId, reason, expectedSequence = 0) => ({ survivorId, ...(reason === undefined ? {} : { reason }), expectedSequence })
const mergePath = id => `receipt-inbox/${id}/merge`

test('CAPTURE-004 / AUDIT-001 merging a duplicate is a private terminal disposition that leaves the survivor untouched; a reason is needed unless the files are identical', async () => {
  const h = await harness()
  try {
    const t = await agency(h), png = await readFile('tests/fixtures/receipts/bistro.png')
    const survivor = await upload(h, t.sam, 'kept-original.png', png), same = await upload(h, t.sam, 'same-file.png', png)
    const different = await upload(h, t.sam, 'different-file.png', Buffer.concat([png, Buffer.alloc(1)]))
    const foreign = await upload(h, t.alex, 'alex-original.png', png)
    const before = await h.get('receipt-inbox', t.sam)
    // Refused shapes, ownership and authority write nothing.
    for (const reason of [5, {}, 'x'.repeat(1001)]) await h.post(mergePath(different.id), mergeBody(survivor.id, reason), t.sam, 400)
    await h.post(mergePath(different.id), mergeBody(survivor.id), t.sam, 400)
    await h.post(mergePath(different.id), mergeBody(survivor.id, '  '), t.sam, 400)
    await h.post(mergePath(different.id), { ...mergeBody(survivor.id, 'Same receipt'), owner: SAM }, t.sam, 400)
    await h.post(mergePath(same.id), { reason: 'No survivor', expectedSequence: 0 }, t.sam, 400)
    await h.post(mergePath(same.id), { survivorId: same.id, expectedSequence: 0 }, t.sam, 400)
    await h.post(mergePath(same.id), mergeBody(survivor.id, undefined, 1), t.sam, 409)
    await h.post(mergePath(same.id), mergeBody('unknown-receipt'), t.sam, 404)
    await h.post(mergePath(same.id), mergeBody(foreign.id), t.sam, 404)
    await h.post(mergePath(same.id), mergeBody(survivor.id), t.alex, 404)
    for (const [address, roles] of [['finance-only', { finance: true }], ['approver-only', { manager: true }], ['auditor-only', { auditor: true }]])
      await h.post(mergePath(same.id), mergeBody(survivor.id), await h.person(`${address}@harbourfinch.example`, roles), 403)
    await h.post(mergePath(same.id), mergeBody(survivor.id), h.owner, 403)
    await h.post(mergePath(same.id), mergeBody(survivor.id), '', 401)
    assert.equal((await h.send(`/api/coaster/${mergePath(same.id)}`, mergeBody(survivor.id), t.sam, { origin: 'https://elsewhere.example' })).status, 403)
    const key = await h.post('agent-keys', { label: 'Capture only' }, t.sam)
    assert.equal((await h.send(`/api/coaster/${mergePath(same.id)}`, mergeBody(survivor.id), '', { authorization: `Bearer ${key.token}` })).status, 401)
    assert.deepEqual(await h.get('receipt-inbox', t.sam), before, 'every refusal leaves all receipt evidence unchanged')
    // The refused reasonless merge of a different file, then the stated reason.
    await h.post(mergePath(different.id), mergeBody(survivor.id, ''), t.sam, 400)
    const hold = (await h.post('legal-holds', { scope: 'person', member: SAM, reason: 'Records review' })).holds[0]
    const reasoned = (await h.post(mergePath(different.id), mergeBody(survivor.id, '  Scan of the same receipt  '), t.sam)).receipt
    assert.deepEqual([reasoned.disposition, reasoned.lifecycleSequence], ['merged', 1])
    assert.deepEqual(reasoned.lifecycle.map(e => [e.sequence, e.kind, e.reason, e.survivorId, e.actorEmail, e.onBehalfOf, e.channel]), [[1, 'merged', 'Scan of the same receipt', survivor.id, SAM, null, 'app']])
    assert.deepEqual(reasoned.history, different.history, 'processing state stays separate from disposition')
    const merged = (await h.post(mergePath(same.id), mergeBody(survivor.id), t.sam)).receipt
    assert.deepEqual([merged.disposition, merged.lifecycle[0].reason, merged.lifecycle[0].survivorId], ['merged', '', survivor.id])
    const after = (await h.get('receipt-inbox', t.sam)).receipts
    assert.deepEqual(after.find(r => r.id === survivor.id), before.receipts.find(r => r.id === survivor.id), 'the survivor original is untouched')
    assert.equal(await h.db.prepare('SELECT COUNT(*) AS n FROM c_capture_lifecycle WHERE receipt_id=?').bind(survivor.id).first('n'), 0)
    assert.deepEqual((await download(h, t.sam, same.id)).bytes, png)
    // Terminal for both dispositions, in either order; no replay.
    await h.post(mergePath(same.id), mergeBody(survivor.id), t.sam, 409)
    await h.post(mergePath(same.id), mergeBody(survivor.id, 'Replay', 1), t.sam, 409)
    await h.post(discardPath(same.id), discardBody('Too late', 1), t.sam, 409)
    await h.post(discardPath(same.id), discardBody('Too late', 0), t.sam, 409)
    const gone = (await h.post(discardPath(foreign.id), discardBody('Not mine'), t.alex)).receipt
    assert.equal(gone.disposition, 'discarded')
    const mine = await upload(h, t.sam, 'into-discarded.png', png), into = await upload(h, t.sam, 'to-discard.png', png)
    await h.post(discardPath(into.id), discardBody('Discarded survivor'), t.sam)
    await h.post(mergePath(mine.id), mergeBody(into.id), t.sam, 409)
    await h.post(mergePath(into.id), mergeBody(survivor.id), t.sam, 409)
    await h.post(mergePath(mine.id), mergeBody(same.id), t.sam, 409)
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const r = await h.mf.dispatchFetch(`${h.origin}/api/coaster/${mergePath(same.id)}`, { method, headers: { cookie: t.sam, origin: h.origin, 'content-type': 'application/json' }, body: JSON.stringify(mergeBody(survivor.id)) })
      assert.ok(r.status >= 400)
    }
    for (const sql of ["UPDATE c_capture_lifecycle SET reason='changed' WHERE receipt_id=?", "UPDATE c_capture_lifecycle SET survivor_id=NULL WHERE receipt_id=?", 'DELETE FROM c_capture_lifecycle WHERE receipt_id=?'])
      await assert.rejects(h.db.prepare(sql).bind(same.id).run(), /permanent|CHECK/)
    // The database itself refuses a merge without a reason for different files, a foreign or closed survivor.
    const insert = (id, survivorId, reason) => h.db.prepare("INSERT INTO c_capture_lifecycle(receipt_id,sequence,kind,reason,survivor_id,at,actor_email,on_behalf_of,channel) VALUES(?,1,'merged',?,?,?,?,NULL,'app')").bind(id, reason, survivorId, new Date().toISOString(), SAM).run()
    const spare = await upload(h, t.sam, 'spare.png', Buffer.concat([png, Buffer.alloc(2)]))
    await assert.rejects(insert(spare.id, survivor.id, ''), /survivor/)
    await assert.rejects(insert(spare.id, foreign.id, 'Foreign'), /survivor/)
    await assert.rejects(insert(spare.id, into.id, 'Closed'), /survivor/)
    await h.post(`legal-holds/${hold.id}/release`, {})
    // Concurrent merges: one wins; opposite directions cannot both win.
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map(n => upload(h, t.sam, `race-${n}.png`, png)))
    const twice = await Promise.all([b, c].map(survivorOf => h.send(`/api/coaster/${mergePath(a.id)}`, mergeBody(survivorOf.id), t.sam)))
    assert.deepEqual(twice.map(r => r.status).sort(), [200, 409])
    const crossed = await Promise.all([[b, c], [c, b]].map(([from, to]) => h.send(`/api/coaster/${mergePath(from.id)}`, mergeBody(to.id), t.sam)))
    assert.ok(crossed.filter(r => r.status === 200).length <= 1 && crossed.every(r => [200, 409].includes(r.status)))
    // Live Submit-only and Full delegates act for the employee on that employee's originals; revoked ones cannot.
    for (const level of ['submit', 'full']) {
      const grant = await h.post('delegates', { delegate: 'alex@harbourfinch.example', level }, t.sam)
      const headers = { 'x-coaster-acting-for': SAM }
      const [dup, keep] = [await upload(h, t.sam, `${level}-dup.png`, png), await upload(h, t.sam, `${level}-keep.png`, png)]
      const r = await h.send(`/api/coaster/${mergePath(dup.id)}`, mergeBody(keep.id), t.alex, headers)
      assert.equal(r.status, 200)
      assert.deepEqual([r.value.receipt.lifecycle[0].actorEmail, r.value.receipt.lifecycle[0].onBehalfOf, r.value.receipt.lifecycle[0].survivorId], ['alex@harbourfinch.example', SAM, keep.id])
      assert.deepEqual((await download(h, t.alex, dup.id, 200, headers)).bytes, png)
      const spare2 = await upload(h, t.sam, `${level}-spare.png`, png)
      await h.post(`delegates/${grant.id}/revoke`, {}, t.sam)
      assert.equal((await h.send(`/api/coaster/${mergePath(spare2.id)}`, mergeBody(keep.id), t.alex, headers)).status, 403)
    }
    // Nothing joins global history, audit packs, retention or claim data; the survivor of a foreign employee is never offered.
    const history = JSON.stringify(await h.get('history'))
    assert.ok(!history.includes('Scan of the same receipt') && !history.includes('different-file.png') && !history.includes('same-file.png'))
    const pack = await h.mf.dispatchFetch(`${h.origin}/api/coaster/audit-pack?from=2026-01-01&to=2026-12-31`, { headers: { cookie: h.owner } })
    assert.ok(!Buffer.from(await pack.arrayBuffer()).includes(Buffer.from('Scan of the same receipt')))
    assert.deepEqual((await h.get('receipt-inbox', h.owner)).receipts, [])
    assert.deepEqual((await h.get('state', t.sam)).claims, [])
    assert.ok(!JSON.stringify(await h.get('retention')).includes(same.id), 'merge starts no expiry proposal')
  } finally { await h.close() }
})

test('ERASURE-001 / CAPTURE-004 merged duplicates keep their originals; names and addresses in the merge reason are replaced and a reasonless identical merge is left alone', async () => {
  const h = await harness()
  try {
    const t = await agency(h), png = await readFile('tests/fixtures/receipts/bistro.png')
    await h.post('settings/members', { email: SAM, name: 'Sam Taylor', employee: true })
    const survivor = await upload(h, t.sam, 'survivor.png', png), identical = await upload(h, t.sam, 'identical.png', png), scan = await upload(h, t.sam, 'scan.png', Buffer.concat([png, Buffer.alloc(1)]))
    await h.post(mergePath(identical.id), mergeBody(survivor.id), t.sam)
    await h.post(mergePath(scan.id), mergeBody(survivor.id, 'Sam Taylor (SAM@HARBOURFINCH.EXAMPLE) scanned this twice.'), t.sam)
    await h.post('settings/members', { email: SAM, name: 'Sam Taylor', employee: true, active: false })
    const sam = await h.post('settings/members/erase', { email: SAM })
    assert.equal(sam.removed.discardReasons, 1)
    const rows = (await h.db.prepare('SELECT * FROM c_capture_lifecycle ORDER BY receipt_id').all()).results
    assert.equal(rows.length, 2)
    const reasoned = rows.find(r => r.receipt_id === scan.id), reasonless = rows.find(r => r.receipt_id === identical.id)
    assert.ok(reasoned.reason.includes(sam.label) && reasoned.reason.includes(sam.retained.subject) && reasoned.reason.includes('scanned this twice'))
    assert.equal(reasonless.reason, '')
    assert.deepEqual([reasoned.survivor_id, reasonless.survivor_id], [survivor.id, survivor.id])
    assert.ok(!/Sam Taylor|sam@harbourfinch\.example/i.test(JSON.stringify(rows)))
    assert.deepEqual(sam.retained.receiptSha256, [...new Set([sha(png), sha(Buffer.concat([png, Buffer.alloc(1)]))])].sort())
    const bucket = await h.mf.getR2Bucket('COASTER_RECEIPTS')
    for (const id of [identical.id, scan.id]) {
      const original = await h.db.prepare('SELECT * FROM c_capture_receipts WHERE id=?').bind(id).first()
      assert.equal(sha(Buffer.from(await (await bucket.get(original.object_key)).arrayBuffer())), original.sha256)
    }
  } finally { await h.close() }
})

test('CAPTURE-004 cash window defaults off, confirms only finance-visible counts, and prepares bounded once-only dated drafts without amounts, attachment, submission or new receipt bytes', async () => {
  const h = await harness()
  try {
    const t = await agency(h), png = await readFile('tests/fixtures/receipts/bistro.png')
    const worker = await h.mf.getWorker(), tick = at => worker.scheduled({ scheduledTime: at, cron: '17 * * * *' })
    const getWindow = () => h.get('settings/cash-draft-window',t.morgan)
    assert.deepEqual(await getWindow(), { days:null,version:0 })
    for (const cookie of [t.sam,t.priya]) {
      await h.get('settings/cash-draft-window',cookie,403)
      await h.post('settings/cash-draft-window/preview',{days:1},cookie,403)
    }
    for (const days of [0,91,1.5,'1']) await h.post('settings/cash-draft-window/preview',{days},t.morgan,400)
    await h.post('settings/cash-draft-window/preview',{days:1,extra:true},t.morgan,400)
    const originals=[]
    for(let i=0;i<29;i++) originals.push(await upload(h,t.sam,`cash-${i}.png`,png))
    const discarded=originals[0],merged=originals[1]
    await h.post(`receipt-inbox/${discarded.id}/discard`,{reason:'not a business expense',expectedSequence:0},t.sam)
    await h.post(`receipt-inbox/${merged.id}/merge`,{survivorId:originals[2].id,expectedSequence:0},t.sam)
    const before=(await h.db.prepare('SELECT * FROM c_capture_receipts ORDER BY id').all()).results
    const future=Date.parse(originals.at(-1).uploadedAt)+86400000
    await tick(future)
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_capture_cash_drafts').first()).n,0,'off makes no drafts')
    const preview=await h.post('settings/cash-draft-window/preview',{days:1},t.morgan)
    assert.deepEqual(Object.keys(preview).sort(),['asOf','count','days','version'])
    assert.equal(preview.count,0,'new originals are not yet old; private filenames and identities never reach finance')
    await h.post('settings/cash-draft-window',{...preview,count:1},t.morgan,409)
    await h.post('settings/cash-draft-window',{...preview,asOf:'2000-01-01T00:00:00.000Z'},t.morgan,409)
    await h.post('settings/cash-draft-window',preview,t.sam,403)
    const cross=await h.send('/api/coaster/settings/cash-draft-window',preview,t.morgan,{origin:'https://outside.example'})
    assert.equal(cross.status,403)
    await h.post('settings/cash-draft-window',preview,t.morgan)
    await h.post('settings/cash-draft-window',preview,t.morgan,409,'stale version')
    await tick(Date.parse(originals[0].uploadedAt)+86400000-1)
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_capture_cash_drafts').first()).n,0,'inclusive eligibility starts only after a full elapsed day')
    const messages=h.messages.length
    await tick(future)
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_capture_cash_drafts').first()).n,25,'one delivery prepares at most 25 drafts')
    await Promise.all([tick(future),tick(future)])
    const drafted=(await h.db.prepare('SELECT * FROM c_capture_cash_drafts ORDER BY receipt_id').all()).results
    assert.ok(drafted.length>=25&&drafted.length<=27,'each delivery is bounded, concurrent deliveries cannot duplicate an original')
    await tick(future)
    const all=(await h.db.prepare('SELECT * FROM c_capture_cash_drafts ORDER BY receipt_id').all()).results
    assert.equal(all.length,27)
    assert.ok(all.some(d=>d.receipt_id===originals.at(-1).id),'a receipt exactly at the elapsed-day cutoff is included')
    assert.ok(!all.some(d=>[discarded.id,merged.id].includes(d.receipt_id)))
    for(const draft of all){
      const original=originals.find(o=>o.id===draft.receipt_id)
      assert.equal(draft.expense_date,original.uploadedAt.slice(0,10))
      const detail=await h.get(`claims/${draft.claim_id}`,t.sam)
      assert.equal(detail.claim.status,'draft');assert.equal(detail.claim.total_minor,0);assert.equal(detail.claim.auto_key,null)
      assert.deepEqual(detail.items,[],'no amount or receipt content is invented')
      assert.equal(detail.events[0].actor_email,'automation: cash-draft window')
      const audit=await h.get('history?q='+encodeURIComponent('CL-'+String(detail.claim.number).padStart(4,'0')))
      assert.equal(audit.lines.find(e=>e.action==='cash-draft-created').channel,'schedule')
      assert.deepEqual(detail.events[0].detail,{state:'needs-details'})
      await h.get(`claims/${draft.claim_id}`,t.morgan,403)
      await h.post(`claims/${draft.claim_id}/submit`,{version:detail.claim.version},t.sam,400)
    }
    await tick(future+86400000)
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_capture_cash_drafts').first()).n,27)
    assert.equal(h.messages.length,messages,'no receipt or suspicion notification is sent')
    assert.deepEqual((await h.db.prepare('SELECT * FROM c_capture_receipts ORDER BY id').all()).results,before,'original evidence never changes')
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_receipts').first()).n,0,'no duplicate BLOB copy')
    const bucket=await h.mf.getR2Bucket('COASTER_RECEIPTS')
    assert.equal((await bucket.list()).objects.length,29,'R2 stores each original once')
    const inbox=await h.get('receipt-inbox',t.sam)
    assert.equal(inbox.receipts.filter(r=>r.cashDraft).length,27)
    assert.deepEqual((await download(h,t.sam,originals[2].id)).bytes,png)
    await assert.rejects(h.db.prepare('DELETE FROM c_capture_cash_drafts').run(),/permanent/)
    await assert.rejects(h.db.prepare("UPDATE c_capture_cash_drafts SET expense_date='2000-01-01'").run(),/permanent/)
    const off=await h.post('settings/cash-draft-window/preview',{days:null},t.morgan)
    await h.post('settings/cash-draft-window',off,t.morgan)
    await upload(h,t.sam,'off-again.png',png);await tick(future+10*86400000)
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_capture_cash_drafts').first()).n,27)
  } finally { await h.close() }
})
