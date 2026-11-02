import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness, receipt } from './harness.mjs'
import { autonomousPolicy, heldPolicy } from '../src/modules/agent-door/conformance/crypto.mjs'
import { schemaErrors } from '../src/modules/agent-door/conformance/schema.mjs'
import { schemaValid, validateSchema } from '../src/modules/agent-door/json-schema.ts'
import { claimArguments, proposalClient } from './agent-door/proposals.mjs'

const workspaceTool = 'coaster.workspace.get', readTool = 'coaster.proposals.get'
const claimTool = 'coaster.claims.propose', batchTool = 'coaster.batches.propose'
const nativeTables = ['c_proposals', 'c_receipts', 'c_claims', 'c_items', 'c_allocations', 'c_batches', 'c_batch_claims', 'c_reimbursement_keys', 'c_revisions', 'c_decisions', 'c_events', 'c_history']
const copy = value => structuredClone(value)
const refusalCode = answer => answer.result?._meta?.['com.runeditrun/error']?.code ?? answer.error?.data?.code
const count = (state, table) => state[table].length

function conforms(schema, value, label) {
  assert.ok(schema && typeof schema === 'object', `${label} advertises an output schema`)
  assert.equal(schemaValid(schema), true, `${label} uses supported native schema assertions`)
  assert.equal(validateSchema(schema, value), true, `${label}: ${schemaErrors(schema, value).join('; ')}`)
}
function rejects(schema, value, change, label) {
  const malformed = copy(value)
  change(malformed)
  assert.equal(validateSchema(schema, malformed), false, label)
}
function typedProposal(value, kind, status = 'proposed') {
  assert.equal(typeof value.id, 'string'); assert.ok(value.id.length > 0)
  assert.equal(value.kind, kind); assert.equal(value.status, status)
  assert.equal(typeof value.agent_label, 'string'); assert.equal(typeof value.for_email, 'string')
  assert.ok(Number.isFinite(Date.parse(value.created_at)))
  if (status === 'proposed') {
    assert.equal(value.decided_by, null); assert.equal(value.decided_at, null); assert.equal(value.result_id, null)
  } else {
    assert.equal(value.decided_by, value.for_email)
    assert.ok(Number.isFinite(Date.parse(value.decided_at)))
    if (status === 'accepted') { assert.equal(typeof value.result_id, 'string'); assert.ok(value.result_id) }
    else assert.equal(value.result_id, null)
  }
}

// Selected BASE-AGENT-002 points 2 and 4: real discovery, typed output and native refusal parity.
test('Preparation contracts describe real context, proposals and native business refusals across MCP versions', async () => {
  const h = await harness()
  try {
    const t = await agency(h), request = (url, init) => h.mf.dispatchFetch(url, init)
    const snapshot = async () => Object.fromEntries(await Promise.all(nativeTables.map(async table => [table, (await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])))
    const policy = async document => {
      const response = await request(h.origin + '/agents/api/policy', { method: 'PUT', headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/json' }, body: JSON.stringify({ document }) })
      assert.equal(response.status, 200, await response.text())
    }
    await policy(autonomousPolicy())
    const employeeKey = await h.post('agent-keys', { label: 'synthetic-coaster-3600' }, t.sam)
    const financeKey = await h.post('agent-keys', { label: 'synthetic-coaster-3601' }, t.morgan)
    const clients = []
    for (const version of ['2026-07-28', '2025-11-25']) {
      const employee = proposalClient(request, h.origin, employeeKey.token, version)
      const finance = proposalClient(request, h.origin, financeKey.token, version)
      const discovery = await employee('tools/list')
      assert.equal(discovery.status, 200); assert.ok(Array.isArray(discovery.result?.tools))
      const tools = new Map(discovery.result.tools.map(tool => [tool.name, tool]))
      assert.equal(tools.size, discovery.result.tools.length, 'discovery has no ambiguous duplicate tools')
      for (const name of [workspaceTool, readTool, claimTool, batchTool]) assert.ok(tools.get(name)?.outputSchema, `${version} discovers ${name}`)
      const financeDiscovery = await finance('tools/list')
      assert.equal(financeDiscovery.status, 200)
      for (const name of [workspaceTool, readTool, claimTool, batchTool]) assert.deepEqual(financeDiscovery.result.tools.find(tool => tool.name === name)?.outputSchema, tools.get(name).outputSchema)
      clients.push({ version, employee, finance, tools })
    }
    const native = (path, token, body) => h.send('/api/coaster/agent/' + path, body, '', { authorization: `Bearer ${token}` })
    const output = (client, name, answer) => {
      assert.equal(answer.status, 200); assert.equal(answer.result?.isError, false, JSON.stringify(answer))
      const value = answer.result.structuredContent
      conforms(client.tools.get(name).outputSchema, value, `${client.version} ${name}`)
      return value
    }
    const call = async (client, person, name, args = {}) => output(client, name, await client[person]('tools/call', { name, arguments: args }))
    const read = async (client, person, proposal, token) => {
      const answer = await client[person]('tools/call', { name: readTool, arguments: { id: proposal.id } })
      const value = output(client, readTool, answer), direct = await native(`proposals/${proposal.id}`, token)
      assert.equal(direct.status, 200); assert.deepEqual(value, direct.value)
      assert.equal(answer.result._meta['com.runeditrun/untrusted'], true)
      return value
    }
    const empty = await snapshot()
    for (const client of clients) {
      for (const [person, token, finance] of [['employee', employeeKey.token, false], ['finance', financeKey.token, true]]) {
        const context = await call(client, person, workspaceTool), direct = await native('context', token)
        assert.equal(direct.status, 200); assert.deepEqual(context, direct.value)
        assert.equal(context.agent, finance ? financeKey.label : employeeKey.label)
        assert.equal(typeof context.for.email, 'string'); assert.equal(typeof context.for.name, 'string')
        assert.equal(context.for.roles.employee, true); assert.equal(context.for.roles.finance, finance)
        assert.ok(Object.values(context.for.roles).every(role => typeof role === 'boolean'))
        assert.equal(context.business.currency, 'AUD')
        assert.equal(context.categories.find(category => category.id === t.c.office).name, 'Office supplies')
        assert.ok(context.categories.every(category => category.active === 1 && typeof category.id === 'string'))
        assert.deepEqual(context.proposals, []); assert.deepEqual(context.approvedClaims, [])
        rejects(client.tools.get(workspaceTool).outputSchema, context, value => { delete value.categories[0].id }, 'category identifier is required')
        rejects(client.tools.get(workspaceTool).outputSchema, context, value => { value.for.roles.finance = 'true' }, 'role has a boolean type')
      }
    }
    assert.deepEqual(await snapshot(), empty, 'discovery and empty context perform no native writes')

    const args = claimArguments(t.c.office, 'synthetic-coaster-3602')
    args.items[0].receipt = await receipt('bistro')
    const privateValues = [args.title, args.note, args.items[0].receipt.base64]
    const refused = async (person, path, name, args, status, code) => {
      const before = await snapshot(), token = person === 'finance' ? financeKey.token : employeeKey.token
      const direct = await native(path, token, args)
      assert.equal(direct.status, status); assert.equal(direct.value.code, code)
      assert.equal(typeof direct.value.error, 'string')
      for (const client of clients) {
        const answer = await client[person]('tools/call', { name, arguments: { ...args, idempotency_key: crypto.randomUUID() } })
        assert.equal(answer.status, 200); assert.equal(refusalCode(answer), direct.value.code)
        assert.equal(answer.result?.structuredContent, undefined, 'refusal has no private result')
        assert.ok(!answer.result?.content?.some(content => content.type === 'resource_link'), 'refusal exposes no private resource')
        for (const value of privateValues) assert.ok(!JSON.stringify(answer).includes(value), 'refusal withholds private expense content')
      }
      for (const value of privateValues) assert.ok(!JSON.stringify(direct.value).includes(value))
      assert.deepEqual(await snapshot(), before, 'refusals preserve proposals, original receipts, financial records and native history')
    }
    const invalidAmount = copy(args); invalidAmount.items[0].amount = '-12.34'
    await refused('employee', 'claims', claimTool, invalidAmount, 400, 'invalid_arguments')
    const invalidCategory = copy(args); invalidCategory.items[0].allocations[0].category = 'synthetic-coaster-3603'
    await refused('employee', 'claims', claimTool, invalidCategory, 400, 'invalid_arguments')
    await refused('employee', 'batches', batchTool, { claims: ['synthetic-coaster-3604'] }, 403, 'native_authority_required')

    const prepare = async (person, name, args, key) => {
      const before = await snapshot()
      let proposal
      for (const client of clients) {
        const params = { name, arguments: { ...args, idempotency_key: key } }
        const answer = await client[person]('tools/call', params), current = output(client, name, answer)
        if (proposal) assert.deepEqual(current, proposal, 'cross-version replay retains the original proposal')
        proposal = current
        const links = answer.result.content.filter(content => content.type === 'resource_link')
        assert.equal(links.length, 1); assert.equal(links[0].uri, `coaster://proposals/${proposal.id}`)
        const after = await snapshot(), replay = await client[person]('tools/call', params)
        assert.deepEqual(output(client, name, replay), proposal)
        assert.deepEqual(await snapshot(), after, 'same-key preparation is once only')
      }
      const after = await snapshot()
      assert.equal(count(after, 'c_proposals'), count(before, 'c_proposals') + 1)
      assert.deepEqual(after.c_claims, before.c_claims); assert.deepEqual(after.c_batches, before.c_batches)
      assert.deepEqual(after.c_reimbursement_keys, before.c_reimbursement_keys)
      return proposal
    }
    const claim = await prepare('employee', claimTool, args, 'synthetic-coaster-3605')
    typedProposal(claim, 'claim')
    assert.equal(claim.payload.title, args.title); assert.equal(claim.payload.note, args.note)
    assert.equal(claim.payload.items[0].amountMinor, 1234); assert.equal(claim.payload.items[0].amount, '12.34')
    assert.equal(claim.payload.items[0].allocations[0].category, t.c.office)
    assert.equal(typeof claim.payload.items[0].receiptId, 'string'); assert.ok(claim.payload.items[0].receiptId)
    assert.equal(claim.payload.items[0].receipt, undefined)
    assert.ok(!JSON.stringify(claim).includes(args.items[0].receipt.base64), 'proposal carries only the original receipt reference')
    for (const client of clients) {
      assert.deepEqual(await read(client, 'employee', claim, employeeKey.token), claim)
      for (const name of [claimTool, readTool]) {
        rejects(client.tools.get(name).outputSchema, claim, value => { delete value.id }, 'proposal identifier is required')
        rejects(client.tools.get(name).outputSchema, claim, value => { value.status = 1 }, 'proposal state is typed')
        rejects(client.tools.get(name).outputSchema, claim, value => { value.payload.items[0].amountMinor = '1234' }, 'expense amount is integer minor units')
      }
    }
    const agentAccept = await h.send(`/api/coaster/proposals/${claim.id}/accept`, {}, '', { authorization: `Bearer ${employeeKey.token}` })
    assert.equal(agentAccept.status, 401)
    const accepted = await h.post(`proposals/${claim.id}/accept`, {}, t.sam)
    assert.equal(accepted.claim.status, 'draft'); assert.equal(accepted.claim.total_minor, 1234)
    await refused('finance', 'batches', batchTool, { claims: [accepted.claim.id] }, 409, 'native_conflict')
    for (const client of clients) {
      const value = await read(client, 'employee', claim, employeeKey.token)
      typedProposal(value, 'claim', 'accepted'); assert.equal(value.result_id, accepted.claim.id)
    }
    const declined = await prepare('employee', claimTool, claimArguments(t.c.office, 'synthetic-coaster-3606'), 'synthetic-coaster-3607')
    await h.post(`proposals/${declined.id}/decline`, { reason: 'synthetic-coaster-3608' }, t.sam)
    for (const client of clients) typedProposal(await read(client, 'employee', declined, employeeKey.token), 'claim', 'declined')
    let approved = await h.post(`claims/${accepted.claim.id}/submit`, { version: accepted.claim.version }, t.sam)
    approved = await h.post(`claims/${approved.id}/decision`, { version: approved.version, revision: approved.revision, decision: 'approved' }, t.priya)
    for (const client of clients) {
      const context = await call(client, 'finance', workspaceTool)
      const row = context.approvedClaims.find(value => value.id === approved.id)
      assert.ok(row); assert.equal(row.title, args.title); assert.equal(row.total_minor, 1234)
      assert.equal(typeof row.number, 'number'); assert.equal(row.currency, 'AUD')
      assert.deepEqual(context, (await native('context', financeKey.token)).value)
      assert.deepEqual((await call(client, 'employee', workspaceTool)).approvedClaims, [], 'employees cannot read the approved finance queue')
      const personal = await call(client, 'employee', workspaceTool)
      assert.equal(personal.proposals.find(value => value.id === claim.id).status, 'accepted')
      assert.equal(personal.proposals.find(value => value.id === declined.id).status, 'declined')
      const schema = client.tools.get(workspaceTool).outputSchema
      rejects(schema, context, value => { delete value.approvedClaims[0].id }, 'approved claim identifier is required')
      rejects(schema, context, value => { value.approvedClaims[0].total_minor = '1234' }, 'approved total is typed')
      rejects(schema, personal, value => { value.proposals[0].status = false }, 'context proposal state is typed')
    }
    const batch = await prepare('finance', batchTool, { claims: [approved.id], note: 'synthetic-coaster-3609' }, 'synthetic-coaster-3610')
    typedProposal(batch, 'batch'); assert.deepEqual(batch.payload.claims, [approved.id]); assert.equal(batch.payload.note, 'synthetic-coaster-3609')
    for (const client of clients) {
      assert.deepEqual(await read(client, 'finance', batch, financeKey.token), batch)
      rejects(client.tools.get(batchTool).outputSchema, batch, value => { delete value.id }, 'batch proposal identifier is required')
      rejects(client.tools.get(batchTool).outputSchema, batch, value => { value.payload.claims[0] = 1 }, 'batch selection identifiers are typed')
      const before = await snapshot(), missingId = 'synthetic-coaster-3611'
      const missing = await client.employee('tools/call', { name: readTool, arguments: { id: missingId } })
      const foreign = await client.employee('tools/call', { name: readTool, arguments: { id: batch.id } })
      assert.equal(refusalCode(missing), 'resource_unavailable')
      assert.equal(foreign.status, missing.status)
      assert.equal(foreign.result?.isError, true); assert.equal(missing.result?.isError, true)
      assert.deepEqual(foreign.result?.content, missing.result?.content, 'foreign and missing own-proposal tools disclose the same refusal')
      assert.deepEqual(foreign.result?._meta?.['com.runeditrun/error'], missing.result?._meta?.['com.runeditrun/error'])
      const missingNative = await native(`proposals/${missingId}`, employeeKey.token), foreignNative = await native(`proposals/${batch.id}`, employeeKey.token)
      assert.equal(missingNative.status, 404); assert.equal(foreignNative.status, 404)
      assert.deepEqual(foreignNative.value, missingNative.value); assert.equal(missingNative.value.code, refusalCode(missing))
      assert.equal(foreign.result?.structuredContent, undefined)
      assert.ok(!JSON.stringify(foreign).includes(batch.payload.note))
      assert.deepEqual(await snapshot(), before)
    }
    const acceptedBatch = await h.post(`proposals/${batch.id}/accept`, {}, t.morgan)
    assert.equal(acceptedBatch.batch.status, 'draft')
    for (const client of clients) {
      const value = await read(client, 'finance', batch, financeKey.token)
      typedProposal(value, 'batch', 'accepted'); assert.equal(value.result_id, acceptedBatch.batch.id)
    }

    await policy(heldPolicy())
    const client = clients[0], heldArgs = claimArguments(t.c.office, 'synthetic-coaster-3612')
    const params = { name: claimTool, arguments: { ...heldArgs, idempotency_key: 'synthetic-coaster-3613' } }
    const approveHeld = async (params, before, secret) => {
      const held = await client.employee('tools/call', params)
      assert.equal(held.status, 200); assert.equal(held.result?.resultType, 'input_required')
      assert.equal(held.result.structuredContent, undefined)
      assert.ok(!held.result.content?.some(content => content.type === 'resource_link'))
      assert.ok(!JSON.stringify(held).includes(secret), 'held calls withhold private result content')
      assert.deepEqual(await snapshot(), before, 'pending company approval performs no native financial action')
      const handle = held.result._meta['com.runeditrun/approval']
      const view = await h.send(`/agents/api/approvals/${handle.id}`, undefined, t.sam)
      assert.equal(view.status, 200)
      const approval = view.value.approval
      const decision = await h.send(`/agents/api/approvals/${handle.id}/approve`, { revision: approval.revision, summary_sha256: approval.summary_sha256 }, t.sam)
      assert.equal(decision.status, 200)
      return { params: { ...params, requestState: held.result.requestState }, answer: await client.employee('tools/call', { ...params, requestState: held.result.requestState }) }
    }
    const beforeHeld = await snapshot(), prepared = await approveHeld(params, beforeHeld, heldArgs.items[0].merchant)
    const heldClaim = output(client, claimTool, prepared.answer)
    typedProposal(heldClaim, 'claim'); assert.equal(heldClaim.payload.items[0].amountMinor, 1234)
    const afterHeld = await snapshot()
    assert.equal(count(afterHeld, 'c_proposals'), count(beforeHeld, 'c_proposals') + 1)
    for (const table of nativeTables.filter(table => !['c_proposals', 'c_events'].includes(table))) assert.deepEqual(afterHeld[table], beforeHeld[table], 'company approval prepares only the proposal')
    assert.deepEqual(output(client, claimTool, await client.employee('tools/call', prepared.params)), heldClaim)
    assert.deepEqual(await snapshot(), afterHeld, 'approved continuation replays once without another native effect')
    const heldRead = await approveHeld({ name: readTool, arguments: { id: heldClaim.id } }, afterHeld, heldArgs.title)
    assert.deepEqual(output(client, readTool, heldRead.answer), heldClaim)
    assert.deepEqual(await snapshot(), afterHeld, 'company read approval cannot accept a proposal')
    const human = await h.post(`proposals/${heldClaim.id}/accept`, {}, t.sam)
    assert.equal(human.claim.status, 'draft'); assert.equal(human.proposal.result_id, human.claim.id)
    const once = await snapshot()
    await h.post(`proposals/${heldClaim.id}/accept`, {}, t.sam, 409)
    assert.deepEqual(await snapshot(), once, 'human acceptance also happens once')
    console.log('PROBE BASE-AGENT-002 2: discovered output schemas under both supported MCP versions -> typed empty employee and finance contexts, receipt references, claim and batch preparations, accepted and declined readbacks; malformed copies refused')
    console.log('PROBE BASE-AGENT-002 4: native and MCP amount, category, finance role, nonapproved selection and own-proposal refusals -> shared codes, hidden content withheld, no native financial or history changes; autonomous and held preparation remain once only and human accepted')
  } finally { await h.close() }
})
