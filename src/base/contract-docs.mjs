import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parseContract } from './seed-contract.mjs'

const cells = line => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(value => value.trim())
const groups = { Published: ['published'], 'Target and push further': ['target', 'push-further'], All: ['published', 'target', 'push-further'] }
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Normalize counts before the shared parser validates the whole source. */
function normalizeSummary(source) {
  const section = /^## Status\s*\n[\s\S]*?(?=^## |$(?![\s\S]))/m.exec(source)
  if (!section) throw new Error('CONTRACT.md has no Status section.')
  const lines = section[0].split('\n')
  const header = lines.findIndex(line => cells(line).join('|') === 'Clause|Title|Kind|Status|Evidence|Gap')
  if (header < 0) throw new Error('CONTRACT.md has no Status clause table.')
  const rows = []
  for (let index = header + 2; index < lines.length && lines[index].trimStart().startsWith('|'); index++) rows.push(cells(lines[index]))
  const count = kinds => {
    const selected = rows.filter(row => kinds.includes(row[2]))
    return ['done', 'partial', 'missing'].map(status => selected.filter(row => row[3] === status).length).concat(selected.length)
  }
  const all = count(groups.All)
  const normalized = section[0].replace(/^\|\s*(Published|Target and push further|All)\s*\|[^\n]*$/gm,
    (_, label) => `| ${label} | ${count(groups[label]).join(' | ')} |`)
    .replace(/\b\d+ clauses?:\s*\d+ done,\s*\d+ partial(?:,| and)\s*\d+ missing\b/gi,
      () => `${all[3]} clauses: ${all[0]} done, ${all[1]} partial, ${all[2]} missing`)
  return source.slice(0, section.index) + normalized + source.slice(section.index + section[0].length)
}

function scopedClaims(source, id, body) {
  const start = `<!-- contract-docs:${id}:start -->`, end = `<!-- contract-docs:${id}:end -->`
  const block = `${start}\n## Implementation status — ${id}\n\n${body}\n${end}`
  const starts = source.split(start).length - 1, ends = source.split(end).length - 1
  if (!starts && !ends) return source + (source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n') + block + '\n'
  if (starts !== 1 || ends !== 1 || source.indexOf(end) < source.indexOf(start)) throw new Error(`docs/CLAIMS.md has invalid generated markers for ${id}.`)
  return source.slice(0, source.indexOf(start)) + block + source.slice(source.indexOf(end) + end.length)
}

/** Pure, incremental generation: unrelated prose is copied byte for byte. */
export function generateContractDocs(files, ids) {
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Supply one or more unique clause IDs.')
  const contract = normalizeSummary(files['CONTRACT.md'])
  const parsed = parseContract(contract)
  const lines = contract.split('\n')
  let acceptance = files['ACCEPTANCE.md'], claims = files['docs/CLAIMS.md']
  for (const id of ids) {
    const clause = parsed.clauses.find(value => value.id === id)
    if (!clause) throw new Error(`Unknown clause: ${id}`)
    const marker = '**Acceptance evidence:**'
    const offset = clause.text.indexOf(marker)
    if (offset < 0) throw new Error(`${id} has no acceptance evidence in CONTRACT.md.`)
    const evidenceText = clause.text.slice(offset + marker.length).trim()
    if (!evidenceText) throw new Error(`${id} has empty acceptance evidence in CONTRACT.md.`)
    const row = cells(lines[clause.row - 1])
    const body = `- **${id} — ${clause.title}. Status: ${clause.status}.** ${evidenceText}`
      + (row[4] ? ` Existing evidence: ${row[4]}` : '')
      + (row[5] ? ` Open scope: ${row[5]}` : '')
    const pattern = new RegExp(`^- \\*\\*${escaped(id)} — [^\\n]*(?:\\n(?!\\s*\\n)[^\\n]+)*`, 'gm')
    const matches = [...acceptance.matchAll(pattern)]
    if (matches.length !== 1) throw new Error(`ACCEPTANCE.md must have exactly one bullet paragraph for ${id}.`)
    acceptance = acceptance.replace(pattern, () => body)
    claims = scopedClaims(claims, id, body)
  }
  return { 'CONTRACT.md': contract, 'ACCEPTANCE.md': acceptance, 'docs/CLAIMS.md': claims }
}

async function main() {
  const [command, ...ids] = process.argv.slice(2)
  if (!['write', 'check'].includes(command) || !ids.length) throw new Error('Usage: node src/base/contract-docs.mjs <write|check> CLAUSE-ID [...]')
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const paths = ['CONTRACT.md', 'ACCEPTANCE.md', 'docs/CLAIMS.md']
  const files = Object.fromEntries(await Promise.all(paths.map(async path => [path, await readFile(resolve(root, path), 'utf8')])))
  const expected = generateContractDocs(files, ids)
  const changed = paths.filter(path => files[path] !== expected[path])
  if (command === 'check' && changed.length) throw new Error(`Generated contract docs differ: ${changed.join(', ')}. Run node src/base/contract-docs.mjs write ${ids.join(' ')}.`)
  if (command === 'write') for (const path of changed) await writeFile(resolve(root, path), expected[path])
  console.log(command === 'write' ? `Updated ${changed.length ? changed.join(', ') : 'no files'}.` : `Contract docs match for ${ids.join(', ')}.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
