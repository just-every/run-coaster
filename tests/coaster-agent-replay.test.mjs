import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness, receipt } from './harness.mjs'
import { autonomousPolicy, heldPolicy } from '../src/modules/agent-door/conformance/crypto.mjs'
import { claimArguments, proposalClient, readProposal } from './agent-door/proposals.mjs'

test('Accepted batch preparation replays the lost outcome under current authority and policy without financial effects', async () => {
  const h = await harness()
  try {
    const t = await agency(h)
    const request = (url, init) => h.mf.dispatchFetch(url, init)
    const policy = async document => {
      const r = await request(h.origin + '/agents/api/policy', { method: 'PUT', headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/json' }, body: JSON.stringify({ document }) })
      assert.equal(r.status, 200, await r.text())
    }
    const audit = async () => {
      const r = await h.send('/agents/api/audit', undefined, h.owner)
      assert.equal(r.status, 200)
      assert.equal(r.value.differs_from_policy, 0)
      return r.value.rows
    }
    // Include exact immutable evidence, not just counts: no repeated transition,
    // batch reservation, decision or numbered native history line may appear.
    const financial = async () => Object.fromEntries(await Promise.all([
      'c_proposals', 'c_claims', 'c_items', 'c_revisions', 'c_decisions',
      'c_batches', 'c_batch_claims', 'c_reimbursement_keys', 'c_events', 'c_receipts', 'c_history',
    ].map(async table => [table, (await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])))
    const refused = (answer, code) => {
      assert.equal(answer.result?._meta?.['com.runeditrun/error']?.code ?? answer.error?.data?.code, code, JSON.stringify(answer))
      assert.equal(answer.result?.structuredContent, undefined, 'refused retries disclose no cached proposal')
      assert.ok(!JSON.stringify(answer).includes('coaster://proposals/'), 'refused retries disclose no cached link')
    }
    for (const [phase, document] of [['autonomous', autonomousPolicy()], ['held', heldPolicy()]]) {
      await policy(document)
      let claim = await h.post('claims', { title: `synthetic-coaster-3800-${phase}` }, t.sam)
      const uploaded = await h.post(`claims/${claim.id}/receipts`, { version: claim.version, ...await receipt(phase === 'held' ? 'officeworks' : 'bistro') }, t.sam)
      claim = await h.post(`claims/${claim.id}/items`, { version: uploaded.claim.version, ...claimArguments(t.c.office, `synthetic-coaster-3800-${phase}`).items[0], receipt: uploaded.receipt }, t.sam)
      claim = await h.post(`claims/${claim.id}/submit`, { version: claim.version }, t.sam)
      claim = await h.post(`claims/${claim.id}/decision`, { version: claim.version, revision: claim.revision, decision: 'approved' }, t.priya)
      const key = await h.post('agent-keys', { label: `synthetic-coaster-3801-${phase}` }, t.morgan)
      const client = proposalClient(request, h.origin, key.token)
      const params = { name: 'coaster.batches.propose', arguments: { claims: [claim.id], note: `synthetic-coaster-3802-${phase}`, idempotency_key: `synthetic-coaster-3803-${phase}` } }
      let original
      const lostClient = proposalClient(async (url, init) => {
        const response = await request(url, init)
        original = await response.json()
        // The Worker completes; the network edge discards the response before
        // the client can receive it. Native state remains independently usable.
        throw new Error('synthetic-coaster-3804 dropped response')
      }, h.origin, key.token)
      await assert.rejects(lostClient('tools/call', params, 3801), /dropped response/)
      assert.equal(original.result?.isError, false, JSON.stringify(original))
      const screen = (await h.get('state', t.morgan)).proposals.find(p => p.payload.note === params.arguments.note)
      assert.ok(screen)
      const proposal = original.result.structuredContent
      for (const [field, value] of Object.entries(screen)) assert.deepEqual(proposal[field], value, field)
      assert.equal(proposal.status, 'proposed')
      const link = original.result.content.filter(c => c.type === 'resource_link')
      assert.equal(link.length, 1)
      assert.equal(link[0].uri, `coaster://proposals/${proposal.id}`)
      assert.equal(original.result._meta['com.runeditrun/decision'].disposition, phase === 'held' ? 'review' : 'autonomous')
      assert.equal((await h.send(`/api/coaster/proposals/${proposal.id}/accept`, {}, '', { authorization: `Bearer ${key.token}` })).status, 401)
      const accepted = await h.post(`proposals/${proposal.id}/accept`, {}, t.morgan)
      assert.equal(accepted.proposal.status, 'accepted')
      assert.equal(accepted.proposal.result_id, accepted.batch.id)
      assert.equal(accepted.batch.status, 'draft')
      assert.equal(accepted.batch.total_minor, 1234)
      assert.equal((await h.get(`claims/${claim.id}`, t.sam)).claim.status, 'batched')
      const before = await financial()
      const retries = []
      for (const rpcId of [3802, 3803]) {
        const retry = await client('tools/call', params, rpcId)
        assert.equal(retry.id, rpcId, 'transport id belongs to this retry')
        assert.equal(retry.result?.isError, false, JSON.stringify(retry))
        assert.deepEqual(retry.result.structuredContent, original.result.structuredContent, 'recorded preparation outcome stays proposed')
        assert.deepEqual(retry.result.content, original.result.content, 'recorded content and original link survive acceptance')
        assert.deepEqual(retry.result._meta['com.runeditrun/receipt'], original.result._meta['com.runeditrun/receipt'])
        assert.deepEqual(retry.result._meta['com.runeditrun/decision'].classes, original.result._meta['com.runeditrun/decision'].classes)
        retries.push(retry.result._meta['com.runeditrun/decision'].id)
        assert.deepEqual(await financial(), before)
      }
      const firstId = original.result._meta['com.runeditrun/decision'].id
      assert.equal(new Set([firstId, ...retries]).size, 3, 'each retry has a distinct decision')
      const rows = await audit(), first = rows.find(r => r.id === firstId)
      assert.equal(first.outcome, 'done')
      assert.deepEqual(first.classes, [{ class: 'standard', facts: { measure: 1 } }])
      for (const id of retries) {
        const row = rows.find(r => r.id === id)
        assert.equal(row.outcome, 'replayed')
        assert.equal(row.replay_of, firstId)
        assert.equal(row.operation_id, first.operation_id)
        for (const field of ['agent', 'sponsor', 'tool', 'resource', 'classes', 'idempotency_key', 'client_id', 'scopes']) assert.deepEqual(row[field], first[field], field)
      }
      let read = await client('resources/read', { uri: link[0].uri })
      if (phase === 'held') {
        assert.equal(read.error?.data?.code, 'approval_required')
        assert.equal(read.result, undefined)
        const handle = read.error.data.approval
        const view = await h.send(`/agents/api/approvals/${handle.id}`, undefined, t.morgan)
        assert.equal(view.status, 200)
        const approval = view.value.approval
        assert.equal((await h.send(`/agents/api/approvals/${handle.id}/approve`, { revision: approval.revision, summary_sha256: approval.summary_sha256 }, t.morgan)).status, 200)
        read = await client('resources/read', { uri: link[0].uri, requestState: read.error.data.requestState })
      }
      assert.deepEqual(readProposal(read), accepted.proposal, 'authorized resource read returns current accepted state')
      assert.deepEqual(await financial(), before)
      refused(await client('tools/call', { ...params, arguments: { ...params.arguments, note: 'synthetic-coaster-3805' } }), 'idempotency_conflict')
      refused(await client('tools/call', { ...params, arguments: { ...params.arguments, idempotency_key: 'synthetic-coaster-3806', completed: first.classes } }), 'native_conflict')
      assert.deepEqual(await financial(), before, 'fresh keys still check claim eligibility; caller-supplied effect facts grant no bypass')
      console.log(`PROBE BASE-AGENT-012 1 and 2 ${phase}: lost MCP response, native acceptance, new JSON-RPC ids with same key -> original outcome and link, accepted resource, distinct linked audits, no duplicate financial effects`)
      console.log(`PROBE BASE-AGENT-012 conflicts ${phase}: changed arguments and fresh key for consumed claims -> conflict, no financial effect`)
      assert.equal((await h.send('/agents/api/pause', { paused: true }, h.owner)).status, 200)
      refused(await client('tools/call', params), 'agents_paused')
      assert.deepEqual(await financial(), before)
      assert.equal((await h.send('/agents/api/pause', { paused: false }, h.owner)).status, 200)
      await policy({ ...autonomousPolicy(), rules: [{ id: 'stop', class: '*', do: 'blocked' }] })
      refused(await client('tools/call', params), 'policy_blocked')
      assert.deepEqual(await financial(), before)
      await policy({ ...heldPolicy(), rules: [{ id: 'hold', class: '*', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }] })
      refused(await client('tools/call', params), 'approval_required')
      assert.deepEqual(await financial(), before)
      await policy(document)
      const member = { email: proposal.for_email, name: 'synthetic-coaster-3807', employee: true, finance: false, active: true }
      await h.post('settings/members', member)
      const afterWithdrawal = await financial()
      refused(await client('tools/call', params), 'native_authority_required')
      assert.deepEqual(await financial(), afterWithdrawal)
      await h.post('settings/members', { ...member, finance: true, active: false })
      const afterInactive = await financial()
      assert.equal((await client('tools/call', params)).status, 401)
      assert.deepEqual(await financial(), afterInactive)
      await h.post('settings/members', { ...member, finance: true, active: true })
      await h.post(`agent-keys/${key.id}/revoke`, {}, t.morgan)
      const afterRevocation = await financial()
      const revoked = await client('tools/call', params)
      assert.equal(revoked.status, 401)
      assert.equal(revoked.result?.structuredContent, undefined)
      assert.deepEqual(await financial(), afterRevocation)
      console.log(`PROBE BASE-AGENT-012 controls ${phase}: Pause, blocking or newly held policy, finance withdrawal, inactive membership and revoked key -> refusal without cached content or native writes`)
    }
  } finally { await h.close() }
})
