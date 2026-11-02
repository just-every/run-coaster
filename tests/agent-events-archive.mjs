import assert from 'node:assert/strict'

/** Retained ids and metadata are portable evidence; personal credentials are excluded. */
export function assertEventArchive(records, expected, keys) {
  assert.equal(records.filter(r => r.table === 'c_agent_keys').length, 0)
  const retained = records.filter(r => r.table === 'agent_door_events').map(r => JSON.parse(r.row.event))
  for (const event of expected) assert.deepEqual(retained.find(e => e.id === event.id), event)
  for (const key of keys) assert.ok(!JSON.stringify(records).includes(key.token), 'no executable personal key in archive')
  return retained
}

export async function proposalEvents(client) {
  const answer = await client('tools/call', { name: 'coaster.events.list', arguments: { limit: 200 } })
  assert.equal(answer.status, 200)
  assert.equal(answer.result.isError, false, JSON.stringify(answer))
  return answer.result.structuredContent.events.filter(e => e.type === 'proposal.created')
}

export async function assertRestoredEvents(client, expected, oldClient) {
  const old = await oldClient('tools/call', { name: 'coaster.events.list', arguments: {} })
  assert.equal(old.status, 401, 'restored evidence confers no reusable key authority')
  const events = await proposalEvents(client)
  assert.deepEqual(events, expected, 'fresh opted-in key sees exactly the original retained proposal event evidence')
  if (expected.length) {
    const params = { name: 'coaster.events.list', arguments: { after: expected[0].id, limit: 1 } }
    const read = await client('tools/call', params)
    assert.deepEqual(await client('tools/call', params), read, 'cursor identity survives real CLI restore')
  }
}
