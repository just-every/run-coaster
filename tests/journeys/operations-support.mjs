// Shared public-door fixtures for the preserved operations assertion phases.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { agency, harness, receipt } from '../harness.mjs'

export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export const sum = (csv, column) => { const [head, ...rows] = csv.trim().split('\r\n').map(r => r.split('","').map(x => x.replace(/^"|"$/g, ''))); const i = head.indexOf(column); return Math.round(rows.reduce((n, r) => n + Number(r[i]) * 100, 0)) }

export async function withAgency(run, options) {
  const h = await harness(options)
  try { await run(h, await agency(h)) } finally { await h.close() }
}
/** A claim with expenses; each expense may carry a receipt fixture. Returns the claim detail. */
export async function claim(h, cookie, title, items) {
  let c = await h.post('claims', { title }, cookie)
  for (const item of items) {
    let receiptId
    if (item.receiptFixture) { const r = await h.post(`claims/${c.id}/receipts`, { version: c.version, ...(await receipt(item.receiptFixture)) }, cookie); c = r.claim; receiptId = r.receipt }
    c = await h.post(`claims/${c.id}/items`, { version: c.version, receipt: receiptId, ...item, receiptFixture: undefined }, cookie)
  }
  return h.get(`claims/${c.id}`, cookie)
}
/** That hour of that day on Central time, as the hourly Cron Trigger would fire it. */
export const central = (day, hour) => {
  const guess = Date.parse(`${day}T${String(hour).padStart(2, '0')}:17:00Z`)
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map(x => [x.type, x.value]))
  return new Date(guess - (Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - guess))
}
export const submit = (h, cookie, d) => h.post(`claims/${d.claim.id}/submit`, { version: d.claim.version }, cookie)
export const approve = async (h, cookie, c, extra = {}) => h.post(`claims/${c.id}/decision`, { revision: c.revision, version: c.version, decision: 'approved', ...extra }, cookie)
/** The owner deactivates a person's sign-in account through Base's account administration. */
export async function deactivateAccount(h, email) {
  const operators = (await h.send('/auth/operators', undefined, h.owner)).value
  const account = (Array.isArray(operators) ? operators : operators.operators).find(o => o.email === email)
  assert.equal((await h.send('/auth/operator/status', { operatorId: account.id, status: 'inactive' }, h.owner)).status, 200)
}

export function unzip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length), files = {}
  let end = bytes.length - 22
  while (v.getUint32(end, true) !== 0x06054b50) end--
  let at = v.getUint32(end + 16, true)
  for (let n = v.getUint16(end + 10, true); n > 0; n--) {
    assert.equal(v.getUint32(at, true), 0x02014b50)
    const size = v.getUint32(at + 20, true), nameLength = v.getUint16(at + 28, true), offset = v.getUint32(at + 42, true)
    const start = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true), data = bytes.subarray(start, start + size)
    assert.equal(crc32(data), v.getUint32(at + 16, true))
    files[bytes.subarray(at + 46, at + 46 + nameLength).toString()] = data
    at += 46 + nameLength + v.getUint16(at + 30, true) + v.getUint16(at + 32, true)
  }
  return files
}

export async function everywhere(db) {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results.map(r => r.name)
  const text = v => v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? Buffer.from(v instanceof ArrayBuffer ? v : v.buffer).toString('latin1') : String(v)
  const found = []
  for (const table of tables) for (const row of (await db.prepare(`SELECT * FROM "${table}"`).all()).results) found.push(...Object.values(row).map(v => `${table}: ${text(v)}`))
  return found
}
