import assert from 'node:assert/strict'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fresh, command, report } from './browser-runtime.mjs'
import { records, rows } from './browser-archive.mjs'
import { harness } from './harness.mjs'
import { proposalClient } from './agent-door/proposals.mjs'
import { assertNoQueryTokens, custodyClock, custodyDatabase, custodyObjects, custodyStorage, queryHarness, queryCustodyJourney } from './agent-door/query-custody.mjs'

function scanArchive(archive, tokens) {
  assertNoQueryTokens(archive, tokens, 'real CLI archive metadata, rows and decoded BLOBs')
  // Reassemble binary segments so a token crossing an archive part boundary cannot escape inspection.
  const binaries = new Map()
  for (const item of rows(archive).filter(item => ['object', 'payload'].includes(item.kind))) {
    const key = JSON.stringify([item.kind, item.bucket, item.key, item.name])
    if (!binaries.has(key)) binaries.set(key, [])
    binaries.get(key).push(item)
  }
  for (const parts of binaries.values()) assertNoQueryTokens(Buffer.concat(parts.sort((a, b) => a.offset - b.offset).map(item => Buffer.from(item.data, 'base64'))), tokens, 'decoded complete CLI binary')
  assert.ok(binaries.size, 'the CLI scan opens actual retained receipt bytes')
  for (const name of ['c_proposals', 'c_claims', 'c_receipts', 'c_batches', 'c_reimbursement_keys']) assert.ok(rows(archive).some(item => item.table === name), `${name} is nonempty in the archive`)
}

export async function agentQueryCustodyArchive() {
  const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/agent-query-custody')
  await mkdir(evidence, { recursive: true })
  const roots = []
  let h
  try {
    const source = await fresh(), destination = await fresh()
    roots.push(source, destination)
    for (const root of roots) await command(root, ['install'])
    const sourceHarness = await queryHarness({ persistencePath: join(source, '.wrangler/state/v3'), databaseId: 'local-foundation-only' })
    h = sourceHarness.h
    const result = await queryCustodyJourney(h, sourceHarness.signer), oldSession = h.owner
    const before = { claim: await h.get(`claims/${result.claim}`), batch: await h.get(`batches/${result.batch}`) }
    const objects = await custodyObjects(h)
    const financialObjects = list => list.map(({ entry, bytes }) => ({ key: entry.key, httpMetadata: entry.httpMetadata, customMetadata: entry.customMetadata, bytes }))
    await h.close(); h = undefined
    await command(source, ['export', '--output', 'exports/query-custody.rer'])
    const archive = join(source, 'exports/query-custody.rer'), exported = await records(archive)
    scanArchive(exported, result.tokens)
    assert.ok(!exported[0].tables.some(table => table.name === 'c_agent_keys'), 'personal execution credentials are excluded from the archive')
    await mkdir(join(destination, 'exports'), { recursive: true })
    await copyFile(archive, join(destination, 'exports/query-custody.rer'))
    await command(destination, ['import', '--input', 'exports/query-custody.rer', '--yes'])
    await command(destination, ['export', '--output', 'exports/query-custody-restored.rer'])
    const restored = await records(join(destination, 'exports/query-custody-restored.rer'))
    scanArchive(restored, result.tokens)
    assert.deepEqual(rows(restored), rows(exported), 'every portable financial row, receipt BLOB, R2 segment and numbered history line survives real CLI restore exactly')

    h = await harness({ clock: custodyClock, captureLogs: true, persistencePath: join(destination, '.wrangler/state/v3'), databaseId: 'local-foundation-only', existingDatabase: true })
    assert.notEqual(h.owner, oldSession, 'restored records use a newly established native owner session')
    assert.equal((await h.send('/api/coaster/state', undefined, oldSession)).status, 401, 'the original installation session cannot authenticate after restore')
    const dbBefore = await custodyDatabase(h), outbound = structuredClone(h.outbound)
    for (const token of result.tokens) {
      const client = proposalClient((url, init) => h.mf.dispatchFetch(url, init), h.origin, token)
      assert.equal((await client('tools/call', { name: 'coaster.workspace.get', arguments: {} })).status, 401, 'archived evidence restores no old personal or Business execution authority')
    }
    assert.deepEqual(await custodyDatabase(h), dbBefore, 'old credentials cannot recreate data or pending approvals')
    assert.deepEqual(h.outbound, outbound, 'old credentials cause no outbound request after restore')
    assert.deepEqual(await h.get(`claims/${result.claim}`), before.claim, 'fresh native authentication reads exact retained claim, receipt, submitted revision, decision and history')
    assert.deepEqual(await h.get(`batches/${result.batch}`), before.batch, 'fresh native authentication reads exact retained batch, payment and once-only evidence')
    assert.deepEqual(financialObjects(await custodyObjects(h)), financialObjects(objects), 'restored original receipt bytes and metadata are exact')
    const restoredScan = await custodyStorage(h, result.tokens)
    await h.close(); h = undefined
    await copyFile(archive, join(evidence, 'query-custody.rer'))
    await copyFile(join(destination, 'exports/query-custody-restored.rer'), join(evidence, 'query-custody-restored.rer'))
    await report(join(evidence, 'query-custody'), { passed: true, refusals: result.refused, controls: result.controls, sourceScan: result.scan, restoredScan, archive: 'decoded real CLI export and restored export; every portable row and original byte exact; fresh native authentication, old authority refused' })
    console.log('PROBE BASE-AGENT-004 5 archive: decoded real CLI export and restored export -> no raw or encoded query credentials; exact nonempty proposals, claims, receipt originals, batch, reimbursement identities and numbered history; fresh native authentication, original session and credentials refused')
  } finally {
    await h?.close()
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) await agentQueryCustodyArchive()
