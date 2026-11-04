import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness, receipt } from './harness.mjs'
import { autonomousPolicy, heldPolicy } from '../src/modules/agent-door/conformance/crypto.mjs'
import { claimArguments, proposalClient } from './agent-door/proposals.mjs'

// One Worker journey: refusal must precede financial writes, approval and egress.
test('Oversized MCP preparations preserve financial evidence and leave their retry identities unused', async () => {
  const h = await harness({
    clock: Date.parse('2031-06-10T12:00:17.250Z'),
    fxRates: '<Cube><Cube time="2026-05-08"><Cube currency="USD" rate="1"/><Cube currency="AUD" rate="1.5"/></Cube></Cube>',
  })
  try {
    const t = await agency(h), request = (url, init) => h.mf.dispatchFetch(url, init)
    await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', receiptThreshold: '', fxEnabled: true })
    const policy = async document => {
      const response = await request(h.origin + '/agents/api/policy', { method: 'PUT', headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/json' }, body: JSON.stringify({ document }) })
      assert.equal(response.status, 200, await response.text())
    }
    await policy(autonomousPolicy())
    const employeeKey = await h.post('agent-keys', { label: 'synthetic-coaster-4500' }, t.sam)
    const financeKey = await h.post('agent-keys', { label: 'synthetic-coaster-4501' }, t.morgan)
    const employee = proposalClient(request, h.origin, employeeKey.token)
    const finance = proposalClient(request, h.origin, financeKey.token)
    const discovery = await employee('server/discover')
    assert.equal(discovery.status, 200)
    const max = discovery.result._meta['com.runeditrun/limits'].maxBodyBytes
    assert.ok(Number.isSafeInteger(max) && max > 0, 'use the advertised production byte limit')
    const versions = ['2026-07-28', '2025-11-25']
    for (const version of versions) assert.ok(discovery.result.supportedVersions.includes(version))

    // Native approved evidence, a real reserved batch and retained receipt bytes
    // make the no-change comparison meaningful before any oversized call.
    const original = await receipt('bistro'), originalBytes = Buffer.from(original.base64, 'base64')
    const approved = async (label, withReceipt = false) => {
      let claim = await h.post('claims', { title: label }, t.sam)
      let receiptId
      if (withReceipt) {
        const uploaded = await h.post(`claims/${claim.id}/receipts`, { version: claim.version, ...original }, t.sam)
        claim = uploaded.claim; receiptId = uploaded.receipt
      }
      claim = await h.post(`claims/${claim.id}/items`, { version: claim.version, ...claimArguments(t.c.office, label).items[0], explanation: label, ...(receiptId ? { receipt: receiptId } : {}) }, t.sam)
      claim = await h.post(`claims/${claim.id}/submit`, { version: claim.version }, t.sam)
      claim = await h.post(`claims/${claim.id}/decision`, { version: claim.version, revision: claim.revision, decision: 'approved', acknowledge: true }, t.priya)
      return { claim, receiptId }
    }
    const retained = await approved('synthetic-coaster-4502', true)
    await h.post('batches', { claims: [retained.claim.id] }, t.morgan)
    const available = (await approved('synthetic-coaster-4503')).claim
    const download = async id => {
      const response = await request(h.origin + `/api/coaster/receipts/${id}`, { headers: { cookie: t.sam } })
      assert.equal(response.status, 200)
      return Buffer.from(await response.arrayBuffer())
    }
    assert.deepEqual(await download(retained.receiptId), originalBytes)

    const tables = ['c_proposals', 'c_receipts', 'c_claims', 'c_items', 'c_allocations', 'c_revisions', 'c_decisions', 'c_batches', 'c_batch_claims', 'c_reimbursement_keys', 'c_events', 'c_history',
      'agent_door_calls', 'agent_door_approvals', 'agent_door_reviews', 'agent_door_audit', 'agent_door_events', 'agent_door_usage']
    const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async name => [name, (await h.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results])))
    const financial = state => Object.fromEntries(['c_claims', 'c_items', 'c_allocations', 'c_revisions', 'c_decisions', 'c_batches', 'c_batch_claims', 'c_reimbursement_keys'].map(name => [name, state[name]]))
    const native = async () => ({ claim: await h.get(`claims/${retained.claim.id}`, t.sam), history: await h.get('history', t.morgan) })
    const callsFor = async key => (await h.db.prepare('SELECT * FROM agent_door_calls WHERE key=?').bind(key).all()).results
    const approvalHandle = answer => answer.result?._meta?.['com.runeditrun/approval'] ?? answer.result?._meta?.['com.runeditrun/error']?.approval
    const prepare = async (client, params, initial) => {
      let answer = initial ?? await client('tools/call', params)
      const handle = approvalHandle(answer)
      if (handle) {
        assert.equal(answer.result.structuredContent, undefined, 'held content waits for the person')
        const url = new URL(handle.url)
        assert.equal(url.origin, h.origin)
        assert.equal(url.pathname, `/agents/approvals/${handle.id}`)
        const page = await h.send(url.pathname, undefined, t.sam)
        assert.equal(page.status, 200, 'follow the returned native approval URL')
        assert.ok(page.text.includes('data-approval-summary'))
        const path = url.pathname.replace('/agents/approvals/', '/agents/api/approvals/')
        const view = await h.send(path, undefined, t.sam)
        assert.equal(view.status, 200)
        assert.equal(view.value.approval.state, 'pending')
        const { revision, summary_sha256 } = view.value.approval
        const decision = await h.send(path + '/approve', { revision, summary_sha256 }, t.sam)
        assert.equal(decision.status, 200)
        assert.equal(decision.value.approval.state, 'executed')
        answer = await client('tools/call', { ...params, ...(answer.result.requestState ? { requestState: answer.result.requestState } : {}) })
      }
      assert.equal(answer.status, 200)
      assert.equal(answer.result?.isError, false, JSON.stringify(answer))
      assert.equal(answer.result.structuredContent.status, 'proposed')
      assert.equal(answer.result.structuredContent.decided_by, null, 'company approval never accepts a native proposal')
      return answer.result.structuredContent
    }
    const claimInput = label => {
      const args = claimArguments(t.c.office, label)
      args.items[0].receipt = original
      args.items[0].currency = 'USD' // If admitted, this valid preparation contacts the ECB edge.
      return args
    }
    await prepare(employee, { name: 'coaster.claims.propose', arguments: { ...claimInput('synthetic-coaster-4504'), idempotency_key: 'synthetic-coaster-4505' } })
    await prepare(finance, { name: 'coaster.batches.propose', arguments: { claims: [available.id], idempotency_key: 'synthetic-coaster-4506' } })
    const seeded = await snapshot()
    for (const name of ['c_proposals', 'c_receipts', 'c_claims', 'c_items', 'c_allocations', 'c_revisions', 'c_decisions', 'c_batches', 'c_batch_claims', 'c_reimbursement_keys', 'c_events', 'agent_door_calls']) {
      assert.ok(seeded[name].length, `${name}: compare nonempty retained evidence`)
    }
    assert.ok(h.outbound.some(r => r.url === 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml'), 'the allowed claim control really uses provider transport')

    // Extensible MCP metadata supplies body bytes without violating the tool's
    // field limits; the exact-limit control carries the same valid arguments.
    const encoded = (params, version, character, target) => {
      const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'synthetic-coaster-padding': '' } } }
      const base = Buffer.byteLength(JSON.stringify(rpc)), width = Buffer.byteLength(character)
      assert.ok(base < target, 'ordinary preparation fits before metadata padding')
      rpc.params._meta['synthetic-coaster-padding'] = character.repeat(Math.ceil((target - base) / width))
      return JSON.stringify(rpc)
    }
    const sendBody = async (params, version, token, text, transport) => {
      const bytes = Buffer.from(text), headers = new Headers({ origin: h.origin, 'content-type': 'application/json', authorization: `Bearer ${token}`, 'MCP-Protocol-Version': version, 'Mcp-Method': 'tools/call', 'Mcp-Name': params.name })
      let body = text
      if (transport === 'declared') headers.set('content-length', String(bytes.length))
      else {
        let position = 0
        body = new ReadableStream({ pull(controller) {
          if (position === bytes.length) { controller.close(); return }
          const end = Math.min(position + 8191, bytes.length)
          controller.enqueue(bytes.subarray(position, end)); position = end
        } })
      }
      const input = new Request(h.origin + '/mcp', { method: 'POST', headers, body, duplex: 'half' })
      assert.equal(input.headers.has('content-length'), transport === 'declared')
      const response = await request(input.url, { method: input.method, headers: Object.fromEntries(input.headers), body: input.body, duplex: 'half' })
      return { status: response.status, ...await response.json() }
    }
    let sequence = 4510
    for (const [policyName, document] of [['autonomous', autonomousPolicy()], ['held', heldPolicy()]]) {
      await policy(document)
      for (const version of versions) {
        const employeeClient = proposalClient(request, h.origin, employeeKey.token, version)
        const financeClient = proposalClient(request, h.origin, financeKey.token, version)
        for (const kind of ['claim', 'batch']) for (const transport of ['declared', 'streamed']) for (const character of ['x', 'é']) {
          const key = `synthetic-coaster-${sequence++}`
          const client = kind === 'claim' ? employeeClient : financeClient
          const params = { name: kind === 'claim' ? 'coaster.claims.propose' : 'coaster.batches.propose', arguments: { ...(kind === 'claim' ? claimInput(key) : { claims: [available.id], note: key }), idempotency_key: key } }
          const token = kind === 'claim' ? employeeKey.token : financeKey.token
          const oversized = encoded(params, version, character, max + 1)
          assert.ok(Buffer.byteLength(oversized) > max)
          if (character === 'é') assert.ok(oversized.length < max, 'UTF-8 bytes exceed capacity although character count fits')
          const before = await snapshot(), nativeBefore = await native(), outboundBefore = structuredClone(h.outbound)
          assert.deepEqual(await callsFor(key), [])
          const refused = await sendBody(params, version, token, oversized, transport)
          assert.equal(refused.status, 413, `${policyName} ${version} ${kind} ${transport} ${character}`)
          assert.equal(refused.result, undefined, 'no preparation result or execution receipt')
          assert.deepEqual(await snapshot(), before, 'no proposal, receipt, financial record, reservation, native history, approval or effect identity changed')
          assert.deepEqual(await native(), nativeBefore, 'native financial readback and numbered history remain identical')
          assert.deepEqual(await download(retained.receiptId), originalBytes, 'retained original download stays byte-identical')
          assert.deepEqual(h.outbound, outboundBefore, 'rejection sends no provider request or message')
          assert.deepEqual(await callsFor(key), [], '413 consumed no idempotency identity')

          const control = encoded(params, version, 'x', max)
          assert.equal(Buffer.byteLength(control), max, 'exact advertised capacity is admitted')
          const first = await sendBody(params, version, token, control, transport)
          assert.equal(first.status, 200)
          const proposal = await prepare(client, params, first)
          const after = await snapshot()
          assert.equal(after.c_proposals.length, before.c_proposals.length + 1, 'retry creates exactly one ordinary proposal')
          assert.equal(after.c_receipts.length, before.c_receipts.length + (kind === 'claim' ? 1 : 0))
          assert.equal(proposal.kind, kind)
          assert.deepEqual(financial(after), financial(before), 'preparation never accepts, submits, batches or reserves reimbursement')
          assert.equal((await callsFor(key)).length, 1)
          if (kind === 'claim') {
            assert.equal(proposal.payload.items[0].amountMinor, 1851, 'normal automatic conversion works after refusal')
            assert.deepEqual(await download(proposal.payload.items[0].receiptId), originalBytes)
            assert.equal(h.outbound.length, outboundBefore.length + 1, 'exactly one allowed provider lookup')
          } else assert.deepEqual(proposal.payload.claims, [available.id])
          const replayOutbound = structuredClone(h.outbound)
          assert.deepEqual(await prepare(client, params), proposal, 'same refused key now replays its one completed preparation')
          const replay = await snapshot()
          for (const name of tables.filter(name => name.startsWith('c_'))) assert.deepEqual(replay[name], after[name], `replay preserves ${name}, including original receipt bytes`)
          assert.equal((await callsFor(key)).length, 1)
          assert.deepEqual(h.outbound, replayOutbound, 'replay cannot repeat the provider request')
          assert.equal(replay.agent_door_approvals.filter(row => row.state === 'pending').length, before.agent_door_approvals.filter(row => row.state === 'pending').length)
          console.log(`PROBE BASE-AGENT-001 6 ${policyName} ${version} ${kind} ${transport} ${character === 'x' ? 'ASCII' : 'UTF-8'}: authenticated MCP preparation above ${max} bytes -> 413, retained financial records and original bytes unchanged, no approval or egress; exact-limit retry and replay -> one proposal`)
        }
      }
    }
  } finally { await h.close() }
})
