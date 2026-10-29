#!/usr/bin/env node
// Generate scoped clause views while preserving the seed's unrelated legacy guidance.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { parseContract } from '../src/base/seed-contract.mjs';

const [mode,...touched]=process.argv.slice(2);
if(!['write','check'].includes(mode)||!touched.length) throw Error('Usage: node scripts/contract-docs.mjs write|check ACCT-006');
const original=readFileSync('CONTRACT.md','utf8'),lines=original.split('\n');
const rows=lines.filter(line=>/^\| `[A-Z]+-\d+` \|/.test(line)).map(line=>line.split('|').slice(1,-1).map(c=>c.trim()));
const tally=selected=>({done:selected.filter(r=>r[3]==='done').length,partial:selected.filter(r=>r[3]==='partial').length,missing:selected.filter(r=>r[3]==='missing').length,total:selected.length});
const all=tally(rows),target=tally(rows.filter(r=>r[2]!=='existing'));
const contract=lines.map(line=>{
  for(const [label,counts] of [['All',all],['Target and push further',target]]) if(line.startsWith(`| ${label} |`)) return `| ${label} | ${counts.done} | ${counts.partial} | ${counts.missing} | ${counts.total} |`;
  return line;
}).join('\n');
const parsed=parseContract(contract),clauses=touched.map(id=>{
  const c=parsed.clauses.find(c=>c.id===id);if(!c)throw Error('Unknown clause '+id);return c;
});
let acceptance=readFileSync('ACCEPTANCE.md','utf8').replace(/\*\*\d+ clauses: \d+ done, \d+ partial, \d+ missing\.\*\*/,`**${all.total} clauses: ${all.done} done, ${all.partial} partial, ${all.missing} missing.**`);
for(const c of clauses) {
  const row=rows.find(r=>r[0]===`\`${c.id}\``);
  const view=`- **${c.id} — ${c.title}. Status: ${c.status}.** ${c.text} Existing evidence: ${row[4] || 'None.'}${c.status==='done'?'':` Open scope: ${c.gap}`}`;
  const pattern=new RegExp(`^- \\*\\*${c.id} —[^\\n]*(?:\\n(?!\\n|[-#])[^^\\n]*)*`,'m');
  if(!pattern.test(acceptance))throw Error('Missing acceptance view for '+c.id);
  acceptance=acceptance.replace(pattern,()=>view);
}
const claims='# Coaster clause status\n\nGenerated from CONTRACT.md. Implementation status does not certify live provider qualification.\n\n'+
  `**${all.total} clauses: ${all.done} done, ${all.partial} partial, ${all.missing} missing.**\n\n`+
  '| Clause | Title | Status | Remaining |\n| --- | --- | --- | --- |\n'+parsed.clauses.map(c=>`| ${c.id} | ${c.title} | ${c.status} | ${c.gap.replaceAll('|','\\|')} |`).join('\n')+'\n';
for(const [path,value] of [['CONTRACT.md',contract],['ACCEPTANCE.md',acceptance],['docs/CLAIMS.md',claims]]) {
  if(mode==='write'){mkdirSync(path.includes('/')?path.slice(0,path.lastIndexOf('/')):'.',{recursive:true});writeFileSync(path,value);}
  else if(!existsSync(path)||readFileSync(path,'utf8')!==value)throw Error('Stale generated contract view: '+path);
}
console.log(`Contract documents ${mode}: ${clauses.map(c=>c.id).join(', ')}; ${all.done} done, ${all.partial} partial, ${all.missing} missing`);
