// Real Gusto Demo setup. All identities, consent, signatures and accounts below
// are fictitious fixtures, authorized only for this newly created Demo company.
// https://docs.gusto.com/embedded-payroll/docs/onboard-a-company
// https://docs.gusto.com/embedded-payroll/docs/onboard-a-w2-employee
import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'

export const gustoOrigin = 'https://api.gusto-demo.com'
const version = '2026-06-15'
const address = { street_1: '300 3rd Street', city: 'San Francisco', state: 'CA', zip: '94107' }
const signature = name => ({ signature_text: name, agree: true, signed_by_ip_address: '192.168.0.1' })
const date = offset => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10) }

/** Tokens exist only in this closure and the returned company; never serialize either. */
export function sandboxApi() {
  const secrets = [process.env.GUSTO_CLIENT_ID, process.env.GUSTO_CLIENT_SECRET].filter(Boolean)
  const clean = text => secrets.reduce((s, secret) => s.replaceAll(secret, '[redacted]'), String(text))
  const call = async (path, data, token, method = data === undefined ? 'GET' : 'POST') => {
    assert.ok(path.startsWith('/') && !path.startsWith('//'))
    const response = await fetch(gustoOrigin + path, { method, redirect: 'error', headers: {
      accept: 'application/json', 'content-type': 'application/json', 'X-Gusto-API-Version': version,
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
    const raw = await response.text()
    let value; try { value = raw ? JSON.parse(raw) : null } catch { throw new Error(`Gusto ${method} ${path}: non-JSON HTTP ${response.status}`) }
    if (!response.ok) throw new Error(clean(`Gusto ${method} ${path}: HTTP ${response.status} ${JSON.stringify(value?.errors ?? { error: value?.error })}`))
    if (value?.access_token) secrets.push(value.access_token)
    if (value?.refresh_token) secrets.push(value.refresh_token)
    console.log(JSON.stringify({ event: 'gusto_demo_request', method, path, status: response.status }))
    return value
  }
  return { call, clean }
}

// Use the provider's default values and enumerated options. Missing new fields
// fail visibly instead of inventing an application fallback or bypassing setup.
function companyTaxValue(requirement) {
  if (requirement.value !== null && requirement.value !== undefined) return requirement.value
  const metadata = requirement.metadata
  if (metadata.options?.length) return (metadata.options.find(o => o.value === false) ?? metadata.options[0]).value
  if (metadata.type === 'account_number' && metadata.mask) return metadata.mask.replaceAll('#', '1').replaceAll('^', 'A').replaceAll('@', 'A').replaceAll('%', '1')
  if (metadata.type === 'tax_rate') {
    if (metadata.validation?.rates?.length) return Number(metadata.validation.rates[0])
    if (metadata.validation?.min !== undefined) return Number(metadata.validation.min)
  }
  throw new Error(`Unanswered fictitious company tax requirement: ${JSON.stringify({ key: requirement.key, label: requirement.label, metadata })}`)
}

export async function provisionEmployeeCompany(call) {
  assert.ok(process.env.GUSTO_CLIENT_ID && process.env.GUSTO_CLIENT_SECRET, 'Inject held Gusto app credentials')
  const auth = await call('/oauth/token', { client_id: process.env.GUSTO_CLIENT_ID, client_secret: process.env.GUSTO_CLIENT_SECRET, grant_type: 'system_access' })
  const adminEmail = `synthetic-coaster-${randomUUID()}@example.com`
  const company = await call('/v1/partner_managed_companies', { user: { first_name: 'Synthetic', last_name: 'Coaster', email: adminEmail },
    company: { name: 'Synthetic Coaster Payroll Acceptance', ein: '89-' + randomInt(1000000, 10000000), contractor_only: false } }, auth.access_token)
  assert.ok(company.company_uuid && company.access_token)
  const root = '/v1/companies/' + company.company_uuid
  const api = (path, data, method) => call(path, data, company.access_token, method)
  await api('/v1/partner_managed_companies/' + company.company_uuid + '/terms_of_service', { email: adminEmail, ip_address: '192.168.0.1', external_user_id: 'synthetic-coaster-' + company.company_uuid })
  const checkDate = date(14), hireDate = date(-14)
  const [location, bank, federal] = await Promise.all([
    api(root + '/locations', { ...address, phone_number: '4155550100', mailing_address: true, filing_address: true }),
    api(root + '/bank_accounts', { routing_number: '102001017', account_number: '9775014007', account_type: 'Checking' }),
    api(root + '/federal_tax_details'),
  ])
  await Promise.all([
    api(root + '/federal_tax_details', { version: federal.version, legal_name: 'Synthetic Coaster Payroll Acceptance', tax_payer_type: 'C-Corporation', filing_form: '941', taxable_as_scorp: false }, 'PUT'),
    api(root + '/industry_selection', { naics_code: '541511', sic_codes: ['7371'], title: 'Synthetic software services' }, 'PUT'),
    api(root + '/pay_schedules', { frequency: 'Every other week', anchor_pay_date: checkDate, anchor_end_of_pay_period: date(7), workweek_start_day: 'Monday' }),
  ])
  const deposits = await api(root + '/bank_accounts/' + bank.uuid + '/send_test_deposits', {})
  const verified = await api(root + '/bank_accounts/' + bank.uuid + '/verify', { deposit_1: deposits.deposit_1, deposit_2: deposits.deposit_2 }, 'PUT')
  assert.equal(verified.verification_status, 'verified')
  const employee = await api(root + '/employees', { first_name: 'Synthetic', last_name: 'Employee', email: 'synthetic-coaster-employee@example.com',
    date_of_birth: '1979-06-01', ssn: '123451776', self_onboarding: false })
  const worker = '/v1/employees/' + employee.uuid
  const job = await api(worker + '/jobs', { title: 'Synthetic software engineer', hire_date: hireDate })
  const compensation = job.compensations[0]
  assert.ok(compensation.uuid && compensation.version)
  await Promise.all([
    api('/v1/compensations/' + compensation.uuid, { version: compensation.version, rate: '70000.00', payment_unit: 'Year', flsa_status: 'Exempt', effective_date: hireDate }, 'PUT'),
    api(worker + '/work_addresses', { location_uuid: location.uuid, effective_date: hireDate }),
    api(worker + '/home_addresses', { ...address, effective_date: hireDate }),
    api(worker + '/bank_accounts', { name: 'Synthetic checking', routing_number: '102001017', account_number: '5809431207', account_type: 'Checking' }),
  ])
  const w4 = await api(worker + '/federal_taxes')
  await api(worker + '/federal_taxes', { version: w4.version, w4_data_type: 'rev_2020_w4', filing_status: 'Single', two_jobs: false,
    dependents_amount: 0, other_income: 0, deductions: 0, extra_withholding: 0 }, 'PUT')
  const states = await api(worker + '/state_taxes')
  const answers = { filing_status: 'S', withholding_allowance: 1, additional_withholding: '0.0', file_new_hire_report: false }
  await api(worker + '/state_taxes', { states: states.map(state => ({ state: state.state, questions: state.questions.map(question => {
    assert.ok(Object.hasOwn(answers, question.key), `New employee tax question: ${question.key}`)
    return { key: question.key, answers: [{ value: answers[question.key], valid_from: hireDate, valid_up_to: null }] }
  }) })) }, 'PUT')
  for (const form of await api(worker + '/forms')) if (form.requires_signing) await api(worker + '/forms/' + form.uuid + '/sign', signature('Synthetic Employee'), 'PUT')
  const workerStatus = await api(worker + '/onboarding_status', { onboarding_status: 'onboarding_completed' }, 'PUT')
  assert.equal(workerStatus.onboarding_status, 'onboarding_completed')
  const tax = await api(root + '/tax_requirements/CA')
  const requirementSets = tax.requirement_sets.map(set => ({ key: set.key, state: set.state, ...(set.effective_from ? { effective_from: set.effective_from } : {}),
    requirements: set.requirements.filter(r => r.editable).map(r => ({ key: r.key, value: companyTaxValue(r) })) }))
  await api(root + '/tax_requirements/CA', { requirement_sets: requirementSets }, 'PUT')
  const signatory = await api(root + '/signatories', { first_name: 'Test', last_name: 'Signatory', title: 'Owner', phone: '4155550100', birthday: '1980-01-01',
    email: 'synthetic-coaster-signatory@example.com', ssn: '123451776', home_address: address })
  assert.equal(signatory.identity_verification_status, 'Pass', 'Demo signatory must pass before any fictitious signing')
  for (const form of await api(root + '/forms')) if (form.requires_signing) await api('/v1/forms/' + form.uuid + '/sign', signature('Test Signatory'), 'PUT')
  const onboarding = await api(root + '/onboarding_status')
  assert.deepEqual(onboarding.onboarding_steps.filter(s => s.required && !s.completed).map(s => ({ id: s.id, requirements: s.requirements })), [], 'Complete every actual Gusto onboarding requirement')
  await api(root + '/finish_onboarding', {}, 'PUT')
  const approved = await api(root + '/approve', {}, 'PUT')
  assert.equal(approved.company_status, 'Approved')
  assert.equal((await api(root + '/onboarding_status')).onboarding_completed, true)
  const payrolls = await api(root + '/payrolls?processing_statuses=unprocessed&per=100')
  assert.ok(payrolls.some(p => p.off_cycle === false), 'Approved company must expose its scheduled regular payroll')
  console.log(JSON.stringify({ event: 'gusto_demo_company_ready', company: company.company_uuid, employee: employee.uuid, bankVerified: true, onboardingCompleted: true }))
  return { company, employee, api }
}
