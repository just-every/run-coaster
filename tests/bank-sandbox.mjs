// Live PAY-002 acceptance against the Plaid sandbox and Stripe test mode: a targeted API-only Miniflare HTTP journey. Run with the held
// provider keys through the approved injector, for example:
//   python3 -I briefs/_od08-env.py PLAID_CLIENT_ID=PLAID_CLIENT_ID PLAID_SANDBOX_SECRET=PLAID_SANDBOX_SECRET \
//     STRIPE_TEST_SECRET_KEY=STRIPE_US_TEST_SECRET_KEY -- node tests/bank-sandbox.mjs
// Only the two providers receive requests; credentials stay in memory and only method, path and status are printed. The journey plays the
// browser's part (Plaid Link, Stripe.js) straight against the providers, as the real browser would, so the account numbers never reach Coaster.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { harness } from './harness.mjs'
import { everything } from './fixtures/bank.mjs'

const need = name => { const value = process.env[name]; assert.ok(value, `${name} must be injected`); return value }
const secrets = ['PLAID_CLIENT_ID', 'PLAID_SANDBOX_SECRET', 'STRIPE_TEST_SECRET_KEY'].map(need)
const clean = text => secrets.reduce((s, secret) => s.replaceAll(secret, '[redacted]'), String(text))
const log = event => console.log(JSON.stringify(event))
log({ event: 'bank_sandbox_invocation', code_sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), providers: ['https://sandbox.plaid.com', 'https://api.stripe.com'] })

const forward = async request => {
  const url = new URL(request.url), headers = new Headers(request.headers)
  headers.delete('host'); headers.delete('content-length')
  const response = await fetch(url, { method: request.method, headers, redirect: 'error', ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.arrayBuffer() }) })
  const bytes = await response.arrayBuffer()
  log({ event: 'bank_sandbox_forward', method: request.method, host: url.host, path: url.pathname.replace(/\/(seti|pm|cus)_\w+/g, '/$1_…'), status: response.status })
  return new Response(bytes, { status: response.status, headers: response.headers })
}
const plaid = async (path, body) => {
  const response = await fetch('https://sandbox.plaid.com' + path, { method: 'POST', headers: { 'content-type': ['application', 'json'].join('/') }, body: JSON.stringify({ client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SANDBOX_SECRET, ...body }) })
  const value = await response.json()
  assert.ok(response.ok, clean(`Plaid ${path}: HTTP ${response.status} ${value.error_code}`))
  log({ event: 'bank_sandbox_browser_step', provider: 'plaid', path, status: response.status })
  return value
}
const stripe = async (method, path, form) => {
  const response = await fetch('https://api.stripe.com' + path, { method, headers: { authorization: 'Bearer ' + process.env.STRIPE_TEST_SECRET_KEY, 'content-type': ['application', 'x-www-form-urlencoded'].join('/') }, ...(form ? { body: new URLSearchParams(form).toString() } : {}) })
  const value = await response.json()
  assert.ok(response.ok, clean(`Stripe ${path}: HTTP ${response.status} ${value.error?.code}`))
  log({ event: 'bank_sandbox_browser_step', provider: 'stripe', method, path: path.replace(/\/(seti|pm|cus)_\w+/g, '/$1_…'), status: response.status })
  return value
}
const STRIPE_TEST_ACCOUNT = '000123456789', STRIPE_TEST_ROUTING = '110000000'

const h = await harness({ plaidEdge: forward, stripeEdge: forward })
try {
  const mail = 'synthetic-coaster-employee@example.invalid', financeMail = 'synthetic-coaster-finance@example.invalid'
  const employee = await h.person(mail, { employee: true }), finance = await h.person(financeMail, { employee: true, finance: true })
  await h.post(['bank', 'providers', 'connect'].join('/'), { provider: 'plaid', clientId: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SANDBOX_SECRET, consent: true })
  await h.post(['bank', 'providers', 'connect'].join('/'), { provider: 'stripe', secretKey: process.env.STRIPE_TEST_SECRET_KEY, publishableKey: 'synthetic-coaster-unused-browser-key', consent: true })

  // Instant verification: Plaid Link in the browser yields a public token for the chosen account.
  const linkPlaid = async (cookie, mask) => {
    const start = await h.post(['bank', 'start'].join('/'), { provider: 'plaid' }, cookie)
    assert.ok(start.linkToken, 'Plaid returned a real link token')
    // A sandbox user holding one checking account, so the item needs no account choice.
    const custom = { override_accounts: [{ type: 'depository', subtype: 'checking', starting_balance: 100, meta: { name: 'Synthetic Coaster Checking', official_name: 'Synthetic Coaster Checking', mask } }] }
    const created = await plaid('/sandbox/public_token/create', { institution_id: 'ins_109508', initial_products: ['auth'], options: { override_username: 'user_custom', override_password: JSON.stringify(custom) } })
    return h.post(['bank', 'complete'].join('/'), { provider: 'plaid', publicToken: created.public_token }, cookie)
  }
  const first = await linkPlaid(employee, '4242')
  assert.deepEqual([first.status, first.account.method, first.account.last4, first.account.held], ['active', 'instant', '4242', false])

  // Micro-deposits: Stripe.js sends the numbers to Stripe, which sandbox-deposits two amounts; the person enters them.
  const start = await h.post(['bank', 'start'].join('/'), { provider: 'stripe' }, finance)
  await stripe('POST', `/v1/setup_intents/${start.setupIntent}/confirm`, [['payment_method_data[type]', 'us_bank_account'], ['payment_method_data[us_bank_account][routing_number]', STRIPE_TEST_ROUTING], ['payment_method_data[us_bank_account][account_number]', STRIPE_TEST_ACCOUNT], ['payment_method_data[us_bank_account][account_holder_type]', 'individual'], ['payment_method_data[billing_details][name]', 'Synthetic Coaster Finance'], ['mandate_data[customer_acceptance][type]', 'online'], ['mandate_data[customer_acceptance][online][ip_address]', '127.0.0.1'], ['mandate_data[customer_acceptance][online][user_agent]', 'synthetic-coaster-sandbox']])
  const pending = await h.post(['bank', 'complete'].join('/'), { provider: 'stripe', setupIntent: start.setupIntent }, finance)
  assert.deepEqual([pending.status, pending.account.last4, pending.account.method], ['pending', '6789', 'microdeposit'])
  await h.post(['bank', 'verify'].join('/'), { id: pending.account.id, amounts: [1, 2] }, finance, 409)
  const verified = await h.post(['bank', 'verify'].join('/'), { id: pending.account.id, amounts: [32, 45] }, finance)
  assert.deepEqual([verified.status, verified.account.last4, verified.account.method], ['active', '6789', 'microdeposit'])

  // A change: the previous address is told, payments are held, and the lines are numbered in order.
  const sent = h.messages.length, changed = await linkPlaid(employee, '4343')
  assert.deepEqual([changed.status, changed.account.last4, changed.account.held, changed.account.holdDays], ['active', '4343', true, 2])
  const notice = h.messages.slice(sent).filter(m => m.to.includes(mail))
  assert.equal(notice.length, 1, 'one notice, to the address on record')
  const lines = (await h.get('history')).lines.filter(l => l.action.startsWith('bank-')).map(l => l.action)
  assert.deepEqual(lines.slice(-3), ['bank-account-changed', 'bank-hold-started', 'bank-notice-sent'])
  log({ event: 'bank_sandbox_history', actions: lines })

  const stored = await everything(h)
  for (const number of [STRIPE_TEST_ACCOUNT, STRIPE_TEST_ROUTING]) assert.ok(!stored.includes(number), 'no account or routing number is stored')
  const rows = (await h.db.prepare('SELECT state,method,provider,last4 FROM c_bank_accounts ORDER BY created_at').all()).results
  log({ event: 'bank_sandbox_result', accounts: rows })
  log({ event: 'bank_sandbox_passed' })
} finally {
  await h.close()
}
