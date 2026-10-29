import { preserveCardReporting1 } from './journeys/card-reporting-1.mjs'
// FEED-004 combined statement-to-receipt journey; only ECB is faked at the provider edge.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { crc32 } from 'node:zlib'
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { agency, harness } from './harness.mjs'

const NOTICE = "When this receipt matches one of your card charges, Coaster attaches it automatically. Approvers and finance can see the receipt, its file name and the total, currency and date you entered once that expense is submitted — by you, your delegate or the owner's scheduled submission."
const tick = async h => (await h.mf.getWorker()).scheduled({scheduledTime:Date.now(),cron:'17 * * * *'})

const decode = stream => Buffer.from(decodePDFRawStream(stream).decode()).toString('utf8')
function pageText(document, page) {
  const fonts = page.node.Resources().lookup(PDFName.of('Font'), PDFDict), characters = new Map()
  for (const name of fonts.keys()) {
    const font = fonts.lookup(name, PDFDict), map = font.lookup(PDFName.of('ToUnicode'))
    if (!(map instanceof PDFRawStream)) continue
    for (const [, glyph, codes] of decode(map).matchAll(/<([a-f\d]{4})>\s*<([a-f\d]+)>/gi)) {
      const bytes = Buffer.from(codes, 'hex')
      characters.set(glyph.toUpperCase(), Array.from({ length: bytes.length / 2 }, (_, i) => String.fromCharCode(bytes.readUInt16BE(i * 2))).join(''))
    }
  }
  const contents = page.node.Contents(), streams = contents instanceof PDFArray ? contents.asArray().map(ref => document.context.lookup(ref)) : [contents]
  return streams.filter(s => s instanceof PDFRawStream).flatMap(s => [...decode(s).matchAll(/<([a-f\d]+)>\s*Tj/gi)].map(([, text]) => (text.match(/.{4}/g) || []).map(code => characters.get(code.toUpperCase()) || '').join(''))).join('\n')
}

function auditFiles(bytes) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length),files={};let end=bytes.length-22
  while(view.getUint32(end,true)!==0x06054b50)end--
  let at=view.getUint32(end+16,true)
  for(let n=view.getUint16(end+10,true);n>0;n--) {
    const size=view.getUint32(at+20,true),length=view.getUint16(at+28,true),offset=view.getUint32(at+42,true)
    const start=offset+30+view.getUint16(offset+26,true)+view.getUint16(offset+28,true),data=bytes.subarray(start,start+size)
    assert.equal(crc32(data),view.getUint32(at+16,true))
    files[bytes.subarray(at+46,at+46+length).toString()]=data
    at+=46+length+view.getUint16(at+30,true)+view.getUint16(at+32,true)
  }
  return files
}

test('FEED-004 twenty posted USD charges and opted-in originals yield eighteen automatic matches, two questions, a human answer, permanent undo and exported EUR basis', async () => {
  await preserveCardReporting1()
  await (async()=>{
  const h=await harness({fxRates:'<Cube><Cube time="2026-10-02"><Cube currency="USD" rate="1.1"/></Cube></Cube>'})
  try {
    const t=await agency(h)
    await h.post('settings/business',{name:'Harbour & Finch US',currency:'USD',timezone:'America/Chicago',perDiem:'75.00',receiptThreshold:'',fxEnabled:true})
    const issuer='Synthetic Juniper corporate card'
    await h.post('statements/cards',{issuer,last4:'1111',employee:'sam@harbourfinch.example'})
    const cases=[
      ...Array.from({length:16},(_,i)=>({merchant:`Stationer${i+1}`,amount:(10+i).toFixed(2),total:(10+i).toFixed(2),currency:'USD'})),
      {merchant:'Harbour Bistro',amount:'48.00',total:'40.00',currency:'USD'},
      {merchant:'Paris Taxi',amount:'90.00',total:'80.00',currency:'EUR'},
      {merchant:'Eastern Kiosk',amount:'200.00',total:'200.00',currency:'USD'},
      {merchant:'Western Newsstand',amount:'200.00',total:'200.00',currency:'USD'},
    ]
    const source=await readFile('tests/fixtures/receipts/bistro.png'),originals=[]
    // Distinct retained originals model separate synthetic receipts, rather than twenty aliases of one file.
    for(const [index,row] of cases.entries()) {
      const bytes=Buffer.concat([source,Buffer.from(`\nSynthetic receipt ${index+1}: ${row.merchant}; 2026-10-02; ${row.currency} ${row.total}\n`)])
      const form=new FormData();form.append('file',new Blob([bytes],{type:'image/png'}),`synthetic-purchase-${index+1}.png`);form.append('source','upload')
      const request=new Request(h.origin+'/api/coaster/receipt-inbox',{method:'POST',headers:{origin:h.origin,cookie:t.sam},body:form})
      const response=await h.mf.dispatchFetch(request.url,{method:'POST',headers:Object.fromEntries(request.headers),body:await request.arrayBuffer()})
      assert.equal(response.status,200);const original=(await response.json()).receipt
      originals.push({...original,bytes})
      await h.post(`receipt-inbox/${original.id}/card-match`,{expectedSequence:original.lifecycleSequence,enabled:true,merchant:row.merchant,date:'2026-10-02',total:row.total,currency:row.currency,last4:'1111',notice:NOTICE},t.sam)
    }
    const statement={format:'csv',name:'synthetic-twenty-purchases.csv',issuer,category:t.c.office,content:'Posted,Transaction,Merchant,Amount,Id\n'+cases.map((row,index)=>`2026-10-03,2026-10-02,${row.merchant},${row.amount},synthetic-purchase-${index+1}`).join('\n'),mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Posted',transactionDate:'Transaction',description:'Merchant',amount:'Amount',transactionId:'Id',wholeFileLast4:'1111'}}
    const preview=await h.post('statements/preview',statement,t.morgan)
    assert.equal(preview.importable,20);assert.deepEqual(preview.errors,[])
    const job=await h.post('statements/commit',{...statement,fingerprint:preview.fingerprint},t.morgan)
    await tick(h)
    const postedMinor=cases.reduce((sum,row)=>sum+Math.round(Number(row.amount)*100),0)
    const range='from=2026-10-01&to=2026-10-31'
    const spend=await h.get('spend?by=card&'+range,t.morgan)
    assert.equal(spend.totalMinor,postedMinor,'posted company spend counts before an employee submits')
    const drill=await h.get('spend?by=card&'+range+'&key='+encodeURIComponent(spend.groups[0].key),t.morgan)
    assert.equal(drill.lines.length,cases.length)
    assert.ok(drill.lines.every(line=>line.receipt===null&&line.receiptLink===null),'draft originals stay private in financial reporting')
    await h.post('budgets',{name:'Company card office spend',scope:'category',scopeKey:t.c.office,period:'monthly',amount:'1000.00',owner:'priya@harbourfinch.example',thresholds:'100',policyRule:true},t.morgan)
    const budget=async()=>(await h.get('budgets?day=2026-10-31',t.morgan)).find(b=>b.name==='Company card office spend')
    assert.equal((await budget()).actualMinor,postedMinor)
    assert.equal((await h.get('reports/unsubmitted?'+range,t.morgan)).totals.amountMinor,postedMinor)
    const inbox=async()=> (await h.get('receipt-inbox',t.sam)).receipts
    let current=await inbox()
    assert.equal(current.filter(r=>r.attachment).length,18)
    assert.equal(current.filter(r=>r.lifecycle.some(l=>l.kind==='attached'&&l.channel==='schedule')).length,18)
    for(const original of originals.slice(18)) {
      const receipt=current.find(r=>r.id===original.id)
      assert.equal(receipt.attachment,null)
      const question=await h.get(`receipt-inbox/${original.id}/card-match-question`,t.sam)
      assert.equal(question.ambiguous,true);assert.equal(question.candidates.length,2)
    }
    let detail=await h.get(`claims/${job.claims[0]}`,t.sam)
    assert.equal(detail.items.length,20);assert.equal(detail.claim.total_minor,0)
    const fxItem=detail.items.find(i=>i.merchant==='Paris Taxi'),fxBasis=JSON.parse(fxItem.card_match_basis)
    assert.equal(fxItem.amount_minor,9000,'posted card amount wins over the USD 88 reference conversion')
    assert.deepEqual([fxBasis.enteredTotalMinor,fxBasis.enteredCurrency,fxBasis.fxRate,fxBasis.fxDate,fxBasis.fxSource,fxBasis.differenceMinor,fxBasis.differenceCurrency],[8000,'EUR','1.1','2026-10-02','ECB reference rates',200,'USD'])
    const tip=detail.items.find(i=>i.merchant==='Harbour Bistro'),tipBasis=JSON.parse(tip.card_match_basis)
    assert.deepEqual([tip.amount_minor,tipBasis.basis,tipBasis.enteredTotalMinor,tipBasis.differenceMinor,tipBasis.differenceCurrency],[4800,'tip',4000,800,'USD'])
    const question=await h.get(`receipt-inbox/${originals[18].id}/card-match-question`,t.sam),answer=question.candidates[0]
    await h.post(`receipt-inbox/${originals[18].id}/attach`,{expectedSequence:current.find(r=>r.id===originals[18].id).lifecycleSequence,claimId:answer.claimId,itemId:answer.itemId,version:answer.version},t.sam)
    current=await inbox()
    const answered=current.find(r=>r.id===originals[18].id)
    assert.equal(answered.lifecycle.at(-1).actorEmail,'sam@harbourfinch.example');assert.equal(answered.lifecycle.at(-1).channel,'app')
    const undone=current.find(r=>r.id===originals[0].id)
    await h.post(`receipt-inbox/${undone.id}/detach`,{expectedSequence:undone.lifecycleSequence,claimId:undone.attachment.claimId,itemId:undone.attachment.itemId,version:undone.attachment.version},t.sam)
    await tick(h)
    assert.equal((await inbox()).find(r=>r.id===undone.id).attachment,null)
    assert.deepEqual((await h.get(`receipt-inbox/${undone.id}/card-match-question`,t.sam)).candidates,[])
    // Missing originals remain explained for ordinary submission; no rule approves private work.
    detail=await h.get(`claims/${job.claims[0]}`,t.sam)
    for(const item of detail.items.filter(i=>!i.receipt_id)) {
      await h.post(`claims/${detail.claim.id}/items`,{version:detail.claim.version,item:item.id,kind:'receipt',date:item.spent_on,merchant:item.merchant,amount:(item.amount_minor/100).toFixed(2),category:t.c.office,explanation:'Distinct synthetic posted purchase; original awaits employee review'},t.sam)
      detail=await h.get(`claims/${detail.claim.id}`,t.sam)
    }
    await h.post(`claims/${detail.claim.id}/submit`,{version:detail.claim.version},t.sam)
    const submitted=await h.get(`claims/${detail.claim.id}`,t.morgan)
    assert.equal((await h.get('spend?by=card&'+range,t.morgan)).totalMinor,postedMinor,'submission never double-counts card spend')
    assert.equal((await budget()).actualMinor,postedMinor)
    assert.equal((await h.get('reports/unsubmitted?'+range,t.morgan)).totals.amountMinor,0)
    assert.deepEqual(JSON.parse(submitted.items.find(i=>i.id===fxItem.id).card_match_basis),fxBasis)
    const response=await h.mf.dispatchFetch(h.origin+'/api/coaster/audit-pack?from=2026-01-01&to=2026-12-31',{headers:{cookie:t.morgan}})
    assert.equal(response.status,200)
    const files=auditFiles(Buffer.from(await response.arrayBuffer())),manifest=JSON.parse(files['manifest.json'].toString())
    const exported=manifest.claims.find(c=>c.id===detail.claim.id).revisions[0].items.find(i=>i.id===fxItem.id)
    assert.deepEqual(exported.cardMatchBasis,fxBasis)
    const provenance=manifest.receipts.find(r=>r.id===fxItem.receipt_id)
    assert.deepEqual(files[provenance.file],originals[17].bytes,'export keeps the original EUR receipt bytes')
    const pdfResponse=await h.mf.dispatchFetch(h.origin+`/api/coaster/claims/${detail.claim.id}/pdf`,{headers:{cookie:t.morgan}})
    assert.equal(pdfResponse.status,200)
    const pdf=await PDFDocument.load(await pdfResponse.arrayBuffer()),visible=pdf.getPages().map(p=>pageText(pdf,p)).join('\n')
    for(const value of ['Matched receipt: EUR 80.00','Reference conversion: $88.00','Posted card amount: $90.00','Exchange rate: 1 EUR = 1.1 USD','Rate date: 2026-10-02','Source: ECB reference rates']) assert.ok(visible.includes(value),value)

  } finally {await h.close()}
})()
})