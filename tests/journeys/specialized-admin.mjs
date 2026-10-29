// Preserved native HTTP assertion phases; callers own test registration.
// Department, hierarchy and escalation phases retain their native-session D1 harness.
import assert from 'node:assert/strict'
import { agency, harness } from '../harness.mjs'

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

// Original assertion phase: ADMIN-001 departments and hierarchy: spend groups by department with receipt drill-down and a head sees the whole department; a Sales travel budget and a Sales stipend count only Sales
export const departmentSpendBudgetAllowance = () => withAgency(async (h, t) => {
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
})

// Original assertion phase: ADMIN-001 FOLLOWUP-002 an approval past its service level escalates along finance's chain for the department, the head then a named finance approver, each step recorded
export const departmentEscalation = () => withAgency(async (h, t) => {
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
})

// Original assertion phase: ADMIN-001 APPROVE-001 a department condition and department-head or manager's-manager steps route a $1,400 claim through the actual hierarchy and refuse self-approval at every level
export const hierarchyWorkflow = () => withAgency(async (h, t) => {
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
})

export async function preserveAdministration() {
  await departmentSpendBudgetAllowance()
  await departmentEscalation()
  await hierarchyWorkflow()
}
