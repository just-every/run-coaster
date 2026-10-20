// Archive checks for COA-012: tampered archives are refused before any write.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makePart, ContentVerifier, ArchiveVerifier } from '@runeditrun/rer/modules/portability/format'
import { command } from './browser-runtime.mjs'

export const records = async path => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
export const rows = archive => archive.filter(r => r.kind === 'part').flatMap(r => r.items)

/** Rewrite one row and re-seal the archive's hashes, so only Coaster's own staged validation can catch it. */
export async function tampered(archive, table, change) {
  const input = await records(archive)
  const item = rows(input).find(r => r.table === table)
  assert.ok(item, `archive holds ${table}`)
  change(item.row)
  const content = new ContentVerifier(input[0]), whole = new ArchiveVerifier(input[0])
  for (let i = 1; i < input.length - 1; i++) { input[i] = await makePart(input[i].index, input[i].items); whole.add(input[i]); for (const row of input[i].items) content.add(row) }
  input.at(-1).contentHash = content.digest(); input.at(-1).archiveHash = whole.digest()
  return input.map(r => JSON.stringify(r)).join('\n') + '\n'
}

export async function rejectInconsistentArchives(root, archive) {
  await command(root, ['export', '--output', 'exports/empty-before.rer'])
  const empty = rows(await records(join(root, 'exports/empty-before.rer')))
  const cases = {
    claim_total: ['c_claims', row => { row.total_minor += 1 }],
    receipt_bytes: ['c_receipts', row => { const bytes = Buffer.from(row.bytes.blob, 'base64'); bytes[bytes.length - 1] ^= 1; row.bytes.blob = bytes.toString('base64') }],
    capture_bytes: ['c_capture_receipts', row => { row.size += 1 }],
    decision_revision: ['c_decisions', row => { row.revision += 7 }],
  }
  for (const [code, [table, change]] of Object.entries(cases)) {
    await writeFile(join(root, `exports/${code}.rer`), await tampered(archive, table, change), { mode: 0o600 })
    const log = await command(root, ['import', '--input', `exports/${code}.rer`, '--yes'], { expected: 4 })
    assert.match(log, new RegExp('coaster_' + code), `restore refused ${code}`)
    await command(root, ['export', '--output', `exports/empty-after-${code}.rer`])
    assert.deepEqual(rows(await records(join(root, `exports/empty-after-${code}.rer`))), empty, `refused ${code} archive wrote nothing`)
  }
  await rejectCaptureLifecycleArchives(root, archive);
}

/** CAPTURE-004 / AUDIT-001: re-sealed lifecycle corruption is still refused. */
export async function rejectCaptureLifecycleArchives(root, archive) {
  const source = rows(await records(archive)).filter(item => item.table === 'c_capture_lifecycle');
  assert.ok(source.length >= 2, 'the public inbox journey discarded two originals');
  await command(root, ['export', '--output', 'exports/lifecycle-before.rer']);
  const before = rows(await records(join(root, 'exports/lifecycle-before.rer')));
  const cases = {
    unknown_receipt: row => { row.receipt_id = 'unknown-receipt' },
    sequence: row => { row.sequence = 2 },
    kind: row => { row.kind = 'restored' },
    blank_reason: row => { row.reason = ' ' },
    long_reason: row => { row.reason = 'x'.repeat(1001) },
    bad_time: row => { row.at = 'not-a-time' },
    early_time: row => { row.at = '1970-01-01T00:00:00.000Z' },
    channel: row => { row.channel = 'agent' },
    attribution: row => { row.on_behalf_of = 'somebody-else@example.test' },
    duplicate: row => { row.receipt_id = source[1].row.receipt_id },
  };
  for (const [name, change] of Object.entries(cases)) {
    await writeFile(join(root, 'exports/invalid-lifecycle.rer'), await tampered(archive, 'c_capture_lifecycle', change), { mode: 0o600 });
    assert.match(await command(root, ['import', '--input', 'exports/invalid-lifecycle.rer', '--yes'], { expected: 4 }), /coaster_capture_lifecycle/, `CAPTURE-004 refuses ${name}`);
  }
  await command(root, ['export', '--output', 'exports/lifecycle-after.rer']);
  assert.deepEqual(rows(await records(join(root, 'exports/lifecycle-after.rer'))), before, 'CAPTURE-004 refused archives leave the destination untouched');
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
