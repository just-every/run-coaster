import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness, receipt } from './harness.mjs'
import { autonomousPolicy, heldPolicy } from '../src/modules/agent-door/conformance/crypto.mjs'
import { claimArguments, linkedProposal, proposalClient, readProposal } from './agent-door/proposals.mjs'

// A single sanity journey exercises proposal custody through Worker, MCP and native doors.
test('Proposal resources preserve own projections, held policy and native human custody', async () => {
  const h = await harness()
  try {
    const t = await agency(h)
    const request = (url, init) => h.mf.dispatchFetch(url, init)
    const policy = async document => {
      const r = await request(h.origin + '/agents/api/policy', { method: 'PUT', headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/json' }, body: JSON.stringify({ document }) })
      assert.equal(r.status, 200, await r.text())
    }
    await policy(autonomousPolicy())
    const key = await h.post('agent-keys', { label: 'synthetic-coaster-3500' }, t.sam)
    const financeKey = await h.post('agent-keys', { label: 'synthetic-coaster-3502' }, t.morgan)
    const client = proposalClient(request, h.origin, key.token), finance = proposalClient(request, h.origin, financeKey.token)
    const templates = await client('resources/templates/list')
    assert.deepEqual(await client('resources/templates/list'), templates, 'template discovery is deterministic')
    assert.deepEqual(templates.result.resourceTemplates.map(r => r.uriTemplate), ['coaster://proposals/{id}'])
    console.log('PROBE BASE-AGENT-003 1: MCP template discovery twice -> one deterministic proposal template')
    const count = async () => (await h.db.prepare('SELECT COUNT(*) AS n FROM c_proposals').first()).n
    const before = await count()
    const args = claimArguments(t.c.office)
    args.items[0].receipt = await receipt('bistro')
    const claim = await linkedProposal(client, 'coaster.claims.propose', args)
    assert.equal(await count(), before + 1, 'replay creates no duplicate proposal')
    const native = async (p, token) => {
      const r = await h.send(`/api/coaster/agent/proposals/${p.id}`, undefined, '', { authorization: `Bearer ${token}` })
      assert.equal(r.status, 200)
      return r.value
    }
    assert.deepEqual(readProposal(await client('resources/read', { uri: claim.uri })), await native(claim.proposal, key.token))
    assert.ok(claim.proposal.payload.items[0].receiptId)
    assert.ok(!JSON.stringify(claim.proposal).includes(args.items[0].receipt.base64), 'resource projection contains no receipt bytes')
    const screen = (await h.get('state', t.sam)).proposals.find(p => p.id === claim.proposal.id)
    for (const [field, value] of Object.entries(screen)) assert.deepEqual(claim.proposal[field], value, `existing native screen projection ${field}`)
    assert.equal(claim.proposal.status, 'proposed')
    assert.equal(claim.proposal.decided_by, null)
    assert.equal((await h.send(`/api/coaster/proposals/${claim.proposal.id}/accept`, {}, '', { authorization: `Bearer ${key.token}` })).status, 401)
    const accepted = await h.post(`proposals/${claim.proposal.id}/accept`, {}, t.sam)
    assert.equal(accepted.claim.status, 'draft', 'resource reads do not accept or submit')
    const decided = readProposal(await client('resources/read', { uri: claim.uri }))
    assert.equal(decided.status, 'accepted'); assert.equal(decided.result_id, accepted.claim.id)
    await h.post(`proposals/${claim.proposal.id}/accept`, {}, t.sam, 409)
    let c = await h.post(`claims/${accepted.claim.id}/submit`, { version: accepted.claim.version }, t.sam)
    c = await h.post(`claims/${c.id}/decision`, { version: c.version, revision: c.revision, decision: 'approved' }, t.priya)
    const batch = await linkedProposal(finance, 'coaster.batches.propose', { claims: [c.id], note: 'synthetic-coaster-3503' })
    assert.deepEqual(readProposal(await finance('resources/read', { uri: batch.uri })), await native(batch.proposal, financeKey.token))
    const batchScreen = (await h.get('state', t.morgan)).proposals.find(p => p.id === batch.proposal.id)
    for (const [field, value] of Object.entries(batchScreen)) assert.deepEqual(batch.proposal[field], value)
    assert.equal((await h.get('state', t.morgan)).batches.length, 0)
    console.log('PROBE BASE-AGENT-003 2: employee claim and finance batch MCP reads -> existing native projections exactly; human acceptance still required')
    console.log('PROBE BASE-AGENT-003 4: claim and batch preparation, replay, acceptance and linked readback -> exact original links, once-only proposals, current native state')
    console.log('PROBE BASE-AGENT-003 6: linked expense content -> standard and sensitive classes with untrusted marker')
    const missing = await client('resources/read', { uri: 'coaster://proposals/synthetic-coaster-3599' })
    assert.equal(missing.error.data.code, 'resource_unavailable')
    assert.deepEqual(await client('resources/read', { uri: batch.uri }), missing, 'foreign and missing records are indistinguishable')
    // Native preparation and conversation records remain excluded even for their owner.
    let draft = await h.post('claims', { title: 'synthetic-coaster-3504' }, t.sam)
    draft = await h.post(`claims/${draft.id}/items`, { version: draft.version, ...claimArguments(t.c.office).items[0] }, t.sam)
    const p = await h.post(`preparations/expenses/${draft.id}`, {}, t.sam)
    assert.deepEqual(await client('resources/read', { uri: `coaster://proposals/${p.id}` }), missing)
    const conversation = await h.post('conversation', { message: 'Denver client trip, May 10-12, 2026', manualRate: '1.00', receipts: [{ date: '2026-05-10', merchant: 'synthetic-coaster-3505', amount: '12.34', category: t.c.travel, receipt: await receipt('uber') }] }, t.sam)
    assert.deepEqual(await client('resources/read', { uri: `coaster://proposals/${conversation.proposal.id}` }), missing)
    console.log('PROBE BASE-AGENT-003 3: foreign, preparation, conversation and missing ids -> identical resource_unavailable')
    await policy(heldPolicy())
    const held = await client('resources/read', { uri: claim.uri })
    assert.equal(held.error.data.code, 'approval_required')
    assert.equal(held.result, undefined, 'no content before company approval')
    assert.ok(!JSON.stringify(held).includes(claim.proposal.payload.title))
    const handle = held.error.data.approval
    const view = await h.send(`/agents/api/approvals/${handle.id}`, undefined, t.sam)
    assert.equal(view.status, 200)
    const approval = view.value.approval
    const decision = await h.send(`/agents/api/approvals/${handle.id}/approve`, { revision: approval.revision, summary_sha256: approval.summary_sha256 }, t.sam)
    assert.equal(decision.status, 200)
    assert.deepEqual(readProposal(await client('resources/read', { uri: claim.uri, requestState: held.error.data.requestState })), decided)
    const pendingRest = await h.send(`/api/coaster/agent/proposals/${batch.proposal.id}`, undefined, '', { authorization: `Bearer ${financeKey.token}` })
    assert.equal(pendingRest.status, 202, 'REST cannot bypass a held private read')
    assert.equal(pendingRest.value.payload, undefined)
    assert.equal((await h.get('state', t.morgan)).proposals.find(p => p.id === batch.proposal.id).status, 'proposed', 'company read approval cannot accept a native proposal')
    await policy(autonomousPolicy())
    const erasureKey = await h.post('agent-keys', { label: 'synthetic-coaster-3508' }, t.alex)
    const erased = proposalClient(request, h.origin, erasureKey.token), erasureArgs = claimArguments(t.c.office, 'synthetic-coaster-3518')
    const erasureIdempotency = 'synthetic-coaster-3519'
    await policy({ ...autonomousPolicy(), rules: [{ id: 'alex-reviewed', class: '*', do: 'review' }], reviewers: ['sponsor'] })
    const erasureProposal = await linkedProposal(erased, 'coaster.claims.propose', erasureArgs, erasureIdempotency)
    const decisionsBefore = (await h.db.prepare('SELECT id,row FROM agent_door_audit WHERE agent=? ORDER BY sequence').bind(erasureKey.id).all()).results.map(({ id, row }) => {
      const { classes, revision, rules, decision } = JSON.parse(row)
      return { id, classes, revision, rules, decision }
    })
    await policy(heldPolicy())
    const heldErasure = await erased('tools/call', { name: 'coaster.claims.propose', arguments: { ...erasureArgs, idempotency_key: 'synthetic-coaster-3517' } })
    assert.equal(heldErasure.result.resultType, 'input_required')
    await h.post(`agent-keys/${key.id}/revoke`, {}, t.sam)
    assert.equal((await client('resources/read', { uri: claim.uri })).status, 401)
    await h.post('settings/members', { email: batch.proposal.for_email, name: 'synthetic-coaster-3506', active: false, employee: true, finance: true })
    assert.equal((await finance('resources/read', { uri: batch.uri })).status, 401)
    assert.equal((await h.db.prepare('SELECT status FROM c_proposals WHERE id=?').bind(batch.proposal.id).first()).status, 'proposed')
    await h.post('settings/members', { email: erasureProposal.proposal.for_email, name: 'synthetic-coaster-3509', active: false, employee: true })
    await h.post('settings/members/erase', { email: erasureProposal.proposal.for_email })
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM agent_door_calls WHERE agent=?').bind(erasureKey.id).first()).n, 0, 'erasure removes captured retry results')
    assert.equal(await h.db.prepare('SELECT 1 FROM agent_door_approvals WHERE id=?').bind(heldErasure.result._meta['com.runeditrun/approval'].id).first(), null, 'erasure removes pending private input')
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM agent_door_reviews WHERE json_extract(saved,'$.principal.agent.id')=?").bind(erasureKey.id).first()).n, 0, 'erasure removes personal review custody')
    for (const before of decisionsBefore) {
      const { classes, revision, rules, decision } = JSON.parse((await h.db.prepare('SELECT row FROM agent_door_audit WHERE id=?').bind(before.id).first()).row)
      assert.deepEqual({ id: before.id, classes, revision, rules, decision }, before, 'erasure retains exact policy and classification evidence')
    }
    const afterErasure = await count()
    assert.equal((await erased('resources/read', { uri: erasureProposal.uri })).status, 401)
    assert.equal((await erased('tools/call', { name: 'coaster.claims.propose', arguments: { ...erasureArgs, idempotency_key: 'synthetic-coaster-3519' } })).status, 401)
    assert.equal((await h.send(`/api/coaster/agent/proposals/${erasureProposal.proposal.id}`, undefined, '', { authorization: `Bearer ${erasureKey.token}` })).status, 401)
    assert.equal((await h.send('/api/coaster/agent/claims', erasureArgs, '', { authorization: `Bearer ${erasureKey.token}`, 'idempotency-key': erasureIdempotency })).status, 401)
    assert.equal(await count(), afterErasure, 'erased authority cannot replay a capture into a new proposal')
    console.log('PROBE BASE-AGENT-003 erasure: native erasure followed by resource read and capture replay -> 401, no new proposal')
    console.log('PROBE BASE-AGENT-003 custody: held read -> content withheld until native company approval; revoked key and withdrawn membership -> 401 without financial changes')
  } finally { await h.close() }
})
