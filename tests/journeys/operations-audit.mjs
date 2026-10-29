// Original operations assertions, composed as named phases without test registrations.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness, receipt } from '../harness.mjs'
import { sha, sum, claim, submit, approve, central, deactivateAccount, unzip, everywhere, withAgency } from './operations-support.mjs'

// AUDIT-001 one action of each kind reads back in order with actor, agent, channel and time, and no route alters or deletes a line
async function retainEveryHistoryLine(h, t) {
  const audrey = await h.person('audrey@harbourfinch.example', { auditor: true })
  await h.post('settings/approval-rule', { enabled: true, limit: '50.00' })
  const lunch = await approve(h, t.priya, await submit(h, t.sam, await claim(h, t.sam, 'Client lunch', [{ kind: 'receipt', date: '2026-05-09', merchant: 'Harbour View Bistro', amount: '64.50', allocations: [{ category: t.c.meals }], receiptFixture: 'bistro' }])))
  const ride = await submit(h, t.alex, await claim(h, t.alex, 'Airport ride', [{ kind: 'receipt', date: '2026-05-09', merchant: 'Uber', amount: '38.60', allocations: [{ category: t.c.travel }], receiptFixture: 'uber' }]))
  assert.equal(ride.status, 'approved', 'the approval rule decided it')
  let batch = await h.post('batches', { claims: [lunch.id, ride.id] }, t.morgan)
  batch = await h.post(`batches/${batch.id}/approve`, { version: batch.version, expectedTotal: 6450 + 3860 }, t.jordan)
  await h.paid(batch.id, batch.version, { reference: 'ACH-2026-0520', paidOn: '2026-05-20' }, t.jordan)
  const key = await h.post('agent-keys', { label: 'Receipt inbox agent' }, t.sam)
  assert.equal((await h.send('/api/coaster/agent/claims', { title: 'Parking', items: [{ kind: 'receipt', date: '2026-05-10', merchant: 'Wilson Parking', amount: '18.00', allocations: [{ category: t.c.travel }], receipt: await receipt('uber') }] }, '', { authorization: `Bearer ${key.token}` })).status, 200)
  const csv = await readFile('tests/fixtures/expensify-report-template.csv', 'utf8'), mapping = { date: 'YYYY-MM-DD', statuses: { Reimbursed: 'reimbursed', Approved: 'approved', Open: 'open' } }
  const preview = await h.post('import/preview', { csv, filename: 'expensify.csv', mapping })
  const imported = await h.post('import/commit', { csv, filename: 'expensify.csv', mapping, fingerprint: preview.fingerprint })
  await h.post('import/undo', { id: imported.job.id, mappingVersion: imported.mappingVersion })
  await h.post('allowances', { name: 'Phone stipend', type: 'stipend', category: t.c.office, period: 'monthly', amount: '30.00', tax: 'taxable', startsOn: '2026-06-01' }, t.jordan)
  await (await h.mf.getWorker()).scheduled({ scheduledTime: central('2026-06-02', 9), cron: '17 * * * *' })

  const history = async () => (await h.get('history', audrey)).lines, before = await history()
  assert.ok(before.length > 40 && before.length < 500)
  assert.deepEqual(before.map(l => l.seq), before.map(l => l.seq).toSorted((a, b) => a - b), 'numbered in write order')
  assert.ok(before.every(l => typeof l.actor_email === 'string' && l.actor_email && !Number.isNaN(Date.parse(l.at)) && ['app', 'agent', 'import', 'rule', 'schedule'].includes(l.channel)), 'every line names its actor, time and channel')
  const first = (action, test = () => true) => { const l = before.find(x => x.action === action && test(x)); assert.ok(l, `${action} is in the history`); return l }
  const seen = [
    ['business-saved', 'owner@harbourfinch.example', 'app'], ['member-invited', 'owner@harbourfinch.example', 'app'], ['approval-rule-set', 'owner@harbourfinch.example', 'app'],
    ['claim-submitted', 'sam@harbourfinch.example', 'app'], ['claim-approved', 'priya@harbourfinch.example', 'app'], ['claim-approved', 'rule v1', 'rule'],
    ['batch-created', 'morgan@harbourfinch.example', 'app'], ['batch-approved', 'jordan@harbourfinch.example', 'app'], ['batch-reimbursed', 'jordan@harbourfinch.example', 'app'],
    ['agent-key-created', 'sam@harbourfinch.example', 'app'], ['claim-proposed', 'sam@harbourfinch.example', 'agent'],
    ['import-committed', 'owner@harbourfinch.example', 'import'], ['import-undone', 'owner@harbourfinch.example', 'import'],
  ].map(([action, actor, channel]) => { const l = first(action, x => x.actor_email === actor); assert.equal(l.channel, channel, `${action} by ${actor} came through ${channel}`); return l })
  assert.equal(seen.find(l => l.action === 'claim-proposed').agent, 'Receipt inbox agent', 'an agent line names the agent beside the person')
  assert.deepEqual([seen.find(l => l.action === 'import-committed').detail.state, seen.find(l => l.action === 'import-undone').detail.state], [imported.job.state, 'undone'])
  assert.equal(first('member-invited', l => l.detail.email === 'audrey@harbourfinch.example').actor_email, 'owner@harbourfinch.example')
  assert.ok(before.some(l => l.actor_email === 'allowance' && l.channel === 'schedule'), 'the hourly run writes under its own name, not as a person in the app')
  assert.deepEqual(seen.map(l => l.seq).slice(3, 9), seen.map(l => l.seq).slice(3, 9).toSorted((a, b) => a - b), 'claim, decisions, batch and payment lines read back in the order they happened')

  // Every route, every method: nothing alters or removes a line already written (only new lines may follow).
  const line = before[0], routes = [...(await readFile('src/coaster/api.ts', 'utf8')).matchAll(/api\.(get|post)\('([^']+)'/g)]
    .map(([, method, path]) => [method, path.replace(/:(\w+)(\{[^}]*\})?/g, (_, name) => name === 'file' ? 'accounting.csv' : name === 'op' ? 'undo' : name === 'name' ? 'aging' : String(line.seq))])
  assert.ok(routes.length > 80)
  const tamper = { id: String(line.seq), seq: line.seq, at: '2020-01-01T00:00:00.000Z', actor_email: 'mallory@example.com', action: 'edited', detail: {}, version: 1, mappingVersion: '1' }
  for (const [method, path] of [...routes, ['get', `/api/coaster/history/${line.seq}`], ['get', '/api/coaster/events']]) {
    for (const verb of ['PUT', 'PATCH', 'DELETE']) {
      const r = await h.mf.dispatchFetch(h.origin + path, { method: verb, headers: { host: new URL(h.origin).host, origin: h.origin, 'content-type': 'application/json', cookie: h.owner }, body: JSON.stringify(tamper) })
      assert.equal(r.status, 404, `${verb} ${path} is no door`); await r.arrayBuffer()
    }
    if (method === 'post') assert.notEqual((await h.send(path, tamper, h.owner)).status, 500, `POST ${path} answered`)
  }
  assert.deepEqual((await history()).slice(0, before.length), before, 'every earlier line is unchanged after every route was tried')
  await assert.rejects(h.db.prepare("UPDATE c_events SET action='edited' WHERE seq=?").bind(line.seq).run(), /history is permanent/)
  await assert.rejects(h.db.prepare('DELETE FROM c_events WHERE seq=?').bind(line.seq).run(), /history is permanent/)
}

export async function preserveAuditOperations() {
  await withAgency(retainEveryHistoryLine)
}
