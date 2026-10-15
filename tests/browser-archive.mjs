// Archive checks for COA-012: tampered archives are refused before any write.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makePart, ContentVerifier, ArchiveVerifier } from '@runeditrun/rer/modules/portability/format'
import { command } from './browser-runtime.mjs'

export const records = async path => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
export const rows = archive => archive.filter(r => r.kind === 'part').flatMap(r => r.items)

/** Rewrite one row and re-seal the archive's hashes, so only Coaster's own staged validation can catch it. */
async function tampered(archive, table, change) {
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
    decision_revision: ['c_decisions', row => { row.revision += 7 }],
  }
  for (const [code, [table, change]] of Object.entries(cases)) {
    await writeFile(join(root, `exports/${code}.rer`), await tampered(archive, table, change), { mode: 0o600 })
    const log = await command(root, ['import', '--input', `exports/${code}.rer`, '--yes'], { expected: 4 })
    assert.match(log, new RegExp('coaster_' + code), `restore refused ${code}`)
    await command(root, ['export', '--output', `exports/empty-after-${code}.rer`])
    assert.deepEqual(rows(await records(join(root, `exports/empty-after-${code}.rer`))), empty, `refused ${code} archive wrote nothing`)
  }
}
