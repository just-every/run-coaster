import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness, receipt } from './harness.mjs'
import { autonomousPolicy, heldPolicy } from '../src/modules/agent-door/conformance/crypto.mjs'
import { claimArguments, proposalClient } from './agent-door/proposals.mjs'

// Independent expectations from ADMIN-001 and COA-010: human owner powers do
// not add a finance flag to the narrower personal preparation grant.
const roles = [
  { role: 'owner', flags: { employee: true }, claim: true, batch: false, humanBatch: true },
  { role: 'admin', flags: { admin: true }, claim: true, batch: false },
  { role: 'finance', flags: { finance: true }, claim: true, batch: true, humanBatch: true },
  { role: 'card-admin', flags: { cardAdmin: true }, claim: true, batch: false },
  { role: 'approver', flags: { manager: true }, claim: true, batch: false },
  { role: 'employee', flags: { employee: true }, claim: true, batch: false },
  { role: 'auditor', flags: { auditor: true }, claim: false, batch: false },
  { role: 'bookkeeper', flags: { bookkeeper: true }, claim: false, batch: false },
]
const address = n => `synthetic-coaster-${n}` + '@' + 'harbourfinch.example'
const code = answer => answer.result?._meta?.['com.runeditrun/error']?.code ?? answer.error?.data?.code
const data = answer => { assert.equal(answer.status, 200); assert.equal(answer.result?.isError, false, JSON.stringify(answer)); return answer.result.structuredContent }

// One journey, one local-key sponsor at a time, through invitations, native
// sessions, personal-agent REST and both production MCP protocol versions.
test('Four personal-agent tools preserve native role permissions and grant narrowing under autonomous and held policy', async () => {
  const h = await harness()
  try {
    const t = await agency(h), request = (url, init) => h.mf.dispatchFetch(url, init)
    const policy = async document => assert.equal((await request(h.origin + '/agents/api/policy', { method: 'PUT', headers: { origin: h.origin, cookie: h.owner, 'content-type': ['application', 'json'].join('/') }, body: JSON.stringify({ document }) })).status, 200)
    const snapshot = async (includeProposals = true) => {
      const tables = (await h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'c_*' ORDER BY name").all()).results
      const names = tables.map(t => t.name).filter(name => includeProposals || !['c_proposals', 'c_receipts', 'c_events'].includes(name))
      const records = await h.db.batch(names.map(name => h.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`)))
      return names.map((name, i) => [name, records[i].results])
    }
    const approved = async label => {
      let c = await h.post('claims', { title: label }, t.sam)
      c = await h.post(`claims/${c.id}/items`, { version: c.version, ...claimArguments(t.c.office, label).items[0], explanation: 'Synthetic role parity expense' }, t.sam)
      c = await h.post(`claims/${c.id}/submit`, { version: c.version }, t.sam)
      return h.post(`claims/${c.id}/decision`, { version: c.version, revision: c.revision, decision: 'approved', acknowledge: true }, t.priya)
    }
    const target = await approved('synthetic-coaster-5300')
    // A foreign proposal remains hidden even from roles which can read all claims.
    const foreignKey = await h.post('agent-keys', { label: 'synthetic-coaster-5301' }, t.sam)
    const foreignResponse = await h.send('/api/coaster/agent/claims', claimArguments(t.c.office, 'synthetic-coaster-5302'), '', { authorization: `Bearer ${foreignKey.token}` })
    assert.equal(foreignResponse.status, 200)
    const foreign = foreignResponse.value
    await h.post(`agent-keys/${foreignKey.id}/revoke`, {}, t.sam)
    for (const [index, fixture] of roles.entries()) {
      const email = fixture.role === 'owner' ? 'owner' + '@' + 'harbourfinch.example' : address(5310 + index)
      const initial = fixture.claim ? fixture.flags : { employee: true }
      const cookie = fixture.role === 'owner' ? h.owner : await h.person(email, initial, 'priya' + '@' + 'harbourfinch.example')
      await h.post(['settings', 'members'].join('/'), { email, name: `synthetic-coaster-${5310 + index}`, ...initial, approver: 'priya' + '@' + 'harbourfinch.example' })
      await policy(autonomousPolicy())
      const key = await h.post('agent-keys', { label: `synthetic-coaster-${5320 + index}` }, cookie)
      const native = (path, body) => h.send('/api/coaster/agent/' + path, body, '', { authorization: `Bearer ${key.token}` })
      const own = (await native('claims', claimArguments(t.c.office, `synthetic-coaster-${5330 + index}`))).value
      assert.equal(own.for_email, email)
      if (!fixture.claim) {
        await h.post(['settings', 'members'].join('/'), { email, name: `synthetic-coaster-${5310 + index}`, ...fixture.flags })
        const before = await snapshot()
        await h.post('agent-keys', { label: 'synthetic-coaster-5340' }, cookie, 403)
        assert.deepEqual(await snapshot(), before, `${fixture.role} cannot issue a new key`)
        await h.post(`proposals/${own.id}/accept`, {}, cookie, 403)
        assert.deepEqual(await snapshot(), before, 'retained proposal cannot acquire missing native acceptance authority')
      }
      const humanBefore = await snapshot()
      const human = await h.send('/api/coaster/claims', { title: 'synthetic-coaster-5341' }, cookie)
      assert.equal(human.status, fixture.claim ? 200 : 403, `${fixture.role} human own-claim capability`)
      if (!fixture.claim) assert.deepEqual(await snapshot(), humanBefore)
      const batchClaim = await approved(`synthetic-coaster-${5350 + index}`)
      const beforeHumanBatch = await snapshot()
      const humanBatch = await h.send('/api/coaster/batches', { claims: [batchClaim.id] }, cookie)
      assert.equal(humanBatch.status, fixture.humanBatch ? 200 : 403, `${fixture.role} native batch capability before grant intersection`)
      if (!fixture.humanBatch) assert.deepEqual(await snapshot(), beforeHumanBatch)
      for (const [policyName, document] of [['autonomous', autonomousPolicy()], ['held', heldPolicy()]]) {
        await policy(document)
        for (const version of ['2025-11-25', '2026-07-28']) {
          const client = proposalClient(request, h.origin, key.token, version)
          const invoke = async (name, args = {}) => {
            const params = { name, arguments: args }
            const beforeCall = await snapshot()
            let answer = await client(['tools', 'call'].join('/'), params)
            const pending = answer.result?._meta?.['com.runeditrun/approval'] ?? answer.result?._meta?.['com.runeditrun/error']?.approval
            if (pending) {
              assert.equal(policyName, 'held')
              assert.equal(answer.result.structuredContent, undefined, 'held content is withheld')
              assert.deepEqual(await snapshot(), beforeCall, 'pending company approval creates no proposal, receipt or financial write')
              if (version === '2025-11-25') assert.equal(answer.result.requestState, undefined, 'legacy read continuation remains a pinned Base gap')
              const before = await snapshot()
              const url = new URL(pending.url)
              assert.equal(url.origin, h.origin)
              assert.equal((await h.send(url.pathname, undefined, cookie)).status, 200, 'returned native review URL opens for its sponsor')
              const apiPath = url.pathname.replace('/agents/approvals/', '/agents/api/approvals/')
              const view = await h.send(apiPath, undefined, cookie)
              assert.equal(view.status, 200)
              assert.deepEqual(await snapshot(), before, 'review alone writes no product data')
              const p = view.value.approval
              const decision = await h.send(apiPath + '/approve', { revision: p.revision, summary_sha256: p.summary_sha256 }, cookie)
              assert.equal(decision.status, 200)
              assert.equal(decision.value.approval.state, 'executed', JSON.stringify(decision.value))
              // Modern read continuations carry requestState; legacy mutation
              // retries use their original idempotency key.
              answer = await client(['tools', 'call'].join('/'), { ...params, ...(answer.result.requestState ? { requestState: answer.result.requestState } : {}) })
              if (version === '2025-11-25' && name === 'coaster.proposals.get') {
                // The pinned legacy transport exposes an approval URL but no
                // read continuation. Keep this boundary explicit until Base
                // supplies it; no private result is disclosed on another call.
                assert.equal(code(answer), 'approval_required')
                assert.equal(answer.result.structuredContent, undefined)
                assert.deepEqual(await snapshot(), before, 'approved legacy read still changes no product data')
              }
            }
            return answer
          }
          const projection = data(await invoke('coaster.workspace.get'))
          const nativeContext = await native('context')
          assert.equal(nativeContext.status, 200)
          assert.deepEqual(projection, nativeContext.value, `${fixture.role} context under ${policyName} and ${version}`)
          const expectedRoles = { owner: false, employee: fixture.claim, manager: fixture.role === 'approver', finance: fixture.batch, auditor: fixture.role === 'auditor', admin: fixture.role === 'admin', cardAdmin: fixture.role === 'card-admin', bookkeeper: fixture.role === 'bookkeeper' }
          assert.deepEqual(projection.for.roles, expectedRoles)
          assert.equal(projection.for.email, email)
          assert.ok(projection.proposals.some(p => p.id === own.id), 'own nonempty proposal list')
          if (fixture.batch) assert.ok(projection.approvedClaims.some(c => c.id === target.id && c.total_minor === 1234))
          else {
            assert.deepEqual(projection.approvedClaims, [], 'no finance-only approved-claim leakage, including native owner')
            assert.ok(!JSON.stringify(projection).includes(target.id), 'the approved financial record is absent from the entire context')
          }
          const read = await invoke('coaster.proposals.get', { id: own.id })
          if (version === '2025-11-25' && policyName === 'held') {
            assert.equal(code(read), 'approval_required')
            console.log(`PROBE BASE-AGENT-005 legacy-read-boundary role=${fixture.role}: returned native URL approved -> executed; MCP retry remains approval_required because the legacy wire omits requestState`)
          } else assert.deepEqual(data(read), (await native(`proposals/${own.id}`)).value)
          const beforeHidden = await snapshot()
          const hidden = await client(['tools', 'call'].join('/'), { name: 'coaster.proposals.get', arguments: { id: foreign.id } })
          const missing = await client(['tools', 'call'].join('/'), { name: 'coaster.proposals.get', arguments: { id: 'synthetic-coaster-5399' } })
          assert.equal(code(hidden), 'resource_unavailable')
          assert.deepEqual(hidden.result, missing.result, 'hidden and missing proposal refusals are indistinguishable')
          assert.equal((await native(`proposals/${foreign.id}`)).status, 404)
          assert.equal((await native(['proposals', 'synthetic-coaster-5399'].join('/'))).status, 404)
          assert.deepEqual(await snapshot(), beforeHidden)
          for (const [tool, path, allowed, args] of [
            ['coaster.claims.propose', 'claims', fixture.claim, { ...claimArguments(t.c.office, 'synthetic-coaster-5360'), items: [{ ...claimArguments(t.c.office).items[0], receipt: await receipt('bistro') }], for_email: address(5398) }],
            ['coaster.batches.propose', 'batches', fixture.batch, { claims: [target.id], note: 'synthetic-coaster-5361' }],
          ]) {
            const before = await snapshot(), financial = await snapshot(false)
            const rest = await native(path, args)
            assert.equal(rest.status, allowed ? 200 : 403, `${fixture.role} personal-agent ${path}`)
            if (!allowed) assert.deepEqual(await snapshot(), before)
            const beforeMcp = await snapshot()
            const answer = await invoke(tool, { ...args, idempotency_key: crypto.randomUUID() })
            if (allowed) {
              const proposed = data(answer)
              assert.equal(proposed.for_email, email, 'preparation is only for the sponsor, even with a foreign target argument')
              assert.equal(proposed.status, 'proposed'); assert.equal(proposed.decided_by, null); assert.equal(proposed.result_id, null)
              const payload = p => ({ ...p, items: p.items?.map(({ receiptId, ...item }) => item) })
              assert.deepEqual(payload(proposed.payload), payload(rest.value.payload), 'MCP and native preparation retain the same expense content')
              if (proposed.kind === 'claim') {
                const stored = async id => h.db.prepare('SELECT owner_email,name,media_type,size,sha256,bytes FROM c_receipts WHERE id=?').bind(id).first()
                assert.deepEqual(await stored(proposed.payload.items[0].receiptId), await stored(rest.value.payload.items[0].receiptId), 'receipt content and custody match')
              }
              assert.deepEqual(proposed, (await native(`proposals/${proposed.id}`)).value)
              assert.deepEqual(await snapshot(false), financial, 'preparation creates no financial records')
            } else {
              assert.equal(code(answer), 'native_authority_required', JSON.stringify(answer))
              assert.equal(answer.result.structuredContent, undefined)
              assert.deepEqual(await snapshot(), beforeMcp, 'refusal creates no proposal, receipt, event or financial write')
            }
          }
          console.log(`PROBE BASE-AGENT-005 role=${fixture.role} policy=${policyName} protocol=${version}: MCP and native doors -> context matches; own proposal ${version === '2025-11-25' && policyName === 'held' ? 'held at documented legacy continuation boundary' : 'matches'}; claim=${fixture.claim}; batch=${fixture.batch}; hidden and missing refused; no financial writes`)
        }
      }
      await h.post(`agent-keys/${key.id}/revoke`, {}, h.owner)
      assert.equal((await proposalClient(request, h.origin, key.token)(['tools', 'call'].join('/'), { name: 'coaster.workspace.get', arguments: {} })).status, 401)
    }
  } finally { await h.close() }
})
