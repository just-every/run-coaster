// Focused CAPTURE-001 browser/CLI journey; the full Verify wall imports the same journey.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { command, fresh, freePort, start } from './browser-runtime.mjs'
import { PEOPLE, api, session, setUp } from './browser-journey.mjs'
import { captureJourney, assertRestoredInbox, expandedReasonJourney, cashWindowJourney } from './browser-capture.mjs'
import { captureFiles } from './fixtures/capture-files.mjs'
import { records, rows, tampered, rejectCaptureLifecycleArchives } from './browser-archive.mjs'

const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/capture-proof')
// Verify runs the lifecycle refusals in parallel slices (CAPTURE_REFUSALS=0/3, 1/3, 2/3); a local run takes every case.
const [part, of] = (process.env.CAPTURE_REFUSALS ?? '0/1').split('/').map(Number)
assert.ok(Number.isInteger(part) && Number.isInteger(of) && part >= 0 && part < of, 'CAPTURE_REFUSALS is part/of')
await mkdir(evidence, { recursive: true })
const launch = () => chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] })
let root, second, cash, restoredCash, server, browser
try {
  root = await fresh()
  await command(root, ['install'])
  const port = await freePort()
  await command(root, ['setup', '--owner-email', 'owner@harbourfinch.example', '--port', String(port)])
  server = await start(root, port); browser = await launch()
  const owner = await session(browser, root, server.origin, 'owner', 1440)
  await setUp(owner, server.origin)
  const { files } = await captureFiles(), shots = []
  for (const width of [1440, 390]) await captureJourney(browser, root, server.origin, width, evidence, shots, files)
  await expandedReasonJourney(browser, root, server.origin, owner)
  const employee = await session(browser, root, server.origin, 'employee', 390)
  const captured = (await api(employee.context, server.origin, 'receipt-inbox')).receipts
  await employee.context.close(); await owner.context.close()
  await browser.close(); browser = undefined; await server.close(); server = undefined
  await command(root, ['export', '--output', 'exports/capture.rer'])
  const archive = join(root, 'exports/capture.rer')
  await copyFile(archive, join(evidence, 'capture.rer'))

  second = await fresh()
  await command(second, ['install'])
  const secondPort = await freePort()
  await command(second, ['setup', '--owner-email', 'owner@harbourfinch.example', '--port', String(secondPort)])
  await mkdir(join(second, 'exports'), { recursive: true })
  await command(second, ['export', '--output', 'exports/empty.rer'])
  const empty = rows(await records(join(second, 'exports/empty.rer')))
  await writeFile(join(second, 'exports/inconsistent.rer'), await tampered(archive, 'c_capture_receipts', row => { row.size += 1 }), { mode: 0o600 })
  assert.match(await command(second, ['import', '--input', 'exports/inconsistent.rer', '--yes'], { expected: 4 }), /coaster_capture_bytes/)
  await command(second, ['export', '--output', 'exports/after-refusal.rer'])
  assert.deepEqual(rows(await records(join(second, 'exports/after-refusal.rer'))), empty, 'inconsistent R2/D1 receipt archive writes nothing')
  await rejectCaptureLifecycleArchives(second, archive, { part, of })
  await copyFile(archive, join(second, 'exports/capture.rer'))
  await command(second, ['import', '--input', 'exports/capture.rer', '--yes'])
  await command(second, ['export', '--output', 'exports/restored.rer'])
  assert.deepEqual(rows(await records(join(second, 'exports/restored.rer'))), rows(await records(archive)), 'receipt rows and original R2 payloads survive restore')
  server = await start(second, secondPort); browser = await launch()
  const restored = await session(browser, second, server.origin, 'employee', 390)
  await assertRestoredInbox(restored.context, server.origin, captured)
  await restored.context.close()
  // Existing ERASURE-001 removes new provenance addresses too; preserved originals keep their hashes.
  const erasing = await session(browser, second, server.origin, 'owner', 1440)
  await api(erasing.context, server.origin, 'settings/members', { email: PEOPLE.employee, name: 'Sam Taylor', employee: true, active: false })
  const erased = await api(erasing.context, server.origin, 'settings/members/erase', { email: PEOPLE.employee })
  assert.deepEqual(erased.retained.receiptSha256, [...new Set(captured.map(r => r.sha256))].sort())
  await erasing.context.close(); await browser.close(); browser = undefined; await server.close(); server = undefined
  await command(second, ['export', '--output', 'exports/erased.rer'])
  const erasedRows = rows(await records(join(second, 'exports/erased.rer')))
  for (const row of erasedRows.filter(row => ['c_capture_receipts', 'c_capture_receipt_events', 'c_capture_lifecycle'].includes(row.table)))
    assert.ok(!JSON.stringify(row).includes(PEOPLE.employee), 'erasure removes employee identity from inbox provenance/history')
  const dispositions = erasedRows.filter(row => row.table === 'c_capture_lifecycle')
  assert.equal(dispositions.length, 7, 'three discards, two merges and two expanded-reason discards')
  for (const { row } of dispositions.filter(item => item.row.reason.includes('kept this duplicate'))) {
    assert.ok(row.reason.includes(erased.label) && row.reason.includes(erased.retained.subject))
    assert.ok(!/Sam Taylor|employee@dev\.localhost/i.test(row.reason))
    assert.ok(row.reason.includes('kept this duplicate for the records'))
  }
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
  await cashWindowJourney(browser,cash,server.origin,evidence,shots);
  await browser.close();browser=undefined;await server.close();server=undefined;
  await command(cash,['export','--output','exports/cash.rer']);
  const prepared=join(cash,'exports/cash.rer');
  restoredCash=await fresh();await command(restoredCash,['install']);const restorePort=await freePort();
  await command(restoredCash,['setup','--owner-email','owner@harbourfinch.example','--port',String(restorePort)]);
  await mkdir(join(restoredCash,'exports'),{recursive:true});
  await command(restoredCash,['export','--output','exports/empty.rer']);
  const cashEmpty=rows(await records(join(restoredCash,'exports/empty.rer')));
  for(const [code,table,mutate] of [['cash_window','c_capture_window',row=>{row.days=91}],['cash_draft','c_capture_cash_drafts',row=>{row.expense_date='2000-01-01'}]]){
    await writeFile(join(restoredCash,`exports/${code}.rer`),await tampered(prepared,table,mutate),{mode:0o600});
    assert.match(await command(restoredCash,['import','--input',`exports/${code}.rer`,'--yes'],{expected:4}),new RegExp('coaster_capture_'+code));
    await command(restoredCash,['export','--output','exports/unchanged.rer']);
    assert.deepEqual(rows(await records(join(restoredCash,'exports/unchanged.rer'))),cashEmpty,'refused cash archive writes nothing');
  }
  await copyFile(prepared,join(restoredCash,'exports/cash.rer'));
  await command(restoredCash,['import','--input','exports/cash.rer','--yes']);
  await command(restoredCash,['export','--output','exports/restored.rer']);
  assert.deepEqual(rows(await records(join(restoredCash,'exports/restored.rer'))),rows(await records(prepared)),'cash reservations and originals round trip exactly');
  server=await start(restoredCash,restorePort);
  const replay=await fetch(server.origin+'/cdn-cgi/handler/scheduled?cron='+encodeURIComponent('17 * * * *'));
  assert.equal(replay.status,200,await replay.text());
  await server.close();server=undefined;
  await command(restoredCash,['export','--output','exports/replayed.rer']);
  assert.deepEqual(rows(await records(join(restoredCash,'exports/replayed.rer'))),rows(await records(prepared)),'restore and scheduler replay make no second draft or writes');
  console.log('CAPTURE-004 cash window 1440/390 confirmation, native Cron draft preparation, exact archive restore/replay and atomic malformed-archive refusal passed');
  console.log('CAPTURE-001 focused browser intake at 1440/390, refusal, exact R2 archive round trip, inconsistent archive refusal and erasure passed')
} finally {
  await browser?.close(); await server?.close()
  if (restoredCash) await rm(restoredCash, { recursive: true, force: true })
  if (cash) await rm(cash, { recursive: true, force: true })
  if (second) await rm(second, { recursive: true, force: true })
  if (root) await rm(root, { recursive: true, force: true })
}
