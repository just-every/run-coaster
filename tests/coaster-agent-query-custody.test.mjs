import { test } from 'node:test'
import { queryHarness, queryCustodyJourney } from './agent-door/query-custody.mjs'

test('Query credentials are refused without disclosure, retention, approval or financial effects while header credentials remain usable', async () => {
  const { h, signer } = await queryHarness()
  try {
    const result = await queryCustodyJourney(h, signer)
    console.log(`PROBE BASE-AGENT-004 application custody: ${result.refused} refused requests and ${result.controls} header-only controls; every retained SQLite cell, R2 object and captured Worker log scanned: ${JSON.stringify(result.scan)}`)
  } finally { await h.close() }
})
