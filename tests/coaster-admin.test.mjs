// ADMIN-001 people, roles, departments and the permission matrix, through the public HTTP API with real native
// sessions, workerd and D1. The matrix journey reads the role permission matrix out of CONTRACT.md itself.
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
const tables = ['c_events', 'c_members', 'c_categories', 'c_policies', 'c_budgets', 'c_cards', 'c_claims', 'c_items', 'c_batches', 'c_approval_workflows', 'c_approval_rules', 'c_departments', 'c_mileage_rates', 'c_allowances',
  'c_escalation_chains', 'c_card_match_rules', 'c_statement_files', 'c_card_charges', 'c_delegates', 'c_requests', 'c_advances', 'c_agent_keys', 'c_proposals', 'c_coding_dimensions', 'c_coding_values', 'c_category_dimensions', 'c_coding_refreshes', 'c_qbo_oauth_states', 'c_qbo_connections']
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

test('ADMIN-001 the permission matrix: each role as a single-role person succeeds at every permitted cell through its public route and is refused every other with 403 and no write', () => {
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
  const doors = [
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
    { row: 'Business settings', prepare: () => owned('Stuck'), call: (who, c) => send(`claims/${c.id}/reassign`, { version: c.version, approver: PRIYA, reason: 'On leave' }, who) },
    { row: 'Business settings', prepare: request, call: (who, r) => send(`requests/${r.id}/reassign`, { version: r.version, approver: PRIYA, reason: 'On leave' }, who) },
    { row: 'Invite people', call: who => send('settings/members', { email: `added-${++n}${domain}`, name: 'Added', employee: true }, who) },
    { row: 'Invite people', prepare: async () => { const email = `invitee-${++n}${domain}`; await h.post('settings/members', { email, name: 'Invitee', employee: true }); return email }, call: (who, email) => send('settings/members/invite', { email }, who) },
    { row: 'Invite people', call: who => send('delegates', { grantor: SAM, delegate: ALEX, level: 'submit' }, who) },
    { row: 'Invite people', prepare: () => h.post('delegates', { grantor: SAM, delegate: ALEX, level: 'submit' }), call: (who, g) => send(`delegates/${g.id}/revoke`, {}, who) },
    { row: 'Policy rules', call: who => send('policy', { rules: [] }, who) },
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
    { row: 'Submit own', call: who => send('expenses', { kind: 'receipt', date: '2026-06-10', merchant: 'Matrix', amount: '5.00', category: t.c.office, explanation: 'Client work' }, who) },
    { row: 'Submit own', call: who => send('requests', { title: `Trip ${++n}`, estimate: '50.00', purpose: 'Client visit' }, who) },
    { row: 'Submit own', call: who => send('advances', { purpose: `Trip ${++n}`, amount: '50.00' }, who) },
    { row: 'Approve, hold', prepare: () => owned('To decide'), call: (who, c) => send(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved', acknowledge: true }, who) },
    { row: 'Approve, hold', prepare: request, call: (who, r) => send(`requests/${r.id}/decision`, { version: r.version, decision: 'approved' }, who) },
    { row: 'Approve, hold', prepare: () => h.post('advances', { purpose: `Trip ${++n}`, amount: '50.00' }, team), call: (who, a) => send(`advances/${a.id}/decision`, { version: a.version, decision: 'approved' }, who) },
    { row: 'Unapprove', prepare: async () => decide(h, cookie.Approver, await owned('To unapprove')), call: (who, c) => send(`claims/${c.id}/unapprove`, { version: c.version, to: 'employee', reason: 'Matrix check' }, who) },
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
  ]
  // Rows whose action has no door in Coaster yet: the clause that adds the door asserts it in its own text and acceptance.
  const noDoor = { 'Connect payment funding account': 'PAY-001', 'Edit coding on submitted or approved expenses': 'ACCT-006', 'See employees\' bank details': 'PAY-002' }
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
})

const BASE = { priya: { employee: true, manager: true }, sam: { employee: true }, alex: { employee: true }, jordan: { employee: true, manager: true, finance: true }, morgan: { employee: true, finance: true } }
/** Saves a person with every field the form carries (a save replaces roles, approving manager and department). */
const place = (h, name, approver, department, flags = BASE[name], extra = {}) => h.post('settings/members', { email: `${name}${domain}`, name, ...flags, approver: approver ? `${approver}${domain}` : undefined, department, ...extra })
/** Sales (head hana), Operations (head jordan) and the hierarchy sam -> priya -> hana -> jordan, with dana in Sales under jordan. */
async function company(h) {
  const hana = await h.person(`hana${domain}`, { employee: true, manager: true }, JORDAN)
  const dana = await h.person(`dana${domain}`, { employee: true }, JORDAN)
  const sales = await h.post('settings/departments', { name: 'Sales', head: `hana${domain}` }), ops = await h.post('settings/departments', { name: 'Operations', head: JORDAN })
  await place(h, 'hana', 'jordan', sales.id, { employee: true, manager: true }); await place(h, 'dana', 'jordan', sales.id, { employee: true })
  await place(h, 'priya', 'hana', sales.id); await place(h, 'sam', 'priya', sales.id); await place(h, 'alex', 'jordan', ops.id)
  return { hana, dana, sales, ops }
}

test('ADMIN-001 departments and hierarchy: spend groups by department with receipt drill-down and a head sees the whole department; a Sales travel budget and a Sales stipend count only Sales', () => withAgency(async (h, t) => {
  await h.post('settings/departments', { name: 'Sales' }, t.sam, 403)
  const { hana, dana, sales, ops } = await company(h)
  await h.post('settings/departments', { name: 'Sales' }, h.owner, 409)
  await h.post('settings/departments', { name: 'Support', head: SAM }, h.owner, 400)
  assert.deepEqual((await h.get('state')).departments.map(d => [d.name, d.head_email, d.members]), [['Operations', JORDAN, 1], ['Sales', `hana${domain}`, 4]])
  // Travel from Sales (sam under priya under hana; dana under jordan), Meals from Sales, and Travel from Operations.
  const filed = []
  filed.push(await submitted(h, t.sam, 'Sales flight', '100.00', t.c.travel), await submitted(h, dana, 'Dana flight', '40.00', t.c.travel), await submitted(h, t.sam, 'Sales lunch', '30.00', t.c.meals), await submitted(h, t.alex, 'Ops flight', '60.00', t.c.travel))
  const range = 'from=2026-01-01&to=2026-12-31'
  const byDepartment = await h.get(`spend?by=department&${range}`, t.jordan)
  assert.deepEqual(byDepartment.groups.map(g => [g.label, g.totalMinor]), [['Sales', 17000], ['Operations', 6000]])
  const drill = await h.get(`spend?by=department&key=${sales.id}&${range}`, t.morgan)
  assert.equal(drill.lines.length, 3); assert.ok(drill.lines.every(l => l.receiptLink))
  assert.equal((await h.mf.dispatchFetch(h.origin + drill.lines[0].receiptLink, { headers: { cookie: t.morgan } })).status, 200, 'the drill-down opens the receipt')
  // The department head's scope is the whole department, wherever its people sit; a manager's is the people below them, however many levels.
  assert.deepEqual((await h.get(`spend?by=department&${range}`, hana)).groups.map(g => [g.label, g.totalMinor]), [['Sales', 17000]])
  assert.deepEqual((await h.get(`spend?by=employee&${range}`, hana)).groups.map(g => g.label).sort(), ['dana', 'sam'])
  assert.deepEqual((await h.get(`spend?by=employee&${range}`, t.priya)).groups.map(g => g.label), ['sam'])
  assert.deepEqual((await h.get(`spend?by=employee&${range}`, h.owner)).groups.map(g => g.label).sort(), ['alex', 'dana', 'sam'])
  // A monthly Travel budget for Sales counts only Sales travel.
  const month = '2026-06'
  await h.post('budgets', { name: 'Sales travel', scope: 'department', scopeKey: ops.id, category: t.c.travel, period: 'monthly', amount: '1000.00', owner: JORDAN }, t.morgan, 200)
  await h.post('budgets', { name: 'Bad', scope: 'department', scopeKey: 'nope', period: 'monthly', amount: '1.00', owner: JORDAN }, t.morgan, 400)
  const budgets = await h.get(`budgets?day=${month}-15`, t.morgan)
  assert.equal(budgets.find(b => b.name === 'Sales travel').actualMinor, 6000, 'a budget for Operations travel counts only Operations travel')
  await h.post('budgets', { name: 'Sales travel real', scope: 'department', scopeKey: sales.id, category: t.c.travel, period: 'monthly', amount: '1000.00', owner: JORDAN }, t.morgan)
  assert.equal((await h.get(`budgets?day=${month}-15`, t.morgan)).find(b => b.name === 'Sales travel real').actualMinor, 14000, 'Sales travel only: no Sales meals, no Operations travel')
  // A $75 monthly phone stipend for Sales pays Sales members only.
  await h.post('allowances', { name: 'Phone stipend', type: 'stipend', department: sales.id, member: SAM, category: t.c.office, period: 'monthly', amount: '75.00', tax: 'accountable', startsOn: '2026-06-01' }, t.morgan, 400)
  await h.post('allowances', { name: 'Phone stipend', type: 'stipend', department: 'nope', category: t.c.office, period: 'monthly', amount: '75.00', tax: 'accountable', startsOn: '2026-06-01' }, t.morgan, 400)
  await h.post('allowances', { name: 'Phone stipend', type: 'stipend', department: sales.id, category: t.c.office, period: 'monthly', amount: '75.00', tax: 'accountable', startsOn: '2026-06-01' }, t.sam, 403)
  await h.post('allowances', { name: 'Phone stipend', type: 'stipend', department: sales.id, category: t.c.office, period: 'monthly', amount: '75.00', tax: 'accountable', startsOn: '2026-06-01' }, t.morgan)
  await (await h.mf.getWorker()).scheduled({ scheduledTime: new Date('2026-06-02T01:17:00Z'), cron: '17 * * * *' })
  const paid = (await h.get('state')).claims.filter(c => c.title.startsWith('Phone stipend')).map(c => [c.employee_name, c.total_minor]).sort()
  assert.deepEqual(paid, [['dana', 7500], ['hana', 7500], ['priya', 7500], ['sam', 7500]], 'only the four Sales members are paid; Operations is not')
}))

test('ADMIN-001 FOLLOWUP-002 an approval past its service level escalates along finance\'s chain for the department, the head then a named finance approver, each step recorded', () => withAgency(async (h, t) => {
  const { sales } = await company(h)
  const steps = [{ kind: 'department-head' }, { kind: 'finance', email: MORGAN }]
  await h.post('settings/escalation-chains', { department: sales.id, steps }, t.sam, 403)
  await h.post('settings/escalation-chains', { department: sales.id, steps: [...steps, { kind: 'manager' }] }, t.morgan, 400)
  await h.post('settings/escalation-chains', { department: sales.id, steps: [{ kind: 'finance', email: PRIYA }] }, t.morgan, 400)
  await h.post('settings/escalation-chains', { department: 'nope', steps }, t.morgan, 400)
  const saved = await h.post('settings/escalation-chains', { department: sales.id, steps }, t.morgan)
  assert.deepEqual(saved.map(c => [c.department_id, c.version, c.steps.map(s => s.kind)]), [[sales.id, 1, ['department-head', 'finance']]])
  await h.post('settings/reminders', { days: '2, 5, 10', quietFrom: '20', quietUntil: '8', serviceLevel: '3', escalateAfter: '2' }, t.jordan)
  const pending = await submitted(h, t.sam, 'Hotel', '150.00', t.c.travel)
  const sydney = (day, hour) => {
    const guess = Date.parse(`${day}T${String(hour).padStart(2, '0')}:17:00Z`)
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map(x => [x.type, x.value]))
    return new Date(guess - (Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - guess))
  }
  const worker = await h.mf.getWorker()
  const tick = async day => { const before = h.messages.length; await worker.scheduled({ scheduledTime: sydney(day, 9), cron: '17 * * * *' }); return h.messages.slice(before).filter(m => m.subject.startsWith('Escalated: ')).map(m => [m.to, m.subject]) }
  const decideSubject = `Escalated: Decide CL-${String(pending.number).padStart(4, '0')}`
  // Priya owes the decision. Seen 2 November; the fourth business day escalates to her department head, two more to the named finance approver.
  assert.deepEqual(await tick('2026-11-02'), []); assert.deepEqual(await tick('2026-11-05'), [])
  assert.deepEqual(await tick('2026-11-06'), [[[`hana${domain}`], decideSubject]])
  assert.deepEqual(await tick('2026-11-10'), [[[MORGAN], decideSubject]])
  const history = (await h.get(`claims/${pending.id}`, t.jordan)).events.filter(e => e.action === 'escalated').map(e => [e.detail.level, e.detail.to, e.detail.chain.step, e.detail.chain.version, e.detail.owedBy])
  assert.deepEqual(history, [[1, [`hana${domain}`], 'department-head', 1, PRIYA], [2, [MORGAN], 'finance', 1, PRIYA]])
  // Saving a new chain is a new version; Operations, with no chain of its own, keeps the approving manager then finance.
  await h.post('settings/escalation-chains', { department: sales.id, steps: [{ kind: 'manager' }] }, h.owner)
  assert.equal((await h.get('state', t.morgan)).escalationChains.find(c => c.department_id === sales.id).version, 2)
}))

test('ADMIN-001 APPROVE-001 a department condition and department-head or manager\'s-manager steps route a $1,400 claim through the actual hierarchy and refuse self-approval at every level', () => withAgency(async (h, t) => {
  const HANA = `hana${domain}`
  const hana = await h.person(HANA, { employee: true, manager: true }, JORDAN)
  const sales = await h.post('settings/departments', { name: 'Sales', head: JORDAN }), ops = await h.post('settings/departments', { name: 'Operations', head: HANA })
  await place(h, 'hana', 'jordan', sales.id, { employee: true, manager: true }); await place(h, 'priya', 'hana', sales.id); await place(h, 'sam', 'priya', sales.id); await place(h, 'alex', 'priya', ops.id)
  const rules = [
    { label: 'Large Sales spend', condition: { kind: 'amount', value: '1000.00' }, stages: [[{ kind: 'managers-manager' }], [{ kind: 'department-head' }]] },
    { label: 'Operations head sees Operations', condition: { kind: 'department', value: ops.id }, stages: [[{ kind: 'department-head' }]] },
  ]
  await h.post('settings/approval-workflow', { version: 0, rules: [{ ...rules[1], condition: { kind: 'department', value: 'nope' } }] }, h.owner, 400)
  await h.post('settings/approval-workflow', { version: 0, rules }, t.sam, 403)
  await h.post('settings/approval-workflow', { version: 0, rules }, h.owner)
  const waitingOn = async (id) => (await h.get(`claims/${id}`, h.owner)).claim.approver_email
  const step = async (c, cookie, status = 200) => h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved', acknowledge: true }, cookie, status)
  // $1,400 from sam: priya (manager), then hana (manager's manager), then jordan (department head); nobody out of turn.
  let big = await submitted(h, t.sam, 'Sales trip', '1400.00', t.c.travel)
  assert.equal(await waitingOn(big.id), PRIYA)
  await step(big, t.jordan, 403); await step(big, await h.person(`nobody${domain}`, { employee: true }, PRIYA), 403)
  big = await step(big, t.priya); assert.equal(await waitingOn(big.id), HANA)
  await step(big, t.priya, 403)
  big = await step(big, hana); assert.equal(await waitingOn(big.id), JORDAN)
  big = await step(big, t.jordan); assert.equal(big.status, 'approved')
  // $900 from sam stops at priya; Operations spend adds the Operations head (hana) after priya.
  const small = await submitted(h, t.sam, 'Sales lunch', '900.00', t.c.travel)
  assert.equal((await step(small, t.priya)).status, 'approved')
  const ops200 = await submitted(h, t.alex, 'Ops tools', '200.00', t.c.travel)
  assert.equal((await step(ops200, t.priya)).status, 'submitted'); assert.equal(await waitingOn(ops200.id), HANA)
  // Self-approval is refused at every level: the head of Operations filing an Operations claim would approve at the department-head step,
  // and a manager whose own manager reports to her would approve at the manager's-manager step.
  await place(h, 'hana', 'jordan', ops.id, { employee: true, manager: true })
  await submitted(h, hana, 'Head filing in Operations', '200.00', t.c.travel).then(() => assert.fail('self'), e => assert.match(e.message, /Nobody approves their own/))
  await place(h, 'hana', 'priya', sales.id, { employee: true, manager: true })
  await submitted(h, hana, 'Manager loop $1,400', '1400.00', t.c.travel).then(() => assert.fail('self'), e => assert.match(e.message, /Nobody approves their own/))
}))
