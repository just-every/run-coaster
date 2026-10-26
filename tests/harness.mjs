// A real Coaster Worker (production API + native auth) on workerd and D1 with
// every migration applied. Only the external Resend transport and, when a test
// names one, the Auth identity provider are faked.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { unstable_splitSqlQuery } from 'wrangler'
import { authEdge } from './identity-provider.mjs'
import { heifEsbuildPlugin } from '../scripts/heif-worker.mjs'

const freePort = async () => { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const { port } = s.address(); await new Promise(r => s.close(r)); return port }

/** Retry only a Worker socket claimed between free-port selection and binding, before any application requests. */
export async function harness(options = {}) {
  try { return await startHarness(options) }
  catch (error) {
    if (error.code !== 'ERR_ADDRESS_IN_USE') throw error
    console.error('Worker socket was claimed during startup; retrying once with another free port')
    return startHarness(options)
  }
}

async function startHarness({ identityProvider, fxRates, d1Barrier, webhookEdge, qboEdge, aiEdge, gustoEdge, persistencePath, databaseId, bindings = {} } = {}) {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`, dir = persistencePath ?? await mkdtemp(join(tmpdir(), 'coaster-test-'))
  const bundle = await build({ entryPoints: ['tests/coaster-worker.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'], external: ['node:*', 'cloudflare:*'], target: 'es2023', plugins: [heifEsbuildPlugin()] })
  // Every request the Worker sends anywhere is recorded with its body, so a test can prove where data leaves (DATA-001).
  const messages = [], outbound = []
  const auth = identityProvider ? await authEdge(identityProvider, origin) : null
  const edge = async request => {
    const body = ['GET', 'HEAD'].includes(request.method) ? '' : await request.text()
    outbound.push({ url: request.url, method: request.method, body, headers: Object.fromEntries(request.headers) })
    // Coaster sends every provider request with redirect: 'manual' (oidc/network.mjs); workerd does not carry the mode across this boundary.
    if (auth && request.url.startsWith(auth.issuer + '/')) return auth.fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body, redirect: 'manual' })
    if (fxRates !== undefined && request.url === 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml') return typeof fxRates === 'function' ? fxRates(request) : new Response(fxRates, { headers: { 'content-type': 'application/xml' } });
    if (aiEdge && new URL(request.url).hostname === 'api.openai.com') return aiEdge(new Request(request.url, { method: request.method, headers: request.headers, body, redirect: 'manual' }))
    if (gustoEdge && new URL(request.url).hostname === 'api.gusto-demo.com') return gustoEdge(new Request(request.url, { method: request.method, headers: request.headers, ...(['GET', 'HEAD'].includes(request.method) ? {} : { body }), redirect: 'manual' }))
    if (qboEdge && new URL(request.url).hostname.endsWith('.intuit.com')) return qboEdge(new Request(request.url, { method: request.method, headers: request.headers, ...(['GET', 'HEAD'].includes(request.method) ? {} : { body }), redirect: 'manual' }))
    if (webhookEdge && /^https:\/\/\d+\.\d+\.\d+\.\d+\//.test(request.url)) return webhookEdge(new Request(request.url, { method: request.method, headers: request.headers, body, redirect: 'manual' }))
    assert.equal(request.url, 'https://api.resend.com/emails')
    assert.equal(request.method, 'POST')
    messages.push(JSON.parse(body))
    return Response.json({ id: crypto.randomUUID() })
  }
  const mf = new Miniflare({ ...convertV4MiniflareOptions({ host: '127.0.0.1', port, modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'], outboundService: edge, ...(d1Barrier ? { serviceBindings: { DB_GATE: d1Barrier } } : {}), d1Databases: { DB: databaseId ?? 'coaster' }, r2Buckets: { COASTER_RECEIPTS: 'coaster-receipts' }, bindings: { AUTH_ORIGIN: origin, AUTH_LOCAL: 'true', OWNER_EMAIL: 'owner@harbourfinch.example', INSTALLATION_KEY: Buffer.from('synthetic-coaster-1').toString('hex').padEnd(64, '0'), SESSION_SECRET: 'local-test-secret-not-production-0123456789', SETUP_TOKEN: 'synthetic-local-test-bootstrap-token-0123456789', MAIL_PROVIDER: 'resend', MAIL_API_KEY: 'test-mail-key', MAIL_FROM: 'Coaster <coaster@harbourfinch.example>', ...(identityProvider ? { IDENTITY_PROVIDER: identityProvider } : {}), ...(typeof bindings === 'function' ? bindings(origin) : bindings) } }), resourcePersistencePath: dir })
  try {
    const db = await mf.getD1Database('DB')
    if (persistencePath) await db.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)').run()
    for (const file of (await readdir('migrations/core')).filter(f => f.endsWith('.sql')).sort()) {
      const statements = unstable_splitSqlQuery(await readFile('migrations/core/' + file, 'utf8')).map(sql => db.prepare(sql))
      if (persistencePath) statements.push(db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(file))
      await db.batch(statements)
    }
    const send = async (path, body, cookie = '', headers = {}) => {
      const response = await mf.dispatchFetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { host: new URL(origin).host, origin, 'content-type': 'application/json', cookie, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual' })
      const text = await response.text()
      let value; try { value = JSON.parse(text) } catch { value = text }
      return { status: response.status, value, text, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] }
    }
    const bootstrap = await send('/auth/bootstrap', { token: 'synthetic-local-test-bootstrap-token-0123456789', displayName: 'Rose Owner' })
    assert.equal(bootstrap.status, 303, JSON.stringify(bootstrap.value))
    const owner = bootstrap.cookie
    /** POST and expect a status (200 by default); returns the JSON answer. */
    const post = async (path, body, cookie = owner, status = 200) => { const r = await send('/api/coaster/' + path, body, cookie); assert.equal(r.status, status, `${path}: ${JSON.stringify(r.value)}`); return r.value }
    const get = async (path, cookie = owner, status = 200) => { const r = await send('/api/coaster/' + path, undefined, cookie); assert.equal(r.status, status, `${path}: ${JSON.stringify(r.value)}`); return r.value }
    const confirmMail = async email => {
      const message = messages.findLast(m => m.to.includes(email))
      assert.ok(message, `mail for ${email}`)
      const token = new URL(message.text.match(/http:\/\/[^\s]+\/auth\/confirm\?token=[^\s]+/)[0]).searchParams.get('token')
      const confirmed = await send('/auth/confirm', { token })
      assert.equal(confirmed.status, 303, JSON.stringify(confirmed.value))
      return confirmed.cookie
    }
    /** Save a Coaster member, invite them and return their real signed-in session cookie. */
    const person = async (email, roles, approver) => {
      await post('settings/members', { email, name: email.split('@')[0], ...roles, approver })
      await post('settings/members/invite', { email })
      return confirmMail(email)
    }
    /** Release a reviewed batch (PAY-004; the owner by default) and record the payment made outside Coaster. */
    const paid = async (id, version, body, cookie = owner, releaser = owner) => post(`batches/${id}/paid`, { ...body, version: (await post(`batches/${id}/release`, { version }, releaser)).version }, cookie)
    return { db, mf, origin, owner, messages, outbound, auth, send, post, get, person, paid, confirmMail, async close() { await mf.dispose(); if (!persistencePath) await rm(dir, { recursive: true, force: true }) } }
  } catch (error) { await mf.dispose(); if (!persistencePath) await rm(dir, { recursive: true, force: true }); throw error }
}

/** The synthetic Harbour & Finch Studio: business, categories and a small team with managers and finance. */
export async function agency(h) {
  await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', perDiem: '75.00', receiptThreshold: '' })
  await h.post('settings/mileage-rates', { effectiveFrom: '2026-01-01', rate: '0.88' })
  const category = async (name, accountCode, taxCode, limit) => (await h.post('settings/categories', { name, accountCode, taxCode, limit })).id
  const c = { meals: await category('Meals', '6300', 'GST', '120.00'), travel: await category('Travel', '6200', 'GST'), car: await category('Car', '6400', 'GST Free'), office: await category('Office supplies', '6500', 'GST') }
  const priya = await h.person('priya@harbourfinch.example', { employee: true, manager: true })
  const morgan = await h.person('morgan@harbourfinch.example', { employee: true, finance: true }, 'priya@harbourfinch.example')
  const sam = await h.person('sam@harbourfinch.example', { employee: true }, 'priya@harbourfinch.example')
  const alex = await h.person('alex@harbourfinch.example', { employee: true }, 'priya@harbourfinch.example')
  const jordan = await h.person('jordan@harbourfinch.example', { employee: true, manager: true, finance: true })
  return { c, priya, morgan, sam, alex, jordan }
}

export const receipt = async name => ({ name: name + '.png', base64: (await readFile(`tests/fixtures/receipts/${name}.png`)).toString('base64') })
