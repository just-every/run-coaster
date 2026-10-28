// Scoped contract projections preserve legacy guidance and derive status from the sole source.
import { readFile, writeFile } from 'node:fs/promises';
import { parseContract } from '../src/base/seed-contract.mjs';

const [command, ...args] = process.argv.slice(2);
if (!['write', 'check'].includes(command)) throw Error('Use write or check with --clause ID');
const selected = [];
for (let index = 0; index < args.length; index += 2) {
  if (args[index] !== '--clause' || !args[index + 1]) throw Error('Use --clause ID for each touched clause');
  selected.push(args[index + 1]);
}
if (!selected.length) throw Error('Name at least one touched clause with --clause ID');
let source = await readFile('CONTRACT.md', 'utf8');
const lines = source.split('\n');
const statusRows = lines.filter(line => /^\| `[^`]+` \|/.test(line)).map(line => { const cells = line.split(/(?<!\\)\|/).map(s => s.trim()); return { kind: cells[3], status: cells[4] }; });
if (!statusRows.length) throw Error('Missing Status rows');
const summary = list => ['done', 'partial', 'missing'].map(status => list.filter(c => c.status === status).length);
for (const [label, list] of [['Published', statusRows.filter(c => c.kind === 'published')], ['Target and push further', statusRows.filter(c => c.kind !== 'published')], ['All', statusRows]]) {
  const at = lines.findIndex(line => line.startsWith(`| ${label} |`));
  if (at < 0) throw Error(`Missing ${label} summary`);
  lines[at] = `| ${label} | ${summary(list).join(' | ')} | ${list.length} |`;
}
source = lines.join('\n');
const contract = parseContract(source);
const { done, partial, missing, total } = contract.counts;
let acceptance = await readFile('ACCEPTANCE.md', 'utf8');
acceptance = acceptance.replace(/\*\*\d+ clauses: \d+ done, \d+ partial, \d+ missing\.\*\*/, `**${total} clauses: ${done} done, ${partial} partial, ${missing} missing.**`);
for (const id of selected) {
  const clause = contract.clauses.find(c => c.id === id); if (!clause) throw Error(`Unknown clause ${id}`);
  const line = lines[clause.row - 1], cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(s => s.trim());
  const acceptanceText = clause.text.split('**Acceptance evidence:**')[1]?.trim();
  if (!acceptanceText) throw Error(`Missing acceptance evidence for ${id}`);
  const paragraphs = acceptance.split('\n');
  const at = paragraphs.findIndex(line => line.startsWith(`- **${id} — `));
  if (at < 0) throw Error(`Missing acceptance entry for ${id}`);
  paragraphs[at] = `- **${id} — ${clause.title}. Status: ${clause.status}.** ${acceptanceText} Evidence: ${cells[4]}.${clause.gap ? ` Open scope: ${clause.gap}` : ''}`;
  acceptance = paragraphs.join('\n');
}
let claims = await readFile('docs/claims.md', 'utf8');
const heading = '## Contract implementation status';
const offset = claims.indexOf(heading);
const following = offset < 0 ? -1 : claims.indexOf('\n## ', offset + heading.length);
const generated = `${heading}\n\n${total} clauses: ${done} done, ${partial} partial, ${missing} missing. See [the contract](/contract) for the full acceptance requirements.\n\n| Clause | Capability | Status |\n| --- | --- | --- |\n${contract.clauses.map(c => `| ${c.id} | ${c.title} | ${c.status} |`).join('\n')}\n`;
claims = offset < 0 ? `${claims.trimEnd()}\n\n${generated}` : claims.slice(0, offset) + generated + (following < 0 ? '' : claims.slice(following));
for (const [file, value] of [['CONTRACT.md', source], ['ACCEPTANCE.md', acceptance], ['docs/claims.md', claims]]) {
  const existing = await readFile(file, 'utf8');
  if (existing === value) continue;
  if (command === 'check') throw Error(`Stale generated contract view: ${file}`);
  await writeFile(file, value);
}
console.log(`Contract projections ${command}: ${selected.join(', ')}; ${done} done, ${partial} partial, ${missing} missing`);
