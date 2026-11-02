import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness, receipt } from './harness.mjs'
import { autonomousPolicy } from '../src/modules/agent-door/conformance/crypto.mjs'
import { claimArguments, configureAgentPolicy, proposalClient } from './agent-door/proposals.mjs'

const decision = value => { const { id, ...rest } = value; return rest }
const effects = async h => Object.fromEntries(await Promise.all(['c_proposals', 'c_receipts', 'c_claims', 'c_items', 'c_batches', 'c_decisions', 'c_reimbursement_keys', 'c_events'].map(async table => [table, (await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])))
const restClient = (h, token) => async (path, args, requestState, headers = {}) => {
  const response = await h.send('/api/coaster/agent/' + path + (requestState ? '?requestState=' + encodeURIComponent(requestState) : ''), args, '', { authorization: `Bearer ${token}`, ...headers })
  return { ...response, decision: JSON.parse(response.headers.get('x-coaster-agent-decision') ?? 'null') }
}
const toolCode = answer => answer.result?._meta?.['com.runeditrun/error']?.code ?? answer.error?.data?.code
const namedPolicy = ref => ({ ...autonomousPolicy(), rules: [{ id: 'named', class: '*', do: 'approval', approver: [ref], wait: 'PT1H' }] })
async function approve(h, approval, action = 'approve', cookie = h.owner) {
  const view = await h.send('/agents/api/approvals/' + approval.id, undefined, cookie)
  assert.equal(view.status, 200, view.text)
  const a = view.value.approval
  const result = await h.send(`/agents/api/approvals/${a.id}/${action}`, { revision: a.revision, summary_sha256: a.summary_sha256 }, cookie)
  assert.equal(result.status, 200, result.text)
  return result.value.approval
}

test('Personal REST and MCP share policy decisions, private approval state and once-only preparations', async () => {
  const h = await harness()
  try {
    const t = await agency(h)
    const employee = await h.post('agent-keys', { label: 'synthetic-coaster-4100' }, t.sam)
    const finance = await h.post('agent-keys', { label: 'synthetic-coaster-4101' }, t.morgan)
    const foreign = await h.post('agent-keys', { label: 'synthetic-coaster-4102' }, t.alex)
    const rest = restClient(h, employee.token), mcp = proposalClient((...args) => h.mf.dispatchFetch(...args), h.origin, employee.token)
    const financeRest = restClient(h, finance.token), financeMcp = proposalClient((...args) => h.mf.dispatchFetch(...args), h.origin, finance.token)
    const ownerId = (await h.db.prepare("SELECT id FROM oa_operators WHERE role='owner'").first()).id
    const claimArgs = claimArguments(t.c.office, 'synthetic-coaster-4103')
    claimArgs.items[0].receipt = await receipt('bistro')
    let c = await h.post('claims', { title: 'synthetic-coaster-4104' }, t.sam)
    c = await h.post(`claims/${c.id}/items`, { version: c.version, ...claimArguments(t.c.office).items[0], explanation: 'synthetic-coaster-4111' }, t.sam)
    c = await h.post(`claims/${c.id}/submit`, { version: c.version }, t.sam)
    c = await h.post(`claims/${c.id}/decision`, { version: c.version, revision: c.revision, decision: 'approved', acknowledge: true, reason: 'synthetic-coaster-4112' }, t.priya)
    const initial = await effects(h)
    const unset = await rest('context')
    assert.equal(unset.status, 409); assert.equal(unset.value.code, 'policy_unset'); assert.equal(unset.value.setup_url, h.origin + '/agents')
    assert.equal(toolCode(await mcp('tools/call', { name: 'coaster.workspace.get', arguments: {} })), 'policy_unset')
    assert.deepEqual(await effects(h), initial)
    await configureAgentPolicy(h)
    const first = await rest('claims', { ...claimArgs, idempotency_key: 'synthetic-coaster-4105' })
    assert.equal(first.status, 200, first.text)
    const descriptors = [
      { path: 'context', name: 'coaster.workspace.get', args: {}, classes: ['standard'] },
      { path: 'proposals/' + first.value.id, name: 'coaster.proposals.get', args: { id: first.value.id }, classes: ['standard', 'sensitive'] },
      { path: 'claims', name: 'coaster.claims.propose', args: claimArgs, classes: ['standard', 'sensitive'], write: true },
      { path: 'batches', name: 'coaster.batches.propose', args: { claims: [c.id] }, classes: ['standard'], write: true, rest: financeRest, mcp: financeMcp },
    ]
    for (const mode of ['autonomous', 'review', 'approval', 'blocked', 'unset']) {
      const document = mode === 'approval' ? namedPolicy('person:' + ownerId) : { ...autonomousPolicy(), rules: [{ id: 'same-rule', class: '*', do: mode === 'unset' ? 'autonomous' : mode }], ...(mode === 'review' ? { reviewers: ['sponsor'] } : {}) }
      const revision = await configureAgentPolicy(h, document)
      // An upgrade may leave a newly declared class unanswered. No transport may bypass it.
      if (mode === 'unset') await h.db.prepare('UPDATE agent_door_state SET local_document=? WHERE id=1').bind(JSON.stringify({ ...document, rules: [] })).run()
      for (const d of descriptors) {
        const r = d.rest ?? rest, m = d.mcp ?? mcp, key = crypto.randomUUID()
        const args = d.write ? { ...d.args, idempotency_key: key } : d.args
        const before = await effects(h)
        const a = await r(d.path, d.write ? args : undefined)
        const b = await m('tools/call', { name: d.name, arguments: args, ...(a.value.requestState ? { requestState: a.value.requestState } : {}) })
        assert.deepEqual(decision(a.decision), decision(b.result._meta['com.runeditrun/decision']), `${mode} ${d.name} decision parity`)
        assert.equal(a.decision.revision, revision)
        assert.deepEqual(a.decision.classes.map(x => x.class), d.classes)
        assert.equal(a.decision.disposition, mode === 'unset' ? 'unset' : mode)
        if (['autonomous', 'review'].includes(mode)) {
          assert.equal(a.status, 200, a.text); assert.equal(b.result.isError, false)
          assert.deepEqual(b.result.structuredContent, a.value)
          assert.equal(Boolean(a.headers.get('x-coaster-agent-review')), mode === 'review')
          if (d.write) {
            assert.equal(a.value.status, 'proposed'); assert.equal(a.value.decided_by, null)
            assert.equal((await effects(h)).c_proposals.length, before.c_proposals.length + 1)
            const changed = await m('tools/call', { name: d.name, arguments: { ...args, note: 'synthetic-coaster-4106' } })
            assert.equal(toolCode(changed), 'idempotency_conflict')
            const same = await r(d.path, { ...args, note: 'synthetic-coaster-4106' })
            assert.equal(same.status, 409); assert.equal(same.value.code, 'idempotency_conflict')
            // Reverse direction too: MCP first, REST retry, preserving sponsor and agent attribution.
            const reverseArgs = { ...args, idempotency_key: crypto.randomUUID() }
            const reverse = await m('tools/call', { name: d.name, arguments: reverseArgs })
            assert.deepEqual((await r(d.path, reverseArgs)).value, reverse.result.structuredContent)
            assert.equal(reverse.result.structuredContent.agent_label, d.write && d.path === 'batches' ? finance.label ?? 'synthetic-coaster-4101' : 'synthetic-coaster-4100')
          }
        } else if (mode === 'approval') {
          assert.equal(a.status, 202); assert.equal(b.result.resultType, 'input_required')
          assert.equal(b.result._meta['com.runeditrun/approval'].id, a.value.approval.id)
          assert.equal(b.result.structuredContent, undefined)
          assert.equal(a.value.payload, undefined); assert.equal(a.value.for, undefined)
          assert.deepEqual(await effects(h), before, 'pending approval has zero native preparation effects')
          const view = await h.send('/agents/api/approvals/' + a.value.approval.id, undefined, h.owner)
          assert.equal(view.value.approval.revision, revision)
          assert.deepEqual(view.value.approval.classes.map(x => x.class), d.classes)
          assert.equal((await h.send(`/agents/api/approvals/${a.value.approval.id}/approve`, { revision, summary_sha256: view.value.approval.summary_sha256 }, t.sam)).status, 403, 'only the named person approves')
          if (!d.write) {
            const other = restClient(h, foreign.token)
            assert.equal((await other(d.path, undefined, a.value.requestState)).status, 400)
            const changedPath = d.path === 'context' ? 'proposals/' + first.value.id : 'context'
            assert.equal((await r(changedPath, undefined, a.value.requestState)).value.code, 'invalid_arguments')
          } else {
            assert.equal((await r(d.path, { ...args, note: 'changed' })).value.code, 'idempotency_conflict')
          }
          await approve(h, a.value.approval)
          const done = await r(d.path, d.write ? args : undefined, a.value.requestState)
          assert.equal(done.status, 200, done.text)
          const replay = await m('tools/call', { name: d.name, arguments: args, requestState: a.value.requestState })
          assert.deepEqual(replay.result.structuredContent, done.value)
          if (d.write) {
            assert.equal(done.value.status, 'proposed', 'company approval never accepts a native proposal')
            assert.equal(done.value.result_id, null)
            assert.equal((await effects(h)).c_proposals.length, before.c_proposals.length + 1)
            assert.deepEqual((await effects(h)).c_claims, before.c_claims)
            assert.deepEqual((await effects(h)).c_batches, before.c_batches)
          }
        } else {
          assert.equal(a.value.code, mode === 'blocked' ? 'policy_blocked' : 'policy_unset')
          assert.equal(toolCode(b), a.value.code)
          assert.deepEqual(await effects(h), before, 'policy refusal changes no native record')
        }
      }
    }
    console.log('PROBE BASE-AGENT-007 6: four actual REST routes and MCP tools under autonomous, review, named approval, blocked and unset policies -> equal computed classes, revision, rules and outcomes; private reads withheld and zero preparation effects until approval')
    await configureAgentPolicy(h, namedPolicy('person:' + ownerId))
    for (const action of ['reject', 'expire']) for (const d of [descriptors[1], descriptors[2]]) {
      const args = d.write ? { ...d.args, idempotency_key: crypto.randomUUID() } : undefined
      const before = await effects(h), pending = await rest(d.path, args)
      assert.equal(pending.status, 202)
      if (action === 'reject') await approve(h, pending.value.approval, 'reject')
      else {
        // A fixed stored expiry avoids any wall-clock boundary or test sleep.
        const row = await h.db.prepare('SELECT saved FROM agent_door_approvals WHERE id=?').bind(pending.value.approval.id).first()
        const saved = JSON.parse(row.saved); saved.expires_at = '2000-01-01T00:00:00Z'
        await h.db.prepare('UPDATE agent_door_approvals SET saved=? WHERE id=?').bind(JSON.stringify(saved), pending.value.approval.id).run()
      }
      const refused = await rest(d.path, args, pending.value.requestState)
      assert.equal(refused.value.code, action === 'reject' ? 'approval_rejected' : 'approval_expired')
      assert.equal(refused.value.payload, undefined)
      const b = await mcp('tools/call', { name: d.name, arguments: args ?? d.args, requestState: pending.value.requestState })
      assert.equal(toolCode(b), refused.value.code)
      assert.deepEqual(await effects(h), before)
    }
    await configureAgentPolicy(h)
    const noKey = await rest('claims', claimArgs)
    assert.equal(noKey.status, 400); assert.equal(noKey.value.code, 'idempotency_key_required'); assert.match(noKey.value.error, /Idempotency-Key/)
    assert.equal((await rest('claims', { ...claimArgs, idempotency_key: 'one' }, undefined, { 'idempotency-key': 'two' })).status, 400)
    assert.equal((await rest('context', undefined, undefined, { origin: 'https://foreign.invalid' })).status, 403)
    assert.equal((await h.send('/api/coaster/agent/context', undefined, t.sam)).status, 401)
    await h.post('settings/members', { email: (await h.get('state')).actor.email, name: 'synthetic-coaster-4113', employee: true })
    const publicKey = await h.post('public-api/keys', { label: 'synthetic-coaster-4107', scopes: ['claims:write'], expiresInDays: 1 })
    assert.equal((await restClient(h, publicKey.token)('context')).status, 401, 'public API credentials gain no personal-agent REST authority')
    // Receipt-bearing JSON larger than the old MCP default still uses the same bounded service.
    const large = structuredClone(claimArgs)
    const bytes = Buffer.concat([Buffer.from(large.items[0].receipt.base64, 'base64'), Buffer.alloc(800_000, 32)])
    large.items[0].receipt.base64 = bytes.toString('base64')
    const bounded = await rest('claims', large, undefined, { 'idempotency-key': 'synthetic-coaster-4108' })
    assert.equal(bounded.status, 200, bounded.text)
    assert.equal((await h.db.prepare('SELECT size FROM c_receipts WHERE proposal_id=?').bind(bounded.value.id).first()).size, bytes.length)
    const before = await effects(h)
    assert.equal((await rest('claims', { ...claimArgs, padding: 'x'.repeat(8_000_000) }, undefined, { 'idempotency-key': 'synthetic-coaster-4109' })).status, 413)
    assert.equal((await rest('batches', { claims: [c.id], padding: 'x'.repeat(3_000_000) })).status, 413)
    assert.deepEqual(await effects(h), before)
    console.log('PROBE BASE-AGENT-007 custody: rejected, expired, changed-input and foreign-state retries -> typed refusal without effects; required keys, Origin and native credential boundary preserved; receipt payload above 1 MB succeeds and original request bounds refuse oversize')
  } finally { await h.close() }
})

test('Personal REST immediately fences Pause, revoked keys and withdrawn native authority at both commit guards', async () => {
  let armed = false, arrived, release
  const h = await harness({ d1Barrier: async request => {
    if (armed && new URL(request.url).pathname === '/before-close-review') {
      armed = false; arrived(); await new Promise(resolve => { release = resolve })
    }
    return new Response('ok')
  } })
  try {
    const t = await agency(h)
    for (const scenario of ['pause', 'key', 'membership', 'role', 'pause-after', 'key-after', 'membership-after', 'role-after']) {
      await configureAgentPolicy(h)
      await h.post('settings/members', { email: 'sam' + '@' + 'harbourfinch.example', name: 'Sam', employee: true, active: true })
      const key = await h.post('agent-keys', { label: 'synthetic-coaster-4110' }, t.sam)
      const rest = restClient(h, key.token), mcp = proposalClient((...args) => h.mf.dispatchFetch(...args), h.origin, key.token)
      const args = { ...claimArguments(t.c.office), idempotency_key: crypto.randomUUID() }
      const statements = {
        pause: 'UPDATE agent_door_state SET local_paused=1 WHERE id=1;',
        key: `UPDATE c_agent_keys SET revoked_at='2026-01-01' WHERE id='${key.id}';`,
        membership: "UPDATE c_members SET active=0 WHERE email=NEW.for_email;",
        role: "UPDATE c_members SET is_employee=0 WHERE email=NEW.for_email;",
      }
      if (scenario.endsWith('-after')) await h.db.prepare(`CREATE TRIGGER synthetic_agent_fence AFTER INSERT ON c_proposals BEGIN ${statements[scenario.slice(0, -6)]} END`).run()
      const reached = new Promise(resolve => { arrived = resolve }); armed = true
      const pending = rest('claims', args)
      await reached
      if (scenario === 'pause') assert.equal((await h.send('/agents/api/pause', { paused: true }, h.owner)).status, 200)
      if (scenario === 'key') await h.post(`agent-keys/${key.id}/revoke`, {}, t.sam)
      if (scenario === 'membership') await h.post('settings/members', { email: 'sam' + '@' + 'harbourfinch.example', name: 'Sam', employee: true, active: false })
      if (scenario === 'role') await h.post('settings/members', { email: 'sam' + '@' + 'harbourfinch.example', name: 'Sam', employee: false, auditor: true })
      const before = await effects(h); release()
      const refused = await pending
      assert.equal(refused.value.code, 'native_conflict', refused.text)
      assert.deepEqual(await effects(h), before, scenario + ' rolls back every preparation write')
      if (scenario.endsWith('-after')) await h.db.prepare('DROP TRIGGER synthetic_agent_fence').run()
      else {
        const again = await rest('claims', args)
        const other = await mcp('tools/call', { name: 'coaster.claims.propose', arguments: args })
        assert.equal(again.status, scenario === 'pause' ? 409 : scenario === 'role' ? 403 : 401)
        assert.equal(scenario === 'pause' ? toolCode(other) : scenario === 'role' ? toolCode(other) : other.status, scenario === 'pause' ? 'agents_paused' : scenario === 'role' ? 'native_authority_required' : 401)
        assert.deepEqual(await effects(h), before)
      }
      assert.equal((await h.send('/agents/api/pause', { paused: false }, h.owner)).status, 200)
    }
    console.log('PROBE BASE-AGENT-007 authority: pause, key revocation, membership and role withdrawal before and inside commit -> no proposals, receipts, claims, batches or financial effects; both transports refuse further execution')
  } finally { release?.(); await h.close() }
})
