import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fresh, command } from './browser-runtime.mjs';
import { records, rows, tampered } from './browser-archive.mjs';
import { harness } from './harness.mjs';
import { individualProgram, classifyAndBatch } from './individual-liability-kit.mjs';

export async function individualArchive() {
  const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/individual-liability');
  await mkdir(evidence,{recursive:true});
  const roots=[];let h,f;
  try {
    for(let i=0;i<2;i++){const root=await fresh();roots.push(root);execFileSync('git',['config','user.name','Run Edit Run fleet'],{cwd:root});execFileSync('git',['config','user.email','fleet@runeditrun.com'],{cwd:root});await command(root,['install']);}
    const [source,destination]=roots;
    h=await harness({clock:Date.parse('2031-06-10T10:00:00Z'),persistencePath:join(source,'.wrangler/state/v3'),databaseId:'local-foundation-only',bindings:origin=>({RER_DEV_ORIGIN:origin})});
    f=await individualProgram(h);await classifyAndBatch(h,f);
    const history=(await h.db.prepare('SELECT * FROM c_events ORDER BY seq').all()).results;
    const charges=(await h.db.prepare('SELECT * FROM c_card_charges ORDER BY id').all()).results;
    await h.close();h=undefined;await f.issuer.close();f=undefined;
    await command(source,['export','--output','./exports/individual.rer']);
    const archive=join(source,'./exports/individual.rer'),exported=await records(archive);
    const table=(list,name)=>rows(list).filter(r=>r.table===name).map(r=>r.row);
    assert.equal(table(exported,'c_card_charges').length,6);
    assert.deepEqual(table(exported,'c_card_charges').sort((a,b)=>a.id.localeCompare(b.id)),charges);
    assert.deepEqual(table(exported,'c_events').sort((a,b)=>a.seq-b.seq),history);
    assert.equal(table(exported,'c_reimbursement_keys').length,4);
    assert.equal(table(exported,'c_batches')[0].total_minor,10000);
    await mkdir(join(destination,'exports'),{recursive:true});
    await command(destination,['export','--output','./exports/empty.rer']);
    const empty=rows(await records(join(destination,'./exports/empty.rer')));
    const mutations=[
      ['c_card_charges',r=>{r.liability='company';},()=>true],
      ['c_items',r=>{r.card_personal=0;},r=>r.card_personal===1],
      ['c_revisions',r=>{const s=JSON.parse(r.snapshot);s.items.find(i=>i.card_personal===1).card_personal=0;r.snapshot=JSON.stringify(s);},()=>true],
      ['c_reimbursement_keys',r=>{r.key='card:synthetic-coaster-forged';},()=>true],
      ['c_reimbursement_keys',r=>{r.key='expense:synthetic-coaster-forged';},()=>true],
      ['c_revisions',r=>{const s=JSON.parse(r.snapshot);s.items.find(i=>i.amount_minor===1000).amount_minor=1001;s.items.find(i=>i.amount_minor===2000).amount_minor=1999;r.snapshot=JSON.stringify(s);},()=>true],
    ];
    for(const [i,[name,mutate,choose]]of mutations.entries()){
      await writeFile(join(destination,`./exports/invalid-${i}.rer`),await tampered(archive,name,mutate,choose),{mode:0o600});
      assert.match(await command(destination,['import','--input',`./exports/invalid-${i}.rer`,'--yes'],{expected:4}),/coaster_|liability/);
    }
    await command(destination,['export','--output','./exports/still-empty.rer']);
    assert.deepEqual(rows(await records(join(destination,'./exports/still-empty.rer'))),empty,'invalid liability evidence writes no destination rows');
    await copyFile(archive,join(destination,'./exports/individual.rer'));
    await command(destination,['import','--input','./exports/individual.rer','--yes']);
    await command(destination,['export','--output','./exports/restored.rer']);
    const restored=await records(join(destination,'./exports/restored.rer'));
    assert.deepEqual(rows(restored),rows(exported),'real CLI restore preserves every portable financial row and numbered history line');
    await copyFile(archive,join(evidence,'individual.rer'));await copyFile(join(destination,'./exports/restored.rer'),join(evidence,'individual-restored.rer'));
    console.log('Individual-liability CLI restore: six immutable charges, two personal, four once-only keys, USD 100.00 batch, identical numbered history; six corrupted archives refused without writes');
  } finally {await h?.close();await f?.issuer.close();await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));}
}
if(process.argv[1]===new URL(import.meta.url).pathname)await individualArchive();
