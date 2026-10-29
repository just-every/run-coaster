// Assertion phases used by the surviving public-door journey.
// FEED-002 statement-file import and the FEED-004 card-expense gates, through the public HTTP API with real native
// sessions, workerd and D1. Fixtures are synthetic; no outbound request is made.
import { crc32 } from 'node:zlib'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness } from '../harness.mjs'
import { importPrivateStatements, scanStatementStorage } from '../statement-archive.mjs'

const SAM = 'sam@harbourfinch.example', ALEX = 'alex@harbourfinch.example', ISSUER = 'Synthetic Card'
const FULL = ['4111111111111111', '4111 1111 1111 1111', '5500 0000 0000 0004', '5500000000000004']
const fixture = name => readFile(`tests/fixtures/statements/${name}`, 'utf8')
const sum = (csv, column) => { const [head, ...rows] = csv.trim().split('\r\n').map(r => r.split('","').map(x => x.replace(/^"|"$/g, ''))); const i = head.indexOf(column); return Math.round(rows.reduce((n, r) => n + Number(r[i]) * 100, 0)) }
async function withAgency(run) { const h = await harness(); try { await run(h, await agency(h)) } finally { await h.close() } }
const ofx = async (extra = {}) => ({ format: 'ofx', name: 'october.ofx', issuer: ISSUER, content: await fixture('synthetic-card.ofx'), ...extra })
const edit = (h, cookie, claim, item, over = {}) => h.post(`claims/${claim.id}/items`, { version: claim.version, item: item.id, kind: 'receipt', date: item.spent_on, merchant: item.merchant, amount: (item.amount_minor / 100).toFixed(2), category: item.allocations[0].category_id, ...over }, cookie)



const NOTICE = "When this receipt matches one of your card charges, Coaster attaches it automatically. Approvers and finance can see the receipt, its file name and the total, currency and date you entered once that expense is submitted — by you, your delegate or the owner's scheduled submission."
const inbox = async(h,t,id) => (await h.get('receipt-inbox',t.sam)).receipts.find(r=>r.id===id)
async function original(h,cookie,name='private-card.png',headers={},bytes) {
  const form=new FormData();form.append('file',new Blob([bytes??await readFile('tests/fixtures/receipts/bistro.png')]),name);form.append('source','upload')
  const req=new Request(h.origin+'/api/coaster/receipt-inbox',{method:'POST',headers:{origin:h.origin,cookie,...headers},body:form})
  const r=await h.mf.dispatchFetch(req.url,{method:'POST',headers:Object.fromEntries(req.headers),body:await req.arrayBuffer()})
  assert.equal(r.status,200);return (await r.json()).receipt
}
async function choose(h,t,r,over={}) {return h.post(`receipt-inbox/${r.id}/card-match`,{expectedSequence:r.lifecycleSequence,enabled:true,merchant:'Different typed private merchant',date:'2026-10-02',total:'48.20',currency:'AUD',notice:NOTICE,...over},t.sam)}
const tick = async (h,scheduledTime=Date.now()) => (await h.mf.getWorker()).scheduled({scheduledTime,cron:'17 * * * *'})
// These matching-only probes run before the posted charges owe their first evidence reminder.
// The full hourly handler still runs, and every outbound message is counted.
const MATCHING_TIME = Date.parse('2026-10-05T02:00:00Z')
async function statement(h,t,rows,{last4='1111',employee=SAM,name='matching.csv'}={}) {
  await h.post('statements/cards',{issuer:ISSUER,last4,employee})
  const base={format:'csv',name,issuer:ISSUER,category:t.c.office,content:'Posted,Transaction,Merchant,Amount,Id,Status\n'+rows.map((r,i)=>`${r.date??'2026-10-03'},${r.transaction??'2026-10-02'},${r.merchant??'Harbour View Bistro'},${r.amount??'48.20'},${r.id??name+'-'+i},${r.status??'posted'}`).join('\n'),mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Posted',transactionDate:'Transaction',description:'Merchant',amount:'Amount',transactionId:'Id',status:'Status',wholeFileLast4:last4}}
  const preview=await h.post('statements/preview',base,t.morgan)
  assert.deepEqual(preview.errors,[])
  return preview.importable ? h.post('statements/commit',{...base,fingerprint:preview.fingerprint},t.morgan) : preview
}










// Read the actual stored ZIP returned by the public audit-pack door, verifying every CRC.
function auditFiles(bytes) {
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.length),files={};let end=bytes.length-22
  while(v.getUint32(end,true)!==0x06054b50)end--
  let at=v.getUint32(end+16,true)
  for(let n=v.getUint16(end+10,true);n>0;n--) {
    assert.equal(v.getUint32(at,true),0x02014b50)
    const size=v.getUint32(at+20,true),length=v.getUint16(at+28,true),offset=v.getUint32(at+42,true)
    const start=offset+30+v.getUint16(offset+26,true)+v.getUint16(offset+28,true),data=bytes.subarray(start,start+size)
    assert.equal(crc32(data),v.getUint32(at+16,true));files[bytes.subarray(at+46,at+46+length).toString()]=data
    at+=46+length+v.getUint16(at+30,true)+v.getUint16(at+32,true)
  }
  return files
}

export async function preserveCardCustody2() {
  // CAPTURE-004 complete role/privacy matrix: employee and both live delegates consent, private questions and originals stay private, submitted audit packs retain only ordinary provenance and frozen match basis
  await (()=>withAgency(async(h,t)=>{
  const auditor=await h.person('auditor@harbourfinch.example',{auditor:true})
  const outsider=await h.person('other-manager@harbourfinch.example',{employee:true,manager:true})
  const roles=[h.owner,t.morgan,t.priya,auditor,t.alex,outsider]
  const key=await h.post('agent-keys',{label:'synthetic-privacy-agent'},t.sam)
  const pack=async cookie=>{
    const res=await h.mf.dispatchFetch(h.origin+'/api/coaster/audit-pack?from=2026-01-01&to=2026-12-31',{headers:{cookie}})
    assert.equal(res.status,200);const files=auditFiles(Buffer.from(await res.arrayBuffer()))
    return {files,manifest:JSON.parse(files['manifest.json'].toString())}
  }
  for(const [index,level] of ['employee','submit','full'].entries()) {
    const bytes=Buffer.concat([await readFile('tests/fixtures/receipts/bistro.png'),Buffer.from(`synthetic-${level}`)])
    const r=await original(h,t.sam,`synthetic-private-${level}.png`,{},bytes),total=(48.20+index*100).toFixed(2)
    const privateMerchant=`synthetic-private-details-${level}`
    const headers=level==='employee'?{}:{'x-coaster-acting-for':SAM},cookie=level==='employee'?t.sam:t.alex
    const grant=level==='employee'?null:await h.post('delegates',{delegate:ALEX,level},t.sam)
    const choice={expectedSequence:0,enabled:true,merchant:privateMerchant,date:'2026-10-02',total,currency:'AUD',notice:NOTICE}
    const consent=await h.send(`/api/coaster/receipt-inbox/${r.id}/card-match`,choice,cookie,headers)
    assert.equal(consent.status,200)
    const privateRead=await h.send('/api/coaster/receipt-inbox',undefined,cookie,headers)
    const opted=privateRead.value.receipts.find(x=>x.id===r.id)
    assert.equal(opted.matchChoice.details.merchant,privateMerchant);assert.equal(opted.matchChoice.notice,NOTICE)
    assert.equal(opted.state,r.state);assert.deepEqual(opted.history,r.history,'typed matching details never claim receipt reading')
    assert.equal((await h.send(`/api/coaster/receipt-inbox/${r.id}`,undefined,cookie,headers)).status,200)
    const job=await statement(h,t,[{amount:total},{amount:total,id:`synthetic-tie-${level}`}],{name:`synthetic-privacy-${level}.csv`})
    await tick(h,MATCHING_TIME)
    const q=await h.send(`/api/coaster/receipt-inbox/${r.id}/card-match-question`,undefined,cookie,headers)
    assert.equal(q.value.ambiguous,true);assert.equal(q.value.candidates.length,2)
    for(const who of roles) {
      const question=await h.get(`receipt-inbox/${r.id}/card-match-question`,who)
      assert.deepEqual(question.candidates,[])
      const list=await h.send('/api/coaster/receipt-inbox',undefined,who)
      assert.ok([200,403].includes(list.status));assert.ok(!JSON.stringify(list.value).includes(r.id))
      assert.ok([403,404].includes((await h.send(`/api/coaster/receipt-inbox/${r.id}`,undefined,who)).status))
      for(const [door,body] of [['card-match',choice],['card-match-reject',{expectedSequence:1,chargeIds:q.value.candidates.map(c=>c.chargeId)}],['detach',{expectedSequence:1,claimId:job.claims[0],itemId:q.value.candidates[0].itemId,version:q.value.candidates[0].version}]])
        assert.ok([403,404].includes((await h.send(`/api/coaster/receipt-inbox/${r.id}/${door}`,body,who)).status),door)
    }
    for(const door of [`receipt-inbox/${r.id}`,`receipt-inbox/${r.id}/card-match-question`,'receipt-inbox'])
      assert.equal((await h.send('/api/coaster/'+door,undefined,'',{authorization:`Bearer ${key.token}`})).status,401)
    for(const [door,body] of [['card-match',choice],['card-match-reject',{expectedSequence:1,chargeIds:q.value.candidates.map(c=>c.chargeId)}]])
      assert.equal((await h.send(`/api/coaster/receipt-inbox/${r.id}/${door}`,body,'',{authorization:`Bearer ${key.token}`})).status,401)
    assert.equal((await h.send(`/api/coaster/receipt-inbox/${r.id}/card-match`,choice,t.sam,{origin:'https://foreign.example'})).status,403)
    // Reject one competing original rather than guessing between two charges: withdraw this choice, then opt in a
    // unique amount after a second import. The rejected question and its entered merchant remain private forever.
    const rejected=await h.send(`/api/coaster/receipt-inbox/${r.id}/card-match-reject`,{expectedSequence:1,chargeIds:q.value.candidates.map(c=>c.chargeId)},cookie,headers)
    assert.equal(rejected.status,200)
    await statement(h,t,[{amount:(Number(total)+1).toFixed(2)}],{name:`synthetic-unique-${level}.csv`})
    assert.equal((await h.send(`/api/coaster/receipt-inbox/${r.id}/card-match`,{...choice,expectedSequence:2,total:(Number(total)+1).toFixed(2)},cookie,headers)).status,200)
    const messagesBefore=h.messages.length
    await Promise.all([tick(h,MATCHING_TIME),tick(h,MATCHING_TIME)])
    let d=await h.get(`claims/${job.claims[0]}`,t.sam),item=d.items.find(i=>i.receipt_id)
    assert.ok(item);const basis=JSON.parse(item.card_match_basis)
    for(const expense of d.items.filter(i=>!i.receipt_id)) {
      await edit(h,t.sam,d.claim,expense,{explanation:'Two distinct posted transactions; original not available'})
      d=await h.get(`claims/${d.claim.id}`,t.sam)
    }
    const hidden=[r.id,r.name,r.sha256,privateMerchant,'match-details','match-rejected']
    const privateFree=value=>{const text=typeof value==='string'?value:JSON.stringify(value);for(const token of hidden)assert.ok(!text.includes(token),`private ${token} leaked`)}
    for(const who of roles) {
      await h.get(`claims/${d.claim.id}`,who,403)
      assert.equal((await h.send(`/api/coaster/receipts/${item.receipt_id}`,undefined,who)).status,403)
    }
    for(const who of [h.owner,t.morgan,auditor]) {
      privateFree(await h.get('state',who));privateFree(await h.get('history',who))
      for(const token of [r.name,r.sha256,privateMerchant])assert.deepEqual((await h.get('history?q='+encodeURIComponent(token),who)).lines,[])
      for(const name of ['aging','cycle-time','receipts','unsubmitted','exceptions'])
        privateFree(await h.get(`reports/${name}?from=2026-01-01&to=2026-12-31`,who))
      const before=await pack(who);assert.ok(!before.manifest.claims.some(c=>c.id===d.claim.id));privateFree(Buffer.concat(Object.values(before.files)).toString())
    }
    assert.equal(h.messages.length,messagesBefore,'hourly matches and questions never notify')
    // Exercise all sharing doors: person, live Submit-only delegate, owner's scheduled submission.
    if(level==='full') {
      await h.post('settings/auto-submit',{schedule:'daily'})
      await (await h.mf.getWorker()).scheduled({scheduledTime:Date.parse('2026-10-23T04:00:00Z'),cron:'17 * * * *'})
    } else {const sent=await h.send(`/api/coaster/claims/${d.claim.id}/submit`,{version:d.claim.version},cookie,headers);assert.equal(sent.status,200,JSON.stringify(sent.value))}
    d=await h.get(`claims/${d.claim.id}`,t.sam);assert.equal(d.claim.status,'submitted')
    for(const who of [h.owner,t.morgan,t.priya,auditor]) {
      const shown=await h.get(`claims/${d.claim.id}`,who)
      assert.deepEqual(JSON.parse(shown.items.find(i=>i.id===item.id).card_match_basis),basis)
      const provenance=shown.receipts.find(f=>f.id===item.receipt_id)
      assert.equal(provenance.name,r.name);assert.equal(provenance.sha256,r.sha256);assert.equal(provenance.uploaded_by,SAM)
      const file=await h.mf.dispatchFetch(`${h.origin}/api/coaster/receipts/${item.receipt_id}`,{headers:{cookie:who}})
      assert.equal(file.status,200);assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes)
      for(const token of [privateMerchant,'match-details','match-rejected'])assert.ok(!JSON.stringify(shown).includes(token))
      assert.deepEqual((await h.get(`receipt-inbox/${r.id}/card-match-question`,who)).candidates,[])
    }
    for(const who of [outsider,t.alex])await h.get(`claims/${d.claim.id}`,who,403)
    for(const who of [h.owner,t.morgan,auditor]) {
      const after=await pack(who),claim=after.manifest.claims.find(c=>c.id===d.claim.id),frozen=claim.revisions[0].items.find(i=>i.id===item.id)
      assert.deepEqual(frozen.cardMatchBasis,basis)
      assert.equal(frozen.receipt.sha256,r.sha256)
      const provenance=after.manifest.receipts.find(f=>f.id===item.receipt_id)
      assert.equal(provenance.name,r.name);assert.equal(provenance.uploadedBy,SAM)
      assert.equal(provenance.source,'upload');assert.equal(provenance.size,bytes.length);assert.equal(provenance.mediaType,'image/png');assert.equal(provenance.uploadedAt,r.uploadedAt)
      assert.deepEqual(after.files[provenance.file],bytes)
      for(const token of [privateMerchant,'match-details','match-rejected'])assert.ok(!Buffer.concat(Object.values(after.files)).toString().includes(token))
    }
    // A new receipt attached after return remains private until its own revision is submitted.
    const returned=await h.post(`claims/${d.claim.id}/decision`,{version:d.claim.version,revision:d.claim.revision,decision:'returned',reason:'synthetic-return-for-evidence'},t.priya)
    const current=await inbox(h,t,r.id)
    await h.post(`receipt-inbox/${r.id}/detach`,{expectedSequence:current.lifecycleSequence,claimId:d.claim.id,itemId:item.id,version:returned.version},t.sam)
    const replacementBytes=Buffer.concat([bytes,Buffer.from('synthetic-returned')])
    const replacement=await original(h,t.sam,`synthetic-returned-${level}.png`,{},replacementBytes)
    let editable=await h.get(`claims/${d.claim.id}`,t.sam)
    await h.post(`receipt-inbox/${replacement.id}/attach`,{expectedSequence:0,claimId:d.claim.id,itemId:item.id,version:editable.claim.version},t.sam)
    for(const who of [h.owner,t.morgan,t.priya,auditor]) {
      const shown=await h.get(`claims/${d.claim.id}`,who)
      assert.equal(shown.items.find(i=>i.id===item.id).receipt_id,null)
      assert.ok(!JSON.stringify(shown).includes(replacement.name)&&!JSON.stringify(shown).includes(replacement.sha256))
      const currentAlias=(await h.get(`claims/${d.claim.id}`,t.sam)).items.find(i=>i.id===item.id).receipt_id
      assert.equal((await h.send(`/api/coaster/receipts/${currentAlias}`,undefined,who)).status,404)
    }
    const returnedPack=await pack(auditor)
    assert.ok(!Buffer.concat(Object.values(returnedPack.files)).toString().includes(replacement.name))
    assert.ok(returnedPack.manifest.receipts.some(f=>f.id===item.receipt_id),'earlier submitted evidence is retained')
    if(grant) {
      await h.post(`delegates/${grant.id}/revoke`,{},t.sam)
      assert.equal((await h.send(`/api/coaster/receipt-inbox/${r.id}/card-match-question`,undefined,t.alex,headers)).status,403)
    }
  }
}))()
  // CAPTURE-004 FEED-004 matched basis survives partial approval and hold release, and a later company charge blocks release of a reimbursable hold
  await (()=>withAgency(async(h,t)=>{
  const r=await original(h,t.sam);await choose(h,t,r)
  const job=await statement(h,t,[{}, {amount:'20.00',merchant:'Synthetic Other'}]);await tick(h)
  let d=await h.get(`claims/${job.claims[0]}`,t.sam),matched=d.items.find(i=>i.receipt_id)
  const basis=JSON.parse(matched.card_match_basis)
  const other=d.items.find(i=>!i.receipt_id)
  await edit(h,t.sam,d.claim,other,{explanation:'Synthetic original unavailable'})
  d=await h.get(`claims/${d.claim.id}`,t.sam)
  const submitted=await h.post(`claims/${d.claim.id}/submit`,{version:d.claim.version},t.sam)
  await h.post(`claims/${d.claim.id}/decision`,{version:submitted.version,revision:submitted.revision,decision:'approved',hold:[matched.id],reason:'Synthetic charge review',acknowledge:true},t.priya)
  const held=(await h.get('state',t.sam)).claims.find(c=>c.title.endsWith('(held)'))
  assert.ok(held)
  const heldDetail=await h.get(`claims/${held.id}`,t.sam)
  assert.equal(heldDetail.claim.held_from,d.claim.id)
  assert.deepEqual(JSON.parse(heldDetail.items[0].card_match_basis),basis)
  assert.notEqual(heldDetail.items[0].receipt_id,matched.receipt_id)
  const alias=await h.db.prepare('SELECT * FROM c_receipts WHERE id=?').bind(heldDetail.items[0].receipt_id).first()
  assert.equal(alias.capture_receipt_id,r.id);assert.equal(new Uint8Array(alias.bytes).byteLength,0)
  await h.post(`claims/${held.id}/release`,{version:held.version,acknowledge:true},t.priya)
  const shown=await h.get(`claims/${held.id}`,t.morgan)
  assert.deepEqual(JSON.parse(shown.revisions[0].snapshot.items[0].card_match_basis),basis)
  const response=await h.mf.dispatchFetch(h.origin+'/api/coaster/audit-pack?from=2026-01-01&to=2026-12-31',{headers:{cookie:h.owner}})
  assert.equal(response.status,200)
  const files=auditFiles(Buffer.from(await response.arrayBuffer())),manifest=JSON.parse(files['manifest.json'].toString())
  for(const id of [d.claim.id,held.id]) {
    const item=manifest.claims.find(c=>c.id===id).revisions.flatMap(r=>r.items).find(i=>i.id===matched.id)
    assert.deepEqual(item.cardMatchBasis,basis);assert.equal(item.receipt.sha256,r.sha256)
    assert.deepEqual(files[item.receipt.file],await readFile('tests/fixtures/receipts/bistro.png'))
  }
  await tick(h)
  assert.equal((await inbox(h,t,r.id)).lifecycle.filter(e=>e.kind==='attached').length,1)
  assert.equal((await (await h.mf.getR2Bucket('COASTER_RECEIPTS')).list()).objects.length,1)
  // A manager cannot release a reimbursement hold after a statement proves the company paid it.
  let reimbursement=await h.post('claims',{title:'Office visit paid personally'},t.sam)
  reimbursement=await h.post(`claims/${reimbursement.id}/items`,{version:reimbursement.version,kind:'receipt',date:'2026-10-07',merchant:'Office depot',amount:'61.00',category:t.c.office,explanation:'Receipt pending'},t.sam)
  reimbursement=await h.post(`claims/${reimbursement.id}/items`,{version:reimbursement.version,kind:'receipt',date:'2026-10-07',merchant:'Parking',amount:'10.00',category:t.c.travel,explanation:'Meter receipt unavailable'},t.sam)
  const originalReport=await h.get(`claims/${reimbursement.id}`,t.sam),office=originalReport.items.find(i=>i.merchant==='Office depot')
  const pending=await h.post(`claims/${reimbursement.id}/submit`,{version:reimbursement.version},t.sam)
  await h.post(`claims/${reimbursement.id}/decision`,{version:pending.version,revision:pending.revision,decision:'approved',hold:[office.id],reason:'Please locate the office receipt',acknowledge:true},t.priya)
  const heldReimbursement=(await h.get('state',t.sam)).claims.find(c=>c.title==='Office visit paid personally (held)')
  await statement(h,t,[{transaction:'2026-10-07',amount:'61.00',merchant:'Office depot'}],{name:'late-office-charge.csv'})
  await h.post(`claims/${heldReimbursement.id}/release`,{version:heldReimbursement.version,acknowledge:true},t.priya,409)
  await h.post(`claims/${heldReimbursement.id}/submit`,{version:heldReimbursement.version},t.sam,409)
  const stillHeld=await h.get(`claims/${heldReimbursement.id}`,t.sam)
  assert.equal(stillHeld.claim.status,'returned');assert.equal(stillHeld.claim.version,heldReimbursement.version)
  assert.deepEqual(stillHeld.revisions,[]);assert.deepEqual(stillHeld.decisions,[])
}))()
  // FEED-005 a missing charge is added as a card expense on its statement report, a stale or unfooted statement cannot close, and the next statement opens from the previous closing balance
  await (() => withAgency(async (h, t) => {
  const CARD = '2222'
  await h.post('statements/cards', { issuer: ISSUER, last4: CARD, employee: SAM }, h.owner)
  const september = { format: 'ofx', name: 'september.ofx', issuer: ISSUER, category: t.c.office, content: await fixture('reconcile-september.ofx') }
  const early = { format: 'qfx', name: 'early.qfx', issuer: ISSUER, category: t.c.office, content: await fixture('reconcile-earlier.qfx') }
  await h.post('statements/commit', { ...early, fingerprint: (await h.post('statements/preview', early, t.morgan)).fingerprint }, t.morgan)
  await h.post('statements/commit', { ...september, fingerprint: (await h.post('statements/preview', september, t.morgan)).fingerprint }, t.morgan)
  const file = (await h.get('statements')).files.find(f => f.name === 'september.ofx'), earlyFile = (await h.get('statements')).files.find(f => f.name === 'early.qfx')
  // A wrong opening balance leaves the statement not footing: the gap is listed, cannot be resolved and blocks closing.
  const wrong = await h.post(`statements/${file.id}/reconcile`, { last4: CARD, openingBalance: '650.00' }, t.morgan)
  const gap = wrong.differences.find(d => d.kind === 'footing')
  assert.deepEqual([gap.effectMinor, gap.resolvable], [-5000, false])
  await h.post(`statements/reconciliations/${wrong.id}/resolve`, { line: 0, resolution: 'explain', note: 'x' }, t.morgan, 409)
  // Adding the missing charge creates the card expense on the card's statement report, coded as chosen, once.
  await h.post(`statements/reconciliations/${wrong.id}/resolve`, { line: 4, resolution: 'add' }, t.morgan, 400)
  const added = await h.post(`statements/reconciliations/${wrong.id}/resolve`, { line: 4, resolution: 'add', category: t.c.travel, note: 'Not the earlier charge: a second purchase' }, t.morgan)
  const statementReport = (await h.get('state', t.sam)).claims.find(c => c.title === 'Card statement · Synthetic Card ····2222 · 2026-09-30')
  const detail = await h.get(`claims/${statementReport.id}`, t.sam)
  assert.deepEqual(detail.items.map(i => i.merchant).sort(), ['Bunnings Warehouse', 'Harbour View Bistro', 'Officeworks', 'Qantas Airways']); assert.equal(detail.claim.total_minor, 0)
  assert.deepEqual([added.heldMinor, added.differences.find(d => d.line === 4).resolution.resolution], [25565, 'add'])
  assert.equal(detail.items.find(i => i.merchant === 'Bunnings Warehouse').allocations[0].category_id, t.c.travel)
  // Correcting the opening balance while the period is open balances it; the credit still needs its acknowledgement.
  const fixed = await h.post(`statements/${file.id}/reconcile`, { last4: CARD, openingBalance: '600.00' }, t.morgan)
  assert.equal(fixed.id, wrong.id); assert.deepEqual(fixed.differences.map(d => [d.kind, d.resolution?.resolution ?? null]), [['missing-charge', 'add'], ['credit', null]])
  await h.post(`statements/reconciliations/${fixed.id}/close`, {}, t.morgan, 409)
  await h.post(`statements/reconciliations/${fixed.id}/resolve`, { line: 7, resolution: 'credit', note: 'Supplier refund on the Officeworks order' }, t.morgan)
  const closed = await h.post(`statements/reconciliations/${fixed.id}/close`, {}, t.morgan)
  assert.deepEqual([closed.ledger.cardAccountMinor, closed.ledger.matches, closed.ledger.entries.length], [35265, true, 8])
  // The earlier file's own period cannot reopen once a later statement is closed, and its import can no longer be undone there.
  assert.equal((await h.post(`statements/${earlyFile.id}/reconcile`, { last4: CARD, openingBalance: '0.00', statementBalance: '0.00' }, t.morgan, 409)).error.length > 0, true)
  // A statement without a stated balance needs finance to give it, and the next period opens from the closing balance.
  const october = { format: 'csv', name: 'october.csv', issuer: ISSUER, category: t.c.office, content: 'Posted,Description,Amount\n2026-10-04,Officeworks,-30.00\n2026-10-10,Card payment,350.00\n', mapping: { dateFormat: 'YYYY-MM-DD', sign: 'purchases-negative', postedDate: 'Posted', description: 'Description', amount: 'Amount', type: undefined, wholeFileLast4: CARD } }
  const p = await h.post('statements/preview', october, t.morgan); await h.post('statements/commit', { ...october, fingerprint: p.fingerprint }, t.morgan)
  const csv = (await h.get('statements')).files.find(f => f.name === 'october.csv')
  await h.post(`statements/${csv.id}/reconcile`, { last4: CARD }, t.morgan, 400)
  const next = await h.post(`statements/${csv.id}/reconcile`, { last4: CARD, statementBalance: '35.65', openingBalance: '999.00' }, t.morgan, 400)
  assert.match(next.error, /opening balance must equal/)
}))()
  // FEED-004 a compliant $40 card charge approves independently on a mixed report while its exceptional $40 peer routes to a person and the rule version is sampled
  await (()=>withAgency(async(h,t)=>{
 await h.post('settings/business',{name:'Synthetic Coaster',currency:'USD',timezone:'America/New_York',receiptThreshold:''});
 await h.post('policy',{rules:[{kind:'blocked-merchant',merchant:'Flagged Dinner',hard:false}]},t.morgan);
 await h.post('settings/approval-rule',{enabled:true,limit:'75.00'});
 await h.post('settings/audit-sample',{percent:'100'},t.morgan);
 const lunch=await original(h,t.sam,'synthetic-coaster-6401.png',{},await readFile('tests/fixtures/policy-review/synthetic-coaster-6004.png'));
 const dinner=await original(h,t.sam,'synthetic-coaster-6402.png',{},await readFile('tests/fixtures/policy-review/synthetic-coaster-6005.png'));
 await choose(h,t,lunch,{merchant:'Lunch',date:'2026-10-02',total:'40.00',currency:'USD'});
 await choose(h,t,dinner,{merchant:'Flagged Dinner',date:'2026-10-20',total:'40.00',currency:'USD'});
 const file=await statement(h,t,[{id:'synthetic-coaster-6403',merchant:'Lunch',amount:'40.00',date:'2026-10-03',transaction:'2026-10-02'},{id:'synthetic-coaster-6404',merchant:'Flagged Dinner',amount:'40.00',date:'2026-10-21',transaction:'2026-10-20'}]);
 await Promise.all([tick(h),tick(h)]);
 let detail=await h.get(`claims/${file.claims[0]}`,t.sam);
 assert.equal(detail.claim.status,'draft');assert.deepEqual(detail.revisions,[]);assert.deepEqual(detail.decisions,[]);assert.equal((await h.get('exceptions',t.morgan)).expenseSamples.length,0);
 const flagged=detail.items.find(i=>i.merchant==='Flagged Dinner');
 const edited=await h.post(`claims/${detail.claim.id}/items`,{version:detail.claim.version,item:flagged.id,kind:'receipt',date:flagged.spent_on,merchant:flagged.merchant,amount:'40.00',receipt:flagged.receipt_id,category:t.c.office,explanation:'Finance needs to review this merchant'},t.sam);
 const claim=await h.post(`claims/${edited.id}/submit`,{version:edited.version},t.sam);
 assert.equal(claim.status,'submitted');assert.equal(claim.total_minor,0);
 detail=await h.get(`claims/${claim.id}`,t.priya);const snapshot=detail.revisions.at(-1).snapshot,approved=snapshot.expenseApprovals;
 assert.equal(approved.length,1);assert.equal(approved[0].item,detail.items.find(i=>i.merchant==='Lunch').id);assert.equal(approved[0].source,'rule');assert.equal(approved[0].actor,'rule v1');assert.equal(approved[0].sampled,true);assert.deepEqual(detail.decisions,[],'the exceptional peer still needs its assigned person');
 assert.ok(snapshot.exceptions.some(e=>e.item===flagged.id&&e.code==='blocked-merchant'));
 const samples=(await h.get('exceptions',t.morgan)).expenseSamples;assert.equal(samples.length,1);assert.equal(samples[0].item,approved[0].item);assert.equal(samples[0].amountMinor,4000);
 const finding=await h.post('audit-samples/finding',{claim:claim.id,revision:claim.revision,item:approved[0].item,outcome:'clean',finding:'Receipt, statement and coding checked'},t.morgan);assert.equal(finding.expenseSamples[0].finding.outcome,'clean');
 await h.post('audit-samples/finding',{claim:claim.id,revision:claim.revision,item:approved[0].item,outcome:'issue',finding:'Cannot overwrite an earlier finding'},t.morgan,409);
 const history=(await h.get('history?q=expense-approved-by-rule',t.morgan)).lines;assert.equal(history.length,1);assert.equal(history[0].channel,'rule');assert.equal(history[0].detail.item,approved[0].item);assert.equal(history[0].detail.version,1);
 const complete=await h.post(`claims/${claim.id}/decision`,{version:claim.version,revision:claim.revision,decision:'approved',acknowledge:true},t.priya);assert.equal(complete.status,'approved');
 await h.post('settings/approval-rule',{enabled:false});const after=await h.get(`claims/${claim.id}`,t.morgan);assert.deepEqual(after.revisions[0].snapshot,snapshot);assert.equal(after.decisions.length,1);assert.equal(after.decisions[0].actor_email,SAM.replace('sam','priya'));assert.equal(after.claim.total_minor,0);
 await h.post('batches',{claims:[claim.id]},t.morgan,409);
}))()
}
