// Archive checks for COA-012: tampered archives are refused before any write.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makePart, ContentVerifier, ArchiveVerifier } from '@runeditrun/rer/modules/portability/format'
import { command, refusalCases } from './browser-runtime.mjs'

export const records = async path => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
export const rows = archive => archive.filter(r => r.kind === 'part').flatMap(r => r.items)

/** Rewrite one row and re-seal the archive's hashes, so only Coaster's own staged validation can catch it. */
export async function tampered(archive, table, change, pick = () => true) {
  const input = await records(archive)
  const item = rows(input).find(r => r.table === table && pick(r.row))
  assert.ok(item, `archive holds ${table}`)
  change(item.row, input)
  input[0].partCount = input.length - 2
  input.at(-1).partCount = input.length - 2
  const content = new ContentVerifier(input[0]), whole = new ArchiveVerifier(input[0])
  for (let i = 1; i < input.length - 1; i++) { input[i] = await makePart(i - 1, input[i].items); whole.add(input[i]); for (const row of input[i].items) content.add(row) }
  input.at(-1).contentHash = content.digest(); input.at(-1).archiveHash = whole.digest()
  return input.map(r => JSON.stringify(r)).join('\n') + '\n'
}

export async function rejectInconsistentArchives(root, archive, { part = 0, of = 1 } = {}) {
  await command(root, ['export', '--output', 'exports/empty-before.rer'])
  const empty = rows(await records(join(root, 'exports/empty-before.rer')))
  const cases = {
    claim_total: ['c_claims', row => { row.total_minor += 1 }],
    receipt_bytes: ['c_receipts', row => { const bytes = Buffer.from(row.bytes.blob, 'base64'); bytes[bytes.length - 1] ^= 1; row.bytes.blob = bytes.toString('base64') }],
    capture_bytes: ['c_capture_receipts', row => { row.size += 1 }],
    capture_reason: ['c_capture_lifecycle', row => { row.reason = 'x'.repeat(1001) }, row => row.kind === 'discarded'],
    decision_revision: ['c_decisions', row => { row.revision += 7 }],
  }
  await refusalCases(root, Object.entries(cases).filter((_, index) => index % of === part), async (root, [code, [table, change, pick]]) => {
    await writeFile(join(root, `exports/${code}.rer`), await tampered(archive, table, change, pick), { mode: 0o600 })
    const log = await command(root, ['import', '--input', `exports/${code}.rer`, '--yes'], { expected: 4 })
    assert.match(log, new RegExp('coaster_' + code), `restore refused ${code}`)
    await command(root, ['export', '--output', `exports/empty-after-${code}.rer`])
    assert.deepEqual(rows(await records(join(root, `exports/empty-after-${code}.rer`))), empty, `refused ${code} archive wrote nothing`)
  })
}

/** CAPTURE-004 / AUDIT-001: re-sealed lifecycle corruption is still refused (the capture Verify shard, tests/capture.mjs).
    Each refusal stages the whole archive first, so CI runs every `of`-th case from `part` in parallel slices. */
export async function rejectCaptureLifecycleArchives(root, archive, { part = 0, of = 1 } = {}) {
  const source = rows(await records(archive)).filter(item => item.table === 'c_capture_lifecycle');
  const expanded = source.find(item => item.row.reason.length > 1000);
  assert.ok(expanded, 'the archive holds the worst-case expanded reason');
  assert.ok(source.length >= 2 && source.some(item => item.row.kind === 'merged') && source.some(item => item.row.kind === 'discarded'), 'the public inbox journey discarded and merged originals');
  await command(root, ['export', '--output', 'exports/lifecycle-before.rer']);
  const before = rows(await records(join(root, 'exports/lifecycle-before.rer')));
  const cases = {
    unknown_receipt: row => { row.receipt_id = 'unknown-receipt' },
    sequence: row => { row.sequence = 2 },
    kind: row => { row.kind = 'restored' },
    blank_reason: row => { row.reason = ' ' },
    long_reason: row => { row.reason = 'x'.repeat(1001) },
    expanded_overflow: row => { row.reason = expanded.row.reason + 'x' },
    fake_tokens: row => { row.reason = 'Former member 00000000'.repeat(60) },
    untrimmed: row => { row.reason = ' needs trimming ' },
    // A self-declared marker sealed into the manifest and every lifecycle row: Base refuses its migration-derived schema before staging.
    forged_marker: (row, input) => {
      input[0].tables.find(t => t.name === 'c_capture_lifecycle').columns.push({ name: 'reason_redacted', notnull: 0, pk: 0, type: 'INTEGER' });
      for (const item of rows(input)) if (item.table === 'c_capture_lifecycle') item.row.reason_redacted = 0;
      row.reason = 'x'.repeat(1500); row.reason_redacted = 1;
    },
    erasure_guard: (_row, input) => {
      const tables = input[0].tables, order = tables.findIndex(t => t.name === 'c_capture_erasing');
      tables[order].count = 1;
      let at = input.findIndex((part, index) => index > 0 && part.kind === 'part' && part.items.some(item => item.kind === 'row' && tables.findIndex(t => t.name === item.table) > order));
      if (at < 0) at = input.length - 1;
      input.splice(at, 0, { index: at - 1, items: [{ index: 0, kind: 'row', table: 'c_capture_erasing', row: { email: 'unfinished-erasure@example.test' } }] });
    },
    // CAPTURE-004 merge lines name another open original of the same employee and state a reason unless the files are identical.
    merge_unknown_survivor: row => { row.survivor_id = 'unknown-receipt' },
    merge_self: row => { row.survivor_id = row.receipt_id },
    merge_reasonless: row => { row.reason = '' },
    discard_names_survivor: row => { row.survivor_id = source.find(item => item.row.kind === 'merged').row.survivor_id },
    bad_time: row => { row.at = 'not-a-time' },
    early_time: row => { row.at = '1970-01-01T00:00:00.000Z' },
    channel: row => { row.channel = 'agent' },
    attribution: row => { row.on_behalf_of = 'somebody-else@example.test' },
    duplicate: row => { Object.assign(row, source[1].row) },
  };
  await refusalCases(root, Object.entries(cases).filter((_, index) => index % of === part), async (root, [name, change]) => {
    const kind = name.startsWith('merge_') ? 'merged' : name.startsWith('discard_') ? 'discarded' : undefined;
    await writeFile(join(root, 'exports/invalid-lifecycle.rer'), await tampered(archive, 'c_capture_lifecycle', change, row => !kind || row.kind === kind), { mode: 0o600 });
    const log = await command(root, ['import', '--input', 'exports/invalid-lifecycle.rer', '--yes'], { expected: 4 });
    assert.match(log, name === 'forged_marker' ? /schema_mismatch/ : /coaster_capture_(history|reason|merge|lifecycle_provenance|erasure_guard)/, `CAPTURE-004 refuses ${name}`);
    assert.ok(!log.includes('finance@dev.localhost') && !log.includes('Sam Taylor'), 'refusal never echoes identity or reason text');
  }, async root => {
    await command(root, ['export', '--output', 'exports/lifecycle-after.rer']);
    assert.deepEqual(rows(await records(join(root, 'exports/lifecycle-after.rer'))), before, 'CAPTURE-004 refused archives leave the destination untouched');
  });
}

/** COA-012 / CLAIM-002: receipt-less per diems can be newest; verify every actual restored receipt. */
export async function assertRestoredReceiptBytes(context, origin, claims) {
  const receipts = claims.flatMap(claim => claim.receipts)
  assert.ok(receipts.length, 'the archive journey includes receipt evidence')
  for (const receipt of receipts) {
    const download = await context.request.get(`${origin}/api/coaster/receipts/${receipt.id}`)
    assert.equal(download.status(), 200, 'a restored receipt remains downloadable')
    assert.equal(createHash('sha256').update(await download.body()).digest('hex'), receipt.sha256, 'restored receipt bytes are exact')
  }
}
