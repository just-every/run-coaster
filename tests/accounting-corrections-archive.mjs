import assert from 'node:assert/strict';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
    await command(root,['install']);
  }
  h=await harness({persistencePath:join(source,'.wrangler/state/v3'),databaseId:'local-foundation-only'});
  const {t,create,approve}=await correctionClaims(h);
  const cap=(await h.post('allowances',{name:'synthetic-coaster-1',type:'cap',period:'yearly',amount:'500.00',startsOn:'2026-01-01'},t.morgan)).all[0];
  let c=await create('Client materials',t.sam,{allowance:cap.id}),d=await h.get(`claims/${c.id}`);
  c=await h.post(correctionPath(c),correctionBody(d),t.priya);
  c=await approve(c);d=await h.get(`claims/${c.id}`);
  c=await h.post(correctionPath(c),correctionBody(d,{accountCode:'6800'}));
  let peer=await h.post('claims',{title:'Retained purchase'},t.sam);
  peer=await h.post(`claims/${peer.id}/items`,{version:peer.version,kind:'receipt',date:'2026-03-11',merchant:'synthetic-coaster-2',amount:'20.00',category:t.c.office,explanation:'Retained purchase'},t.sam);
  peer=await approve(await h.post(`claims/${peer.id}/submit`,{version:peer.version},t.sam));
  let former=await h.post('batches',{claims:[c.id,peer.id]},t.morgan);
  former=await h.post(`batches/${former.id}/remove`,{version:former.version,claim:c.id},t.morgan);
  await h.post(`batches/${former.id}/approve`,{version:former.version,expectedTotal:2000},t.morgan);
  await h.post(['accounting','desktop','connect'].join('/'),{consent:true,company:'synthetic-coaster-1.QBW'});
  await h.post(['accounting','desktop','sync'].join('/'),{},t.morgan);
  d=await h.get(`claims/${c.id}`);
  c=await h.post(correctionPath(c),correctionBody(d,{accountCode:'6810'}));
  let batch=await h.post('batches',{claims:[c.id]},t.morgan);
  batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:11000},t.morgan);
  const expected=await h.get(`batches/${batch.id}`,t.morgan),history=(await h.db.prepare('SELECT * FROM c_events ORDER BY seq').all()).results;
  assert.equal(expected.lines[0].account,'6810');
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
  const before=(await h.get(`claims/${c.id}`)).accountCoding;
  await h.post(correctionPath(c),correctionBody(await h.get(`claims/${c.id}`)),h.owner,409);
  assert.deepEqual((await h.get(`claims/${c.id}`)).accountCoding,before,'restored frozen correction cannot replay');
  await copyFile(archive,join(evidence,'corrections.rer'));
  await copyFile(join(destination,'exports/restored.rer'),join(evidence,'restored.rer'));
  console.log('Account correction real CLI restore, immutable selection and staged refusal passed');
} finally {await h?.close();await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));}
