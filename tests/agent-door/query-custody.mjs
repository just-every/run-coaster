import assert from 'node:assert/strict'
import { webcrypto, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { agency, harness, receipt } from '../harness.mjs'
import { claimArguments, proposalClient } from './proposals.mjs'
import { accessToken, autonomousPolicy, heldPolicy, policyEnvelope, signJws } from '../../src/modules/agent-door/conformance/crypto.mjs'

export const custodyClock = Date.parse('2031-06-10T12:00:17Z')
const percentEncoded = token => [...token].map(char => '%' + char.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join('')

/** Inspect strings, binary cells, JSON snapshots and decoded CLI binary segments without printing credentials. */
export function assertNoQueryTokens(value, tokens, label) {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    return assertNoQueryTokens(bytes.toString('utf8'), tokens, label)
  }
  if (typeof value === 'string') {
    for (const token of tokens) for (const form of new Set([token, encodeURIComponent(token), percentEncoded(token), percentEncoded(token).toLowerCase()])) {
      assert.equal(value.includes(form), false, `${label} contains no raw or URL-encoded fixture credential`)
    }
  } else if (Array.isArray(value)) {
    if (value.length && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return assertNoQueryTokens(Buffer.from(value), tokens, label)
    for (const cell of value) assertNoQueryTokens(cell, tokens, label)
  } else if (value && typeof value === 'object') {
    for (const [key, cell] of Object.entries(value)) {
      assertNoQueryTokens(key, tokens, label)
      if ((key === 'blob' || key === 'data' && ['object', 'payload'].includes(value.kind)) && typeof cell === 'string') assertNoQueryTokens(Buffer.from(cell, 'base64'), tokens, label)
      else assertNoQueryTokens(cell, tokens, label)
    }
  }
}

/** Actual persisted SQLite includes metadata hidden by the D1 SQL API. */
export async function custodyStorage(h, tokens) {
  const databases = (await readdir(h.persistencePath, { recursive: true })).filter(name => name.endsWith('.sqlite'))
  let tables = 0, cells = 0
  for (const file of databases) {
    const db = new DatabaseSync(join(h.persistencePath, file), { readOnly: true })
    try {
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
        tables++
        for (const row of db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()) {
          cells += Object.keys(row).length
          assertNoQueryTokens(row, tokens, `retained SQLite table ${name}`)
        }
      }
    } finally { db.close() }
  }
  const objects = await custodyObjects(h)
  assertNoQueryTokens(objects, tokens, 'retained R2 metadata and bytes')
  await h.flushLogs()
  assertNoQueryTokens(h.logs, tokens, 'captured Worker application logs')
  assert.ok(databases.length && tables && cells && objects.length && h.logs.length, 'every custody scan uses nonempty retained data and an observed Worker log stream')
  return { databases: databases.length, tables, cells, objects: objects.length, logs: h.logs.length }
}

export async function custodyObjects(h) {
  const bucket = await h.mf.getR2Bucket('COASTER_RECEIPTS'), result = []
  let cursor
  do {
    const page = await bucket.list({ cursor, include: ['httpMetadata', 'customMetadata'] })
    for (const entry of page.objects) result.push({ entry: JSON.parse(JSON.stringify(entry)), bytes: Buffer.from(await (await bucket.get(entry.key)).arrayBuffer()) })
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return result
}

export async function custodyDatabase(h) {
  const tables = (await h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'_cf_METADATA' ORDER BY name").all()).results
  return Object.fromEntries(await Promise.all(tables.map(async ({ name }) => [name,
    (await h.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()).results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ])))
}

/** The released verifier's single-sponsor trust; bind only the already-established native owner. */
export async function queryHarness(options = {}) {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const signer = { privateKey: pair.privateKey, kid: randomUUID(), issuer: 'https://synthetic-coaster-4500.invalid', installationId: randomUUID() }
  const { kty, crv, x, y } = await webcrypto.subtle.exportKey('jwk', pair.publicKey)
  const publicKeys = { [signer.kid]: { kty, crv, x, y, kid: signer.kid, alg: 'ES256', use: 'sig' } }
  const h = await harness({ ...options, clock: custodyClock, captureLogs: true, bindings: origin => ({
    RER_DEV_ORIGIN: origin, RER_OWNER_CLAIM_ISSUER: signer.issuer, RER_OWNER_CLAIM_INSTALLATION_ID: signer.installationId,
    RER_OWNER_CLAIM_APP_ORIGIN: origin, RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify(publicKeys),
    RER_BUSINESS_TRUST: JSON.stringify({ v: 1, issuer: signer.issuer, audience: origin, subject: signer.installationId, keys: publicKeys }),
  }) })
  return { h, signer }
}

/** Complete only the company approval at its returned native URL; financial acceptance stays human. */
async function usablePreparation(h, client, params, held) {
  let answer = await client('tools/call', params)
  const handle = answer.result?._meta?.['com.runeditrun/approval'] ?? answer.result?._meta?.['com.runeditrun/error']?.approval
  assert.equal(Boolean(handle), held, 'only the held policy needs company approval')
  if (handle) {
    const url = new URL(handle.url, h.origin)
    assert.equal(url.origin, h.origin)
    const page = await h.send(url.pathname + url.search, undefined, h.owner)
    assert.equal(page.status, 200, 'the returned approval URL opens in the sponsor native session')
    const view = await h.send(`/agents/api/approvals/${handle.id}`, undefined, h.owner)
    assert.equal(view.status, 200)
    const approval = view.value.approval
    assert.equal(approval.state, 'pending')
    const approved = await h.send(`/agents/api/approvals/${handle.id}/approve`, { revision: approval.revision, summary_sha256: approval.summary_sha256 }, h.owner)
    assert.equal(approved.status, 200)
    answer = await client('tools/call', { ...params, ...(answer.result.requestState ? { requestState: answer.result.requestState } : {}) })
  }
  assert.equal(answer.status, 200)
  assert.equal(answer.result?.isError, false, 'the identical header-only preparation is usable')
  assert.equal(answer.result.structuredContent.status, 'proposed')
  assert.equal(answer.result.structuredContent.decided_by, null, 'company approval does not accept the financial proposal')
  return answer.result.structuredContent
}

export async function queryCustodyJourney(h, signer) {
  const t = await agency(h), owner = (await h.send('/auth/session', undefined, h.owner)).value.operator
  await h.post('settings/members', { email: owner.email, name: owner.displayName, employee: true, finance: true, manager: true })
  const context = { signer, origin: h.origin, now: custodyClock, person: { sub: 'synthetic-coaster-4501', email: owner.email }, agentId: 'synthetic-coaster-4502', business: 'synthetic-coaster-4503', consent: 'synthetic-coaster-4504', seq: 0, revision: 0,
    surface: { specialist: 'Expense controller', tools: [{ scope: 'proposals:read' }, { scope: 'proposals:write' }] } }
  const iat = Math.floor(custodyClock / 1000)
  const settings = await signJws(signer.privateKey, signer.kid, 'rer-business-settings+jwt', {
    v: 1, iss: signer.issuer, aud: h.origin, sub: signer.installationId, business: context.business, email: owner.email, owner_id: context.person.sub,
    jti: randomUUID(), iat, exp: iat + 300, rev: 1, values: {}, logo: null, team: null,
  })
  assert.equal((await h.send('/api/rer/business-settings', { settings })).status, 200, 'signed settings bind the existing owner without enrollment or roster writes')
  const key = await h.post('agent-keys', { label: 'synthetic-coaster-4505' })
  const businessToken = await accessToken(context), tokens = [key.token, businessToken]
  const request = (url, init) => h.mf.dispatchFetch(url, init)

  // Native receipt, claim, batch and once-only identity are nonempty before refusals.
  const original = await receipt('bistro')
  let claim = await h.post('claims', { title: 'synthetic-coaster-4506' }, t.sam)
  const uploaded = await h.post(`claims/${claim.id}/receipts`, { version: claim.version, ...original }, t.sam)
  claim = await h.post(`claims/${claim.id}/items`, { version: uploaded.claim.version, ...claimArguments(t.c.office).items[0], date: '2031-06-10', receipt: uploaded.receipt }, t.sam)
  claim = await h.post(`claims/${claim.id}/submit`, { version: claim.version }, t.sam)
  claim = await h.post(`claims/${claim.id}/decision`, { version: claim.version, revision: claim.revision, decision: 'approved' }, t.priya)
  let batch = await h.post('batches', { claims: [claim.id] }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: batch.total_minor }, t.jordan)
  await h.paid(batch.id, batch.version, { reference: 'synthetic-coaster-4507', paidOn: '2031-06-10' }, t.jordan)
  const form = new FormData()
  form.append('file', new Blob([Buffer.from(original.base64, 'base64')]), original.name)
  form.append('source', 'upload')
  const encoded = new Request(h.origin + '/api/coaster/receipt-inbox', { method: 'POST', headers: { origin: h.origin, cookie: t.sam }, body: form })
  const captured = await (await h.mf.getWorker()).fetch(encoded.url, { method: 'POST', headers: Object.fromEntries(encoded.headers), body: await encoded.arrayBuffer() })
  assert.equal(captured.status, 200, 'retain an original through native inbox upload for the R2 scan')
  await captured.body?.cancel()
  let refused = 0, controls = 0
  for (const [phase, document] of [['autonomous', autonomousPolicy()], ['held', heldPolicy()]]) {
    const envelope = await policyEnvelope(context, document)
    assert.equal((await h.send('/api/rer/agent-policy', { policy: envelope.policy })).status, 200)
    context.seq = envelope.payload.seq; context.revision = envelope.payload.revision
    // A known usable proposal gives subsequent refusal comparisons a nonempty baseline.
    const modern = proposalClient(request, h.origin, key.token)
    await usablePreparation(h, modern, { name: 'coaster.claims.propose', arguments: { ...claimArguments(t.c.office, 'synthetic-coaster-4508'), idempotency_key: randomUUID() } }, phase === 'held')
    for (const [kind, token] of [['personal', key.token], ['Business', businessToken]]) for (const version of ['2026-07-28', '2025-11-25']) {
      const client = proposalClient(request, h.origin, token, version)
      for (const [point, params] of [
        ['read', { name: 'coaster.workspace.get', arguments: {} }],
        ['preparation', { name: 'coaster.claims.propose', arguments: { ...claimArguments(t.c.office, 'synthetic-coaster-4509'), idempotency_key: randomUUID() } }],
      ]) {
        const before = await custodyDatabase(h), objects = await custodyObjects(h), outbound = structuredClone(h.outbound)
        for (const name of ['c_proposals', 'c_claims', 'c_receipts', 'c_batches', 'c_reimbursement_keys']) assert.ok(before[name].length, `${name} baseline is nonempty`)
        const rpc = { jsonrpc: '2.0', id: 4510, method: 'tools/call', params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': version } } }
        const headers = { origin: h.origin, 'content-type': 'application/json', 'MCP-Protocol-Version': version, 'Mcp-Method': 'tools/call', 'Mcp-Name': params.name }
        for (const [encoding, headerToken] of [[token, null], [percentEncoded(token), null], [percentEncoded(token), token], [token, tokens.find(value => value !== token)]]) {
          const response = await request(`${h.origin}/mcp?access_token=${encoding}`, { method: 'POST', headers: { ...headers, ...(headerToken ? { authorization: `Bearer ${headerToken}` } : {}) }, body: JSON.stringify(rpc) })
          assert.equal(response.status, 401, `${phase} ${kind} ${version} ${point}: query credentials are always refused`)
          assert.equal(response.headers.get('www-authenticate'), `Bearer resource_metadata="${h.origin}/.well-known/oauth-protected-resource/mcp"`)
          const text = await response.text()
          assertNoQueryTokens([text, Object.fromEntries(response.headers)], tokens, 'refusal body and headers')
          const body = JSON.parse(text)
          assert.equal(body.error.code, -32001)
          assert.equal(body.result, undefined)
          refused++
        }
        assert.deepEqual(await custodyDatabase(h), before, 'refusal creates no pending approval, audit, proposal or financial effect in any D1 table')
        assert.deepEqual(await custodyObjects(h), objects, 'refusal changes no receipt object or its metadata')
        assert.deepEqual(h.outbound, outbound, 'query tokens cause no outbound request or message')
        await h.flushLogs()
        assertNoQueryTokens(h.logs, tokens, 'captured application logs after refusal')
        if (point === 'preparation') await usablePreparation(h, client, params, phase === 'held')
        else {
          const allowed = await client('tools/call', params)
          assert.equal(allowed.status, 200)
          assert.equal(allowed.result?.isError, false, 'the identical header-only read is usable')
          assert.ok(allowed.result.structuredContent.categories.length, 'the read returns real native context')
        }
        controls++
      }
      console.log(`PROBE BASE-AGENT-004 5 ${phase} ${kind} ${version}: valid read and preparation with raw or encoded query-only tokens, encoded query plus header and mixed valid header -> 401 resource_metadata, no disclosure, pending approval, retained change or egress; header-only controls succeed`)
    }
  }
  const scan = await custodyStorage(h, tokens)
  assertNoQueryTokens(h.outbound, tokens, 'captured application egress')
  assert.equal((await h.get(`claims/${claim.id}`)).claim.status, 'reimbursed')
  assert.equal((await h.get(`batches/${batch.id}`)).batch.total_minor, 1234)
  return { tokens, key, claim: claim.id, batch: batch.id, scan, refused, controls }
}
