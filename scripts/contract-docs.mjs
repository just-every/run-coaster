// Seed-owned scoped regeneration; legacy acceptance entries outside the selected clauses stay intact.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {parseContract} from '../src/base/seed-contract.mjs';
const [mode,...selected]=process.argv.slice(2);
if(!['write','check'].includes(mode)||!selected.length)throw Error('Usage: node ./scripts/contract-docs.mjs write|check CLAUSE...');
let source=readFileSync('CONTRACT.md','utf8');
const statusRows=()=>source.split('\n').filter(l=>/^\| `[A-Z0-9]+-\d+` \|/.test(l)).map(line=>({line,cells:line.slice(1,-1).split(/(?<!\\)\|/).map(c=>c.trim())}));
const tally=kind=>{
  const rows=statusRows().filter(r=>!kind||r.cells[2]===kind);
  return [rows.filter(r=>r.cells[3]==='done').length,rows.filter(r=>r.cells[3]==='partial').length,rows.filter(r=>r.cells[3]==='missing').length,rows.length];
};
const total=tally(),published=tally('published'),target=total.map((v,i)=>v-published[i]);
for(const [label,values] of [['Published',published],['Target and push further',target],['All',total]])
  source=source.replace(new RegExp('^\\| '+label+' \\|.*$','m'),'| '+label+' | '+values.join(' | ')+' |');
const contract=parseContract(source);
let acceptance=readFileSync('ACCEPTANCE.md','utf8');
acceptance=acceptance.replace(/\*\*\d+ clauses: \d+ done, \d+ partial, \d+ missing\.\*\*/,`**${total[3]} clauses: ${total[0]} done, ${total[1]} partial, ${total[2]} missing.**`);
for(const id of selected){
  const clause=contract.clauses.find(c=>c.id===id),row=statusRows().find(r=>r.cells[0]==='`'+id+'`');
  if(!clause||!row)throw Error('Unknown clause '+id);
  const entry=`- **${id} — ${clause.title}. Status: ${clause.status}.** ${clause.text} **Evidence:** ${row.cells[4]} **Remaining:** ${row.cells[5]}`;
  const pattern=new RegExp('^- \\*\\*'+id+' — [\\s\\S]*?(?=\\n\\n|$)','m');
  if(!pattern.test(acceptance))throw Error('Missing acceptance entry '+id);
  acceptance=acceptance.replace(pattern,()=>entry);
}
const header='| Clause | Title | Kind | Status | Evidence | Gap |';
const claims='# Coaster clause status\n\nGenerated from CONTRACT.md by `node ./scripts/contract-docs.mjs write` with the changed clause ids.\n\n'+header+'\n| --- | --- | --- | --- | --- | --- |\n'+statusRows().map(r=>r.line).join('\n')+'\n';
for(const [path,expected] of [['CONTRACT.md',source],['ACCEPTANCE.md',acceptance],['docs/CLAIMS.md',claims]]){
  if(mode==='write')writeFileSync(path,expected);
  else if(!existsSync(path)||readFileSync(path,'utf8')!==expected)throw Error(path+' is stale; run scoped contract-docs write');
}
console.log(`contract-docs ${mode}: ${selected.join(', ')}; ${total[0]} done, ${total[1]} partial, ${total[2]} missing`);
