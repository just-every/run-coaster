// A real Coaster Worker (production API + native auth) on workerd and D1 with
// every migration applied. Only the external Resend transport is faked.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { unstable_splitSqlQuery } from 'wrangler'

const freePort = async () => { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const { port } = s.address(); await new Promise(r => s.close(r)); return port }

export async function harness() {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`, dir = await mkdtemp(join(tmpdir(), 'coaster-test-'))
  const bundle = await build({ entryPoints: ['tests/coaster-worker.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'], external: ['node:*', 'cloudflare:*'], target: 'es2023' })
  const messages = []
  const mailTransport = async request => {
    assert.equal(request.url, 'https://api.resend.com/emails')
    assert.equal(request.method, 'POST')
    messages.push(await request.json())
    return Response.json({ id: crypto.randomUUID() })
  }
  const mf = new Miniflare({ ...convertV4MiniflareOptions({ host: '127.0.0.1', port, modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'], outboundService: mailTransport, d1Databases: { DB: 'coaster' }, bindings: { AUTH_ORIGIN: origin, AUTH_LOCAL: 'true', OWNER_EMAIL: 'owner@harbourfinch.example', SESSION_SECRET: 'local-test-secret-not-production-0123456789', SETUP_TOKEN: 'local-test-bootstrap-token-0123456789', MAIL_PROVIDER: 'resend', MAIL_API_KEY: 'test-mail-key', MAIL_FROM: 'Coaster <coaster@harbourfinch.example>' } }), resourcePersistencePath: dir })
  try {
    const db = await mf.getD1Database('DB')
    for (const file of (await readdir('migrations/core')).filter(f => f.endsWith('.sql')).sort())
      await db.batch(unstable_splitSqlQuery(await readFile('migrations/core/' + file, 'utf8')).map(sql => db.prepare(sql)))
    const send = async (path, body, cookie = '', headers = {}) => {
      const response = await mf.dispatchFetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { host: new URL(origin).host, origin, 'content-type': 'application/json', cookie, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual' })
      const text = await response.text()
      let value; try { value = JSON.parse(text) } catch { value = text }
      return { status: response.status, value, text, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] }
    }
    const bootstrap = await send('/auth/bootstrap', { token: 'local-test-bootstrap-token-0123456789', displayName: 'Rose Owner' })
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
    return { db, mf, origin, owner, send, post, get, person, confirmMail, async close() { await mf.dispose(); await rm(dir, { recursive: true, force: true }) } }
  } catch (error) { await mf.dispose(); await rm(dir, { recursive: true, force: true }); throw error }
}

/** The synthetic Harbour & Finch Studio: business, categories and a small team with managers and finance. */
export async function agency(h) {
  await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', mileageRate: '0.88', perDiem: '75.00', receiptThreshold: '' })
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
