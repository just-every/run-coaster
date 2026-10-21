// CAPTURE-004 cash-window proof through native screens, Cron, and the public archive doors.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { command, fresh, freePort, start } from './browser-runtime.mjs'
import { api, session, setUp } from './browser-journey.mjs'
import { cashWindowJourney } from './browser-capture.mjs'
import { records, rows, tampered } from './browser-archive.mjs'
const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/cash-draft-proof')
await mkdir(evidence,{recursive:true})
const launch=()=>chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
let root,cash,restoredCash,server,browser
try {
  root=await fresh();await command(root,['install']);const port=await freePort()
  await command(root,['setup','--owner-email','owner@harbourfinch.example','--port',String(port)])
  server=await start(root,port);browser=await launch()
  const owner=await session(browser,root,server.origin,'owner',1440);await setUp(owner,server.origin);await owner.context.close()
  const employee=await session(browser,root,server.origin,'employee',1440)
  const upload=await employee.context.request.post(server.origin+'/api/coaster/receipt-inbox',{headers:{origin:server.origin},multipart:{source:'upload',file:{name:'cash-receipt.png',mimeType:'image/png',buffer:await readFile('tests/fixtures/receipts/bistro.png')}}})
  assert.equal(upload.status(),200);await employee.context.close()
  await browser.close();browser=undefined;await server.close();server=undefined
  await command(root,['export','--output','exports/original.rer'])
  const archive=join(root,'exports/original.rer'),shots=[]
  // CAPTURE-004: age exactly one active original in a re-sealed, fully validated archive fixture.
  // Restoring through the real import door supplies the elapsed-time precondition without a test-only application clock.
  const snapshot=rows(await records(archive)), closed=new Set(snapshot.filter(r=>r.table==='c_capture_lifecycle').map(r=>r.row.receipt_id));
  const aged=snapshot.find(r=>r.table==='c_capture_receipts'&&!closed.has(r.row.id));
  const old=new Date(Date.now()-3*86400000).toISOString();
  cash=await fresh();await command(cash,['install']);const cashPort=await freePort();
  await command(cash,['setup','--owner-email','owner@harbourfinch.example','--port',String(cashPort)]);
  await mkdir(join(cash,'exports'),{recursive:true});
  await writeFile(join(cash,'exports/aged.rer'),await tampered(archive,'c_capture_receipts',(row,input)=>{
    row.uploaded_at=old;
    for(const item of rows(input).filter(r=>r.table==='c_capture_receipt_events'&&r.row.receipt_id===row.id))item.row.at=old;
  },row=>row.id===aged.row.id),{mode:0o600});
  await command(cash,['import','--input','exports/aged.rer','--yes']);
  server=await start(cash,cashPort);browser=await launch();
  await cashWindowJourney(browser,cash,server.origin,evidence,shots,()=>server.scheduled());
  await browser.close();browser=undefined;await server.close();server=undefined;
  await command(cash,['export','--output','exports/cash.rer']);
  const prepared=join(cash,'exports/cash.rer');
  await copyFile(prepared,join(evidence,'cash.rer'));
  restoredCash=await fresh();await command(restoredCash,['install']);const restorePort=await freePort();
  await command(restoredCash,['setup','--owner-email','owner@harbourfinch.example','--port',String(restorePort)]);
  await mkdir(join(restoredCash,'exports'),{recursive:true});
  await command(restoredCash,['export','--output','exports/empty.rer']);
  const cashEmpty=rows(await records(join(restoredCash,'exports/empty.rer')));
  for(const [code,table,mutate] of [['cash_window','c_capture_window',row=>{row.days=91}],['cash_draft','c_capture_cash_drafts',row=>{row.expense_date='2000-01-01'}]]){
    await writeFile(join(restoredCash,`exports/${code}.rer`),await tampered(prepared,table,mutate),{mode:0o600});
    assert.match(await command(restoredCash,['import','--input',`exports/${code}.rer`,'--yes'],{expected:4}),new RegExp('coaster_capture_'+code));
    await command(restoredCash,['export','--output',`exports/unchanged-${code}.rer`]);
    assert.deepEqual(rows(await records(join(restoredCash,`exports/unchanged-${code}.rer`))),cashEmpty,'refused cash archive writes nothing');
  }
  await copyFile(prepared,join(restoredCash,'exports/cash.rer'));
  await command(restoredCash,['import','--input','exports/cash.rer','--yes']);
  await command(restoredCash,['export','--output','exports/restored.rer']);
  assert.deepEqual(rows(await records(join(restoredCash,'exports/restored.rer'))),rows(await records(prepared)),'cash reservations and originals round trip exactly');
  server=await start(restoredCash,restorePort);
  const replay=await server.scheduled();
  assert.equal(replay.status,200,await replay.text());
  await server.close();server=undefined;
  await command(restoredCash,['export','--output','exports/replayed.rer']);
  assert.deepEqual(rows(await records(join(restoredCash,'exports/replayed.rer'))),rows(await records(prepared)),'restore and scheduler replay make no second draft or writes');
  console.log('CAPTURE-004 cash window 1440/390 confirmation, native Cron draft preparation, exact archive restore/replay and atomic malformed-archive refusal passed');
} finally {
  await browser?.close();await server?.close()
  for(const directory of [restoredCash,cash,root])if(directory)await rm(directory,{recursive:true,force:true})
}
