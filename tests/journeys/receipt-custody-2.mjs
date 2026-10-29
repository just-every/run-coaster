// Assertion phases used by the surviving public-door journey.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { agency, harness } from '../harness.mjs'
import { captureFiles, captureFolio } from '../fixtures/capture-files.mjs'

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



const discardBody = (reason = 'Personal copy retained for the audit', expectedSequence = 0) => ({ reason, expectedSequence })
const discardPath = id => `receipt-inbox/${id}/discard`




const mergeBody = (survivorId, reason, expectedSequence = 0) => ({ survivorId, ...(reason === undefined ? {} : { reason }), expectedSequence })
const mergePath = id => `receipt-inbox/${id}/merge`

export async function preserveReceiptCustody2() {
  // CAPTURE-004 attaches and detaches one R2 original on editable purchases, preserves revisions and proves delegate and authority boundaries plus ERASURE-001 alias provenance
  await (async () => {
  const h=await harness()
  try {
    const t=await agency(h), png=await readFile('tests/fixtures/receipts/bistro.png')
    const original=await upload(h,t.sam,'private-inbox.png',png)
    let c=await h.post('claims',{title:'Client visit'},t.sam)
    c=await h.post(`claims/${c.id}/items`,{version:c.version,kind:'receipt',date:'2026-10-20',merchant:'Client lunch',amount:'42.00',category:t.c.meals},t.sam)
    let d=await h.get(`claims/${c.id}`,t.sam), item=d.items[0]
    const path=kind=>`receipt-inbox/${original.id}/${kind}`
    const body=(seq=0)=>({expectedSequence:seq,claimId:c.id,itemId:item.id,version:c.version})
    const before=await h.get('receipt-inbox',t.sam)
    await h.post(path('attach'),{...body(),extra:true},t.sam,400)
    await h.post(path('attach'),{...body(),version:0},t.sam,409)
    await h.post(path('attach'),body(),t.alex,404)
    await h.post(path('attach'),body(),t.morgan,404)
    await h.post(path('attach'),body(),h.owner,403)
    await h.post(path('attach'),body(),'',401)
    assert.equal((await h.send('/api/coaster/'+path('attach'),body(),t.sam,{origin:'https://elsewhere.example'})).status,403)
    assert.deepEqual(await h.get('receipt-inbox',t.sam),before)
    const attached=await h.post(path('attach'),body(),t.sam);c=attached.claim
    assert.deepEqual([attached.receipt.lifecycleSequence,attached.receipt.attachment.itemId],[1,item.id])
    d=await h.get(`claims/${c.id}`,t.sam);const first=d.items[0].receipt_id
    assert.equal(d.items[0].receipt_sha256,sha(png));assert.equal(d.claim.total_minor,4200)
    assert.equal((await h.db.prepare('SELECT length(bytes) n FROM c_receipts WHERE id=?').bind(first).first()).n,0)
    assert.deepEqual((await download(h,t.sam,original.id)).bytes,png)
    const file=await h.mf.dispatchFetch(`${h.origin}/api/coaster/receipts/${first}`,{headers:{cookie:t.sam}})
    assert.equal(file.status,200);assert.deepEqual(Buffer.from(await file.arrayBuffer()),png)
    await h.get(`receipts/${first}`,t.morgan,403)
    await h.post(path('attach'),body(),t.sam,409)
    await h.post(`receipt-inbox/${original.id}/discard`,{expectedSequence:1,reason:'private'},t.sam,409)
    await h.post(`claims/${c.id}/items/remove`,{version:c.version,item:item.id},t.sam,409)
    const detached=await h.post(path('detach'),body(1),t.sam);c=detached.claim
    assert.equal(detached.receipt.attachment,null)
    d=await h.get(`claims/${c.id}`,t.sam);assert.equal(d.items[0].receipt_id,null)
    await h.post(`claims/${c.id}/items`,{version:c.version,item:item.id,kind:'receipt',date:'2026-10-20',merchant:'Client lunch',amount:'42.00',category:t.c.meals,receipt:first},t.sam,409)
    for(const level of ['submit','full']){
      const grant=await h.post('delegates',{delegate:'alex@harbourfinch.example',level},t.sam), headers={'x-coaster-acting-for':SAM}
      let seq=(await h.get('receipt-inbox',t.sam)).receipts[0].lifecycleSequence
      let response=await h.send('/api/coaster/'+path('attach'),body(seq),t.alex,headers)
      assert.equal(response.status,200);c=response.value.claim
      assert.deepEqual([response.value.receipt.lifecycle.at(-1).actorEmail,response.value.receipt.lifecycle.at(-1).onBehalfOf],['alex@harbourfinch.example',SAM])
      response=await h.send('/api/coaster/'+path('detach'),body(seq+1),t.alex,headers)
      assert.equal(response.status,200);c=response.value.claim
      await h.post(`delegates/${grant.id}/revoke`,{},t.sam)
      assert.equal((await h.send('/api/coaster/'+path('attach'),body(seq+2),t.alex,headers)).status,403)
    }
    let seq=(await h.get('receipt-inbox',t.sam)).receipts[0].lifecycleSequence
    const raced=await Promise.all([h.send('/api/coaster/'+path('attach'),body(seq),t.sam),h.send('/api/coaster/'+path('attach'),body(seq),t.sam)])
    assert.deepEqual(raced.map(r=>r.status).sort(),[200,409]);c=raced.find(r=>r.status===200).value.claim
    c=await h.post(`claims/${c.id}/submit`,{version:c.version},t.sam)
    await h.post(path('detach'),body(seq+1),t.sam,409)
    d=await h.get(`claims/${c.id}`,t.morgan);const submittedAlias=d.items[0].receipt_id
    assert.equal((await h.mf.dispatchFetch(`${h.origin}/api/coaster/receipts/${submittedAlias}`,{headers:{cookie:t.morgan}})).status,200)
    c=await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'returned',reason:'Correct the purpose'},t.priya)
    c=(await h.post(path('detach'),body(seq+1),t.sam)).claim
    d=await h.get(`claims/${c.id}`,t.sam)
    assert.equal(d.revisions[0].snapshot.items[0].receipt.id,submittedAlias)
    assert.equal((await h.mf.dispatchFetch(`${h.origin}/api/coaster/receipts/${submittedAlias}`,{headers:{cookie:t.morgan}})).status,200,'submitted evidence stays visible')
    // ERASURE-001: erasing an upload/attachment delegate updates both alias and original provenance consistently.
    const erasingGrant=await h.post('delegates',{delegate:'jordan@harbourfinch.example',level:'submit'},t.sam)
    const delegateOriginal=await upload(h,t.jordan,'delegate-original.png',png,{headers:{'x-coaster-acting-for':SAM}})
    const delegatedAttach=await h.send(`/api/coaster/receipt-inbox/${delegateOriginal.id}/attach`,{expectedSequence:0,claimId:c.id,itemId:item.id,version:c.version},t.jordan,{'x-coaster-acting-for':SAM})
    assert.equal(delegatedAttach.status,200);c=delegatedAttach.value.claim
    const delegateAlias=(await h.get(`claims/${c.id}`,t.sam)).items[0].receipt_id
    await h.post(`delegates/${erasingGrant.id}/revoke`,{},t.sam)
    await h.post('settings/members',{email:'jordan@harbourfinch.example',name:'jordan',employee:true,manager:true,finance:true,active:false})
    const erased=await h.post('settings/members/erase',{email:'jordan@harbourfinch.example'})
    const afterErase=(await h.get('receipt-inbox',t.sam)).receipts.find(r=>r.id===delegateOriginal.id)
    assert.equal(afterErase.uploadedBy,erased.retained.subject)
    assert.equal(afterErase.lifecycle[0].actorEmail,erased.retained.subject)
    const erasedFile=await h.mf.dispatchFetch(`${h.origin}/api/coaster/receipts/${delegateAlias}`,{headers:{cookie:t.sam}})
    assert.equal(erasedFile.status,200);assert.deepEqual(Buffer.from(await erasedFile.arrayBuffer()),png)
    // Receipt consumers use the one R2 original, including an inbox PDF above the legacy BLOB limit.
    const folio=await captureFolio(8_000_000), large=await upload(h,t.sam,'large-folio.pdf',folio)
    let largeClaim=await h.post('claims',{title:'Hotel folio'},t.sam)
    largeClaim=await h.post(`claims/${largeClaim.id}/items`,{version:largeClaim.version,kind:'receipt',date:'2026-10-19',merchant:'Harbour Hotel',amount:'240.00',category:t.c.travel},t.sam)
    let largeDetail=await h.get(`claims/${largeClaim.id}`,t.sam)
    largeClaim=(await h.post(`receipt-inbox/${large.id}/attach`,{expectedSequence:0,claimId:largeClaim.id,itemId:largeDetail.items[0].id,version:largeClaim.version},t.sam)).claim
    largeDetail=await h.get(`claims/${largeClaim.id}`,t.sam)
    const largeFile=await h.mf.dispatchFetch(`${h.origin}/api/coaster/receipts/${largeDetail.items[0].receipt_id}`,{headers:{cookie:t.sam}})
    assert.equal(largeFile.status,200);assert.deepEqual(Buffer.from(await largeFile.arrayBuffer()),folio)
    largeClaim=await h.post(`claims/${largeClaim.id}/submit`,{version:largeClaim.version},t.sam)
    const pdf=await h.mf.dispatchFetch(`${h.origin}/api/coaster/claims/${largeClaim.id}/pdf`,{headers:{cookie:t.morgan}})
    assert.equal(pdf.status,200);assert.ok((await pdf.arrayBuffer()).byteLength>folio.length)
    const audit=await h.mf.dispatchFetch(`${h.origin}/api/coaster/audit-pack?from=2026-01-01&to=2026-12-31`,{headers:{cookie:h.owner}})
    assert.equal(audit.status,200);assert.ok((await audit.arrayBuffer()).byteLength>folio.length)
    // Attached originals are excluded from the hourly window even without a cash reservation.
    const window=await h.post('settings/cash-draft-window/preview',{days:1},t.morgan)
    await h.post('settings/cash-draft-window',window,t.morgan)
    await (await h.mf.getWorker()).scheduled({scheduledTime:Date.parse(large.uploadedAt)+86400000,cron:'17 * * * *'})
    assert.equal(await h.db.prepare('SELECT COUNT(*) n FROM c_capture_cash_drafts WHERE receipt_id=?').bind(large.id).first('n'),0)
    const bucket=await h.mf.getR2Bucket('COASTER_RECEIPTS');assert.equal((await bucket.list()).objects.length,3)
    // Existing automatic reports can use an inbox original too; their scheduler resolves R2 when freezing a revision.
    let automatic=await h.post('expenses',{kind:'receipt',date:'2026-10-18',merchant:'Office supplies',amount:'16.00',category:t.c.office},t.alex)
    const autoOriginal=await upload(h,t.alex,'automatic.png',await readFile('tests/fixtures/receipts/officeworks.png')),autoDetail=await h.get(`claims/${automatic.id}`,t.alex)
    automatic=(await h.post(`receipt-inbox/${autoOriginal.id}/attach`,{expectedSequence:0,claimId:automatic.id,itemId:autoDetail.items[0].id,version:automatic.version},t.alex)).claim
    await h.post('settings/auto-submit',{schedule:'daily'})
    await (await h.mf.getWorker()).scheduled({scheduledTime:Date.parse('2026-10-22T04:00:00Z'),cron:'17 * * * *'})
    assert.equal((await h.get(`claims/${automatic.id}`,t.alex)).claim.status,'submitted')
    assert.equal((await h.db.prepare('SELECT SUM(length(bytes)) n FROM c_receipts').first()).n,0)
    assert.ok(!JSON.stringify(await h.get('history')).includes('private-inbox.png'))
    for(const sql of ['UPDATE c_capture_lifecycle SET item_id=NULL','DELETE FROM c_capture_lifecycle'])await assert.rejects(h.db.prepare(sql).run(),/permanent|CHECK/)
    // RETAIN-001 removes the financial claim, while the private original and its attachment history remain usable.
    largeClaim=await h.post(`claims/${largeClaim.id}/decision`,{version:largeClaim.version,revision:largeClaim.revision,decision:'rejected',reason:'Not reimbursable'},t.priya)
    await h.post('settings/retention',{years:1})
    await (await h.mf.getWorker()).scheduled({scheduledTime:Date.parse('2028-10-22T04:00:00Z'),cron:'17 * * * *'})
    const proposal=(await h.get('retention')).proposal;assert.ok(proposal)
    await h.post(`retention/${proposal.id}/confirm`,{})
    await h.get(`claims/${largeClaim.id}`,t.sam,404)
    assert.deepEqual((await download(h,t.sam,large.id)).bytes,folio)
    let later=await h.post('claims',{title:'Retained original review'},t.sam)
    later=await h.post(`claims/${later.id}/items`,{version:later.version,kind:'receipt',date:'2026-10-19',merchant:'Harbour Hotel',amount:'240.00',category:t.c.travel},t.sam)
    const laterDetail=await h.get(`claims/${later.id}`,t.sam)
    await h.post(`receipt-inbox/${large.id}/attach`,{expectedSequence:1,claimId:later.id,itemId:laterDetail.items[0].id,version:later.version},t.sam)

  } finally {await h.close()}
})()
}
