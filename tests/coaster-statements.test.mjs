// FEED-002 statement-file import and the FEED-004 card-expense gates, through the public HTTP API with real native
// sessions, workerd and D1. Fixtures are synthetic; no outbound request is made.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness } from './harness.mjs'

const SAM = 'sam@harbourfinch.example', ALEX = 'alex@harbourfinch.example', ISSUER = 'Synthetic Card'
const fixture = name => readFile(`tests/fixtures/statements/${name}`, 'utf8')
async function withAgency(run) { const h = await harness(); try { await run(h, await agency(h)) } finally { await h.close() } }

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
