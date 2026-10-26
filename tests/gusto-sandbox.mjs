// Live PAY-003 acceptance. Run with held app keys through the approved injector
// and heavy-slot. Only Gusto Demo receives requests; credentials stay in memory.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { gustoOrigin, provisionEmployeeCompany, sandboxApi } from './gusto-sandbox-company.mjs'
import { harness } from './harness.mjs'

const { call, clean } = sandboxApi()
console.log(JSON.stringify({ event: 'gusto_sandbox_invocation', code_sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), providerOrigin: gustoOrigin, apiVersion: '2026-06-15' }))
const nativeRoot = ['payroll', 'gusto'].join('/')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function completed(api, path, phase) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const payroll = await api(path + '?include=taxes&per=100')
    assert.notEqual(payroll.processing_request?.status, 'processing_failed', `Gusto ${phase}: ${JSON.stringify(payroll.processing_request?.errors)}`)
    if (phase === 'calculation' ? payroll.calculated_at && payroll.processing_request?.status === 'calculate_success' : payroll.processed === true && payroll.processing_request?.status === 'submit_success') return payroll
    await sleep(2000)
  }
  throw new Error(`Gusto ${phase} did not finish within three minutes; do not resubmit the run`)
}

async function nativeBatch(h) {
  const today = '2026-06-01'
  await h.post('settings/business', { name: 'Synthetic Coaster Payroll Acceptance', currency: 'USD', timezone: 'America/Los_Angeles', perDiem: '75.00', receiptThreshold: '' })
  const category = (await h.post('settings/categories', { name: 'Synthetic expenses', accountCode: '6500', taxCode: 'No tax' })).id
  const manager = await h.person('manager@coaster.example', { employee: true, manager: true })
  const finance = await h.person('finance@coaster.example', { employee: true, finance: true })
  const email = 'employee@coaster.example', employee = await h.person(email, { employee: true }, 'manager@coaster.example')
  let claim = await h.post('claims', { title: 'Synthetic Gusto reimbursement and non-accountable expense' }, employee)
  for (const [merchant, amount] of [['Synthetic accountable purchase', '10.00'], ['Synthetic non-accountable purchase', '5.00']]) {
    claim = await h.post(`claims/${claim.id}/items`, { version: claim.version, kind: 'receipt', date: today, merchant, amount,
      allocations: [{ category }], explanation: 'Authorized fictitious Sandbox payroll evidence; no real purchase' }, employee)
  }
  claim = await h.post(`claims/${claim.id}/submit`, { version: claim.version }, employee)
  const detail = await h.get(`claims/${claim.id}`, finance)
  const taxableItem = detail.items.find(item => item.merchant === 'Synthetic non-accountable purchase')
  assert.ok(taxableItem)
  await h.post(`claims/${claim.id}/items/${taxableItem.id}/accountable-plan`, { reason: 'Finance explicitly treats this fictitious amount as non-accountable wages' }, finance)
  claim = await h.post(`claims/${claim.id}/decision`, { version: claim.version, revision: claim.revision, decision: 'approved', acknowledge: true }, manager)
  await h.post('allowances', { name: 'Synthetic taxable phone stipend', type: 'stipend', category, period: 'monthly', amount: '7.00', tax: 'taxable', startsOn: today, member: email }, finance)
  await (await h.mf.getWorker()).scheduled({ scheduledTime: new Date('2026-06-02T19:17:00Z'), cron: '17 * * * *' })
  let stipend = (await h.get('state', manager)).claims.find(c => c.title.startsWith('Synthetic taxable phone stipend · '))
  assert.ok(stipend, 'The actual hourly allowance run must create the taxable stipend')
  stipend = (await h.get(`claims/${stipend.id}`, manager)).claim
  stipend = await h.post(`claims/${stipend.id}/decision`, { version: stipend.version, revision: stipend.revision, decision: 'approved', acknowledge: true }, manager)
  let batch = await h.post('batches', { claims: [claim.id, stipend.id] }, finance)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 2200 }, finance)
  batch = await h.post(`batches/${batch.id}/release`, { version: batch.version })
  assert.equal(batch.total_minor, 2200)
  return { batch, email, claims: [claim.id, stipend.id] }
}

async function journey() {
  const { company, employee, api } = await provisionEmployeeCompany(call)
  let physicalUpdates = 0
  const h = await harness({ gustoEdge: async request => {
    const url = new URL(request.url)
    assert.equal(url.origin, gustoOrigin)
    if (request.method === 'PUT' && /^\/v1\/companies\/[^/]+\/payrolls\/[^/]+$/.test(url.pathname)) physicalUpdates++
    const headers = new Headers(request.headers)
    headers.delete('host'); headers.delete('content-length')
    const response = await fetch(url, { method: request.method, headers, redirect: 'error',
      ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.arrayBuffer() }) })
    const bytes = await response.arrayBuffer()
    if (!response.ok) console.error(clean(JSON.stringify({ event: 'gusto_demo_forward_error', method: request.method, path: url.pathname,
      status: response.status, body: new TextDecoder().decode(bytes) })))
    if (response.ok && url.pathname.endsWith('/prepare')) {
      const payroll = JSON.parse(new TextDecoder().decode(bytes))
      console.log(JSON.stringify({ event: 'gusto_demo_prepared_shape', payroll: payroll.payroll_uuid, fixed_compensation_types: payroll.fixed_compensation_types,
        employees: payroll.employee_compensations.map(e => ({ employee: e.employee_uuid, fixed_compensations: e.fixed_compensations, reimbursements: e.reimbursements })) }))
    }
    return new Response(bytes, { status: response.status, headers: response.headers })
  } })
  try {
    const { batch, email, claims } = await nativeBatch(h)
    await h.post(`${nativeRoot}/connect`, { company: company.company_uuid, token: company.access_token, consent: true })
    await h.post(`${nativeRoot}/employees`, { email, employee: employee.uuid })
    const review = await h.get(`batches/${batch.id}/payroll`)
    assert.deepEqual(review.lines.map(l => [l.employeeUuid, l.reimbursementMinor, l.taxableMinor]), [[employee.uuid, 1000, 1200]])
    const next = review.payrolls[0]
    assert.ok(next && next.off_cycle === false, 'The app chooses the next actual regular Gusto payroll')
    const sent = await h.post(`batches/${batch.id}/payroll`, { version: batch.version, payroll: next.payroll_uuid, consent: true })
    assert.equal(sent.status, 'sent')
    const payrollPath = `/v1/companies/${company.company_uuid}/payrolls/${next.payroll_uuid}`
    const pending = await api(payrollPath + '?per=100')
    const pay = pending.employee_compensations.find(e => e.employee_uuid === employee.uuid)
    assert.ok(pay)
    assert.equal(pay.reimbursements.reduce((sum, r) => sum + Math.round(Number(r.amount) * 100), 0), 1000)
    assert.equal(pay.fixed_compensations.find(f => f.name === 'Bonus').amount, '12.00')
    assert.equal((await h.post(`batches/${batch.id}/payroll/confirm`, {})).confirmed, false)
    for (const id of claims) assert.equal((await h.get(`claims/${id}`)).claim.status, 'batched', 'Claims stay unpaid before provider processing')
    await h.post(`batches/${batch.id}/payroll`, { version: batch.version, payroll: next.payroll_uuid, consent: true }, h.owner, 409)
    assert.equal(physicalUpdates, 1, 'A repeated send must never repeat the actual provider write')
    await api(payrollPath + '/calculate', {}, 'PUT')
    await completed(api, payrollPath, 'calculation')
    await api(payrollPath + '/submit', {}, 'PUT')
    const processed = await completed(api, payrollPath, 'submission')
    const confirmation = await h.post(`batches/${batch.id}/payroll/confirm`, {})
    assert.equal(confirmation.confirmed, true)
    for (const id of claims) assert.equal((await h.get(`claims/${id}`)).claim.status, 'reimbursed')
    const receipt = await api(`/v1/payrolls/${next.payroll_uuid}/receipt?per=100`)
    const receiptEmployee = receipt.employee_compensations.find(e => e.employee_uuid === employee.uuid)
    assert.equal(receiptEmployee.total_reimbursement, '10.00')
    assert.equal(receiptEmployee.payment_method, 'Direct Deposit')
    await h.post(`batches/${batch.id}/payroll/confirm`, {})
    assert.equal(physicalUpdates, 1)
    const history = (await h.get('history')).lines
    assert.equal(history.filter(line => line.action === 'batch-reimbursed').length, 1)
    const visible = JSON.stringify([await h.get('state'), await h.get(`batches/${batch.id}/payroll`), history])
    assert.ok(!visible.includes(company.access_token), 'Company token must not enter native public records')
    console.log(JSON.stringify({ event: 'gusto_sandbox_acceptance', providerOrigin: gustoOrigin, apiVersion: '2026-06-15', company: company.company_uuid,
      employee: employee.uuid, payroll: next.payroll_uuid, batch: batch.id, processed: processed.processed, processingStatus: processed.processing_request?.status,
      reimbursement: receiptEmployee.total_reimbursement, taxableBonus: '12.00', ordinaryMinor: 1000, nonAccountableMinor: 500, taxableStipendMinor: 700,
      receipt: receipt.payroll_uuid, providerWrites: physicalUpdates, nativeClaimsReimbursed: claims.length, productionAuthority: false }))
  } finally { await h.close() }
}

try { await journey() }
catch (error) { console.error(clean(error.message)); process.exitCode = 1 }
