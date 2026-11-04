import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness, receipt } from './harness.mjs'
import { autonomousPolicy, heldPolicy } from '../src/modules/agent-door/conformance/crypto.mjs'
import { claimArguments, linkedProposal, proposalClient } from './agent-door/proposals.mjs'

const list = async (client, args = {}) => {
  const r = await client('tools/call', { name: 'coaster.events.list', arguments: args })
  assert.equal(r.status, 200)
  assert.equal(r.result?.isError, false, JSON.stringify(r))
  return r.result.structuredContent
}
const created = events => events.filter(e => e.type === 'proposal.created')

test('Retained proposal events preserve cursor identity, explicit grants and current native custody', async () => {
  const h = await harness()
  try {
    const t = await agency(h), request = (url, init) => h.mf.dispatchFetch(url, init)
    const policy = async document => {
      const r = await request(h.origin + '/agents/api/policy', { method: 'PUT', headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/json' }, body: JSON.stringify({ document }) })
      assert.equal(r.status, 200, await r.text())
    }
    await policy(autonomousPolicy())
    const legacy = await h.post('agent-keys', { label: 'synthetic-coaster-4200', scopes: ['events:read'] }, t.sam)
    const key = await h.post('agent-keys', { label: 'synthetic-coaster-4201', eventsRead: true }, t.sam)
    const financeKey = await h.post('agent-keys', { label: 'synthetic-coaster-4202', eventsRead: true }, t.morgan)
    const client = proposalClient(request, h.origin, key.token), finance = proposalClient(request, h.origin, financeKey.token)
    const legacyClient = proposalClient(request, h.origin, legacy.token)
    assert.deepEqual(legacy.scopes, ['proposals:read', 'proposals:write'])
    assert.deepEqual(key.scopes, [...legacy.scopes, 'events:read'])
    const stored = await h.db.prepare('SELECT token_hash,scopes FROM c_agent_keys WHERE id=?').bind(key.id).first()
    assert.notEqual(stored.token_hash, key.token); assert.equal(stored.token_hash.length, 64)
    assert.ok(!JSON.stringify(stored).includes(key.token))
    await h.post('agent-keys', { label: 'synthetic-coaster-4203', eventsRead: 'true' }, t.sam, 400)
    assert.equal((await legacyClient('tools/list')).result.tools.find(t => t.name === 'coaster.events.list')._meta['com.runeditrun/scope'], 'events:read')
    const missingScope = await legacyClient('tools/call', { name: 'coaster.events.list', arguments: {} })
    assert.equal(missingScope.status, 403)
    assert.equal(missingScope.error.data.code, 'insufficient_scope')
    const templates = await client('resources/templates/list')
    assert.deepEqual(templates.result.resourceTemplates.map(r => r.uriTemplate), ['coaster://proposals/{id}'])
    assert.equal((await client('subscriptions/listen', { uris: ['coaster://proposals/synthetic-coaster-4204'] })).error.data.code, 'capability_not_declared')
    const before = await list(client)
    assert.deepEqual(created(before.events), [])
    const args = claimArguments(t.c.office, 'synthetic-coaster-4205')
    args.items[0].receipt = await receipt('bistro')
    args.actor = { name: 'synthetic-coaster-4206' }; args.classes = ['money']; args.at = 'synthetic-coaster-4207'
    const captured = { name: 'coaster.claims.propose', arguments: { ...args, idempotency_key: 'synthetic-coaster-4230' } }
    const p = await linkedProposal(client, captured.name, args, captured.arguments.idempotency_key)
    const second = await linkedProposal(client, 'coaster.claims.propose', claimArguments(t.c.office, 'synthetic-coaster-4208'))
    const events = created((await list(client)).events)
    assert.deepEqual(events.map(e => e.uri), [p.uri, second.uri])
    assert.equal(new Set(events.map(e => e.id)).size, 2, 'same-key mutation replay emits no second created event')
    const operator = await h.db.prepare('SELECT id,display_name AS name FROM oa_operators WHERE lower(email)=?').bind(p.proposal.for_email).first()
    for (const e of events) {
      assert.deepEqual(Object.keys(e).sort(), ['actor', 'at', 'id', 'type', 'uri'])
      assert.match(e.id, /^[a-f0-9-]{36}$/); assert.ok(Number.isFinite(Date.parse(e.at)))
      assert.equal(e.actor.kind, 'agent'); assert.deepEqual(e.actor.agent, { id: key.id, name: key.label })
      assert.equal(e.actor.for.id, operator.id); assert.equal(e.actor.for.name, operator.name)
      assert.ok(!JSON.stringify(e).includes(args.title)); assert.ok(!JSON.stringify(e).includes(key.token))
      assert.ok(!JSON.stringify(e).includes(args.items[0].receipt.base64))
    }
    const page = await list(client, { limit: 1 })
    assert.equal(page.events[0].id, events[0].id); assert.equal(page.cursor, events[0].id)
    const replay = await list(client, { after: page.cursor, limit: 1 })
    assert.deepEqual(replay.events, [events[1]])
    assert.deepEqual(await list(client, { after: page.cursor, limit: 1 }), replay)
    assert.deepEqual(await list(client, { after: replay.cursor }), { events: [], cursor: replay.cursor })
    console.log('PROBE BASE-AGENT-010 3: MCP claim preparation and same-key replay, then paged and repeated cursor reads -> exact proposal URIs, server attribution, stable ordered once-only event ids')
    // Ordinary human acceptance, submission and independent approval still control finance records.
    assert.equal((await h.send(`/api/coaster/proposals/${p.proposal.id}/accept`, {}, '', { authorization: `Bearer ${key.token}` })).status, 401)
    let claim = (await h.post(`proposals/${p.proposal.id}/accept`, {}, t.sam)).claim
    assert.equal(claim.status, 'draft')
    claim = await h.post(`claims/${claim.id}/submit`, { version: claim.version }, t.sam)
    claim = await h.post(`claims/${claim.id}/decision`, { version: claim.version, revision: claim.revision, decision: 'approved' }, t.priya)
    const batch = await linkedProposal(finance, 'coaster.batches.propose', { claims: [claim.id], note: 'synthetic-coaster-4209' })
    const financeEvents = created((await list(finance)).events)
    assert.equal(financeEvents.length, 1); assert.equal(financeEvents[0].uri, batch.uri)
    assert.equal(financeEvents[0].actor.agent.id, financeKey.id)
    assert.ok(!(await list(client)).events.some(e => e.uri === batch.uri), 'foreign proposals never appear')
    // Native conversations and preparation records have no proposal-created emission.
    let draft = await h.post('claims', { title: 'synthetic-coaster-4210' }, t.sam)
    draft = await h.post(`claims/${draft.id}/items`, { version: draft.version, ...claimArguments(t.c.office).items[0] }, t.sam)
    const hidden = await h.post(`preparations/expenses/${draft.id}`, {}, t.sam)
    assert.ok(!(await list(client)).events.some(e => e.uri === `coaster://proposals/${hidden.id}`))
    assert.deepEqual(created((await list(client)).events), events)
    const snapshot = async () => ({ proposals: (await h.db.prepare('SELECT * FROM c_proposals ORDER BY id').all()).results,
      claims: (await h.db.prepare('SELECT * FROM c_claims ORDER BY id').all()).results,
      batches: (await h.db.prepare('SELECT * FROM c_batches ORDER BY id').all()).results,
      events: (await h.db.prepare("SELECT * FROM agent_door_events WHERE json_extract(event,'$.type')='proposal.created' ORDER BY sequence").all()).results })
    const beforeRefused = await snapshot()
    const refused = await client('tools/call', { name: 'coaster.batches.propose', arguments: { claims: [claim.id], idempotency_key: 'synthetic-coaster-4211' } })
    assert.equal(refused.result.isError, true)
    const invalid = await client('tools/call', { name: 'coaster.claims.propose', arguments: { ...claimArguments(t.c.office), items: [{ kind: 'receipt', amount: '-1' }], idempotency_key: 'synthetic-coaster-4212' } })
    assert.equal(invalid.result.isError, true)
    assert.deepEqual(await snapshot(), beforeRefused, 'refused preparations create no proposal or event')
    await policy(heldPolicy())
    const heldParams = { name: 'coaster.claims.propose', arguments: { ...claimArguments(t.c.office, 'synthetic-coaster-4213'), idempotency_key: 'synthetic-coaster-4214' } }
    const held = await client('tools/call', heldParams)
    assert.equal(held.result.resultType, 'input_required')
    assert.deepEqual(await snapshot(), beforeRefused, 'no proposal-created event before required approval')
    const handle = held.result._meta['com.runeditrun/approval']
    const view = await h.send(`/agents/api/approvals/${handle.id}`, undefined, t.sam)
    assert.equal(view.status, 200)
    const decision = await h.send(`/agents/api/approvals/${handle.id}/approve`, { revision: view.value.approval.revision, summary_sha256: view.value.approval.summary_sha256 }, t.sam)
    assert.equal(decision.status, 200)
    const completed = await client('tools/call', { ...heldParams, requestState: held.result.requestState })
    assert.equal(completed.result.isError, false)
    const heldId = completed.result.structuredContent.id
    await client('tools/call', { ...heldParams, requestState: held.result.requestState })
    const heldState = await snapshot()
    assert.equal(heldState.proposals.length, beforeRefused.proposals.length + 1)
    assert.equal(heldState.events.length, beforeRefused.events.length + 1)
    assert.equal(JSON.parse(heldState.events.at(-1).event).uri, `coaster://proposals/${heldId}`)
    assert.deepEqual(heldState.claims, beforeRefused.claims); assert.deepEqual(heldState.batches, beforeRefused.batches)
    const approvalOnly = heldPolicy(); approvalOnly.rules = approvalOnly.rules.filter(rule => rule.id !== 'standard')
    await policy(approvalOnly)
    const batchParams = { name: 'coaster.batches.propose', arguments: { claims: [claim.id], idempotency_key: 'synthetic-coaster-4226' } }
    const heldBatch = await finance('tools/call', batchParams)
    assert.equal(heldBatch.result.resultType, 'input_required')
    assert.deepEqual(await snapshot(), heldState, 'held finance preparation creates no proposal or event before approval')
    const batchHandle = heldBatch.result._meta['com.runeditrun/approval']
    const batchView = await h.send(`/agents/api/approvals/${batchHandle.id}`, undefined, t.morgan)
    assert.equal(batchView.status, 200)
    const batchDecision = await h.send(`/agents/api/approvals/${batchHandle.id}/approve`, { revision: batchView.value.approval.revision, summary_sha256: batchView.value.approval.summary_sha256 }, t.morgan)
    assert.equal(batchDecision.status, 200)
    const completedBatch = await finance('tools/call', { ...batchParams, requestState: heldBatch.result.requestState })
    assert.equal(completedBatch.result.isError, false)
    await finance('tools/call', { ...batchParams, requestState: heldBatch.result.requestState })
    const afterBatch = await snapshot()
    assert.equal(afterBatch.proposals.length, heldState.proposals.length + 1)
    assert.equal(afterBatch.events.length, heldState.events.length + 1)
    assert.equal(JSON.parse(afterBatch.events.at(-1).event).uri, `coaster://proposals/${completedBatch.result.structuredContent.id}`)
    assert.deepEqual(afterBatch.claims, heldState.claims); assert.deepEqual(afterBatch.batches, heldState.batches)
    await policy(autonomousPolicy())
    await h.post('delegates', { delegate: p.proposal.for_email, level: 'full' }, t.priya)
    const delegator = (await h.get('state', t.priya)).actor.email
    const keysBeforeRefusal = (await h.db.prepare('SELECT * FROM c_agent_keys ORDER BY id').all()).results
    assert.equal((await h.send('/api/coaster/agent-keys', { label: 'synthetic-coaster-4227', eventsRead: true }, t.sam, { 'x-coaster-acting-for': delegator })).status, 403)
    assert.equal((await h.send('/api/coaster/agent-keys', { label: 'synthetic-coaster-4228', eventsRead: true }, '', { authorization: `Bearer ${key.token}` })).status, 401)
    await h.post(`agent-keys/${financeKey.id}/revoke`, {}, t.sam, 404)
    assert.deepEqual((await h.db.prepare('SELECT * FROM c_agent_keys ORDER BY id').all()).results, keysBeforeRefusal)
    console.log('PROBE BASE-AGENT-010 creation: employee and finance MCP preparations under autonomous and held policies -> one minimal event only after successful native creation and required approval; no native financial decisions')
    // Stored grants are intersected on every request; an opted-in key never widens another key.
    await h.db.prepare('UPDATE c_agent_keys SET scopes=? WHERE id=?').bind(JSON.stringify(['events:read']), key.id).run()
    assert.deepEqual(created((await list(client)).events), [], 'event scope alone cannot bypass the proposal resource scope')
    await h.db.prepare('UPDATE c_agent_keys SET scopes=? WHERE id=?').bind(JSON.stringify(legacy.scopes), key.id).run()
    const narrowed = await client('tools/call', { name: 'coaster.events.list', arguments: {} })
    assert.equal(narrowed.status, 403)
    assert.equal(narrowed.error.data.code, 'insufficient_scope')
    await h.post(`agent-keys/${key.id}/revoke`, {}, t.sam)
    const revokedState = await snapshot()
    assert.equal((await client('tools/call', { name: 'coaster.events.list', arguments: { after: page.cursor } })).status, 401)
    assert.equal((await client('tools/call', captured)).status, 401)
    assert.deepEqual(await snapshot(), revokedState, 'a revoked captured mutation cannot create a proposal or a retained event')
    await h.post('settings/members', { email: batch.proposal.for_email, name: 'synthetic-coaster-4215', active: false, employee: true, finance: true })
    const inactive = await finance('tools/call', { name: 'coaster.events.list', arguments: {} })
    assert.equal(inactive.status, 401); assert.equal(inactive.result, undefined)
    const erasureKey = await h.post('agent-keys', { label: 'synthetic-coaster-4216', eventsRead: true }, t.alex)
    const erased = proposalClient(request, h.origin, erasureKey.token)
    const erasedProposal = await linkedProposal(erased, 'coaster.claims.propose', claimArguments(t.c.office, 'synthetic-coaster-4217'))
    await h.post('settings/members', { email: erasedProposal.proposal.for_email, name: 'synthetic-coaster-4218', active: false, employee: true })
    await h.post('settings/members/erase', { email: erasedProposal.proposal.for_email })
    const afterErasure = await snapshot()
    assert.equal((await erased('tools/call', { name: 'coaster.events.list', arguments: {} })).status, 401)
    assert.equal((await erased('tools/call', { name: 'coaster.claims.propose', arguments: { ...args, idempotency_key: 'synthetic-coaster-4219' } })).status, 401)
    assert.deepEqual(await snapshot(), afterErasure, 'erased credentials cannot read events or resurrect proposals')
    console.log('PROBE BASE-AGENT-010 4: ungranted, narrowed, revoked and inactive keys plus erasure and capture replay -> refused without event disclosure or record resurrection')
  } finally { await h.close() }
})
