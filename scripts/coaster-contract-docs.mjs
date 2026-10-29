import { readFileSync, writeFileSync } from 'node:fs';
import { parseContract } from '../src/base/seed-contract.mjs';

// Scoped regeneration preserves unrelated legacy acceptance prose while this edition keeps its current Base pin.
const [mode,...ids]=process.argv.slice(2);
if(!['write','check'].includes(mode)||!ids.length)throw Error('Use write or check followed by the clause IDs to regenerate');
const original=readFileSync('CONTRACT.md','utf8');
const rows=[...original.matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \| (done|partial|missing) \|\s*(.*?)\s*\|\s*(.*?)\s*\|$/gm)];
const counts=selected=>Object.fromEntries(['done','partial','missing'].map(status=>[status,selected.filter(row=>row[4]===status).length]));
let contract=original;
for(const [label,selected]of [['Published',rows.filter(r=>r[3].trim()==='published')],['Target and push further',rows.filter(r=>r[3].trim()!=='published')],['All',rows]]){
  const c=counts(selected);
  contract=contract.replace(new RegExp(`^\\| ${label} \\|.*$`,'m'),`| ${label} | ${c.done} | ${c.partial} | ${c.missing} | ${selected.length} |`);
}
const parsed=parseContract(contract);
let acceptance=readFileSync('ACCEPTANCE.md','utf8');
for(const id of ids){
  const clause=parsed.clauses.find(c=>c.id===id),row=rows.find(r=>r[1]===id);
  if(!clause||!row)throw Error('Unknown clause '+id);
  const proof=clause.text.split('**Acceptance evidence:**')[1]?.trim();
  if(!proof)throw Error('Acceptance evidence required for '+id);
  const entry=`- **${id} — ${clause.title}. Status: ${clause.status}.** ${proof}${row[5]?` Existing evidence: ${row[5]}`:''}${row[6]?` Open scope: ${row[6]}`:''}`;
  const pattern=new RegExp(`^- \\*\\*${id} — .*?$`,'m');
  if(!pattern.test(acceptance))throw Error('Missing acceptance entry '+id);
  acceptance=acceptance.replace(pattern,()=>entry);
}
const c=parsed.counts;
acceptance=acceptance.replace(/\*\*\d+ clauses: \d+ done, \d+ partial, \d+ missing\.\*\*/,`**${c.total} clauses: ${c.done} done, ${c.partial} partial, ${c.missing} missing.**`);
if(mode==='write'){
  writeFileSync('CONTRACT.md',contract);writeFileSync('ACCEPTANCE.md',acceptance);
}else if(contract!==original||acceptance!==readFileSync('ACCEPTANCE.md','utf8'))throw Error('Stale scoped contract documents');
console.log(`Contract documents ${mode}: ${ids.join(', ')}; ${c.done} done, ${c.partial} partial, ${c.missing} missing`);
