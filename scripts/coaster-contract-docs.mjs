#!/usr/bin/env node
// Scoped projections for clauses changed before the contract's separate standard conversion.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseContract } from '../src/base/seed-contract.mjs';

const [command, ...requested] = process.argv.slice(2);
if (!['write', 'check'].includes(command)) throw Error('Use write or check, followed by clause IDs.');
const source = readFileSync('CONTRACT.md', 'utf8'), parsed = parseContract(source), lines = source.split('\n');
const acceptancePath = 'ACCEPTANCE.md', claimsPath = 'docs/claims.md';
let acceptance = readFileSync(acceptancePath, 'utf8'), claims = readFileSync(claimsPath, 'utf8');
const ids = requested.length ? requested : [...claims.matchAll(/<!-- contract-docs begin ([A-Z]+-\d+) -->/g)].map(match => match[1]);
for (const id of ids) {
  const clause = parsed.clauses.find(clause => clause.id === id);
  if (!clause) throw Error(`Unknown contract clause ${id}`);
  const cells = lines[clause.row - 1].split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim());
  const projected = `- **${id} — ${clause.title}. Status: ${clause.status}.** ${clause.text} **Evidence:** ${cells[4]} **Remaining:** ${cells[5]}`;
  const existing = acceptance.split('\n').find(line => line.startsWith(`- **${id} — `));
  if (!existing) throw Error(`${acceptancePath} has no entry for ${id}`);
  acceptance = acceptance.replace(existing, projected);
  const begin = `<!-- contract-docs begin ${id} -->`, end = `<!-- contract-docs end ${id} -->`;
  const generated = `${begin}\n## ${clause.title}\n\nStatus: **${clause.status}**. ${clause.text}\n\nEvidence: ${cells[4]}\n\nRemaining: ${cells[5]}\n${end}`;
  const start = claims.indexOf(begin), finish = claims.indexOf(end);
  if ((start < 0) !== (finish < 0)) throw Error(`Incomplete generated block for ${id}`);
  claims = start < 0 ? claims.trimEnd() + '\n\n' + generated + '\n' : claims.slice(0, start) + generated + claims.slice(finish + end.length);
}
if (!ids.length) throw Error('Name at least one clause for its first projection.');
for (const [file, value] of [[acceptancePath, acceptance], [claimsPath, claims]]) {
  if (readFileSync(file, 'utf8') === value) continue;
  if (command === 'check') throw Error(`${file} differs from CONTRACT.md; run the scoped generator write command.`);
  writeFileSync(file, value);
}
console.log(`Scoped contract projections ${command === 'check' ? 'current' : 'written'}: ${ids.join(', ')}`);
