import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness } from './harness.mjs'
import { autonomousPolicy, heldPolicy } from '../src/modules/agent-door/conformance/crypto.mjs'
import { claimArguments, proposalClient } from './agent-door/proposals.mjs'

test('Agent capacity shares the advertised allowance and refuses preparation without native or provider effects', async () => {
  const clock = Date.parse('2031-06-10T12:00:17.250Z')
  const h = await harness({ clock })
  try {
    const t = await agency(h)
    const request = (url, init) => h.mf.dispatchFetch(url, init)
    const snapshot = async () => {
      const tables = ['c_proposals', 'c_claims', 'c_items', 'c_receipts', 'c_revisions', 'c_decisions', 'c_batches', 'c_batch_claims', 'c_reimbursement_keys', 'c_events']
      return Object.fromEntries(await Promise.all(tables.map(async name => [name, (await h.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results])))
    }
    // Retain real nonempty financial records, including once-only reimbursement keys.
    let paid = await h.post('claims', { title: 'synthetic-coaster-4300' }, t.sam)
    paid = await h.post(`claims/${paid.id}/items`, { version: paid.version, ...claimArguments(t.c.office).items[0], date: '2031-06-10', explanation: 'synthetic-coaster-4301' }, t.sam)
    paid = await h.post(`claims/${paid.id}/submit`, { version: paid.version }, t.sam)
    paid = await h.post(`claims/${paid.id}/decision`, { version: paid.version, revision: paid.revision, decision: 'approved', acknowledge: true }, t.priya)
    await h.post('batches', { claims: [paid.id] }, t.morgan)
    let draft = await h.post('claims', { title: 'synthetic-coaster-4302' }, t.sam)

    for (const [policyName, document] of [['autonomous', autonomousPolicy()], ['held', heldPolicy()]]) {
      const response = await request(h.origin + '/agents/api/policy', { method: 'PUT', headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/json' }, body: JSON.stringify({ document }) })
      assert.equal(response.status, 200, await response.text())
      const key = await h.post('agent-keys', { label: 'synthetic-coaster-4303' }, t.sam)
      const other = await h.post('agent-keys', { label: 'synthetic-coaster-4304' }, t.sam)
      const first = proposalClient(request, h.origin, key.token)
      const discovery = await first('server/discover')
      assert.equal(discovery.status, 200)
      const { requestsPerMinute: allowance, maxBodyBytes } = discovery.result._meta['com.runeditrun/limits']
      assert.ok(Number.isSafeInteger(allowance) && allowance > 2)
      assert.ok(Number.isSafeInteger(maxBodyBytes) && maxBodyBytes > 0)
      const clients = discovery.result.supportedVersions.map(version => proposalClient(request, h.origin, key.token, version))
      assert.ok(clients.length > 1, 'exercise supported versions against one agent counter')
      const another = proposalClient(request, h.origin, other.token)
      const args = claimArguments(t.c.office, 'synthetic-coaster-4305')
      const call = { name: 'coaster.claims.propose', arguments: { ...args, idempotency_key: crypto.randomUUID() } }
      let allowed = await another('tools/call', call)
      if (policyName === 'held') {
        const approvalHandle = allowed.result._meta['com.runeditrun/approval']
        assert.ok(approvalHandle, 'held preparation requires native company approval')
        const view = await h.send(`/agents/api/approvals/${approvalHandle.id}`, undefined, t.sam)
        assert.equal(view.status, 200)
        const approval = view.value.approval
        const decision = await h.send(`/agents/api/approvals/${approvalHandle.id}/approve`, { revision: approval.revision, summary_sha256: approval.summary_sha256 }, t.sam)
        assert.equal(decision.status, 200)
        allowed = await another('tools/call', { ...call, requestState: allowed.result.requestState })
      }
      assert.equal(allowed.result.isError, false, JSON.stringify(allowed))
      assert.equal(allowed.result.structuredContent.status, 'proposed', 'within capacity the authorized preparation succeeds')
      const before = await snapshot(), outboundBefore = structuredClone(h.outbound)
      for (const table of ['c_proposals', 'c_claims', 'c_batches', 'c_reimbursement_keys']) assert.ok(before[table].length, `${table} comparison uses nonempty records`)
      const methods = ['tools/list', 'resources/templates/list', 'prompts/list']
      const catalogue = async n => {
        const id = n % 2 ? `synthetic-coaster-${4400 + n}` : n
        const answer = await clients[n % clients.length](methods[n % methods.length], {}, id)
        assert.equal(answer.id, id, 'JSON-RPC correlation is preserved across versions')
        return answer
      }
      // Consume the production allowance by ordinary HTTP calls, never by seeding its counter.
      for (let n = 0; n < allowance - 2; n++) {
        const answer = await catalogue(n)
        assert.equal(answer.status, 200)
        assert.ok(answer.result, JSON.stringify(answer))
      }
      const boundary = await Promise.all(Array.from({ length: 4 }, (_, n) => catalogue(allowance - 2 + n)))
      assert.equal(boundary.filter(answer => answer.status === 200).length, 2, 'exactly the remaining slots admit concurrent requests')
      assert.equal(boundary.filter(answer => answer.status === 429).length, 2, 'concurrency cannot exceed the shared allowance')
      const refused = answer => {
        assert.equal(answer.status, 429)
        assert.equal(answer.error.data.code, 'rate_limited')
        assert.equal(Number(answer.retryAfter), Math.ceil((60000 - clock % 60000) / 1000), 'positive delay accurately reaches the next fixed minute')
        assert.ok(Number(answer.retryAfter) > 0)
        assert.equal(answer.result, undefined)
      }
      boundary.filter(answer => answer.status === 429).forEach(refused)
      // This valid automatic-FX preparation would contact a provider if it passed admission.
      args.items[0].currency = 'USD'
      for (const [index, client] of clients.entries()) refused(await client('tools/call', {
        name: 'coaster.claims.propose', arguments: { ...args, idempotency_key: crypto.randomUUID() },
      }, `synthetic-coaster-${4306 + index}`))
      assert.deepEqual(await snapshot(), before, `${policyName}: refused admission changes no proposal, claim, batch, reimbursement key or native history`)
      assert.deepEqual(h.outbound, outboundBefore, `${policyName}: no provider request or outbound message`)
      const independent = await another('tools/list')
      assert.equal(independent.status, 200)
      assert.ok(independent.result.tools.length, 'a distinct authorized agent for the same person remains usable')
      draft = await h.post(`claims/${draft.id}/title`, { version: draft.version, title: `synthetic-coaster-4307-${policyName}` }, t.sam)
      assert.equal(draft.title, `synthetic-coaster-4307-${policyName}`, 'ordinary native-session claim writes remain usable')
      console.log(`PROBE BASE-AGENT-011 1 ${policyName}: ${allowance} authenticated catalogue requests across ${clients.length} versions and mixed ids, concurrent boundary -> exactly ${allowance} admitted, HTTP 429 rate_limited with Retry-After=${Math.ceil((60000 - clock % 60000) / 1000)}; preparation refused, nonempty financial records and outbound unchanged; other agent and native claim write usable`)
    }
  } finally { await h.close() }
})
