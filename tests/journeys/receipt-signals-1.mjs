// Assertion phases used by the surviving public-door journey.
import assert from 'node:assert/strict'
import {deflateSync} from 'node:zlib'
import {decode as decodePng,encode as encodePng} from 'fast-png'
import {encode as encodeWebp} from '@stacksjs/ts-webp'
import {PDFDocument} from 'pdf-lib'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {harness,agency} from '../harness.mjs'
import {imageSignalCases,patternSignalCases,cardSignalCases,addSignalExpense} from '../receipt-signal-scenarios.mjs'
import {croppedCopy} from '../fixtures/receipt-image-variants.mjs'
import {makeReceipt,addTextMetadata} from '../fixtures/receipt-metadata.mjs'

const corpus=JSON.parse(await readFile('tests/fixtures/receipt-metadata-clean.json','utf8'))
const splitCategory=results=>results.flatMap(r=>r.signals).find(s=>s.code==='split-charge').evidence.category
const upload=async(h,who,claim,record,bytes=makeReceipt(record))=>{
 const r=await h.post(`claims/${claim.id}/receipts`,{version:claim.version,name:record.id+'.'+(record.ext??'png'),base64:bytes.toString('base64')},who)
 return h.post(`claims/${claim.id}/items`,{version:r.claim.version,kind:'receipt',date:record.date,merchant:record.merchant,amount:String(record.amount),receipt:r.receipt,allocations:[{category:record.category}]},who)
}

export async function preserveReceiptSignals1() {
  // POLICY-002 metadata signals name computable software/date evidence, never gate reimbursement, and finance records a human reason without changing the frozen evidence
  await (async()=>{
 const h=await harness();try{
 const t=await agency(h),record={...corpus[0],id:'EDITED-POSSIBLE',category:t.c.office,merchant:'Harbour stationery',amount:40,software:'Adobe Photoshop 2026',imageDate:'2026-06-19',date:'2026-06-16'}
 const bytes=makeReceipt(record)
 let c=await h.post('claims',{title:'Possible metadata edit'},t.sam)
 c=await upload(h,t.sam,c,record,bytes)
 await h.post('settings/approval-rule',{enabled:true,limit:'100'})
 c=await h.post(`claims/${c.id}/submit`,{version:c.version},t.sam)
 assert.equal(c.status,'approved','a metadata flag does not prevent the existing owner rule from approving')
 const detail=await h.get(`claims/${c.id}`,t.morgan),evidence=detail.revisions[0].snapshot.receiptSignals[0]
 assert.deepEqual(detail.exceptions,[],'metadata signals never become submission-blocking policy exceptions')
 assert.deepEqual(evidence.signals.map(s=>s.code),['editing-software','image-date-mismatch'])
 assert.ok(evidence.signals.every(s=>s.label==='possible, needs review'))
 assert.match(evidence.signals[0].reason,/Adobe Photoshop/)
 assert.match(evidence.signals[1].reason,/2026-06-19.*2026-06-16/)
 assert.match(evidence.signals[1].reason,/Later photographs can be legitimate/)
 assert.equal(evidence.sha256,createHash('sha256').update(bytes).digest('hex'))
 assert.equal(evidence.fields.software,record.software)
 assert.equal(evidence.image.status,'checked',JSON.stringify(evidence.image))
 const body={revision:1,item:evidence.item,code:'editing-software',note:'Legitimate supplier preparation; finance reviewed the original.'}
 const review=()=>h.post(`claims/${c.id}/receipt-signals/review`,body,t.morgan)
 for(const cookie of [t.sam,t.priya])await h.post(`claims/${c.id}/receipt-signals/review`,body,cookie,403)
 await h.get(`claims/${c.id}`,t.alex,403)
 let batch=await h.post('batches',{claims:[c.id]},t.morgan)
 batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:4000},t.morgan)
 await h.paid(batch.id,batch.version,{reference:'EXTERNAL-PAID',paidOn:'2026-06-20'},t.morgan)
 assert.equal((await h.get(`claims/${c.id}`,t.sam)).claim.status,'reimbursed','unresolved metadata signals never delay a person-released payment')
 await review();await h.post(`claims/${c.id}/receipt-signals/review`,body,t.morgan,409)
 const after=await h.get(`claims/${c.id}`,t.morgan)
 assert.deepEqual(after.revisions[0].snapshot.receiptSignals[0],evidence)
 assert.equal(after.claim.status,'reimbursed')
 const resolved=after.events.find(e=>e.action==='receipt-signal-reviewed')
 assert.equal(resolved.actor_email,'morgan@harbourfinch.example');assert.equal(resolved.detail.note,body.note)
 assert.equal(resolved.detail.reason,evidence.signals[0].reason)
 // Real little- and big-endian TIFF IFDs in a JPEG identify only their actual metadata.
 const jpeg=await readFile('tests/fixtures/receipts/report-bistro.jpg')
 for(const little of [true,false]){
  let image=await h.post('claims',{title:'Exif '+little},t.alex)
  image=await upload(h,t.alex,image,{...record,id:'EXIF-'+little,ext:'jpg',merchant:'JPEG supplier '+little},withExif(jpeg,{little}))
  image=await h.post(`claims/${image.id}/submit`,{version:image.version},t.alex)
  const result=(await h.get(`claims/${image.id}`,t.morgan)).revisions[0].snapshot.receiptSignals[0]
  assert.equal(result.fields.software,'GIMP 3.0');assert.equal(result.fields.dateTimeOriginal,'2026:06:19 12:00:00')
  assert.deepEqual(result.signals.filter(s=>['editing-software','image-date-mismatch'].includes(s.code)).map(s=>s.code),['editing-software','image-date-mismatch'])
 }
 // Stripped metadata, arbitrary trailing text and a damaged metadata chunk never invent a flag.
 const stripped=makeReceipt({...record,software:undefined,imageDate:undefined}),damaged=addTextMetadata(stripped,'Software','Adobe Photoshop');damaged[damaged.indexOf(Buffer.from('tEXt'))+8]^=1
 for(const [index,clean] of [stripped,Buffer.concat([stripped,Buffer.from('Software Adobe Photoshop')]),damaged].entries()){
  let plain=await h.post('claims',{title:'No metadata '+index},t.alex)
  plain=await upload(h,t.alex,plain,{...record,id:'NO-META-'+index,merchant:'Unflagged merchant '+index},clean)
  plain=await h.post(`claims/${plain.id}/submit`,{version:plain.version},t.alex)
  const observed=(await h.get(`claims/${plain.id}`,t.morgan)).revisions[0].snapshot.receiptSignals[0]
  assert.equal(observed.status,'no metadata to check');assert.deepEqual(observed.signals.filter(s=>['editing-software','image-date-mismatch'].includes(s.code)),[])
  if(index===1)assert.ok(observed.signals.some(s=>s.code==='near-duplicate-image'),'the same pixels with different metadata still raise the image comparison')
 }
 // Every named editor is detected from actual supported metadata, without an accusation.
 for(const [index,software] of ['Affinity Photo 2','Pixelmator Pro'].entries()) {
  let edited=await h.post('claims',{title:software},t.alex)
  edited=await upload(h,t.alex,edited,{...record,id:'synthetic-coaster-'+(610+index),merchant:software,software,imageDate:undefined})
  edited=await h.post(`claims/${edited.id}/submit`,{version:edited.version},t.alex)
  const result=(await h.get(`claims/${edited.id}`,t.morgan)).revisions[0].snapshot.receiptSignals[0]
  assert.equal(result.fields.software,software)
  const signal=result.signals.find(s=>s.code==='editing-software')
  assert.equal(signal.label,'possible, needs review');assert.ok(signal.reason.includes(software))
 }
 // Valid zTXt and XMP containers are deliberately outside the metadata reader.
 const chunk=(type,payload)=>{const bytes=Buffer.concat([Buffer.from(type),payload]);let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}const out=Buffer.alloc(payload.length+12);out.writeUInt32BE(payload.length);bytes.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out}
 const xmp='<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Adobe Photoshop"/></rdf:RDF></x:xmpmeta>'
 const compressed=Buffer.concat([stripped.subarray(0,-12),chunk('zTXt',Buffer.concat([Buffer.from('Software\0\0'),deflateSync('Adobe Photoshop')])),stripped.subarray(-12)])
 const pngXmp=addTextMetadata(stripped,'XML:com.adobe.xmp',xmp)
 const payload=Buffer.from('http://ns.adobe.com/xap/1.0/\0'+xmp),length=Buffer.alloc(2);length.writeUInt16BE(payload.length+2)
 const jpegXmp=Buffer.concat([jpeg.subarray(0,2),Buffer.from([255,225]),length,payload,jpeg.subarray(2)])
 for(const [index,bytes] of [compressed,pngXmp,jpegXmp].entries()) {
  let unchecked=await h.post('claims',{title:'Unchecked metadata '+index},t.alex)
  unchecked=await upload(h,t.alex,unchecked,{...record,id:'synthetic-coaster-'+(620+index),merchant:'Unchecked '+index,ext:index===2?'jpg':'png'},bytes)
  unchecked=await h.post(`claims/${unchecked.id}/submit`,{version:unchecked.version},t.alex)
  const observed=(await h.get(`claims/${unchecked.id}`,t.morgan)).revisions[0].snapshot.receiptSignals[0]
  assert.equal(observed.status,'no metadata to check');assert.deepEqual(observed.fields,{})
  assert.equal(observed.image.status,'checked','ignored metadata does not disable pixel inspection')
  assert.deepEqual(observed.signals.filter(s=>['editing-software','image-date-mismatch'].includes(s.code)),[])
 }
 }finally{await h.close()}
})()
  // POLICY-002 exact, cropped, photographed and visibly changed receipts name comparative evidence across employees
  await (async()=>{
 const h=await harness();try {
  const t=await agency(h)
  await imageSignalCases(h,t)
  // Exercise actual raster decoders and safe refusals through native upload/submission.
  const record={...corpus[0],id:'synthetic-coaster-630',category:t.c.office,software:undefined,imageDate:undefined},png=makeReceipt(record),decoded=decodePng(png)
  const rgba=Uint8Array.from({length:decoded.width*decoded.height*4},(_,i)=>i%4===3?255:decoded.data[Math.floor(i/4)])
  const webp=Buffer.from(encodeWebp({width:decoded.width,height:decoded.height,data:rgba},{backend:'pure-ts',lossless:true}))
  const blank=Buffer.from(encodePng({width:32,height:32,data:new Uint8Array(32*32).fill(255),channels:1,depth:8}))
  const oversized=Buffer.from(png);oversized.writeUInt32BE(6000,16);oversized.writeUInt32BE(4001,20)
  const pdf=await PDFDocument.create();pdf.addPage();pdf.setProducer('Adobe Photoshop')
  const cases=[
   ['webp',webp,'checked',undefined,'unsupported'],
   ['heic',await readFile('tests/fixtures/receipts/report-bistro.heic'),'checked',undefined,'unsupported'],
   ['png',png.subarray(0,25),'corrupt',/could not be decoded/,'no metadata to check'],
   ['png',blank,'limited',/Insufficient separable receipt ink/,'no metadata to check'],
   ['png',oversized,'limited',/24 megapixel/,'no metadata to check'],
   ['heic',await readFile('tests/fixtures/receipts/report-oversized.heic'),'limited',/24 megapixel/,'unsupported'],
   ['pdf',Buffer.from(await pdf.save()),'unsupported',/supports JPEG, PNG, WebP and single-image HEIC/,'unsupported'],
  ]
  for(const [index,[ext,bytes,status,reason,metadata]] of cases.entries()) {
   let c=await h.post('claims',{title:'Inspection status '+index},t.sam)
   c=await upload(h,t.sam,c,{...record,id:'synthetic-coaster-'+(630+index),ext,merchant:'Inspection '+index},bytes)
   c=await h.post(`claims/${c.id}/submit`,{version:c.version},t.sam)
   const result=(await h.get(`claims/${c.id}`,t.morgan)).revisions[0].snapshot.receiptSignals[0]
   assert.equal(result.image.status,status,JSON.stringify(result.image));if(reason)assert.match(result.image.reason,reason)
   assert.equal(result.status,metadata);assert.deepEqual(result.fields,{})
   assert.deepEqual(result.signals.filter(s=>['editing-software','image-date-mismatch'].includes(s.code)),[])
   assert.equal(result.sha256,createHash('sha256').update(bytes).digest('hex'))
   if(status!=='checked')assert.deepEqual(result.signals.filter(s=>['near-duplicate-image','image-content-change','compression-grid'].includes(s.code)),[])
  }
 }finally{await h.close()}
})()
  // POLICY-002 split and round/weekend patterns enter the finance queue and reviewed reasons never gate reimbursement
  await (async()=>{
 const h=await harness();try {
  const t=await agency(h),{claim:c,results}=await patternSignalCases(h,t)
  const queue=await h.get('exceptions',t.morgan),signals=queue.open.filter(x=>x.signal&&x.claim===c.id)
  assert.ok(signals.length>=4)
  assert.ok(signals.every(s=>s.message&&s.evidence))
  const target=signals.find(s=>s.code==='split-charge'),frozen=JSON.stringify(results)
  const review={claim:c.id,revision:c.revision,item:target.item,code:target.code,note:'Legitimate separate equipment purchases; original supplier records checked.'}
  await h.post('exceptions/review',review,t.sam,403)
  await h.post('exceptions/review',{...review,note:''},t.morgan,400)
  const reviewed=await h.post('exceptions/review',review,t.morgan)
  assert.ok(!reviewed.open.some(s=>s.claim===c.id&&s.item===target.item&&s.code===target.code))
  await h.post('exceptions/review',review,t.morgan,409)
  let approved=await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved',acknowledge:true},t.priya)
  let batch=await h.post('batches',{claims:[c.id]},t.morgan)
  batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:approved.total_minor},t.morgan)
  await h.paid(batch.id,batch.version,{reference:'synthetic-coaster-401',paidOn:'2026-06-20'},t.morgan)
  const after=await h.get(`claims/${c.id}`,t.morgan)
  assert.equal(after.claim.status,'reimbursed');assert.equal(JSON.stringify(after.revisions.at(-1).snapshot.receiptSignals),frozen)
  assert.equal(after.events.find(e=>e.action==='receipt-signal-reviewed').detail.note,review.note)
  assert.ok((await h.get('exceptions',t.morgan)).open.some(s=>s.signal&&s.claim===c.id),'other unresolved signals survive payment')
  const category=splitCategory(results)
  let later=await h.post('claims',{title:'Purchase reported separately'},t.sam)
  const record={...corpus[0],id:'SYNTHETIC-COASTER-403',merchant:'Equipment House',amount:480,date:'2026-06-16',category,explanation:'A separate purchase, submitted on its own report'}
  later=await addSignalExpense(h,t.sam,later,record,makeReceipt(record))
  later=await h.post(`claims/${later.id}/submit`,{version:later.version},t.sam)
  const extra=(await h.get(`claims/${later.id}`,t.morgan)).revisions[0].snapshot.receiptSignals[0].signals.find(s=>s.code==='split-charge')
  assert.equal(extra.evidence.purchases.length,3,'the detector crosses submitted claims while earlier observations stay frozen')
  // Attendee sharing excludes a purchase even when its dates/amounts would trigger every pattern.
  const attendees=[{kind:'employee',name:'sam',email:'sam@harbourfinch.example'},{kind:'guest',name:'synthetic-coaster-650'}]
  let shared=await h.post('claims',{title:'Legitimate shared purchases and isolated spend'},t.sam)
  const legitimate=[
   ...['2026-06-06','2026-06-07','2026-06-13','2026-06-13'].map((date,i)=>({merchant:'Shared equipment',date,amount:i===3?470:480,attendees})),
   {merchant:'Isolated weekend',date:'2026-06-06',amount:100},
   ...['2026-04-04','2026-05-02','2026-06-06'].map(date=>({merchant:'Monthly subscription',date,amount:100})),
  ]
  for(const [i,r] of legitimate.entries())shared=await addSignalExpense(h,t.sam,shared,{...corpus[0],...r,id:'synthetic-coaster-'+(650+i),category,explanation:'Reviewed business purpose'})
  shared=await h.post(`claims/${shared.id}/submit`,{version:shared.version},t.sam)
  const clean=(await h.get(`claims/${shared.id}`,t.morgan)).revisions[0].snapshot.receiptSignals
  assert.equal(clean.length,legitimate.length)
  for(const r of clean)assert.deepEqual(r.signals.filter(s=>['split-charge','round-amount-pattern','weekend-pattern'].includes(s.code)),[])
  // Freeze both initial observations, keep only approved expenses, then change the held original.
  let part=await h.post('claims',{title:'Review only the kept observations'},t.alex)
  const heldRecord={...corpus[0],id:'synthetic-coaster-670',category:t.c.office,merchant:'Held supplier',software:'Affinity Photo 2',imageDate:undefined}
  part=await upload(h,t.alex,part,heldRecord)
  part=await upload(h,t.alex,part,{...heldRecord,id:'synthetic-coaster-671',merchant:'Kept supplier',software:'Pixelmator Pro'})
  part=await h.post(`claims/${part.id}/submit`,{version:part.version},t.alex)
  const before=(await h.get(`claims/${part.id}`,t.morgan)).revisions[0].snapshot.receiptSignals
  const heldItem=before[0].item
  part=await h.post(`claims/${part.id}/decision`,{version:part.version,revision:part.revision,decision:'approved',acknowledge:true,hold:[heldItem],reason:'Confirm supplier original'},t.priya)
  const kept=await h.get(`claims/${part.id}`,t.morgan)
  assert.deepEqual(kept.revisions[0].snapshot.receiptSignals,before,'the original revision remains frozen')
  assert.deepEqual(kept.revisions[1].snapshot.receiptSignals,[before[1]],'partial approval retains exactly the kept observations')
  const heldId=kept.revisions[1].snapshot.split.heldClaim
  let held=(await h.get(`claims/${heldId}`,t.alex)).claim
  const corrected=makeReceipt({...heldRecord,id:'synthetic-coaster-672',software:undefined})
  const replacement=await h.post(`claims/${heldId}/receipts`,{version:held.version,name:'synthetic-coaster-672.png',base64:corrected.toString('base64')},t.alex)
  held=await h.post(`claims/${heldId}/items`,{version:replacement.claim.version,item:heldItem,kind:'receipt',date:heldRecord.date,merchant:heldRecord.merchant,amount:String(heldRecord.amount),receipt:replacement.receipt,category:t.c.office},t.alex)
  await h.post(`claims/${heldId}/release`,{version:held.version,reason:'Corrected original checked',acknowledge:true},t.priya)
  const released=(await h.get(`claims/${heldId}`,t.morgan)).revisions[0].snapshot.receiptSignals
  assert.equal(released.length,1);assert.equal(released[0].item,heldItem)
  assert.equal(released[0].sha256,createHash('sha256').update(corrected).digest('hex'))
  assert.notEqual(released[0].sha256,before[0].sha256);assert.equal(released[0].status,'no metadata to check')
  assert.equal(released[0].image.status,'checked');assert.ok(!released[0].signals.some(s=>s.code==='editing-software'))
  assert.deepEqual((await h.get(`claims/${part.id}`,t.morgan)).revisions[0].snapshot.receiptSignals,before)

 }finally{await h.close()}
})()
  // POLICY-002 matched receipt and posted card differences show entered totals, tip and FX context without blocking approval
  await (async()=>{
 const h=await harness();try {
  const t=await agency(h)
  const privateRecord={...corpus[0],id:'synthetic-coaster-680',merchant:'Private supplier',employee:'sam@harbourfinch.example',software:'Pixelmator Pro',imageDate:'2026-06-19'},privateBytes=makeReceipt(privateRecord)
  const form=new FormData();form.append('file',new Blob([privateBytes]),'synthetic-coaster-680.png')
  const request=new Request(h.origin+'/api/coaster/receipt-inbox',{method:'POST',headers:{origin:h.origin,cookie:t.sam},body:form})
  const response=await h.mf.dispatchFetch(request.url,{method:'POST',headers:Object.fromEntries(request.headers),body:await request.arrayBuffer()})
  assert.equal(response.status,200);const original=(await response.json()).receipt
  let unrelated=await h.post('claims',{title:'Public purchase with no private comparison'},t.alex)
  unrelated=await upload(h,t.alex,unrelated,{...privateRecord,category:t.c.office,id:'synthetic-coaster-681'},croppedCopy(makeReceipt({...privateRecord,software:undefined,imageDate:undefined})))
  unrelated=await h.post(`claims/${unrelated.id}/submit`,{version:unrelated.version},t.alex)
  const published=await h.get(`claims/${unrelated.id}`,t.morgan)
  assert.deepEqual(published.revisions[0].snapshot.receiptSignals[0].signals,[],'a similar unmatched private original supplies no comparison or metadata evidence')
  const hidden=[original.id,original.sha256,original.name,'Pixelmator Pro']
  const privateFree=value=>{const text=JSON.stringify(value);for(const token of hidden)assert.ok(!text.includes(token),'unmatched private data leaked')}
  for(const who of [h.owner,t.morgan,t.priya]){
   privateFree(await h.get('state',who));privateFree(await h.get(`claims/${unrelated.id}`,who))
   if(who===t.priya)await h.get('exceptions',who,403);else privateFree(await h.get('exceptions',who))
   if(who===t.priya)await h.get('history',who,403);else privateFree(await h.get('history',who))
  }
  privateFree(h.messages)
  const {claim}=await cardSignalCases(h,t,{
   async upload(bytes,name,who) {
    const form=new FormData();form.append('file',new Blob([bytes]),name)
    const request=new Request(h.origin+'/api/coaster/receipt-inbox',{method:'POST',headers:{origin:h.origin,cookie:who},body:form})
    const response=await h.mf.dispatchFetch(request.url,{method:'POST',headers:Object.fromEntries(request.headers),body:await request.arrayBuffer()})
    assert.equal(response.status,200);return (await response.json()).receipt
   },
   tick:async()=> (await h.mf.getWorker()).scheduled({scheduledTime:Date.now(),cron:'17 * * * *'})
  })
  let c=claim
  c=await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved'},t.priya)
  assert.equal(c.status,'approved');assert.equal(c.total_minor,0,'company-card charge remains non-reimbursable')
 }finally{await h.close()}
})()
}

// Genuine APP1 Exif segment inserted before the JPEG's original segments.
function withExif(jpeg,{software='GIMP 3.0',original='2026:06:19 12:00:00',little=true}={}){
 const strings=[Buffer.from(software+'\0','ascii'),Buffer.from(original+'\0','ascii')]
 const child=38,start=56,tiff=Buffer.alloc(start+strings[0].length+strings[1].length)
 const short=(p,v)=>little?tiff.writeUInt16LE(v,p):tiff.writeUInt16BE(v,p)
 const long=(p,v)=>little?tiff.writeUInt32LE(v,p):tiff.writeUInt32BE(v,p)
 tiff.write(little?'II':'MM',0);short(2,42);long(4,8);short(8,2)
 short(10,0x0131);short(12,2);long(14,strings[0].length);long(18,start)
 short(22,0x8769);short(24,4);long(26,1);long(30,child)
 short(child,1);short(child+2,0x9003);short(child+4,2);long(child+6,strings[1].length);long(child+10,start+strings[0].length)
 strings[0].copy(tiff,start);strings[1].copy(tiff,start+strings[0].length)
 const payload=Buffer.concat([Buffer.from('Exif\0\0','ascii'),tiff]),header=Buffer.alloc(4)
 header[0]=255;header[1]=0xe1;header.writeUInt16BE(payload.length+2,2)
 return Buffer.concat([jpeg.subarray(0,2),header,payload,jpeg.subarray(2)])
}
