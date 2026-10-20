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
