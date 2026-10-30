import assert from 'node:assert/strict'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { command, fresh, freePort, start } from './browser-runtime.mjs'
import { records, rows, tampered } from './browser-archive.mjs'

/** Real CLI staging rejects forged coverage before writes; an intact archive retains immutable evidence but no SFTP authority. */
export async function restoreFeedHealth(archive,evidence) {
  const before=rows(await records(archive)),feeds=before.filter(r=>r.table==='c_program_feeds')
  assert.ok(feeds.length && feeds.every(r=>r.row.enabled===0 && r.row.credentials_sealed===null && r.row.lease_id===null),'export strips provider execution authority')
  const health=before.filter(r=>r.table==='c_program_health')
  assert.ok(health.some(r=>r.row.kind==='missed') && health.some(r=>r.row.kind==='covered'),'both sides of the late delivery survive export')
  const root=await fresh();let server
  try {
    const port=await freePort()
    await command(root,['setup','--owner-email','owner'+'@'+'harbourfinch.example','--port',String(port)])
    await mkdir(join(root,'exports'),{recursive:true})
    await command(root,['export','--output','exports/before.rer'])
    const empty=rows(await records(join(root,'exports/before.rer')))
    for(const [name,table,change,pick] of [
      ['coverage','c_program_deliveries',row=>{row.coverage_date='2031-06-28'},row=>row.coverage_date!==null],
      ['history','c_program_health',row=>{row.delivery_date='2031-06-28'},row=>row.kind==='covered'],
      ['calendar','c_program_feeds',row=>{row.delivery_timezone='synthetic-coaster-2099'},()=>true],
    ]) {
      const path=`exports/invalid-${name}.rer`
      await writeFile(join(root,path),await tampered(archive,table,change,pick),{mode:0o600})
      const result=await command(root,['import','--input',path,'--yes'],{expected:4})
      assert.match(result,/coaster_feed_health/)
      await command(root,['export','--output',`exports/after-${name}.rer`])
      assert.deepEqual(rows(await records(join(root,`exports/after-${name}.rer`))),empty,'malformed coverage archive writes no domain records')
    }
    await copyFile(archive,join(root,'exports/source.rer'))
    await command(root,['import','--input','exports/source.rer','--yes'])
    await command(root,['export','--output','exports/restored.rer'])
    await copyFile(join(root,'exports/restored.rer'),join(evidence,'feed-health-restored.rer'))
    assert.deepEqual(rows(await records(join(root,'exports/restored.rer'))),before,'real CLI restore preserves all portable records and every numbered health line exactly')
    server=await start(root,port,{clock:Date.parse('2031-07-02T18:00:00Z')})
    await server.scheduled(Date.parse('2031-07-02T18:00:00Z'))
    await server.close();server=undefined
    await command(root,['export','--output','exports/after-tick.rer'])
    const after=rows(await records(join(root,'exports/after-tick.rer')))
    for(const table of ['c_program_feeds','c_program_deliveries','c_program_health','c_card_charges']) assert.deepEqual(after.filter(r=>r.table===table),before.filter(r=>r.table===table),'restored schedule cannot execute or change program evidence')
    console.log('PROBE FEED-003 restore: real CLI export and import -> identical numbered health evidence, disabled SFTP; malformed coverage -> refusal before writes')
  } finally {await server?.close();await rm(root,{recursive:true,force:true})}
}
