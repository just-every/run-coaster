import { preserveAdministration } from './journeys/specialized-admin.mjs'
import { preserveSuccessorHandoff } from './journeys/specialized-handoff.mjs'
// ADMIN-001 people, roles, departments and the permission matrix, through the public HTTP API with real native
// sessions, workerd and D1. The matrix journey reads the role permission matrix out of CONTRACT.md itself.
import { createHash, generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness } from './harness.mjs'
import { qboFixture } from './fixtures/qbo.mjs'

const SAM = 'sam@harbourfinch.example', ALEX = 'alex@harbourfinch.example', PRIYA = 'priya@harbourfinch.example', MORGAN = 'morgan@harbourfinch.example', JORDAN = 'jordan@harbourfinch.example'
const domain = '@harbourfinch.example'
async function withAgency(run, options = {}) { const h = await harness(options); try { await run(h, await agency(h)) } finally { await h.close() } }

let counter = 0
const png = text => ({ name: `${text}.png`, source: 'upload', base64: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]).toString('base64') })
async function addExpense(h, cookie, c, merchant, amount, category, extra = {}) {
  const up = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...png(`receipt-${++counter}`) }, cookie)
  return h.post(`claims/${c.id}/items`, { version: up.claim.version, kind: 'receipt', date: '2026-06-10', merchant, amount, receipt: up.receipt, allocations: [{ category }], explanation: 'Client work', ...extra }, cookie)
}
async function submitted(h, cookie, title, amount, category, extra) {
  const c = await addExpense(h, cookie, await h.post('claims', { title }, cookie), title, amount, category, extra)
  return h.post(`claims/${c.id}/submit`, { version: c.version }, cookie)
}
const decide = (h, cookie, c, extra = {}, status = 200) => h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved', acknowledge: true, ...extra }, cookie, status)
const tables = ['c_events', 'c_members', 'c_categories', 'c_policies', 'c_budgets', 'c_cards', 'c_claims', 'c_items', 'c_batches', 'c_approval_workflows', 'c_approval_rules', 'c_approval_envelopes', 'c_departments', 'c_mileage_rates', 'c_allowances',
  'c_escalation_chains', 'c_card_match_rules', 'c_statement_files', 'c_card_charges', 'c_delegates', 'c_requests', 'c_advances', 'c_agent_keys', 'c_proposals', 'c_coding_dimensions', 'c_coding_values', 'c_category_dimensions', 'c_coding_refreshes', 'c_qbo_oauth_states', 'c_qbo_connections',
  'c_bank_accounts', 'c_bank_settings', 'c_bank_providers',
  'c_receipt_reading_settings', 'c_receipt_readings', 'c_receipt_reading_match_defaults', 'c_program_feeds', 'c_program_deliveries',
  'c_coding_corrections', 'c_batch_coding', 'c_auto_coding_rules', 'c_auto_coding_contexts', 'c_auto_coding_suggestions', 'c_auto_coding_feedback', 'c_auto_coding_observations', 'c_auto_coding_flags']
const snapshot = h => h.db.prepare(`SELECT ${tables.map(t => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(',')}`).first()

/** The role permission matrix in CONTRACT.md: each row's label and, per role, its cell text ('' is refused). */
async function matrix() {
  const text = (await readFile('CONTRACT.md', 'utf8')).split('**Role permission matrix (ADMIN-001).**')[1].split('\n')
  const rows = []
  const start = text.findIndex(l => l.startsWith('|')), end = text.findIndex((l, i) => i > start && !l.startsWith('|'))
  for (const line of text.slice(start + 2, end)) rows.push(line.split('|').slice(1, -1).map(c => c.trim()))
  const roles = ['Owner', 'Admin', 'Finance', 'Card admin', 'Approver', 'Employee', 'Auditor', 'Bookkeeper']
  return rows.map(([label, ...cells]) => ({ label, cells: Object.fromEntries(roles.map((r, i) => [r, cells[i]])) }))
}

/** A one-purchase credit-card statement (OFX 1.x) on a card known only by its last four, unique per call. */
const statement = (n, category) => ({ format: 'ofx', name: `matrix-${n}.ofx`, issuer: 'Synthetic Card', category, content: ['OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'SECURITY:NONE', 'ENCODING:USASCII', 'CHARSET:1252', 'COMPRESSION:NONE', 'OLDFILEUID:NONE', 'NEWFILEUID:NONE', '',
  '<OFX>', '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20260630120000<LANGUAGE>ENG</SONRS></SIGNONMSGSRSV1>',
  '<CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>', '<CCSTMTRS><CURDEF>AUD', '<CCACCTFROM><ACCTID>************7001</CCACCTFROM>', '<BANKTRANLIST><DTSTART>20260601<DTEND>20260630',
  `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260610<TRNAMT>-${(10 + n).toFixed(2)}<FITID>MATRIX-${n}<NAME>Matrix supplies ${n}</STMTTRN>`, '</BANKTRANLIST>',
  `<LEDGERBAL><BALAMT>-${(10 + n).toFixed(2)}<DTASOF>20260630</LEDGERBAL>`, '</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>', ''].join('\n') })

test('ADMIN-001 the permission matrix: each role as a single-role person succeeds at every permitted cell through its public route and is refused every other with 403 and no write', async () => {
  await preserveAdministration()
  await preserveSuccessorHandoff()
  await (() => {
 const qbo = qboFixture()
 return withAgency(async (h, t) => {
  const cookie = { Owner: h.owner }
  // One person holding only each role, under the existing three-level hierarchy (jordan, priya, then each person).
  for (const [role, flags] of [['Admin', { admin: true }], ['Finance', { finance: true }], ['Card admin', { cardAdmin: true }], ['Approver', { manager: true }], ['Employee', { employee: true }], ['Auditor', { auditor: true }], ['Bookkeeper', { bookkeeper: true }]])
    cookie[role] = await h.person(`${role.toLowerCase().replace(' ', '-')}-only${domain}`, flags, PRIYA)
  await h.post('settings/members', { email: `finance-only${domain}`, name: 'finance', finance: true, release: true, approver: PRIYA })
  // The owner submits their own expenses too, so the owner's record names an approving manager.
  await h.post('settings/members', { email: 'owner@harbourfinch.example', name: 'Rose', employee: true, approver: PRIYA })
  const APPROVER = `approver-only${domain}`
  const team = await h.person(`team${domain}`, { employee: true }, APPROVER)
  await h.post('statements/cards', { issuer: 'Synthetic Card', last4: '7001', employee: SAM })
  const hasRoute = new Set()
  let n = 0
  const send = (path, body, who) => h.send(`/api/coaster/${path}`, body, who)
  const owned = async (title, who = team) => submitted(h, who, title, '20.00', t.c.office)
  const approvedBy = async (title, who) => decide(h, who, await owned(title, who === cookie.Approver ? team : t.sam))
  const batchOf = async () => h.post('batches', { claims: [(await approvedBy(`Batch ${++n}`, t.priya)).id] }, h.owner)
  const reviewed = async () => { const b = await batchOf(); return h.post(`batches/${b.id}/approve`, { version: b.version, expectedTotal: 2000 }, h.owner) }
  const request = async () => h.post('requests', { title: `Trip ${++n}`, estimate: '50.00', purpose: 'Client visit' }, team)
  const previewed = async () => { const body = statement(++n, t.c.office); return { ...body, fingerprint: (await h.post('statements/preview', body)).fingerprint } }
  const range = 'from=2026-01-01&to=2026-12-31'
  const connectQbo = async () => { const start = await h.post('accounting/qbo/connect', { consent: true }); assert.equal((await h.send(qbo.callback(start.authorizationUrl), undefined, h.owner)).status, 303) }
  const codingDimension = async () => (await h.post('coding/dimensions', { version: (await h.get('coding')).version, name: `synthetic-coaster-${1000 + ++n}`, kind: 'tag' })).saved
  const feedConfig = { consent: true, host: '8.8.8.8', port: 22, username: 'synthetic-coaster-9000', privateKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' }).toString(), hostKeyFingerprint: 'SHA256:' + createHash('sha256').update('synthetic-coaster-9001').digest('base64').replace(/=+$/, ''), directory: '/synthetic-coaster-9002', issuer: 'Matrix card program', category: t.c.office, intervalMinutes: 60, mapping: { dateFormat: 'YYYY-MM-DD', sign: 'purchases-positive', postedDate: 'Date', transactionId: 'Transaction', description: 'Merchant', amount: 'Amount', card: 'Card', sequence: 'Sequence' } }
  const doors = [
    { row: 'Business settings', call: async who => send('settings/receipt-reading', { version: (await h.get('settings/receipt-reading')).version, enabled: false, consent: false }, who) },
    { row: 'Connect feeds', call: who => send('feeds/program', feedConfig, who) },
    { row: 'Connect feeds', prepare: () => h.post('feeds/program', feedConfig), call: (who, feed) => send(`feeds/program/${feed.id}/disconnect`, { version: feed.version, consent: true }, who) },
    { row: 'Business settings', call: async who => send('coding/dimensions', { version: (await h.get('coding')).version, name: `synthetic-coaster-${1000 + ++n}`, kind: 'tag' }, who) },
    { row: 'Business settings', prepare: codingDimension, call: async (who, dimension) => send('coding/values', { version: (await h.get('coding')).version, dimension, name: `synthetic-coaster-${1000 + ++n}` }, who) },
    { row: 'Business settings', prepare: codingDimension, call: async (who, dimension) => send('coding/requirements', { version: (await h.get('coding')).version, category: t.c.office, dimensions: [{ dimension, required: false }] }, who) },
    { row: 'Business settings', call: async who => send('coding/import', { version: (await h.get('coding')).version, csv: `dimension,parentDimension,kind,required,value,parentValue,owner\nsynthetic-coaster-${1000 + ++n},,tag,false,synthetic-coaster-${1000 + ++n},,` }, who) },
    { row: 'Connect feeds', call: who => send('accounting/qbo/connect', { consent: true }, who) },
    { row: 'Connect feeds', prepare: connectQbo, call: async who => send('accounting/qbo/disconnect', { consent: true, version: (await h.get('accounting/qbo')).version }, who) },
    { row: 'Run a manual ledger sync', prepare: connectQbo, call: who => send('accounting/qbo/refresh', {}, who) },
    { row: 'Business settings', call: who => send('settings/business', { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', perDiem: '75.00', receiptThreshold: '' }, who) },
    { row: 'Business settings', call: async who => send('settings/approval-workflow', { version: (await h.get('state')).approvalWorkflow?.version ?? 0, rules: [] }, who) },
    { row: 'Business settings', call: who => send('settings/categories', { name: `Category ${++n}`, accountCode: '6900', taxCode: 'GST' }, who) },
    { row: 'Business settings', call: who => send('settings/mileage-rates', { effectiveFrom: `2025-01-${String(++n % 28 + 1).padStart(2, '0')}`, rate: '0.70' }, who) },
    { row: 'Business settings', call: who => send('settings/auto-submit', { schedule: 'daily' }, who) },
    { row: 'Business settings', call: who => send('settings/departments', { name: `Department ${++n}` }, who) },
    { row: 'Business settings', call: who => send('settings/approval-rule', { enabled: false }, who) },
    { row: 'Grant or revoke policy agent', call: async who => send('settings/approval-envelope', {version:(await h.get('state')).approvalEnvelope?.version??0,enabled:false,consent:false},who) },
    { row: 'Business settings', prepare: () => owned('Stuck'), call: (who, c) => send(`claims/${c.id}/reassign`, { version: c.version, approver: PRIYA, reason: 'On leave' }, who) },
    { row: 'Business settings', prepare: request, call: (who, r) => send(`requests/${r.id}/reassign`, { version: r.version, approver: PRIYA, reason: 'On leave' }, who) },
    { row: 'Invite people', call: who => send('settings/members', { email: `added-${++n}${domain}`, name: 'Added', employee: true }, who) },
    { row: 'Invite people', prepare: async () => { const email = `invitee-${++n}${domain}`; await h.post('settings/members', { email, name: 'Invitee', employee: true }); return email }, call: (who, email) => send('settings/members/invite', { email }, who) },
    { row: 'Invite people', call: who => send('delegates', { grantor: SAM, delegate: ALEX, level: 'submit' }, who) },
    { row: 'Invite people', prepare: () => h.post('delegates', { grantor: SAM, delegate: ALEX, level: 'submit' }), call: (who, g) => send(`delegates/${g.id}/revoke`, {}, who) },
    { row: 'Policy rules', call: who => send('policy', { rules: [] }, who) },
    { row: 'Policy rules', call: async who => send('coding/automatic/rules', { version: (await h.get('coding/automatic/rules')).version, scope: 'finance', merchant: `synthetic-coaster-${2000 + ++n}`, coding: { category: t.c.office }, active: true }, who) },
    { row: 'Policy rules', call: async who => send('coding/automatic/mcc', { version: (await h.get('coding/automatic/rules')).version, mcc: String(1000 + ++n), category: t.c.office, active: true }, who) },
    { row: 'Policy rules', call: who => send('coding/automatic/rates', undefined, who) },
    { row: 'Policy rules', call: who => send('budgets', { name: `Budget ${++n}`, scope: 'entity', period: 'monthly', amount: '5000.00', owner: SAM, thresholds: '80, 100' }, who) },
    { row: 'Policy rules', call: who => send('budgets/import', { csv: `name,scope,scopeKey,period,amount,owner,thresholds,perMember,policyRule\nImported ${++n},entity,,yearly,9000.00,${SAM},100,no,no\n` }, who) },
    { row: 'Policy rules', call: who => send('allowances', { name: `Stipend ${++n}`, type: 'stipend', member: SAM, category: t.c.office, period: 'monthly', amount: '10.00', tax: 'accountable', startsOn: '2026-06-01' }, who) },
    { row: 'Policy rules', call: who => send('settings/escalation-chains', { steps: [{ kind: 'manager' }] }, who) },
    { row: 'Policy rules', call: async who => send('settings/card-matching', { version: (await h.get('settings/card-matching')).version, enabled: true, windowDays: 7, tipPercent: 20, fxPercent: 5 }, who) },
    { row: 'Connect feeds', call: who => send('statements/preview', statement(++n, t.c.office), who) },
    { row: 'Connect feeds', prepare: previewed, call: (who, body) => send('statements/commit', body, who) },
    { row: 'Connect feeds', prepare: async () => h.post('statements/commit', await previewed()), call: (who, job) => send(`statements/${job.file}/undo`, {}, who) },
    { row: 'Issue, limit, freeze', call: who => send('statements/cards', { issuer: 'Synthetic Card', last4: '1111', employee: SAM }, who) },
    { row: 'Submit own', call: who => send('claims', { title: 'Mine' }, who) },
    { row: 'Submit own', call: async who => send('coding/automatic/rules', { version: (await h.get('coding/automatic/rules')).version, scope: 'personal', merchant: `synthetic-coaster-${2000 + ++n}`, coding: { category: t.c.office }, active: true }, who) },
    { row: 'Submit own', call: who => send('coding/automatic/preview', { merchant: 'synthetic-coaster-3000', values: {} }, who) },
    { row: 'Submit own', call: who => send('expenses', { kind: 'receipt', date: '2026-06-10', merchant: 'Matrix', amount: '5.00', category: t.c.office, explanation: 'Client work' }, who) },
    { row: 'Submit own', call: who => send('requests', { title: `Trip ${++n}`, estimate: '50.00', purpose: 'Client visit' }, who) },
    { row: 'Submit own', call: who => send('advances', { purpose: `Trip ${++n}`, amount: '50.00' }, who) },
    { row: 'Approve, hold', prepare: () => owned('To decide'), call: (who, c) => send(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved', acknowledge: true }, who) },
    { row: 'Approve, hold', prepare: request, call: (who, r) => send(`requests/${r.id}/decision`, { version: r.version, decision: 'approved' }, who) },
    { row: 'Approve, hold', prepare: () => h.post('advances', { purpose: `Trip ${++n}`, amount: '50.00' }, team), call: (who, a) => send(`advances/${a.id}/decision`, { version: a.version, decision: 'approved' }, who) },
    { row: 'Unapprove', prepare: async () => decide(h, cookie.Approver, await owned('To unapprove')), call: (who, c) => send(`claims/${c.id}/unapprove`, { version: c.version, to: 'employee', reason: 'Matrix check' }, who) },
    { row: 'Edit coding on submitted', prepare: () => owned('Account correction'), call: async (who,c) => { const d=await h.get(`claims/${c.id}`);return send(`claims/${c.id}/coding-corrections`,{version:c.version,revision:c.revision,item:d.items[0].id,allocation:0,sequence:0,accountCode:'6990',reason:'Matrix correction'},who) } },
    // Reads. A limited cell is driven inside its limit (scoped) or, where the door lies outside it, refused (outside).
    { row: 'Read all claims', prepare: async () => ({ routed: await owned('Routed to the approver'), mine: await submitted(h, cookie.Employee, 'My own', '10.00', t.c.office) }), call: (who, c) => send(`claims/${c.routed.id}`, undefined, who),
      scoped: { Employee: (who, c) => send(`claims/${c.mine.id}`, undefined, who) }, outside: ['Card admin'] },
    { row: 'Read all claims', prepare: async () => { const routed = await owned('Receipt to read'), mine = await submitted(h, cookie.Employee, 'My receipt', '10.00', t.c.office); const receipt = async c => (await h.get(`claims/${c.id}`)).items[0].receipt_id; return { routed: await receipt(routed), mine: await receipt(mine) } },
      call: (who, r) => send(`receipts/${r.routed}`, undefined, who), scoped: { Employee: (who, r) => send(`receipts/${r.mine}`, undefined, who) }, outside: ['Card admin'] },
    { row: 'Read all claims', prepare: reviewed, call: (who, b) => send(`batches/${b.id}`, undefined, who), outside: ['Card admin', 'Approver', 'Employee'] },
    { row: 'Read all claims', call: who => send('statements', undefined, who), outside: ['Approver', 'Employee'] },
    { row: 'Read all claims', call: who => send('statements/reconciliations', undefined, who), outside: ['Approver', 'Employee'] },
    { row: 'Create and review', prepare: async () => (await approvedBy(`Batch ${++n}`, t.priya)).id, call: (who, id) => send('batches', { claims: [id] }, who) },
    { row: 'Create and review', prepare: () => batchOf(), call: (who, b) => send(`batches/${b.id}/approve`, { version: b.version, expectedTotal: 2000 }, who) },
    { row: 'Create and review', prepare: async () => { const pair = [(await approvedBy(`Pair ${++n}`, t.priya)).id, (await approvedBy(`Pair ${++n}`, t.priya)).id]; return { batch: await h.post('batches', { claims: pair }, h.owner), claim: pair[0] } },
      call: (who, x) => send(`batches/${x.batch.id}/remove`, { version: x.batch.version, claim: x.claim }, who) },
    { row: 'Release payments', prepare: reviewed, call: (who, b) => send(`batches/${b.id}/release`, { version: b.version }, who) },
    { row: 'Export reports', call: who => send(`exports/reimbursements.csv?${range}`, undefined, who), scoped: { Approver: who => send(`spend?by=employee&${range}`, undefined, who) } },
    { row: 'Export reports', call: who => send(`exports/accounting.csv?${range}`, undefined, who), scoped: { Approver: who => send(`spend?by=category&${range}`, undefined, who) } },
    { row: 'Export reports', prepare: reviewed, call: (who, b) => send(`batches/${b.id}/accounting.csv`, undefined, who), outside: ['Approver'] },
    { row: 'Export reports', call: who => send(`reports/aging?${range}`, undefined, who), outside: ['Approver'] },
    { row: 'Export audit packs', call: who => send(`audit-pack?${range}`, undefined, who) },
    { row: 'Read full history', call: who => send('history', undefined, who) },
    { row: 'See employees\' bank details', call: who => send(['bank', 'people'].join('/'), undefined, who), scoped: { Employee: who => send('bank', undefined, who) } },
  ]
  // Rows whose action has no door in Coaster yet: the clause that adds the door asserts it in its own text and acceptance.
  const noDoor = { 'Connect payment funding account': 'PAY-001' }
  const rows = await matrix()
  for (const row of rows) assert.ok(row.label in noDoor || doors.some(d => row.label.startsWith(d.row)), `matrix row "${row.label}" has a door in this journey or is named as having none`)
  for (const label of Object.keys(noDoor)) assert.ok(rows.some(r => r.label === label))
  const ok = r => r.status >= 200 && r.status < 300
  for (const door of doors) {
    const row = rows.find(r => r.label.startsWith(door.row))
    for (const role of Object.keys(row.cells)) {
      const cell = row.cells[role], limited = cell !== '' && !cell.startsWith('✓'), allowed = cell !== '' && !(limited && door.outside?.includes(role))
      const call = limited && door.scoped?.[role] ? door.scoped[role] : door.call
      const target = door.prepare ? await door.prepare() : undefined
      const before = allowed ? null : await snapshot(h), r = await call(cookie[role], target)
      if (allowed) assert.ok(ok(r), `${role} should succeed at "${row.label}" (${door.row}): ${r.status} ${r.text?.slice(0, 160)}`)
      else { assert.equal(r.status, 403, `${role} must be refused "${row.label}": ${r.status} ${r.text?.slice(0, 120)}`); assert.deepEqual(await snapshot(h), before, `${role} refused "${row.label}" with no write`) }
      hasRoute.add(row.label)
    }
  }
  assert.equal(hasRoute.size + Object.keys(noDoor).length, rows.length)
  // Agent routes follow the same rows: a key acts inside its person's row, and a person who cannot submit cannot hold one.
  const approved = (await approvedBy(`Agent batch ${++n}`, t.priya)).id
  for (const role of ['Admin', 'Finance', 'Card admin', 'Approver', 'Employee', 'Auditor', 'Bookkeeper']) {
    const before = await snapshot(h), key = await send('agent-keys', { label: `${role} agent` }, cookie[role])
    if (['Auditor', 'Bookkeeper'].includes(role)) { assert.equal(key.status, 403, `${role} holds no agent key`); assert.deepEqual(await snapshot(h), before); continue }
    assert.equal(key.status, 200)
    const bearer = { authorization: `Bearer ${key.value.token}` }
    assert.equal((await h.send('/api/coaster/agent/claims', { title: 'Agent draft', items: [{ kind: 'receipt', date: '2026-06-10', merchant: 'Agent', amount: '5.00', category: t.c.office }] }, '', bearer)).status, 200, `${role}'s agent prepares a draft (Submit row)`)
    const mid = await snapshot(h), batch = await h.send('/api/coaster/agent/batches', { claims: [approved] }, '', bearer)
    if (role === 'Finance') assert.equal(batch.status, 200, 'finance\'s agent proposes a batch')
    else { assert.equal(batch.status, 403, `${role}'s agent cannot propose a batch`); assert.deepEqual(await snapshot(h), mid) }
  }
  // A person's powers are the union of their roles: finance plus approver gets both rows, and separation still holds.
  const both = await h.person(`both${domain}`, { finance: true, manager: true }, PRIYA)
  const own = await submitted(h, both, 'Own claim', '30.00', t.c.office)
  assert.equal((await send(`claims/${own.id}/decision`, { revision: own.revision, version: own.version, decision: 'approved', acknowledge: true }, both)).status, 403, 'nobody approves their own claim, whatever their roles')
  await h.post('settings/members', { email: `team${domain}`, name: 'team', employee: true, approver: `both${domain}` })
  const second = await submitted(h, team, 'Routed to the combined person', '30.00', t.c.office)
  assert.equal((await send('batches', { claims: [(await approvedBy('Union batch', t.priya)).id] }, both)).status, 200, 'finance row')
  assert.equal((await send(`claims/${second.id}/decision`, { revision: second.revision, version: second.version, decision: 'approved', acknowledge: true }, both)).status, 200, 'approver row')
  // Limits inside permitted cells: an approver reads only routed claims, an employee only their own, a card admin no claims at all.
  const foreign = await submitted(h, t.sam, 'Someone else\'s', '12.00', t.c.office)
  for (const role of ['Approver', 'Employee', 'Card admin']) assert.equal((await send(`claims/${foreign.id}`, undefined, cookie[role])).status, 403)
  // The owner's own record and delegates are the owner's alone; release access is the owner's to give.
  assert.equal((await send('settings/members', { email: 'owner@harbourfinch.example', name: 'Rose', employee: true }, cookie.Admin)).status, 403)
  assert.equal((await send('delegates', { grantor: 'owner@harbourfinch.example', delegate: ALEX, level: 'full' }, cookie.Admin)).status, 403)
  assert.equal((await send('settings/members', { email: MORGAN, name: 'morgan', employee: true, finance: true, release: true, approver: PRIYA }, cookie.Admin)).status, 403)
 }, { qboEdge: qbo.fetch, bindings: qbo.bindings })
})()
})