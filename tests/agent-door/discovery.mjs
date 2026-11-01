import assert from 'node:assert/strict'
import { proposalClient } from './proposals.mjs'

export const discoveryClient = proposalClient

export async function verifyPrompts(client) {
  const listed = await client('prompts/list')
  assert.equal(listed.status, 200)
  assert.deepEqual(await client('prompts/list'), listed, 'prompt discovery is deterministic')
  assert.equal(listed.result.cacheScope, 'private')
  assert.equal(listed.result.ttlMs, 0)
  assert.equal(listed.result.resultType, 'complete')
  const byName = new Map()
  for (const prompt of listed.result.prompts) {
    const answer = await client('prompts/get', { name: prompt.name })
    assert.equal(answer.status, 200)
    assert.equal(answer.error, undefined)
    assert.equal(answer.result.cacheScope, 'private')
    assert.equal(answer.result.ttlMs, 0)
    assert.ok(answer.result.messages.length)
    assert.ok(answer.result.messages.every(message => message.role === 'user' && message.content.type === 'text'))
    byName.set(prompt.name, answer.result)
  }
  assert.equal(byName.size, 2, 'both preparation jobs are discoverable')
  assert.ok(byName.has('coaster.claims.prepare'))
  assert.ok(byName.has('coaster.batches.prepare'))
  assert.equal((await client('prompts/get', { name: 'synthetic-coaster-3799' })).error.code, -32602)
  for (const args of [null, [], 'synthetic-coaster-3798', { id: 17 }]) {
    assert.equal((await client('prompts/get', { name: 'coaster.claims.prepare', arguments: args })).error.code, -32602)
  }
  return { byName, list: listed.result.prompts }
}
