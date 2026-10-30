import assert from 'node:assert/strict';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fresh, command } from './browser-runtime.mjs';
import { records, rows, tampered } from './browser-archive.mjs';
import { harness } from './harness.mjs';
import { correctionClaims, correctionBody, correctionPath } from './account-correction-kit.mjs';

const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/account-corrections-archive');
await mkdir(evidence,{recursive:true});
const roots=[];let h;
try {
  const source=await fresh(),destination=await fresh();roots.push(source,destination);
  for(const root of roots) {
    await promisify(execFile)('git',['config','user.name','Run Edit Run fleet'],{cwd:root});
    await promisify(execFile)('git',['config','user.email','fleet@runeditrun.com'],{cwd:root});
    await command(root,['install']);
  }
  h=await harness({persistencePath:join(source,'.wrangler/state/v3'),databaseId:'local-foundation-only'});
  const {t,create,approve}=await correctionClaims(h);
  let c=await create(),d=await h.get(`claims/${c.id}`);
  c=await h.post(correctionPath(c),correctionBody(d),t.priya);
  c=await approve(c);d=await h.get(`claims/${c.id}`);
  c=await h.post(correctionPath(c),correctionBody(d,{accountCode:'6800'}));
  let batch=await h.post('batches',{claims:[c.id]},t.morgan);
  const originalBatch=batch,selection=(await h.db.prepare('SELECT * FROM c_batch_coding ORDER BY batch_id').all()).results;
  await h.post(`batches/${batch.id}/remove`,{version:batch.version,claim:c.id},t.morgan);
  d=await h.get(`claims/${c.id}`);
  c=await h.post(correctionPath(c),correctionBody(d,{allocation:1,accountCode:'6810',reason:'Correct the second split after removing the draft batch'}));
  assert.deepEqual((await h.db.prepare('SELECT * FROM c_batch_coding ORDER BY batch_id').all()).results,selection,'prior frozen selection remains exact');
  batch=await h.post('batches',{claims:[c.id]},t.morgan);
  batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:11000},t.morgan);
  const expected=await h.get(`batches/${batch.id}`,t.morgan),history=(await h.db.prepare('SELECT * FROM c_events ORDER BY seq').all()).results;
  assert.equal(expected.lines[0].account,'6800');
  assert.deepEqual(expected.lines.map(l=>[l.account,l.amountMinor]),[['6800',6000],['6810',4000],['GST paid',1000]]);
  await h.close();h=undefined;
  await command(source,['export','--output','exports/corrections.rer']);
  const archive=join(source,'exports/corrections.rer'),original=rows(await records(archive));
  await command(destination,['export','--output','exports/empty.rer']);
  const empty=rows(await records(join(destination,'exports/empty.rer')));
  let refusalIndex=0;
  for(const [table,mutate,pick] of [
    ['c_account_corrections',row=>{row.before_account='not-the-submitted-code';}],
    ['c_account_corrections',row=>{row.sequence+=4;}],
    ['c_account_corrections',row=>{row.revision+=2;}],
    ['c_account_corrections',row=>{row.reason=' ';}],
    ['c_account_corrections',row=>{row.allocation_position=1;}],
    ['c_events',row=>{const detail=JSON.parse(row.detail);detail.after='6900';row.detail=JSON.stringify(detail);},row=>row.action==='account-code-corrected'],
    ['c_batch_coding',row=>{row.correction_sequence=0;},row=>row.batch_id===batch.id],
  ]) {
    await writeFile(join(destination,'exports/invalid.rer'),await tampered(archive,table,mutate,pick),{mode:0o600});
    const log=await command(destination,['import','--input','exports/invalid.rer','--yes'],{expected:4});
    assert.match(log,/coaster_account_corrections/);
    const afterPath=`exports/after-refusal-${++refusalIndex}.rer`;
    await command(destination,['export','--output',afterPath]);
    assert.deepEqual(rows(await records(join(destination,afterPath))),empty,'malformed coding evidence writes no destination rows');
  }
  await copyFile(archive,join(destination,'exports/corrections.rer'));
  await command(destination,['import','--input','exports/corrections.rer','--yes']);
  await command(destination,['export','--output','exports/restored.rer']);
  const restored=rows(await records(join(destination,'exports/restored.rer')));
  assert.deepEqual(restored,original,'real CLI restores every portable row and original byte exactly');
  assert.deepEqual(restored.filter(r=>r.table==='c_events').map(r=>r.row).sort((a,b)=>a.seq-b.seq),history);
  h=await harness({existingDatabase:true,persistencePath:join(destination,'.wrangler/state/v3'),databaseId:'local-foundation-only'});
  const actual=await h.get(`batches/${batch.id}`);
  assert.deepEqual(actual.lines,expected.lines);assert.deepEqual(actual.people,expected.people);
  assert.deepEqual((await h.db.prepare('SELECT * FROM c_batch_coding WHERE batch_id=?').bind(originalBatch.id).all()).results,selection,'real CLI restore retains the removed batch selection exactly');
  const csv=await h.send(`/api/coaster/batches/${batch.id}/accounting.csv`,undefined,h.owner);
  assert.equal(csv.status,200);assert.match(csv.text,/"6800"/);assert.match(csv.text,/"6810"/);
  assert.match(csv.text,/"60\.00"/);assert.match(csv.text,/"40\.00"/);assert.match(csv.text,/"10\.00"/);
  const before=(await h.get(`claims/${c.id}`)).accountCoding;
  await h.post(correctionPath(c),correctionBody(await h.get(`claims/${c.id}`)),h.owner,409);
  assert.deepEqual((await h.get(`claims/${c.id}`)).accountCoding,before,'restored frozen correction cannot replay');
  await copyFile(archive,join(evidence,'corrections.rer'));
  await copyFile(join(destination,'exports/restored.rer'),join(evidence,'restored.rer'));
  console.log('Account correction real CLI restore, immutable selection and staged refusal passed');
} finally {await h?.close();await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));}
