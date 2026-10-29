import { preserveReceiptCustody1 } from './journeys/receipt-custody-1.mjs'
import { preserveReceiptCustody2 } from './journeys/receipt-custody-2.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { agency, harness } from './harness.mjs'
import { captureFiles } from './fixtures/capture-files.mjs'

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

test('CAPTURE-001 thirty mixed uploads retain exact originals and provenance in a private inbox, including an 8 MB three-page PDF and HEIC; one refusal leaves valid files intact', async () => {
  await preserveReceiptCustody1()
  await preserveReceiptCustody2()
  await (async () => {
  const h = await harness()
  try {
    const team = await agency(h), before = Date.now()
    const { files,oversized } = await captureFiles()
    const uploaded = []
    for (let index = 0; index < 30; index++) {
      const input = files[index], name = input.name
      const receipt = await upload(h,team.sam,name,input.bytes,{ source: index === 0 ? 'camera' : 'upload' })
      assert.ok(receipt.id, 'each successful file has an inbox identity')
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
    assert.deepEqual(inbox.receipts.map(r => [r.name,r.state,r.size,r.sha256]).sort(), uploaded.map(({ receipt }) => [receipt.name,'needs-attention',receipt.size,receipt.sha256]).sort(), 'the inbox retains every original and its processing state after the refused file')
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

    const first=uploaded[0].receipt,second=uploaded[1].receipt
    await h.post(`receipt-inbox/${first.id}/discard`,{expectedSequence:0,reason:'Private duplicate'},team.alex,404)
    const discarded=(await h.post(`receipt-inbox/${first.id}/discard`,{expectedSequence:0,reason:'Private duplicate'},team.sam)).receipt
    assert.equal(discarded.disposition,'discarded')
    await h.post(`receipt-inbox/${first.id}/discard`,{expectedSequence:1,reason:'Replay'},team.sam,409)
    assert.deepEqual((await download(h,team.sam,first.id)).bytes,uploaded[0].input.bytes)
    const duplicate=await upload(h,team.sam,'duplicate.png',uploaded[1].input.bytes)
    const merged=(await h.post(`receipt-inbox/${duplicate.id}/merge`,{expectedSequence:0,survivorId:second.id},team.sam)).receipt
    assert.equal(merged.disposition,'merged')
    let c=await h.post('claims',{title:'Private receipt to report'},team.sam)
    c=await h.post(`claims/${c.id}/items`,{version:c.version,kind:'receipt',date:'2026-06-10',merchant:'Office supplier',amount:'20.00',allocations:[{category:team.c.office}]},team.sam)
    const item=(await h.get(`claims/${c.id}`,team.sam)).items[0]
    const attached=await h.post(`receipt-inbox/${second.id}/attach`,{expectedSequence:0,claimId:c.id,itemId:item.id,version:c.version},team.sam)
    assert.ok((await h.get(`claims/${c.id}`,team.sam)).items[0].receipt_id)
    let original=(await h.get('receipt-inbox',team.sam)).receipts.find(r=>r.id===second.id)
    c=(await h.get(`claims/${c.id}`,team.sam)).claim
    await h.post(`receipt-inbox/${second.id}/detach`,{expectedSequence:original.lifecycleSequence,claimId:c.id,itemId:item.id,version:c.version},team.sam)
    assert.equal((await h.get(`claims/${c.id}`,team.sam)).items[0].receipt_id,null)

    // Email is another intake door into this same private inbox. Known senders
    // retain their exact source mail; an unknown alias needs a native proof.
    const {receiptAddress,threeMails,receiptMail,deliverMail,aliasCode}=await import('./fixtures/receipt-email.mjs')
    await h.post('settings/receipt-email',{address:receiptAddress,consent:true})
    const oldInbox=(await h.get('receipt-inbox',team.sam)).receipts
    const mailed=await threeMails(h)
    let mailReceipts=(await h.get('receipt-inbox',team.sam)).receipts.filter(r=>!oldInbox.some(old=>old.id===r.id))
    assert.equal(mailReceipts.length,3)
    for(const receipt of mailReceipts){
      const response=await h.mf.dispatchFetch(h.origin+receipt.emailSource.sourceUrl,{headers:{cookie:team.sam}})
      const source=Buffer.from(await response.arrayBuffer())
      assert.ok(mailed.originals.some(raw=>raw.equals(source)))
      await h.get('receipt-inbox/'+receipt.id+'/source',team.alex,404)
    }
    const mailCount=(await h.get('receipt-inbox',team.sam)).receipts.length
    for(const raw of mailed.originals)await deliverMail(h,raw)
    assert.equal((await h.get('receipt-inbox',team.sam)).receipts.length,mailCount,'source mail replay creates no duplicates')
    const alias='sam.receipts@example.net'
    await deliverMail(h,receiptMail({from:alias}),alias)
    assert.equal((await h.get('settings/receipt-email')).held.length,1)
    assert.equal((await h.get('receipt-inbox',team.sam)).receipts.length,mailCount)
    await h.post('settings/receipt-email/aliases',{email:alias},team.sam)
    await h.post('settings/receipt-email/aliases/confirm',{email:alias,code:aliasCode(h,alias)},team.sam)
    await deliverMail(h,receiptMail({from:alias,subject:'Confirmed alias receipt'}),alias)
    assert.equal((await h.get('receipt-inbox',team.sam)).receipts.length,mailCount+1)
    await h.post('settings/receipt-email/aliases/remove',{email:alias},team.sam)
    await deliverMail(h,receiptMail({from:alias,subject:'Revoked alias'}),alias)
    assert.equal((await h.get('receipt-inbox',team.sam)).receipts.length,mailCount+1)
    // Finance explicitly enables aging originals into empty cash drafts. Neither
    // terminal dispositions nor a repeated scheduler invent amounts or reports.
    await h.post('settings/cash-draft-window/preview',{days:1},team.sam,403)
    const preview=await h.post('settings/cash-draft-window/preview',{days:1},team.morgan)
    await h.post('settings/cash-draft-window',preview,team.morgan)
    const future=Date.now()+2*86400000,worker=await h.mf.getWorker()
    for(let i=0;i<3;i++)await worker.scheduled({scheduledTime:future,cron:'17 * * * *'})
    const aged=(await h.get('receipt-inbox',team.sam)).receipts
    assert.ok(aged.some(r=>r.cashDraft))
    assert.ok(aged.filter(r=>r.disposition!=='active').every(r=>!r.cashDraft))
    const draftIds=aged.filter(r=>r.cashDraft).map(r=>r.cashDraft.claim_id)
    assert.equal(new Set(draftIds).size,draftIds.length)
    for(const id of draftIds){const d=await h.get('claims/'+id,team.sam);assert.equal(d.claim.status,'draft');assert.equal(d.claim.total_minor,0);assert.deepEqual(d.items,[])}
    await worker.scheduled({scheduledTime:future,cron:'17 * * * *'})
    assert.deepEqual((await h.get('receipt-inbox',team.sam)).receipts.filter(r=>r.cashDraft).map(r=>r.cashDraft.claim_id),draftIds)
  } finally { await h.close() }
})()
})