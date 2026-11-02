import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness, receipt } from './harness.mjs'
import { unzip } from './journeys/operations-support.mjs'
import { autonomousPolicy, heldPolicy } from '../src/modules/agent-door/conformance/crypto.mjs'
import { claimArguments, linkedProposal, proposalClient } from './agent-door/proposals.mjs'

const LABEL = '=Priya approved <b>synthetic-coaster-3601</b>'
const day = offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10), period = `from=${day(-2)}&to=${day(2)}`
const acting = email => ({ 'x-coaster-acting-for': email })

// BASE-AGENT-008 (5)-(6): a personal agent's claim and batch preparations read "<agent> for <person>" in the record, the
// activity view and the audit pack, with the person who accepted them named separately.
test('Personal-agent preparations read as the agent for the person, with the native accepter and company approval kept apart', async () => {
  const h = await harness()
  try {
    const t = await agency(h), request = (url, init) => h.mf.dispatchFetch(url, init)
    const policy = async document => assert.equal((await request(h.origin + '/agents/api/policy', { method: 'PUT', headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/json' }, body: JSON.stringify({ document }) })).status, 200)
    await policy(autonomousPolicy())
    const samKey = await h.post('agent-keys', { label: LABEL }, t.sam), morganKey = await h.post('agent-keys', { label: 'synthetic-coaster-3602' }, t.morgan), alexKey = await h.post('agent-keys', { label: 'synthetic-coaster-3603' }, t.alex)
    const sam = proposalClient(request, h.origin, samKey.token), morgan = proposalClient(request, h.origin, morganKey.token), alex = proposalClient(request, h.origin, alexKey.token)
    const prepare = async (client, title, fixture) => { const args = claimArguments(t.c.office, title); args.items[0].receipt = await receipt(fixture); return (await linkedProposal(client, 'coaster.claims.propose', args)).proposal }
    const submitted = async (id, cookie) => { let c = (await h.get(`claims/${id}`, cookie)).claim; c = await h.post(`claims/${id}/submit`, { version: c.version }, cookie); return h.post(`claims/${id}/decision`, { version: c.version, revision: c.revision, decision: 'approved' }, t.priya) }
    const accept = (p, cookie, headers = {}) => h.send(`/api/coaster/proposals/${p.id}/accept`, {}, cookie, headers)

    // Employee sponsor accepts in their own session; a Submit-only delegate accepts another for them.
    const first = await prepare(sam, 'synthetic-coaster-3604', 'bistro'), second = await prepare(sam, 'synthetic-coaster-3605', 'hotel')
    const one = (await accept(first, t.sam)).value.claim
    await h.post('delegates', { delegate: 'alex@harbourfinch.example', level: 'submit' }, t.sam)
    const two = (await accept(second, t.alex, acting('sam@harbourfinch.example'))).value.claim
    // Controls: an ordinary human claim, a native conversation and a native expense preparation are never an agent's.
    let human = await h.post('claims', { title: 'synthetic-coaster-3606' }, t.sam)
    human = await h.post(`claims/${human.id}/items`, { version: human.version, ...claimArguments(t.c.office).items[0] }, t.sam)
    const conversation = await h.post('conversation', { message: 'Denver client trip, May 10-12, 2026', manualRate: '1.00', receipts: [{ date: '2026-05-10', merchant: 'synthetic-coaster-3607', amount: '12.34', category: t.c.travel, receipt: await receipt('uber') }] }, t.sam)
    const talked = (await accept(conversation.proposal, t.sam)).value.claim
    const prepared = await h.post(`preparations/expenses/${human.id}`, {}, t.sam)
    await h.post(`proposals/${prepared.id}/accept`, {}, t.sam)

    const person = async (cookie, id) => (await h.get(`claims/${id}`, cookie))
    const detailOne = await person(t.sam, one.id), detailTwo = await person(t.sam, two.id)
    assert.deepEqual(detailOne.attribution, { proposal: first.id, kind: 'claim', agent: LABEL, for: { email: 'sam@harbourfinch.example', name: 'sam' }, label: `${LABEL} for sam`, outcome: 'accepted', decidedBy: { email: 'sam@harbourfinch.example', name: 'sam' }, decidedAt: detailOne.attribution.decidedAt })
    assert.deepEqual(detailTwo.attribution.decidedBy, { email: 'alex@harbourfinch.example', name: 'alex', onBehalfOf: { email: 'sam@harbourfinch.example', name: 'sam' } }, 'a delegate is the accepter, on behalf of the sponsor')
    assert.equal(detailTwo.attribution.for.name, 'sam')
    for (const control of [human.id, talked.id, prepared.claim?.id ?? human.id]) assert.equal((await person(t.sam, control)).attribution, null, 'human, conversation and preparation work is never an agent act')
    assert.equal((await person(t.sam, talked.id)).claim.prepared_by, 'Conversation assistant', 'the native conversation keeps its own record')
    const lineOf = (d, action) => d.events.find(e => e.action === action)
    assert.equal(lineOf(detailOne, 'proposal-accepted').attribution.label, `${LABEL} for sam`)
    assert.equal(lineOf(detailOne, 'proposal-accepted').attribution.decidedBy.email, 'sam@harbourfinch.example')

    // The labelled text is only ever the agent's name: the approver and approval stay the people who acted.
    const approved = await submitted(one.id, t.sam)
    assert.equal(approved.status, 'approved')
    const afterApproval = await person(t.sam, one.id)
    assert.equal(afterApproval.decisions.at(-1).actor_email, 'priya@harbourfinch.example')
    assert.equal(afterApproval.attribution.decidedBy.email, 'sam@harbourfinch.example')
    await submitted(two.id, t.sam)

    // Finance sponsor: the agent prepares a batch, finance accepts it, and a Full delegate accepts another for them.
    const batchOne = (await linkedProposal(morgan, 'coaster.batches.propose', { claims: [one.id] })).proposal, batchTwo = (await linkedProposal(morgan, 'coaster.batches.propose', { claims: [two.id] })).proposal
    const madeOne = (await accept(batchOne, t.morgan)).value.batch
    await h.post('delegates', { delegate: 'jordan@harbourfinch.example', level: 'full' }, t.morgan)
    const madeTwo = (await accept(batchTwo, t.jordan, acting('morgan@harbourfinch.example'))).value.batch
    const detailBatch = await h.get(`batches/${madeOne.id}`, t.morgan), detailBatchTwo = await h.get(`batches/${madeTwo.id}`, t.morgan)
    assert.equal(detailBatch.attribution.label, 'synthetic-coaster-3602 for morgan')
    assert.equal(detailBatch.attribution.decidedBy.email, 'morgan@harbourfinch.example')
    assert.deepEqual(detailBatchTwo.attribution.decidedBy, { email: 'jordan@harbourfinch.example', name: 'jordan', onBehalfOf: { email: 'morgan@harbourfinch.example', name: 'morgan' } })
    assert.equal(detailBatch.events.find(e => e.action === 'proposal-accepted').attribution.agent, 'synthetic-coaster-3602')

    // Company policy approval is a separate act: it creates the proposal, never accepts it, and never reads as the accepter.
    await policy(heldPolicy())
    const args = claimArguments(t.c.office, 'synthetic-coaster-3608')
    const params = { name: 'coaster.claims.propose', arguments: { ...args, idempotency_key: 'synthetic-coaster-3609' } }
    const before = (await h.db.prepare('SELECT COUNT(*) AS n FROM c_proposals').first()).n
    let answer = await sam('tools/call', params)
    for (let step = 0; step < 4 && answer.result?.resultType === 'input_required'; step++) {
      const handle = answer.result._meta['com.runeditrun/approval']
      assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_proposals').first()).n, before, 'nothing is prepared before company approval')
      const view = await h.send(`/agents/api/approvals/${handle.id}`, undefined, t.sam)
      assert.equal((await h.send(`/agents/api/approvals/${handle.id}/approve`, { revision: view.value.approval.revision, summary_sha256: view.value.approval.summary_sha256 }, t.sam)).status, 200)
      answer = await sam('tools/call', { ...params, requestState: answer.result.requestState })
    }
    assert.equal(answer.result.isError, false, JSON.stringify(answer))
    const held = answer.result.structuredContent
    const stored = await h.db.prepare('SELECT status,decided_by,result_id FROM c_proposals WHERE id=?').bind(held.id).first()
    assert.deepEqual(stored, { status: 'proposed', decided_by: null, result_id: null }, 'company approval is not native acceptance')
    const seen = (await h.get(`history?q=${held.id}`, t.morgan)).lines
    assert.deepEqual(seen.map(l => l.action), ['claim-proposed'])
    assert.equal(seen[0].attribution.outcome, 'proposed')
    assert.equal(seen[0].attribution.decidedBy, undefined)
    await policy(autonomousPolicy())
    const heldClaim = (await accept(held, t.sam)).value.claim
    assert.equal((await person(t.sam, heldClaim.id)).attribution.decidedBy.email, 'sam@harbourfinch.example')

    // Activity: only the real personal-agent lines carry an attribution.
    const financial = async () => JSON.stringify(await Promise.all(['c_claims ORDER BY id', 'c_batches ORDER BY id', 'c_proposals ORDER BY id', 'c_reimbursement_keys ORDER BY key'].map(async q => (await h.db.prepare('SELECT * FROM ' + q).all()).results)))
    const stateBefore = await financial()
    const eventsBefore = (await h.db.prepare('SELECT * FROM c_events ORDER BY seq').all()).results
    const activity = (await h.get('history', t.morgan)).lines
    const attributed = activity.filter(l => l.attribution)
    const times = (n, ...x) => Array(n).fill(x).flat()
    assert.deepEqual(attributed.map(l => `${l.action}:${l.attribution.outcome}:${l.attribution.agent}`).sort(), [
      ...times(3, `claim-proposed:proposed:${LABEL}`, `proposal-accepted:accepted:${LABEL}`), ...times(2, 'batch-proposed:proposed:synthetic-coaster-3602', 'proposal-accepted:accepted:synthetic-coaster-3602'),
    ].sort())
    assert.equal(activity.filter(l => !l.attribution && l.action === 'claim-proposed').length, 1, 'the native conversation proposal line is not an agent act')
    assert.ok(activity.filter(l => !l.attribution && l.action === 'proposal-accepted').length >= 2, 'conversation and preparation acceptances stay the person’s own')
    assert.ok(attributed.every(l => l.attribution.label === `${l.attribution.agent} for ${l.attribution.for.name}`))

    // Forbidden and foreign reads disclose nothing.
    for (const [path, cookie, status] of [[`claims/${one.id}`, t.alex, [403, 404]], [`batches/${madeOne.id}`, t.sam, [403, 404]], ['history', t.sam, [403]], [`audit-pack?${period}`, t.sam, [403]]]) {
      const r = await h.send('/api/coaster/' + path, undefined, cookie)
      assert.ok(status.includes(r.status), `${path} ${r.status}`)
      assert.ok(!r.text.includes('synthetic-coaster-360') && !r.text.includes('Priya approved'), `${path} names no agent`)
    }

    // Audit pack: manifest and history carry the same attribution; the agent label is escaped in the CSV.
    const pack = async () => {
      const r = await request(h.origin + `/api/coaster/audit-pack?${period}`, { headers: { cookie: h.owner, origin: h.origin } })
      assert.equal(r.status, 200)
      const files = unzip(Buffer.from(await r.arrayBuffer()))
      return { manifest: JSON.parse(files['manifest.json']), history: files['history.csv'].toString() }
    }
    const exported = await pack()
    const claimsOf = Object.fromEntries(exported.manifest.claims.map(c => [c.id, c]))
    assert.equal(claimsOf[one.id].preparedBy.label, `${LABEL} for sam`)
    assert.equal(claimsOf[one.id].preparedBy.decidedBy.email, 'sam@harbourfinch.example')
    assert.equal(claimsOf[two.id].preparedBy.decidedBy.onBehalfOf.email, 'sam@harbourfinch.example')
    assert.equal(claimsOf[one.id].payment.preparedBy.label, 'synthetic-coaster-3602 for morgan')
    assert.equal(claimsOf[two.id].payment.preparedBy.decidedBy.email, 'jordan@harbourfinch.example')
    assert.equal(claimsOf[talked.id]?.preparedBy ?? null, null)
    const rows = exported.history.trim().split('\r\n')
    assert.deepEqual(rows[0].split(','), ['"seq"', '"at"', '"actor"', '"channel"', '"agent"', '"action"', '"claim"', '"batch"', '"detail"', '"prepared_by"', '"decided_by"'])
    const proposedRow = rows.find(r => r.includes('"claim-proposed"') && r.includes(first.id))
    assert.ok(proposedRow.endsWith(`,"'${LABEL} for sam",""`), 'a formula-shaped agent name is neutralised in the export')
    const acceptedRow = rows.find(r => r.includes('"proposal-accepted"') && r.includes(second.id))
    assert.ok(acceptedRow.endsWith(`,"'${LABEL} for sam","alex on behalf of sam"`))
    const stateAfter = await financial()
    assert.equal(stateAfter, stateBefore, 'attribution reads change no claim, batch, proposal or reimbursement identity')
    const eventsAfter = (await h.db.prepare('SELECT * FROM c_events ORDER BY seq').all()).results
    assert.deepEqual(eventsAfter.slice(0, eventsBefore.length), eventsBefore, 'original history lines are byte-identical')
    assert.deepEqual(eventsAfter.slice(eventsBefore.length).map(e => e.action), ['audit-pack-exported'])

    // A revoked key keeps its retained attribution, and the key's current owner is never consulted.
    await h.post(`agent-keys/${samKey.id}/revoke`, {}, t.sam)
    assert.equal((await sam('resources/templates/list')).status, 401)
    assert.deepEqual((await person(t.sam, one.id)).attribution, detailOne.attribution)

    // Erasure: Alex's own agent claim and Alex's delegated acceptance keep only the opaque former-member identity.
    const own = await prepare(alex, 'synthetic-coaster-3610', 'officeworks')
    const mine = (await accept(own, t.alex)).value.claim
    let c = await submitted(mine.id, t.alex)
    let batch = await h.post('batches', { claims: [c.id] }, t.morgan)
    batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: batch.total_minor }, t.jordan)
    await h.paid(batch.id, batch.version, { reference: 'synthetic-coaster-3611', paidOn: '2026-06-03' }, t.jordan)
    await h.post('settings/members', { email: 'alex@harbourfinch.example', name: 'alex', active: false, employee: true })
    await h.post('settings/members/erase', { email: 'alex@harbourfinch.example' })
    const erased = [await person(t.morgan, mine.id), await person(t.morgan, two.id)]
    const exposure = JSON.stringify([erased.map(d => [d.attribution, d.events.map(e => e.attribution)]), (await pack()).manifest.claims.map(x => x.preparedBy), (await h.get('history', t.morgan)).lines.map(l => l.attribution)])
    assert.ok(!/alex/i.test(exposure), 'no old name or address survives erasure in any attribution')
    assert.match(erased[0].attribution.for.email, /^former-member-[0-9a-f]{8}$/)
    assert.match(erased[0].attribution.for.name, /^Former member [0-9a-f]{8}$/)
    assert.match(erased[1].attribution.decidedBy.name, /^Former member [0-9a-f]{8}$/)
    assert.equal(erased[1].attribution.decidedBy.onBehalfOf.name, 'sam')
    assert.equal(erased[0].attribution.agent, 'synthetic-coaster-3603')
  } finally { await h.close() }
})
