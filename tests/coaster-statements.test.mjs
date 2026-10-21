// FEED-002 statement-file import and the FEED-004 card-expense gates, through the public HTTP API with real native
// sessions, workerd and D1. Fixtures are synthetic; no outbound request is made.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness } from './harness.mjs'

const SAM = 'sam@harbourfinch.example', ALEX = 'alex@harbourfinch.example', ISSUER = 'Synthetic Card'
const FULL = ['4111111111111111', '4111 1111 1111 1111', '5500 0000 0000 0004', '5500000000000004']
const fixture = name => readFile(`tests/fixtures/statements/${name}`, 'utf8')
const sum = (csv, column) => { const [head, ...rows] = csv.trim().split('\r\n').map(r => r.split('","').map(x => x.replace(/^"|"$/g, ''))); const i = head.indexOf(column); return Math.round(rows.reduce((n, r) => n + Number(r[i]) * 100, 0)) }
async function withAgency(run) { const h = await harness(); try { await run(h, await agency(h)) } finally { await h.close() } }
const ofx = async (extra = {}) => ({ format: 'ofx', name: 'october.ofx', issuer: ISSUER, content: await fixture('synthetic-card.ofx'), ...extra })
const edit = (h, cookie, claim, item, over = {}) => h.post(`claims/${claim.id}/items`, { version: claim.version, item: item.id, kind: 'receipt', date: item.spent_on, merchant: item.merchant, amount: (item.amount_minor / 100).toFixed(2), category: item.allocations[0].category_id, ...over }, cookie)

test('FEED-002 FEED-004 a statement file posts company-card expenses that are never reimbursed, immutable, keyed by the card transaction and blocked as out-of-pocket duplicates', () => withAgency(async (h, t) => {
  const sent = h.outbound.length, base = await ofx({ category: t.c.office })
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
  assert.equal(d.claim.title, 'Expenses · 2026-10'); assert.equal(d.claim.status, 'draft'); assert.equal(d.items.length, 3)
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
  await h.post('expenses', { kind: 'receipt', date: '2026-10-09', merchant: 'Taxi', amount: '30.00', category: t.c.travel, explanation: 'No receipt' }, t.sam)
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
  const sub2 = await h.post(`claims/${dup.id}/submit`, { version: withDup.version }, t.sam)
  const ok2 = await h.post(`claims/${dup.id}/decision`, { revision: sub2.revision, version: sub2.version, decision: 'approved', acknowledge: true }, t.priya)
  const refused = await h.send('/api/coaster/batches', { claims: [ok2.id] }, t.morgan)
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
  assert.equal(h.outbound.length, sent, 'statement import made no outbound request')
}))
