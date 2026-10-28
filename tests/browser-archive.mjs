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

export async function rejectInconsistentArchives(root,archive){
  await writeFile(join(root,'exports/inconsistent.rer'),await tampered(archive,'c_claims',row=>{row.total_minor+=1}),{mode:0o600})
  const log=await command(root,['import','--input','exports/inconsistent.rer','--yes'],{expected:4})
  assert.match(log,/coaster_claim_total/,'re-sealing an archive never authorizes inconsistent financial records')
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
