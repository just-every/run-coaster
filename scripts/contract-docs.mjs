// Scoped migration of legacy acceptance notes; unselected prose stays byte-identical.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseContract } from '../src/base/seed-contract.mjs';

const [mode, ...args] = process.argv.slice(2);
if (!['write','check'].includes(mode) || args.length === 0 || args.length % 2 || args.some((v,i) => i % 2 === 0 && v !== '--clause'))
  throw Error('Usage: node scripts/contract-docs.mjs write|check --clause ID [--clause ID]');
const ids = args.filter((_,i) => i % 2 === 1);
let source = readFileSync('CONTRACT.md','utf8');
const sourceRows = [...source.matchAll(/^\| `([^`]+)` \| (.*?) \| (published|target|push-further) \| (done|partial|missing) \|/gm)];
const tally = selected => ({ done: selected.filter(r => r[4] === 'done').length, partial: selected.filter(r => r[4] === 'partial').length, missing: selected.filter(r => r[4] === 'missing').length, total: selected.length });
for (const [label,selected] of [['Published',sourceRows.filter(r=>r[3]==='published')],['Target and push further',sourceRows.filter(r=>r[3]!=='published')],['All',sourceRows]]) {
  const n=tally(selected);
  source=source.replace(new RegExp(`^\\| ${label} \\| \\d+ \\| \\d+ \\| \\d+ \\| \\d+ \\|$`,'m'),`| ${label} | ${n.done} | ${n.partial} | ${n.missing} | ${n.total} |`);
}
const contract = parseContract(source), { done, partial, missing, total } = contract.counts;
let acceptance = readFileSync('ACCEPTANCE.md','utf8').replace(/\*\*\d+ clauses: \d+ done, \d+ partial, \d+ missing\.\*\*/,`**${total} clauses: ${done} done, ${partial} partial, ${missing} missing.**`);
for (const id of ids) {
  const clause=contract.clauses.find(c=>c.id===id);
  if(!clause) throw Error(`Unknown clause ${id}`);
  const row=source.split('\n')[clause.row-1].split('|').slice(1,-1).map(s=>s.trim());
  const evidence=clause.text.split('**Acceptance evidence:**')[1]?.trim();
  if(!evidence) throw Error(`${id} names no acceptance evidence`);
  const line=`- **${id} — ${clause.title}. Status: ${clause.status}.** ${evidence} Native slice evidence: ${row[4]}${row[4].endsWith('.')?'':'.'}${clause.gap ? ` Open scope: ${clause.gap}` : ''}`;
  const match=new RegExp(`^- \\*\\*${id} — .*?$`,'m');
  if(match.test(acceptance)) acceptance=acceptance.replace(match,()=>line);
  else {
    const previous=contract.clauses.slice(0,contract.clauses.indexOf(clause)).reverse()
      .find(c=>new RegExp(`^- \\*\\*${c.id} — .*?$`,'m').test(acceptance));
    if(!previous) throw Error(`No preceding acceptance entry for new clause ${id}`);
    const anchor=new RegExp(`^- \\*\\*${previous.id} — .*?$`,'m');
    acceptance=acceptance.replace(anchor,existing=>`${existing}\n\n${line}`);
  }
}
const table = ['| Clause | Title | Kind | Status |','| --- | --- | --- | --- |',...contract.clauses.map(c=>`| ${c.id} | ${c.title} | ${c.kind} | ${c.status} |`)].join('\n');
const guide = readFileSync('docs/claims.md','utf8').split('\n## Implementation status\n')[0].trimEnd();
const claims=`${guide}\n\n## Implementation status\n\nGenerated from the Status table in [CONTRACT.md](https://github.com/just-every/run-coaster/blob/main/CONTRACT.md). That source retains the acceptance requirements, current evidence and remaining work for each clause.\n\n**${total} clauses: ${done} done, ${partial} partial, ${missing} missing.**\n\n${table}\n`;
const views={'CONTRACT.md':source,'ACCEPTANCE.md':acceptance,'docs/claims.md':claims};
let stale=false;
for(const [path,content] of Object.entries(views)) {
  if(existsSync(path) && readFileSync(path,'utf8')===content) continue;
  if(mode==='write') writeFileSync(path,content);
  else {console.error(`Stale generated contract view: ${path}`);stale=true;}
}
if(stale) process.exitCode=1;
else console.log(`Contract views ${mode==='write'?'generated':'current'} for ${ids.join(', ')}; ${done} done, ${partial} partial, ${missing} missing`);
