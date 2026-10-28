#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = ['CONTRACT.md', 'ACCEPTANCE.md', 'docs/CLAIMS.md'];
const begin = '<!-- contract-docs:implementation-status:start -->';
const end = '<!-- contract-docs:implementation-status:end -->';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const read = path => readFile(resolve(root, path), 'utf8');

function registry(contract) {
  const start = contract.indexOf('| Clause | Title | Kind | Status | Evidence | Gap |');
  if (start < 0) throw new Error('CONTRACT.md has no clause Status table.');
  const rows = new Map();
  for (const line of contract.slice(start).split('\n')) {
    if (!/^\| `[A-Z]+-\d+` \|/.test(line)) continue;
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim());
    if (cells.length !== 6) throw new Error(`Expected six Status cells: ${line}`);
    const [quoted, title, kind, status, evidence, gap] = cells, id = quoted.slice(1, -1);
    if (rows.has(id)) throw new Error(`Duplicate Status row: ${id}`);
    if (!['done', 'partial', 'missing'].includes(status)) throw new Error(`Unknown status for ${id}: ${status}`);
    rows.set(id, { id, title, kind, status, evidence, gap });
  }
  if (!rows.size) throw new Error('CONTRACT.md Status table has no clauses.');
  return rows;
}

/** Bound one clause by the next clause or heading; leave its separator byte-for-byte. */
function clauseBlock(document, id) {
  const pattern = new RegExp(`^- \\*\\*${escape(id)} — `, 'm');
  const match = pattern.exec(document);
  if (!match) throw new Error(`Missing clause paragraph: ${id}`);
  const start = match.index, rest = document.slice(start + match[0].length);
  const next = /\n(?:- \*\*[A-Z]+-\d+ — |#{1,6} )/.exec(rest);
  const boundary = next ? start + match[0].length + next.index : document.length;
  const content = document.slice(start, boundary).trimEnd();
  return { start, end: start + content.length, content };
}

function acceptance(contract, row) {
  const clause = clauseBlock(contract, row.id).content, marker = '**Acceptance evidence:**';
  const position = clause.indexOf(marker);
  if (position < 0) throw new Error(`${row.id} has no Acceptance evidence in CONTRACT.md.`);
  const journey = clause.slice(position + marker.length).trim();
  if (!journey) throw new Error(`${row.id} has empty Acceptance evidence.`);
  return { journey, paragraph: `- **${row.id} — ${row.title}. Status: ${row.status}.** ${journey}${row.evidence ? ` Existing evidence: ${row.evidence}.` : ''}${row.gap ? ` Open scope: ${row.gap}` : ''}` };
}

function counts(rows) {
  const result = { done: 0, partial: 0, missing: 0, total: 0 };
  for (const row of rows) { result[row.status]++; result.total++; }
  return result;
}

function summaries(document, rows) {
  const all = counts(rows);
  let next = document.replace(/\*\*\d+ clauses: \d+ done, \d+ partial, \d+ missing\.\*\*/g,
    `**${all.total} clauses: ${all.done} done, ${all.partial} partial, ${all.missing} missing.**`);
  for (const [label, selected] of [
    ['Published', rows.filter(row => row.kind === 'published')],
    ['Target and push further', rows.filter(row => row.kind !== 'published')],
    ['All', rows],
  ]) {
    const value = counts(selected);
    next = next.replace(new RegExp(`^\\| ${escape(label)} \\| \\d+ \\| \\d+ \\| \\d+ \\| \\d+ \\|$`, 'gm'),
      `| ${label} | ${value.done} | ${value.partial} | ${value.missing} | ${value.total} |`);
  }
  return next;
}

async function verifyEvidence(row, journey) {
  const evidence = `${row.evidence}\n${journey}`, candidates = new Set();
  for (const [, token] of evidence.matchAll(/`([^`\n]+)`/g)) {
    if (!/\s|^[a-z]+:\/\//i.test(token) && (/\//.test(token) || /\.[a-z0-9]{1,8}$/i.test(token))) candidates.add(token);
  }
  for (const [, target] of evidence.matchAll(/\]\(([^)\s]+)\)/g)) if (!/^[a-z]+:|^#/.test(target)) candidates.add(target);
  for (const [path] of evidence.matchAll(/\b(?:src|tests|scripts|docs|migrations|public)\/[\w./@+-]+/g)) candidates.add(path.replace(/\.$/, ''));
  for (const candidate of candidates) {
    const path = candidate.replace(/#.*$/, '').replace(/:\d+(?::\d+)?$/, '');
    const resolved = resolve(root, path), local = relative(root, resolved);
    if (isAbsolute(path) || local.startsWith('..') || isAbsolute(local)) throw new Error(`${row.id}: evidence must stay within the checkout: ${candidate}`);
    try { await stat(resolved); } catch { throw new Error(`${row.id}: evidence path does not exist: ${candidate}`); }
  }
  return candidates.size;
}

function implementationSection(help, selected) {
  const section = `${begin}\n## Implementation status\n\nSource: [CONTRACT.md](../CONTRACT.md#status). Only the selected clauses below are generated; the help above is maintained separately.\n\n${selected.map(row => `- **${row.id} — ${row.title}. Status: ${row.status}.**${row.evidence ? ` Existing evidence: ${row.evidence}.` : ''}${row.gap ? ` Open scope: ${row.gap}` : ''}`).join('\n\n')}\n${end}`;
  const start = help.indexOf(begin), finish = help.indexOf(end);
  if ((start < 0) !== (finish < 0) || (start >= 0 && finish < start)) throw new Error('docs/CLAIMS.md has incomplete generated status markers.');
  if (start >= 0) {
    if (help.indexOf(begin, start + begin.length) >= 0 || help.indexOf(end, finish + end.length) >= 0) throw new Error('docs/CLAIMS.md has duplicate generated status markers.');
    return help.slice(0, start) + section + help.slice(finish + end.length);
  }
  return help + (help.endsWith('\n\n') ? '' : help.endsWith('\n') ? '\n' : '\n\n') + section + '\n';
}

async function main() {
  const [mode, ...arguments_] = process.argv.slice(2);
  const ids = [...new Set(arguments_.flatMap(value => value.split(',')))];
  if (!['write', 'check'].includes(mode) || !ids.length || ids.some(id => !/^[A-Z]+-\d+$/.test(id))) {
    throw new Error('Usage: node scripts/contract-docs.mjs <write|check> CLAUSE-ID [CLAUSE-ID ...]');
  }
  const original = await Promise.all(paths.map(read));
  const [contract, acceptanceDocument, help] = original, rows = registry(contract);
  const selected = ids.map(id => { const row = rows.get(id); if (!row) throw new Error(`Unknown clause: ${id}`); return row; });
  let nextAcceptance = acceptanceDocument, evidencePaths = 0;
  for (const row of selected) {
    const generated = acceptance(contract, row);
    evidencePaths += await verifyEvidence(row, generated.journey);
    const block = clauseBlock(nextAcceptance, row.id);
    nextAcceptance = nextAcceptance.slice(0, block.start) + generated.paragraph + nextAcceptance.slice(block.end);
  }
  const next = [summaries(contract, [...rows.values()]), summaries(nextAcceptance, [...rows.values()]), implementationSection(help, selected)];
  const changed = paths.filter((_, index) => next[index] !== original[index]);
  if (mode === 'check' && changed.length) throw new Error(`Generated documentation is stale: ${changed.join(', ')}. Run write with the same clause IDs.`);
  if (mode === 'write') for (let index = 0; index < paths.length; index++) if (next[index] !== original[index]) await writeFile(resolve(root, paths[index]), next[index]);
  console.log(`${mode}: ${ids.join(', ')}; ${evidencePaths} evidence paths exist; ${changed.length ? `updated ${changed.join(', ')}` : 'documents current'}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
