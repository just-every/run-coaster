// FEED-002 statement-file import and the FEED-004 card-expense gates, through the public HTTP API with real native
// sessions, workerd and D1. Fixtures are synthetic; no outbound request is made.
import { test } from 'node:test'
import { crc32 } from 'node:zlib'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness } from './harness.mjs'
import { importPrivateStatements, scanStatementStorage } from './statement-archive.mjs'

const SAM = 'sam@harbourfinch.example', ALEX = 'alex@harbourfinch.example', ISSUER = 'Synthetic Card'
const FULL = ['4111111111111111', '4111 1111 1111 1111', '5500 0000 0000 0004', '5500000000000004']
const fixture = name => readFile(`tests/fixtures/statements/${name}`, 'utf8')
const sum = (csv, column) => { const [head, ...rows] = csv.trim().split('\r\n').map(r => r.split('","').map(x => x.replace(/^"|"$/g, ''))); const i = head.indexOf(column); return Math.round(rows.reduce((n, r) => n + Number(r[i]) * 100, 0)) }
async function withAgency(run) { const h = await harness(); try { await run(h, await agency(h)) } finally { await h.close() } }
const ofx = async (extra = {}) => ({ format: 'ofx', name: 'october.ofx', issuer: ISSUER, content: await fixture('synthetic-card.ofx'), ...extra })
const edit = (h, cookie, claim, item, over = {}) => h.post(`claims/${claim.id}/items`, { version: claim.version, item: item.id, kind: 'receipt', date: item.spent_on, merchant: item.merchant, amount: (item.amount_minor / 100).toFixed(2), category: item.allocations[0].category_id, ...over }, cookie)

test('FEED-002 FEED-004 a statement file posts company-card expenses that are never reimbursed, immutable, keyed by the card transaction and blocked as out-of-pocket duplicates', () => withAgency(async (h, t) => {
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
}))

test('FEED-002 QFX and mapped CSV import with masking, overlap flags, imported-history skips and an undo that keeps edited charges', () => withAgency(async (h, t) => {
  const sent = h.outbound.length
  await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', perDiem: '75.00', receiptThreshold: '' })
  await h.post('statements/cards', { issuer: ISSUER, last4: '1111', employee: SAM }, h.owner); await h.post('statements/cards', { issuer: ISSUER, last4: '0004', employee: ALEX }, h.owner)
  const first = await ofx({ category: t.c.office }), p1 = await h.post('statements/preview', first, t.morgan)
  await h.post('statements/commit', { ...first, fingerprint: p1.fingerprint }, t.morgan)
  // Bank statements and foreign-currency files are refused before anything is kept.
  await h.post('statements/preview', { ...first, content: await fixture('bank.ofx') }, t.morgan, 400)
  assert.match((await h.post('statements/preview', { ...first, content: first.content.replace('<CURDEF>AUD', '<CURDEF>EUR') }, t.morgan)).errors[0], /EUR/)
  // A QFX (OFX 2.x) overlapping the first file: a repeated FITID is skipped, a same-charge row under another id is flagged.
  const qfx = { format: 'qfx', name: 'october.qfx', issuer: ISSUER, category: t.c.office, content: await fixture('synthetic-card.qfx') }, q1 = await h.post('statements/preview', qfx, t.morgan)
  assert.equal(q1.importable, 1); assert.equal(q1.duplicates.length, 1); assert.equal(q1.possibleDuplicates.length, 1)
  const include = [q1.possibleDuplicates[0].id], q2 = await h.post('statements/preview', { ...qfx, includeRows: include }, t.morgan)
  assert.equal(q2.importable, 2)
  const job = await h.post('statements/commit', { ...qfx, includeRows: include, fingerprint: q2.fingerprint }, t.morgan)
  let d = await h.get(`claims/${job.claims[0]}`, t.sam)
  assert.equal(d.items.length, 5)
  // Undo reverses only charges still exactly as imported: an edited one stays and is listed.
  const coles = d.items.find(i => i.merchant === 'Coles Express'); await edit(h, t.sam, d.claim, coles, { explanation: 'Fuel snack', category: t.c.office })
  const undone = await h.post(`statements/${job.file}/undo`, {}, t.morgan)
  assert.equal(undone.removed, 1); assert.deepEqual(undone.kept.map(k => [k.merchant, k.reason]), [['Coles Express', 'it was edited']])
  await h.post(`statements/${job.file}/undo`, {}, t.morgan, 409)
  d = await h.get(`claims/${job.claims[0]}`, t.sam); assert.equal(d.items.length, 4)
  assert.equal((await h.post('statements/preview', qfx, t.morgan)).alreadyImported, false, 'an undone file can be imported again')
  // Mapped CSV: the card column is a full number, masked everywhere; a pending row, credit, payment and an imported-history charge create nothing.
  const ramp = (await readFile('tests/fixtures/ramp-transactions.csv', 'utf8')).replaceAll(',USD,', ',AUD,').split('\n').filter((_, i) => i === 0 || i > 2).join('\n')
  await h.post('import/commit', { source: 'ramp', csv: ramp, filename: 'ramp.csv', mapping: { date: 'YYYY-MM-DD' }, fingerprint: (await h.post('import/preview', { source: 'ramp', csv: ramp, filename: 'ramp.csv', mapping: { date: 'YYYY-MM-DD' } })).fingerprint, receipts: undefined })
  const mapping = { dateFormat: 'YYYY-MM-DD', sign: 'purchases-positive', postedDate: 'Posted', transactionDate: 'Purchased', description: 'Merchant', amount: 'Amount', card: 'Card', status: 'State', type: 'Kind', transactionId: 'Ref' }
  const csv = { format: 'csv', name: 'alex.csv', issuer: ISSUER, content: await fixture('mapped-card.csv'), mapping, category: t.c.office }
  await h.post('statements/preview', { ...csv, mapping: { ...mapping, sign: undefined } }, t.morgan, 400)
  const c1 = await h.post('statements/preview', csv, t.morgan)
  assert.equal(c1.importable, 2); assert.equal(c1.totalMinor, 6495 + 3110)
  assert.deepEqual(c1.excluded.map(e => e.reason).sort(), ['a credit, kept in the original file only', 'a payment to the card account', 'already in imported Ramp card charge RT-1003', 'pending or authorized, not posted'].sort())
  const imported = await h.post('statements/commit', { ...csv, fingerprint: c1.fingerprint }, t.morgan)
  const alex = await h.get(`claims/${imported.claims[0]}`, t.alex)
  assert.deepEqual(alex.items.map(i => [i.merchant, i.spent_on]).sort(), [['Officeworks', '2026-10-12'], ['Staples', '2026-10-06']], 'the transaction date wins over the posted date')
  const files = (await h.get('statements', t.morgan)).files
  for (const f of files) { const original = await h.send(`/api/coaster/statements/${f.id}/file`, undefined, t.morgan); for (const number of FULL) assert.equal(original.text.includes(number), false, `${f.name} keeps no ${number}`) }
  const kept = (await h.send(`/api/coaster/statements/${imported.file}/file`, undefined, t.morgan)).text; assert.ok(kept.includes('**** **** **** 0004'), JSON.stringify(kept).slice(0, 300))
  for (const [table, column] of [['c_statement_files', 'CAST(bytes AS TEXT)'], ['c_statement_files', 'mapping'], ['c_cards', 'issuer||last4'], ['c_card_charges', 'descriptor||memo||transaction_key'], ['c_events', 'detail'], ['c_items', 'description||merchant']])
    for (const number of FULL) assert.equal((await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE instr(${column},?)>0`).bind(number).first()).n, 0, `${table} holds no card number`)
  await h.get('statements', t.sam, 403)
  // Repeated compact, spaced, hyphenated and mixed-format numbers must not enter any derived field.
  await importPrivateStatements({
    post: (path, body) => h.post(path, body), get: path => h.get(path),
    download: async id => { const response = await h.send(`/api/coaster/statements/${id}/file`, undefined, h.owner); assert.equal(response.status, 200); return { bytes: Buffer.from(response.text), disposition: response.headers.get('content-disposition') }; },
  }, t.c.office, SAM)
  await original(h, t.sam, 'synthetic-privacy-receipt.png')
  await scanStatementStorage(h)
  assert.equal(h.outbound.length, sent, 'statement import made no outbound request')
}))

const NOTICE = "When this receipt matches one of your card charges, Coaster attaches it automatically. Approvers and finance can see the receipt, its file name and the total, currency and date you entered once that expense is submitted — by you, your delegate or the owner's scheduled submission."
const inbox = async(h,t,id) => (await h.get('receipt-inbox',t.sam)).receipts.find(r=>r.id===id)
async function original(h,cookie,name='private-card.png',headers={},bytes) {
  const form=new FormData();form.append('file',new Blob([bytes??await readFile('tests/fixtures/receipts/bistro.png')]),name);form.append('source','upload')
  const req=new Request(h.origin+'/api/coaster/receipt-inbox',{method:'POST',headers:{origin:h.origin,cookie,...headers},body:form})
  const r=await h.mf.dispatchFetch(req.url,{method:'POST',headers:Object.fromEntries(req.headers),body:await req.arrayBuffer()})
  assert.equal(r.status,200);return (await r.json()).receipt
}
async function choose(h,t,r,over={}) {return h.post(`receipt-inbox/${r.id}/card-match`,{expectedSequence:r.lifecycleSequence,enabled:true,merchant:'Different typed private merchant',date:'2026-10-02',total:'48.20',currency:'AUD',notice:NOTICE,...over},t.sam)}
const tick = async h => (await h.mf.getWorker()).scheduled({scheduledTime:Date.now(),cron:'17 * * * *'})
async function statement(h,t,rows,{last4='1111',employee=SAM,name='matching.csv'}={}) {
  await h.post('statements/cards',{issuer:ISSUER,last4,employee})
  const base={format:'csv',name,issuer:ISSUER,category:t.c.office,content:'Posted,Transaction,Merchant,Amount,Id,Status\n'+rows.map((r,i)=>`${r.date??'2026-10-03'},${r.transaction??'2026-10-02'},${r.merchant??'Harbour View Bistro'},${r.amount??'48.20'},${r.id??name+'-'+i},${r.status??'posted'}`).join('\n'),mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Posted',transactionDate:'Transaction',description:'Merchant',amount:'Amount',transactionId:'Id',status:'Status',wholeFileLast4:last4}}
  const preview=await h.post('statements/preview',base,t.morgan)
  assert.deepEqual(preview.errors,[])
  return preview.importable ? h.post('statements/commit',{...base,fingerprint:preview.fingerprint},t.morgan) : preview
}

test('CAPTURE-004 FEED-004 G6 APPROVE-004 matching never approves or samples a private card expense before submission; exact matching attaches once with private schedule provenance',()=>withAgency(async(h,t)=>{
  const r=await original(h,t.sam),before=h.messages.length
  await choose(h,t,r)
  const job=await statement(h,t,[{}])
  await h.post('settings/approval-rule',{enabled:true,limit:'75.00'})
  await h.post('settings/audit-sample',{percent:'100'},t.morgan)
  let d=await h.get(`claims/${job.claims[0]}`,t.sam)
  assert.equal(d.items[0].receipt_id,null,'import itself does not attach or approve')
  const statementFields=['card_charge_id','card_transaction_key','spent_on','merchant','amount_minor','original_minor','original_currency','card_issuer','card_last4']
  const statementFacts=Object.fromEntries(statementFields.map(k=>[k,d.items[0][k]]))
  await Promise.all([tick(h),tick(h)])
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
  await Promise.all([tick(h),tick(h)])
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
}))

test('CAPTURE-004 FEED-004 native per-original consent, live delegate authority, validated details, stale guards, withdrawal and the cash-window exclusion',()=>withAgency(async(h,t)=>{
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
}))

test('CAPTURE-004 FEED-004 G7 automatic path skips discarded, merged, attached, withdrawn, cash-reserved and inactive originals and foreign charges; undo permanently excludes its pair',()=>withAgency(async(h,t)=>{
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
}))

test('CAPTURE-004 FEED-004 rule v1 never breaks amount ties with merchant or date; private questions can be rejected or attached by the person',()=>withAgency(async(h,t)=>{
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
}))

test('FEED-004 CAPTURE-004 exact rule v1 tip, date and optional binding last four boundaries, off switch and private replay-safe matching',()=>withAgency(async(h,t)=>{
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
}))

test('FEED-004 CLAIM-003 rule v1 EUR reference matching needs ECB opt-in and merchant agreement, uses transaction dates and respects both inclusive date bounds',async()=>{
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
})

test('CAPTURE-004 FEED-004 hourly decision budget is 100 oldest-waiting originals and unchanged no-candidate originals do not starve later work',()=>withAgency(async(h,t)=>{
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
}))

test('CAPTURE-004 ERASURE-001 private match choices withdraw on erasure and typed identities are replaced without changing the original',()=>withAgency(async(h,t)=>{
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
}))

test('FEED-004 CAPTURE-004 RETAIN-001 expired financial expenses retain their immutable card provenance and leave the original available for a different posted charge',()=>withAgency(async(h,t)=>{
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
}))

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

test('CAPTURE-004 complete role/privacy matrix: employee and both live delegates consent, private questions and originals stay private, submitted audit packs retain only ordinary provenance and frozen match basis',()=>withAgency(async(h,t)=>{
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
    await tick(h)
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
    await Promise.all([tick(h),tick(h)])
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
}))

test('CAPTURE-004 FEED-004 matched basis survives partial approval and hold release, and a later company charge blocks release of a reimbursable hold',()=>withAgency(async(h,t)=>{
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
}))

test('FEED-005 a statement with one missing charge and one refund is reconciled line by line, closed into the card ledger at the statement balance, grouped into a statement report that submits on schedule', () => withAgency(async (h, t) => {
  const CARD = '2222', audrey = await h.person('audrey@harbourfinch.example', { auditor: true }), sent = h.outbound.length
  await h.post('statements/cards', { issuer: ISSUER, last4: CARD, employee: SAM }, h.owner)
  const earlier = { format: 'qfx', name: 'early-september.qfx', issuer: ISSUER, category: t.c.office, content: await fixture('reconcile-earlier.qfx') }
  await h.post('statements/commit', { ...earlier, fingerprint: (await h.post('statements/preview', earlier, t.morgan)).fingerprint }, t.morgan)
  const september = { format: 'ofx', name: 'september.ofx', issuer: ISSUER, category: t.c.office, content: await fixture('reconcile-september.ofx') }
  const preview = await h.post('statements/preview', september, t.morgan)
  assert.equal(preview.importable, 3); assert.equal(preview.possibleDuplicates.length, 1, 'the Bunnings charge delivered earlier under another id stays out of the import')
  const done = await h.post('statements/commit', { ...september, fingerprint: preview.fingerprint }, t.morgan)
  // The statement period's charges collect in one report for the card and period, not a calendar month.
  const report = await h.get(`claims/${done.claims[0]}`, t.sam)
  assert.equal(done.claims.length, 1); assert.equal(report.claim.title, 'Card statement · Synthetic Card ····2222 · 2026-09-30'); assert.equal(report.items.length, 3)
  const file = (await h.get('statements')).files.find(f => f.name === 'september.ofx')

  // Who may reconcile: finance and the owner, never an employee, a manager, an auditor or an agent key; the auditor reads.
  const open = { last4: CARD, openingBalance: '600.00' }
  await h.post(`statements/${file.id}/reconcile`, open, t.sam, 403); await h.post(`statements/${file.id}/reconcile`, open, t.priya, 403); await h.post(`statements/${file.id}/reconcile`, open, audrey, 403)
  const key = await h.post('agent-keys', { label: 'Statement agent' }, t.morgan)
  assert.equal((await h.send(`/api/coaster/statements/${file.id}/reconcile`, open, '', { authorization: `Bearer ${key.token}` })).status, 401)
  await h.post(`statements/${file.id}/reconcile`, { last4: CARD }, t.morgan, 400)
  await h.post(`statements/${file.id}/reconcile`, { ...open, statementBalance: '100.00' }, t.morgan, 400)
  await h.post(`statements/${file.id}/reconcile`, { last4: '9999', openingBalance: '600.00' }, t.morgan, 409)

  // Coaster totals posted charges, payments and credits against the statement balance and lists what differs.
  const rec = await h.post(`statements/${file.id}/reconcile`, open, t.morgan)
  assert.deepEqual([rec.status, rec.openingMinor, rec.statementMinor, rec.purchasesMinor, rec.heldMinor, rec.creditsMinor, rec.paymentsMinor, rec.feesMinor, rec.coasterMinor, rec.differenceMinor], ['open', 60000, 35265, 25565, 19165, 1200, 50000, 900, 30065, 5200])
  assert.deepEqual(rec.differences.map(d => [d.kind, d.descriptor, d.amountMinor, d.effectMinor, d.resolution]), [['missing-charge', 'Bunnings Warehouse', 6400, 6400, null], ['credit', 'Officeworks refund', 1200, -1200, null]])
  assert.deepEqual((await h.get('statements/reconciliations', audrey)).statements.map(s => s.id), [rec.id]); await h.get('statements/reconciliations', t.sam, 403)
  // Closing with differences open is refused and writes nothing.
  await h.post(`statements/reconciliations/${rec.id}/close`, {}, t.morgan, 409)
  assert.equal((await h.get(`statements/reconciliations/${rec.id}`, t.morgan)).ledger, null)
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_card_ledger').first()).n, 0)

  // Resolving: the refund is acknowledged against the charge it refunds; the missing charge needs its explanation.
  const officeworks = (await h.get('statements')).charges.find(c => c.descriptor === 'Officeworks' && c.last4 === CARD)
  await h.post(`statements/reconciliations/${rec.id}/resolve`, { line: 7, resolution: 'credit' }, t.morgan, 400)
  await h.post(`statements/reconciliations/${rec.id}/resolve`, { line: 7, resolution: 'credit', charge: 'not-a-charge' }, t.morgan, 400)
  await h.post(`statements/reconciliations/${rec.id}/resolve`, { line: 7, resolution: 'credit', charge: officeworks.id }, t.sam, 403)
  const credited = await h.post(`statements/reconciliations/${rec.id}/resolve`, { line: 7, resolution: 'credit', charge: officeworks.id }, t.morgan)
  assert.equal(credited.differenceMinor, 6400); await h.post(`statements/reconciliations/${rec.id}/resolve`, { line: 7, resolution: 'credit', charge: officeworks.id }, t.morgan, 409)
  await h.post(`statements/reconciliations/${rec.id}/resolve`, { line: 4, resolution: 'explain' }, t.morgan, 400)
  await h.post(`statements/reconciliations/${rec.id}/resolve`, { line: 4, resolution: 'credit', note: 'x' }, t.morgan, 400)
  await h.post(`statements/reconciliations/${rec.id}/resolve`, { line: 5, resolution: 'explain', note: 'a payment is not a difference' }, t.morgan, 404)
  const settled = await h.post(`statements/reconciliations/${rec.id}/resolve`, { line: 4, resolution: 'explain', note: 'Same Bunnings charge, delivered earlier as EARLY-9001' }, t.morgan)
  assert.deepEqual([settled.differenceMinor, settled.unresolved], [0, 0])

  // Closing writes the card ledger once, and the card account then equals the statement balance to the cent.
  const closed = await h.post(`statements/reconciliations/${rec.id}/close`, {}, t.morgan)
  assert.equal(closed.status, 'closed'); assert.deepEqual([closed.ledger.cardAccountMinor, closed.ledger.statementMinor, closed.ledger.matches], [35265, 35265, true])
  assert.deepEqual(closed.ledger.entries.map(e => [e.kind, e.amount_minor]), [['opening', 60000], ['purchase', 4820], ['purchase', 12000], ['purchase', 2345], ['unmatched', 6400], ['payment', 50000], ['fee', 900], ['credit', 1200]])
  assert.ok(closed.ledger.entries.filter(e => e.kind === 'purchase').every(e => e.debit_account === 'Expense · 6500 Office supplies' && e.credit_account === 'Card liability · Synthetic Card ····2222'))
  assert.deepEqual(closed.ledger.entries.find(e => e.kind === 'payment'), { ...closed.ledger.entries.find(e => e.kind === 'payment'), debit_account: 'Card liability · Synthetic Card ····2222', credit_account: 'Card payment clearing' })
  await h.post(`statements/reconciliations/${rec.id}/close`, {}, t.morgan, 409)
  await h.post(`statements/reconciliations/${rec.id}/resolve`, { line: 4, resolution: 'explain', note: 'again' }, t.morgan, 409)
  await h.post(`statements/${file.id}/reconcile`, open, t.morgan, 409)
  await h.post(`statements/${file.id}/undo`, {}, t.morgan, 409)
  await assert.rejects(h.db.prepare('DELETE FROM c_card_ledger').run(), /permanent/); await assert.rejects(h.db.prepare("UPDATE c_card_ledger SET amount_minor=1").run(), /permanent/)
  await assert.rejects(h.db.prepare('UPDATE c_card_statements SET statement_minor=1').run(), /permanent|keeps/)
  // Every step is a numbered, uneditable history line under the person who took it.
  const lines = (await h.get('history?q=card-statement', h.owner)).lines.filter(l => l.action.startsWith('card-statement-')).toSorted((a, b) => a.seq - b.seq)
  assert.deepEqual(lines.map(l => [l.action, l.actor_email]), [['card-statement-opened', 'morgan@harbourfinch.example'], ['card-statement-difference-resolved', 'morgan@harbourfinch.example'], ['card-statement-difference-resolved', 'morgan@harbourfinch.example'], ['card-statement-closed', 'morgan@harbourfinch.example']])
  assert.equal(h.outbound.length, sent, 'reconciliation made no outbound request')

  // The statement report submits on the owner's schedule like any automatic report; nothing is reimbursable on it.
  await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', perDiem: '75.00', receiptThreshold: '500.00' })
  assert.deepEqual(await h.post('settings/auto-submit', { schedule: 'weekly' }), { schedule: 'weekly' })
  await (await h.mf.getWorker()).scheduled({ scheduledTime: new Date('2026-10-04T22:17:00Z'), cron: '17 * * * *' })
  const submitted = (await h.get('state', t.sam)).claims.filter(c => c.title.startsWith('Card statement'))
  assert.deepEqual(submitted.map(c => [c.title, c.status, c.total_minor]).sort(), [['Card statement · Synthetic Card ····2222 · 2026-09-09', 'submitted', 0], ['Card statement · Synthetic Card ····2222 · 2026-09-30', 'submitted', 0]])
}))

test('FEED-005 a missing charge is added as a card expense on its statement report, a stale or unfooted statement cannot close, and the next statement opens from the previous closing balance', () => withAgency(async (h, t) => {
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
}))

test('ADMIN-001 deactivating an approver or a cardholder hands approvals, reports and unsubmitted card charges to a named successor; an attached private original is detached and stays with the departed person', () => withAgency(async (h, t) => {
  const PRIYA = 'priya@harbourfinch.example', JORDAN = 'jordan@harbourfinch.example', MORGAN = 'morgan@harbourfinch.example'
  const png = text => ({ name: `${text}.png`, source: 'upload', base64: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]).toString('base64') })
  const filed = async (cookie, title) => {
    const c = await h.post('claims', { title }, cookie), up = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...png(title) }, cookie)
    const item = await h.post(`claims/${c.id}/items`, { version: up.claim.version, kind: 'receipt', date: '2026-06-10', merchant: title, amount: '20.00', receipt: up.receipt, allocations: [{ category: t.c.office }], explanation: 'Client work' }, cookie)
    return h.post(`claims/${c.id}/submit`, { version: item.version }, cookie)
  }
  const member = (email, over = {}) => h.post('settings/members', { email, name: email.split('@')[0], employee: true, ...over })
  // Approver: Alex's claim waits on Priya. Deactivation needs a named successor who can take the work.
  const waiting = await filed(t.alex, 'Waiting on Priya')
  assert.equal(waiting.approver_email, PRIYA)
  const priya = { manager: true }
  await member(PRIYA, { ...priya, active: false }, ) .then(() => assert.fail('no successor'), e => assert.match(e.message, /successor[\s\S]*409/))
  await member(PRIYA, { ...priya, active: false, successor: MORGAN }).then(() => assert.fail('finance only'), e => assert.match(e.message, /approver[\s\S]*409/))
  assert.equal((await h.get(`claims/${waiting.id}`, t.priya)).claim.approver_email, PRIYA, 'refused deactivation moved nothing')
  await member(PRIYA, { ...priya, active: false, successor: JORDAN })
  await h.get('state', t.priya, 403)
  const moved = await h.get(`claims/${waiting.id}`, t.jordan)
  assert.equal(moved.claim.approver_email, JORDAN); assert.ok(moved.events.some(e => e.action === 'workflow-review-reassigned' || e.action === 'claim-reassigned'))
  assert.equal((await h.get('state')).members.find(m => m.email === ALEX).approver_email, JORDAN, 'her reports follow the successor')
  await h.post(`claims/${waiting.id}/decision`, { revision: waiting.revision, version: moved.claim.version, decision: 'approved', acknowledge: true }, t.jordan)
  // Cardholder: Sam's posted charge carries an opted-in original attached automatically.
  const r = await original(h, t.sam)
  await choose(h, t, r)
  const job = await statement(h, t, [{}])
  await tick(h)
  assert.ok((await inbox(h, t, r.id)).attachment, 'attached automatically')
  const charge = (await h.get('statements')).charges[0]
  await member(SAM, { approver: undefined, active: false }).then(() => assert.fail('no successor'), e => assert.match(e.message, /successor[\s\S]*409/))
  assert.equal((await h.get(`claims/${job.claims[0]}`, t.sam)).claim.employee_email, SAM)
  await member(SAM, { approver: undefined, active: false, successor: ALEX })
  await h.get('state', t.sam, 403)
  // The charge reached Alex's own statement report without the receipt; the original is still the departed person's, detached on their lifecycle.
  const handed = (await h.get('statements')).charges.find(c => c.id === charge.id)
  assert.equal(handed.employee_email, ALEX); assert.notEqual(handed.claim_id, job.claims[0])
  const alexReport = await h.get(`claims/${handed.claim_id}`, t.alex)
  assert.equal(alexReport.claim.employee_email, ALEX); assert.equal(alexReport.items.length, 1); assert.equal(alexReport.items[0].receipt_id, null); assert.equal(alexReport.items[0].card_charge_id, charge.id)
  assert.equal((await h.get('receipt-inbox', t.alex)).receipts.some(x => x.id === r.id), false, 'the successor never sees the original')
  const lines = (await h.db.prepare('SELECT kind,actor_email,channel FROM c_capture_lifecycle WHERE receipt_id=? ORDER BY sequence').bind(r.id).all()).results
  assert.deepEqual(lines.slice(-2).map(l => l.kind), ['detached', 'match-withdrawn']); assert.equal((await h.db.prepare('SELECT owner_email FROM c_capture_receipts WHERE id=?').bind(r.id).first()).owner_email, SAM)
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_card_handoffs').first()).n, 1)
  const history = JSON.stringify((await h.get('history?q=card-charge-handed-off')).lines)
  assert.ok(history.includes('card-charge-handed-off') && !history.includes(r.id) && !history.includes(r.name) && !history.includes(r.sha256), 'the history line names no original')
  await assert.rejects(h.db.prepare('UPDATE c_card_charges SET amount_minor=1').run(), /immutable/)
  await assert.rejects(h.db.prepare("UPDATE c_card_charges SET employee_email='x@y.example'").run(), /immutable/)
}))

test('FEED-004 a compliant $40 card charge approves independently on a mixed report while its exceptional $40 peer routes to a person and the rule version is sampled',()=>withAgency(async(h,t)=>{
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
}))
