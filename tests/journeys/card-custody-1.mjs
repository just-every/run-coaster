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

export async function preserveCardCustody1() {
  // FEED-002 FEED-004 a statement file posts company-card expenses that are never reimbursed, immutable, keyed by the card transaction and blocked as out-of-pocket duplicates
  await (() => withAgency(async (h, t) => {
  const sent = h.outbound.length, base = await ofx({ category: t.c.office })
  // A reimbursement approved before the statement arrives is still blocked at batching.
  const early = await h.post('claims', { title: 'Flight before statement' }, t.sam)
  const earlyItem = await h.post(`claims/${early.id}/items`, { version: early.version, kind: 'receipt', date: '2026-10-05', merchant: 'Qantas Airways', amount: '120.00', category: t.c.travel, explanation: 'Paid myself' }, t.sam)
  const earlySub = await h.post(`claims/${early.id}/submit`, { version: earlyItem.version }, t.sam)
  const earlyApproved = await h.post(`claims/${early.id}/decision`, { revision: earlySub.revision, version: earlySub.version, decision: 'approved', acknowledge: true }, t.priya)
  // Who may import: finance and the owner, never an employee, a manager, or an agent key.
  await h.post('statements/preview', base, t.sam, 403)
  await h.post('statements/preview', base, t.priya, 403)
  const key = await h.post('agent-keys', { label: 'Statement agent' }, t.morgan)
  assert.equal((await h.send('/api/coaster/statements/preview', base, '', { authorization: `Bearer ${key.token}` })).status, 401)
  const before = { history: (await h.get('history', t.morgan)).lines?.length ?? (await h.get('history', t.morgan)).length, claims: (await h.get('state', t.sam)).claims.length }
  // Preview writes nothing and names every row's fate; the unassigned card blocks commit.
  const preview = await h.post('statements/preview', base, t.morgan)
  assert.equal(preview.format, 'ofx'); assert.deepEqual(preview.period, { start: '2026-10-01', end: '2026-10-31' })
  assert.deepEqual(preview.cards, [{ last4: '1111', assignedTo: null, excluded: false, rows: 3, totalMinor: 19165 }]); assert.deepEqual(preview.unassigned, ['1111'])
  assert.deepEqual(preview.excluded.map(e => e.reason), ['a payment to the card account', 'a fee', 'interest', 'a credit, kept in the original file only'])
  assert.match(preview.masking, /masked/)
  assert.equal((await h.get('statements')).files.length, 0); assert.equal((await h.get('state', t.sam)).claims.length, before.claims)
  assert.equal(JSON.stringify(preview).includes('4111111111111111'), false)
  const commit = { ...base, fingerprint: preview.fingerprint }
  await h.post('statements/commit', commit, t.morgan, 409)
  // Cards are assigned by the owner to an active employee, by last four only.
  await h.post('statements/cards', { issuer: ISSUER, last4: '1111', employee: SAM }, t.morgan, 403)
  await h.post('statements/cards', { issuer: ISSUER, last4: '4111111111111111', employee: SAM }, h.owner, 400)
  await h.post('statements/cards', { issuer: ISSUER, last4: '1111', employee: 'nobody@harbourfinch.example' }, h.owner, 409)
  await h.post('statements/cards', { issuer: ISSUER, last4: '1111', employee: SAM }, h.owner)
  const ready = await h.post('statements/preview', base, t.morgan)
  assert.equal(ready.importable, 3); assert.equal(ready.totalMinor, 19165); assert.deepEqual(ready.unassigned, [])
  await h.post('statements/commit', { ...commit, category: undefined }, t.morgan, 400)
  await h.post('statements/commit', { ...commit, fingerprint: 'stale' }, t.morgan, 409)
  const done = await h.post('statements/commit', { ...commit, fingerprint: ready.fingerprint }, t.morgan)
  // Re-importing the same file creates nothing twice.
  await h.post('statements/commit', { ...commit, fingerprint: ready.fingerprint }, t.morgan, 409)
  assert.equal((await h.post('statements/preview', base, t.morgan)).duplicates.length, 3)
  assert.equal(h.outbound.length, sent, 'statement import made no outbound request')
  // G5: the charges sit on the cardholder's own draft automatic report for the expense month.
  assert.equal(done.claims.length, 1)
  let d = await h.get(`claims/${done.claims[0]}`, t.sam)
  assert.equal(d.claim.title, 'Card statement · Synthetic Card ····1111 · 2026-10-31'); assert.equal(d.claim.status, 'draft'); assert.equal(d.items.length, 3)
  assert.deepEqual(d.items.map(i => [i.merchant, i.spent_on, i.amount_minor]).sort(), [['Harbour View Bistro', '2026-10-02', 4820], ['Officeworks', '2026-10-06', 2345], ['Qantas Airways', '2026-10-05', 12000]])
  // G1 and G3: nothing here is reimbursable, and each expense is keyed by its card transaction.
  assert.equal(d.claim.total_minor, 0)
  assert.deepEqual(d.items.map(i => i.card_transaction_key).sort(), ['card:synthetic card|1111:fitid:SYN-1001', 'card:synthetic card|1111:fitid:SYN-1002', 'card:synthetic card|1111:fitid:SYN-1003'])
  assert.equal((await h.get('state', t.alex)).claims.length, 0, 'no one else sees the charges')
  // G2: the statement facts never change by any route; coding and explanation do.
  const bistro = d.items.find(i => i.merchant === 'Harbour View Bistro')
  await edit(h, t.sam, d.claim, bistro, { amount: '48.00', explanation: 'x' }).then(() => assert.fail('amount changed'), e => assert.match(e.message, /409/))
  await edit(h, t.sam, d.claim, bistro, { merchant: 'Other', explanation: 'x' }).then(() => assert.fail('merchant changed'), e => assert.match(e.message, /409/))
  await edit(h, t.sam, d.claim, bistro, { date: '2026-10-03', explanation: 'x' }).then(() => assert.fail('date changed'), e => assert.match(e.message, /409/))
  await h.post(`claims/${d.claim.id}/items/remove`, { version: d.claim.version, item: bistro.id }, t.sam, 409)
  await assert.rejects(h.db.prepare('UPDATE c_card_charges SET amount_minor=1').run(), /immutable/)
  await assert.rejects(h.db.prepare('UPDATE c_items SET amount_minor=1 WHERE card_charge_id IS NOT NULL').run(), /statement facts/)
  await assert.rejects(h.db.prepare('DELETE FROM c_card_charges').run(), /undoing its statement import/)
  for (const item of d.items) { const c = (await h.get(`claims/${d.claim.id}`, t.sam)).claim; await edit(h, t.sam, c, item, { explanation: 'Company card charge', category: t.c.travel }) }
  d = await h.get(`claims/${d.claim.id}`, t.sam)
  assert.equal(d.items.length, 3); assert.ok(d.items.every(i => i.card_charge_id && i.allocations[0].category_id === t.c.travel && i.explanation))
  // An out-of-pocket expense added to the same report makes it a mixed claim: only the out-of-pocket amount is reimbursed.
  await h.post(`claims/${d.claim.id}/items`, { version: d.claim.version, kind: 'receipt', date: '2026-10-09', merchant: 'Taxi', amount: '30.00', category: t.c.travel, explanation: 'No receipt' }, t.sam)
  d = await h.get(`claims/${d.claim.id}`, t.sam)
  assert.equal(d.items.length, 4); assert.equal(d.claim.total_minor, 3000)
  const submitted = await h.post(`claims/${d.claim.id}/submit`, { version: d.claim.version }, t.sam)
  assert.equal(submitted.total_minor, 3000)
  const approved = await h.post(`claims/${d.claim.id}/decision`, { revision: submitted.revision, version: submitted.version, decision: 'approved', acknowledge: true }, t.priya)
  let batch = await h.post('batches', { claims: [approved.id] }, t.morgan)
  assert.equal(batch.total_minor, 3000, 'the batch total counts the reimbursable expense only')
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 3000 }, t.jordan)
  const accounting = await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`, undefined, t.morgan), people = await h.send(`/api/coaster/batches/${batch.id}/reimbursements.csv`, undefined, t.morgan)
  assert.equal(sum(accounting.text, 'amount'), 3000); assert.equal(sum(people.text, 'amount'), 3000)
  assert.ok(!/Bistro|Qantas|Officeworks/.test(accounting.text), 'a company-card expense has no accounting line to reimburse')
  // G4: the same purchase claimed out of pocket cannot be reimbursed.
  const dup = await h.post('claims', { title: 'Flight again' }, t.sam)
  const withDup = await h.post(`claims/${dup.id}/items`, { version: dup.version, kind: 'receipt', date: '2026-10-05', merchant: 'Qantas Airways', amount: '120.00', category: t.c.travel, explanation: 'Paid myself' }, t.sam)
  const duplicate = await h.post(`claims/${dup.id}/submit`, { version: withDup.version }, t.sam, 409)
  assert.match(duplicate.error, /company card already paid/)
  const unchanged = await h.get(`claims/${dup.id}`, t.sam)
  assert.equal(unchanged.claim.status, 'draft'); assert.equal(unchanged.claim.version, withDup.version)
  assert.deepEqual(unchanged.revisions, []); assert.deepEqual(unchanged.decisions, [])
  // The employee can correct a genuinely different purchase and submit normally.
  const corrected = await edit(h, t.sam, unchanged.claim, unchanged.items[0], { merchant: 'Airport Shuttle', amount: '119.00', explanation: 'Separate airport transfer' })
  assert.equal((await h.post(`claims/${dup.id}/submit`, { version: corrected.version }, t.sam)).status, 'submitted')
  // Scheduled submission uses the same gate, even with an explanation on the duplicate.
  const auto = await h.post('expenses', { kind: 'receipt', date: '2026-10-05', merchant: '  QANTAS   Airways ', amount: '120.00', category: t.c.travel, explanation: 'Paid myself' }, t.sam)
  await h.post('settings/auto-submit', { schedule: 'daily' })
  await (await h.mf.getWorker()).scheduled({ scheduledTime: Date.parse('2026-10-13T01:00:00Z'), cron: '17 * * * *' })
  const autoAfter = await h.get(`claims/${auto.id}`, t.sam)
  assert.equal(autoAfter.claim.status, 'draft'); assert.deepEqual(autoAfter.revisions, [])
  const refused = await h.send('/api/coaster/batches', { claims: [earlyApproved.id] }, t.morgan)
  assert.equal(refused.status, 409); assert.match(refused.value.error, /company card already paid/)
  // History: every charge, the commit and each assignment are numbered lines on the import channel or the person's.
  const lines = (await h.get('history?q=import-', t.morgan)).lines ?? (await h.get('history?q=import-', t.morgan))
  assert.ok(JSON.stringify(lines).includes('import-statement-committed') && JSON.stringify(lines).includes('import-card-charge-created'))
}))()
  // CAPTURE-004 FEED-004 G6 APPROVE-004 matching never approves or samples a private card expense before submission; exact matching attaches once with private schedule provenance
  await (()=>withAgency(async(h,t)=>{
  const r=await original(h,t.sam),before=h.messages.length
  await choose(h,t,r)
  const job=await statement(h,t,[{}])
  await h.post('settings/approval-rule',{enabled:true,limit:'75.00'})
  await h.post('settings/audit-sample',{percent:'100'},t.morgan)
  let d=await h.get(`claims/${job.claims[0]}`,t.sam)
  assert.equal(d.items[0].receipt_id,null,'import itself does not attach or approve')
  const statementFields=['card_charge_id','card_transaction_key','spent_on','merchant','amount_minor','original_minor','original_currency','card_issuer','card_last4']
  const statementFacts=Object.fromEntries(statementFields.map(k=>[k,d.items[0][k]]))
  await Promise.all([tick(h,MATCHING_TIME),tick(h,MATCHING_TIME)])
  const matched=await inbox(h,t,r.id)
  assert.ok(matched.attachment);assert.deepEqual([matched.lifecycle.at(-1).kind,matched.lifecycle.at(-1).actorEmail,matched.lifecycle.at(-1).onBehalfOf,matched.lifecycle.at(-1).channel],['attached','automation: card match',SAM,'schedule'])
  d=await h.get(`claims/${job.claims[0]}`,t.sam)
  assert.equal(d.claim.status,'draft');assert.equal(d.claim.total_minor,0);assert.deepEqual(d.decisions,[]);assert.deepEqual(d.revisions,[])
  assert.deepEqual(Object.fromEntries(statementFields.map(k=>[k,d.items[0][k]])),statementFacts,'automation changes no statement facts')
  assert.equal((await (await h.mf.getR2Bucket('COASTER_RECEIPTS')).list()).objects.length,1,'matching keeps one original object')
  assert.equal((await h.get('exceptions',t.morgan)).samples.length,0,'G6: no sampling before submission')
  const alias=await h.db.prepare('SELECT * FROM c_receipts WHERE id=?').bind(d.items[0].receipt_id).first()
  assert.equal(new Uint8Array(alias.bytes).byteLength,0);assert.equal(alias.capture_receipt_id,r.id)
  const matchBasis=JSON.parse(d.items[0].card_match_basis)
  assert.deepEqual(matchBasis,{ruleVersion:1,basis:'exact',enteredTotalMinor:4820,enteredCurrency:'AUD',enteredDate:'2026-10-02',differenceMinor:0,differenceCurrency:'AUD'})
  const history=await h.get('history?q=card-charge-matched',t.morgan)
  assert.equal(history.lines.length,1);assert.equal(history.lines[0].channel,'schedule')
  assert.deepEqual(Object.keys(history.lines[0].detail).sort(),['charge','ruleVersion'])
  assert.ok(!JSON.stringify(history).includes(r.id)&&!JSON.stringify(history).includes(r.name)&&!JSON.stringify(history).includes(r.sha256)&&!JSON.stringify(history).includes('Different typed private merchant'))
  for(const cookie of [h.owner,t.morgan,t.priya]) {
    await h.get(`claims/${job.claims[0]}`,cookie,403)
    assert.deepEqual((await h.get('receipt-inbox',cookie)).receipts,[])
    assert.deepEqual((await h.get(`receipt-inbox/${r.id}/card-match-question`,cookie)).candidates,[])
  }
  assert.equal(h.messages.length,before,'matching never notifies')
  await Promise.all([tick(h,MATCHING_TIME),tick(h,MATCHING_TIME)])
  assert.equal((await inbox(h,t,r.id)).lifecycle.filter(e=>e.kind==='attached').length,1)
  assert.equal((await h.get('history?q=card-charge-matched',t.morgan)).lines.length,1)
  const submitted=await h.post(`claims/${d.claim.id}/submit`,{version:d.claim.version},t.sam)
  assert.equal(submitted.status,'approved')
  d=await h.get(`claims/${d.claim.id}`,t.morgan)
  assert.equal(d.decisions[0].actor_email,'rule v1');assert.equal((await h.get('exceptions',t.morgan)).samples.length,1)
  assert.deepEqual(JSON.parse(d.revisions[0].snapshot.items[0].card_match_basis),matchBasis)
  assert.equal(d.receipts[0].name,r.name)
  // Receipt identity also blocks re-claiming it under different purchase fields or by another employee.
  const copy = await h.post('claims', { title: 'Same company receipt, different details' }, t.alex)
  const uploaded = await h.post(`claims/${copy.id}/receipts`, { version: copy.version, name: 'my-copy.png', base64: (await readFile('tests/fixtures/receipts/bistro.png')).toString('base64') }, t.alex)
  const copyItem = await h.post(`claims/${copy.id}/items`, { version: uploaded.claim.version, receipt: uploaded.receipt, kind: 'receipt', date: '2026-10-08', merchant: 'Different entered merchant', amount: '19.00', category: t.c.office, explanation: 'Typed differently' }, t.alex)
  await h.post(`claims/${copy.id}/submit`, { version: copyItem.version }, t.alex, 409)
  assert.deepEqual((await h.get(`claims/${copy.id}`, t.alex)).revisions, [])
}))()
  // CAPTURE-004 FEED-004 native per-original consent, live delegate authority, validated details, stale guards, withdrawal and the cash-window exclusion
  await (()=>withAgency(async(h,t)=>{
  const r=await original(h,t.sam)
  assert.equal(r.matchChoice.enabled,false);assert.equal(r.matchChoice.notice,NOTICE)
  await h.post(`receipt-inbox/${r.id}/card-match`,{expectedSequence:0,enabled:true,merchant:'Bistro',date:'2026-10-02',total:'48.20'},t.sam,400)
  for(const [field,value] of [['merchant',' '],['merchant','x'.repeat(201)],['date','2026-02-30'],['total','0'],['total','1.001'],['currency','ZZZ'],['last4','4111111111111111']])
    await h.post(`receipt-inbox/${r.id}/card-match`,{expectedSequence:0,enabled:true,merchant:'Bistro',date:'2026-10-02',total:'48.20',currency:'AUD',notice:NOTICE,[field]:value},t.sam,400)
  const key=await h.post('agent-keys',{label:'Cannot consent'},t.sam)
  assert.equal((await h.send(`/api/coaster/receipt-inbox/${r.id}/card-match`,{expectedSequence:0,enabled:false},'',{authorization:`Bearer ${key.token}`})).status,401)
  for(const cookie of [h.owner,t.morgan,t.priya,t.alex]) await h.post(`receipt-inbox/${r.id}/card-match`,{expectedSequence:0,enabled:false},cookie,cookie===h.owner?403:404)
  for(const level of ['submit','full']) {
    const grant=await h.post('delegates',{delegate:ALEX,level},t.sam)
    const current=await inbox(h,t,r.id)
    const result=await h.send(`/api/coaster/receipt-inbox/${r.id}/card-match`,{expectedSequence:current.lifecycleSequence,enabled:true,merchant:'  Bistro  ',date:'2026-10-02',total:'48.20',notice:NOTICE},t.alex,{'x-coaster-acting-for':SAM})
    assert.equal(result.status,200,JSON.stringify(result.value));assert.equal(result.value.details.currency,'AUD');assert.equal(result.value.details.merchant,'Bistro')
    const line=(await inbox(h,t,r.id)).lifecycle.at(-1);assert.deepEqual([line.actorEmail,line.onBehalfOf],[ALEX,SAM])
    await h.post('delegates/'+grant.id+'/revoke',{},t.sam)
    assert.equal((await h.send(`/api/coaster/receipt-inbox/${r.id}/card-match`,{expectedSequence:result.value.sequence,enabled:false},t.alex,{'x-coaster-acting-for':SAM})).status,403)
  }
  await choose(h,t,r).then(()=>assert.fail('stale choice accepted'),e=>assert.match(e.message,/409/))
  const older=await h.post('settings/cash-draft-window/preview',{days:1},t.morgan)
  await h.post('settings/cash-draft-window',older,t.morgan)
  await (await h.mf.getWorker()).scheduled({scheduledTime:Date.now()+2*86400000,cron:'17 * * * *'})
  assert.equal((await inbox(h,t,r.id)).cashDraft,null,'an opted-in receipt never becomes a cash draft')
  const current=await inbox(h,t,r.id)
  await h.post(`receipt-inbox/${r.id}/card-match`,{expectedSequence:current.lifecycleSequence,enabled:false},t.sam)
  await (await h.mf.getWorker()).scheduled({scheduledTime:Date.now()+2*86400000,cron:'17 * * * *'})
  const reserved=await inbox(h,t,r.id);assert.ok(reserved.cashDraft)
  await choose(h,t,reserved).then(()=>assert.fail('cash-reserved choice accepted'),e=>assert.match(e.message,/409/))
}))()
  // CAPTURE-004 FEED-004 G7 automatic path skips discarded, merged, attached, withdrawn, cash-reserved and inactive originals and foreign charges; undo permanently excludes its pair
  await (()=>withAgency(async(h,t)=>{
  const skipped=[]
  for(const kind of ['discarded','merged','attached','withdrawn','inactive','cash-reserved']) {
    const cookie=kind==='inactive'?t.alex:t.sam,r=await original(h,cookie,kind+'.png')
    if(kind!=='cash-reserved') await choose(h,{...t,sam:cookie},r)
    const current=(await h.get('receipt-inbox',cookie)).receipts.find(x=>x.id===r.id)
    if(kind==='discarded') await h.post(`receipt-inbox/${r.id}/discard`,{expectedSequence:current.lifecycleSequence,reason:'Not needed'},cookie)
    if(kind==='merged') {const survivor=await original(h,cookie,'survivor.png');await h.post(`receipt-inbox/${r.id}/merge`,{expectedSequence:current.lifecycleSequence,survivorId:survivor.id,reason:''},cookie)}
    if(kind==='withdrawn') await h.post(`receipt-inbox/${r.id}/card-match`,{expectedSequence:current.lifecycleSequence,enabled:false},cookie)
    if(kind==='attached') {
      let c=await h.post('claims',{title:'Manual private purchase'},cookie)
      c=await h.post(`claims/${c.id}/items`,{version:c.version,kind:'receipt',date:'2026-10-02',merchant:'Hand-built',amount:'1.00',category:t.c.office},cookie)
      const item=(await h.get(`claims/${c.id}`,cookie)).items[0]
      await h.post(`receipt-inbox/${r.id}/attach`,{expectedSequence:current.lifecycleSequence,claimId:c.id,itemId:item.id,version:c.version},cookie)
    }
    if(kind==='inactive') await h.post('settings/members',{email:ALEX,name:'alex',employee:true,active:false})
    if(kind==='cash-reserved') {
      const preview=await h.post('settings/cash-draft-window/preview',{days:1},t.morgan);await h.post('settings/cash-draft-window',preview,t.morgan)
      await (await h.mf.getWorker()).scheduled({scheduledTime:Date.now()+2*86400000,cron:'17 * * * *'})
    }
    skipped.push({r,kind,cookie})
  }
  const waiting=await original(h,t.sam,'genuine-waiting.png');await choose(h,t,waiting)
  await statement(h,t,[{}],{last4:'4444',employee:'jordan@harbourfinch.example',name:'foreign.csv'})
  await tick(h);assert.equal((await inbox(h,t,waiting.id)).attachment,null,'same amount on another employee card never matches')
  const matchedJob=await statement(h,t,[{}]);await tick(h)
  for(const {r,kind,cookie} of skipped) {
    if(kind==='inactive') continue
    const result=(await h.get('receipt-inbox',cookie)).receipts.find(x=>x.id===r.id)
    assert.equal(result.lifecycle.filter(e=>e.actorEmail==='automation: card match').length,0,kind)
  }
  assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM c_capture_lifecycle WHERE receipt_id=? AND channel='schedule'").bind(skipped.find(x=>x.kind==='inactive').r.id).first()).n,0)
  const matched=await inbox(h,t,waiting.id);assert.ok(matched.attachment)
  await h.post(`receipt-inbox/${waiting.id}/detach`,{expectedSequence:matched.lifecycleSequence,claimId:matched.attachment.claimId,itemId:matched.attachment.itemId,version:matched.attachment.version},t.sam)
  let undone=await inbox(h,t,waiting.id);assert.equal(undone.matchChoice.enabled,false)
  await choose(h,t,undone);await tick(h)
  undone=await inbox(h,t,waiting.id);assert.equal(undone.attachment,null)
  assert.deepEqual((await h.get(`receipt-inbox/${waiting.id}/card-match-question`,t.sam)).candidates,[])
  assert.equal((await h.get('history?q=card-charge-unmatched',t.morgan)).lines.length,1)
  const excluded=(await h.db.prepare('SELECT transaction_key FROM c_card_match_rejections WHERE receipt_id=?').bind(waiting.id).first()).transaction_key
  const undoneStatement=await h.post(`statements/${matchedJob.file}/undo`,{},t.morgan);assert.equal(undoneStatement.removed,1)
  assert.equal((await h.db.prepare('SELECT transaction_key FROM c_card_charge_undo_history').first()).transaction_key,excluded)
  await assert.rejects(h.db.prepare('DELETE FROM c_card_charge_undo_history').run(),/permanent/)
  await statement(h,t,[{}]);await tick(h)
  assert.equal((await inbox(h,t,waiting.id)).attachment,null,'the same transaction stays excluded after statement undo and re-import creates a new charge row')
  assert.deepEqual((await h.get(`receipt-inbox/${waiting.id}/card-match-question`,t.sam)).candidates,[])
  assert.ok((await h.db.prepare('SELECT transaction_key FROM c_card_charges').all()).results.some(c=>c.transaction_key===excluded))
}))()
  // CAPTURE-004 FEED-004 rule v1 never breaks amount ties with merchant or date; private questions can be rejected or attached by the person
  await (()=>withAgency(async(h,t)=>{
  const r=await original(h,t.sam);await choose(h,t,r,{merchant:'Harbour View Bistro'})
  const job=await statement(h,t,[{}, {transaction:'2026-10-03',merchant:'Completely different merchant'}])
  await tick(h)
  let current=await inbox(h,t,r.id);assert.equal(current.attachment,null)
  const q=await h.get(`receipt-inbox/${r.id}/card-match-question`,t.sam);assert.equal(q.ambiguous,true);assert.equal(q.candidates.length,2)
  await h.post(`receipt-inbox/${r.id}/card-match-reject`,{expectedSequence:current.lifecycleSequence,chargeIds:[q.candidates[0].chargeId]},t.sam,409)
  const chosen=q.candidates[1]
  await h.post('delegates',{delegate:ALEX,level:'submit'},t.sam)
  const answer=await h.send(`/api/coaster/receipt-inbox/${r.id}/attach`,{expectedSequence:current.lifecycleSequence,claimId:chosen.claimId,itemId:chosen.itemId,version:chosen.version},t.alex,{'x-coaster-acting-for':SAM})
  assert.equal(answer.status,200,JSON.stringify(answer.value))
  current=await inbox(h,t,r.id);assert.equal(current.lifecycle.at(-1).actorEmail,ALEX);assert.equal(current.lifecycle.at(-1).onBehalfOf,SAM);assert.equal(current.lifecycle.at(-1).channel,'app')
  const global=(await h.get('history?q=card-charge-matched',t.morgan)).lines
  assert.equal(global.at(-1).actor_email,ALEX);assert.deepEqual(Object.keys(global.at(-1).detail).sort(),['charge','ruleVersion'])
  const a=await original(h,t.sam,'duplicate-a.png'),b=await original(h,t.sam,'duplicate-b.png')
  for(const original of [a,b]) await choose(h,t,original)
  await tick(h)
  for(const original of [a,b]) {assert.equal((await inbox(h,t,original.id)).attachment,null);assert.equal((await h.get(`receipt-inbox/${original.id}/card-match-question`,t.sam)).ambiguous,true)}
  const question=await h.get(`receipt-inbox/${a.id}/card-match-question`,t.sam)
  await h.post(`receipt-inbox/${a.id}/card-match-reject`,{expectedSequence:(await inbox(h,t,a.id)).lifecycleSequence,chargeIds:question.candidates.map(c=>c.chargeId)},t.sam)
  await tick(h)
  assert.ok((await inbox(h,t,b.id)).attachment,'eliminating one competitor makes the remaining mutual pair unique')
  assert.equal((await inbox(h,t,a.id)).attachment,null)
}))()
  // FEED-004 CAPTURE-004 exact rule v1 tip, date and optional binding last four boundaries, off switch and private replay-safe matching
  await (()=>withAgency(async(h,t)=>{
  let rule=await h.get('settings/card-matching',t.morgan)
  assert.deepEqual([rule.version,rule.enabled,rule.window_days,rule.tip_percent,rule.fx_percent],[1,1,7,20,5])
  const config={version:1,enabled:false,windowDays:7,tipPercent:20,fxPercent:5}
  await h.post('settings/card-matching',config,t.sam,403)
  await h.post('settings/card-matching',{...config,windowDays:15},t.morgan,400)
  await h.post('settings/card-matching',config,t.morgan)
  const r=await original(h,t.sam);await choose(h,t,r,{merchant:'BISTRO',total:'40.17',last4:'1111'})
  await statement(h,t,[{amount:'48.20'}]) // floor(40.17 * 1.20) = 48.20
  await tick(h);assert.equal((await inbox(h,t,r.id)).attachment,null)
  await h.post('settings/card-matching',{...config,version:2,enabled:true},t.morgan)
  await tick(h)
  const matched=await inbox(h,t,r.id);assert.ok(matched.attachment)
  const d=await h.get(`claims/${matched.attachment.claimId}`,t.sam)
  assert.deepEqual([JSON.parse(d.items[0].card_match_basis).basis,JSON.parse(d.items[0].card_match_basis).differenceMinor],['tip',803])
  const invalid=await original(h,t.sam,'wrong-card.png');await choose(h,t,invalid,{last4:'2222'})
  assert.deepEqual((await h.get(`receipt-inbox/${invalid.id}/card-match-question`,t.sam)).candidates,[])
  const tooLate=await original(h,t.sam,'late.png');await choose(h,t,tooLate,{date:'2026-09-24'})
  assert.deepEqual((await h.get(`receipt-inbox/${tooLate.id}/card-match-question`,t.sam)).candidates,[])
  await assert.rejects(h.db.prepare("UPDATE c_capture_lifecycle SET match_data='{}'").run(),/permanent/)
  await assert.rejects(h.db.prepare('DELETE FROM c_card_match_rules').run(),/permanent/)
}))()
  // FEED-004 CLAIM-003 rule v1 EUR reference matching needs ECB opt-in and merchant agreement, uses transaction dates and respects both inclusive date bounds
  await (async()=>{
  const xml='<Cube><Cube time="2026-10-02"><Cube currency="AUD" rate="1.5"/></Cube></Cube>'
  const h=await harness({fxRates:xml})
  try {
    const t=await agency(h),r=await original(h,t.sam)
    await choose(h,t,r,{merchant:'Bistro',total:'32.13',currency:'EUR'})
    const job=await statement(h,t,[{}])
    await tick(h);assert.equal((await inbox(h,t,r.id)).attachment,null)
    assert.equal(h.outbound.filter(q=>q.url.includes('ecb.europa.eu')).length,0,'FX off sends nothing')
    await h.post('settings/business',{name:'Harbour & Finch Studio',currency:'AUD',timezone:'Australia/Sydney',perDiem:'75.00',receiptThreshold:'',fxEnabled:true})
    await tick(h)
    const matched=await inbox(h,t,r.id);assert.ok(matched.attachment)
    const d=await h.get(`claims/${job.claims[0]}`,t.sam),b=JSON.parse(d.items[0].card_match_basis)
    assert.deepEqual([b.basis,b.enteredCurrency,b.enteredTotalMinor,b.differenceMinor,b.fxSource],['fx','EUR',3213,0,'ECB reference rates'])
    assert.ok(h.outbound.filter(q=>q.url.includes('ecb.europa.eu')).every(q=>q.method==='GET'&&q.body===''&&q.url==='https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml'))
    const rows=[{amount:'17.00',transaction:'2026-10-01'},{amount:'18.00',transaction:'2026-10-09'},{amount:'19.00',transaction:'2026-09-30'},{amount:'20.00',transaction:'2026-10-10'},{amount:'21.00'}]
    await statement(h,t,rows,{name:'date-bounds.csv'})
    for(const [index,expected] of [1,1,0,0,0].entries()) {
      const o=await original(h,t.sam,`bounds-${index}.png`)
      await choose(h,t,o,{total:(17+index).toFixed(2),...(index===4?{last4:'2222'}:{})})
      const question=await h.get(`receipt-inbox/${o.id}/card-match-question`,t.sam)
      assert.equal(question.candidates.length,expected,JSON.stringify(rows[index]))
    }
  } finally {await h.close()}
})()
  // CAPTURE-004 FEED-004 hourly decision budget is 100 oldest-waiting originals and unchanged no-candidate originals do not starve later work
  await (()=>withAgency(async(h,t)=>{
  const originals=[]
  for(let i=0;i<101;i++) {
    const r=await original(h,t.sam,`waiting-${String(i).padStart(3,'0')}.png`);originals.push(r)
    await choose(h,t,r,{total:i===100?'48.20':'11.11'})
  }
  await statement(h,t,[{}])
  await tick(h)
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_card_match_checks').first()).n,100)
  assert.equal((await inbox(h,t,originals[100].id)).attachment,null,'the 101st original waits for the next hourly delivery')
  await tick(h)
  assert.ok((await inbox(h,t,originals[100].id)).attachment,'unchanged earlier no-match originals do not starve the waiting match')
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_card_match_checks').first()).n,101)
}))()
  // CAPTURE-004 ERASURE-001 private match choices withdraw on erasure and typed identities are replaced without changing the original
  await (()=>withAgency(async(h,t)=>{
  const r=await original(h,t.sam),hash=r.sha256
  await choose(h,t,r,{merchant:`sam ${SAM.toUpperCase()} bistro`})
  const grant=await h.post('delegates',{delegate:ALEX,level:'full'},t.sam)
  const delegated=await h.send(`/api/coaster/receipt-inbox/${r.id}/card-match`,{expectedSequence:1,enabled:true,merchant:`alex ${ALEX.toUpperCase()} bistro`,date:'2026-10-02',total:'48.20',currency:'AUD',notice:NOTICE},t.alex,{'x-coaster-acting-for':SAM})
  assert.equal(delegated.status,200)
  await h.post(`delegates/${grant.id}/revoke`,{},t.sam)
  await h.post('settings/members',{email:SAM,name:'sam',employee:true,active:false})
  const erased=await h.post('settings/members/erase',{email:SAM})
  const lines=(await h.db.prepare('SELECT * FROM c_capture_lifecycle WHERE receipt_id=? ORDER BY sequence').bind(r.id).all()).results
  assert.equal(lines.at(-1).kind,'match-withdrawn')
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_card_match_generations WHERE employee_email=?').bind(SAM).first()).n,0,'native account deletion must not reintroduce erased identity into the derived cache')
  assert.ok(lines.every(line=>!JSON.stringify(line).toLowerCase().includes(SAM)))
  const details=JSON.parse(lines[0].match_data);assert.ok(details.merchant.includes(erased.label)&&details.merchant.includes(erased.retained.subject))
  await h.post('settings/members',{email:ALEX,name:'alex',employee:true,active:false})
  await h.post('settings/members/erase',{email:ALEX})
  const anonymized=(await h.db.prepare('SELECT * FROM c_capture_lifecycle WHERE receipt_id=?').bind(r.id).all()).results
  assert.ok(anonymized.every(line=>!JSON.stringify(line).toLowerCase().includes(SAM)&&!JSON.stringify(line).toLowerCase().includes(ALEX)))
  assert.equal((await h.db.prepare('SELECT sha256 FROM c_capture_receipts WHERE id=?').bind(r.id).first()).sha256,hash)
  await tick(h)
  assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM c_capture_lifecycle WHERE receipt_id=? AND channel='schedule'").bind(r.id).first()).n,0)
}))()
  // FEED-004 CAPTURE-004 RETAIN-001 expired financial expenses retain their immutable card provenance and leave the original available for a different posted charge
  await (()=>withAgency(async(h,t)=>{
  const r=await original(h,t.sam);await choose(h,t,r)
  const job=await statement(h,t,[{}]);await tick(h)
  let d=await h.get(`claims/${job.claims[0]}`,t.sam)
  const submitted=await h.post(`claims/${d.claim.id}/submit`,{version:d.claim.version},t.sam)
  await h.post(`claims/${d.claim.id}/decision`,{version:submitted.version,revision:submitted.revision,decision:'rejected',reason:'Keep statement history only'},t.priya)
  await h.post('settings/retention',{years:1})
  await (await h.mf.getWorker()).scheduled({scheduledTime:Date.parse('2028-10-22T04:00:00Z'),cron:'17 * * * *'})
  const proposal=(await h.get('retention')).proposal;assert.ok(proposal)
  await h.post(`retention/${proposal.id}/confirm`,{})
  await h.get(`claims/${d.claim.id}`,t.sam,404)
  assert.equal((await h.db.prepare('SELECT claim_id FROM c_card_charges').first()).claim_id,d.claim.id)
  const kept=await inbox(h,t,r.id);assert.equal(kept.attachment,null);assert.equal(kept.sha256,r.sha256)
  await statement(h,t,[{id:'later-distinct-transaction',merchant:'Another merchant'}],{name:'later.csv'})
  await tick(h)
  assert.ok((await inbox(h,t,r.id)).attachment)
  assert.equal((await inbox(h,t,r.id)).lifecycle.filter(l=>l.channel==='schedule').length,2)
}))()
}
