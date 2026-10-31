import assert from 'node:assert/strict'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { command, fresh, freePort, start } from './browser-runtime.mjs'
import { records, rows, tampered } from './browser-archive.mjs'

/** Real CLI staging refuses forged repair evidence before writes; an intact archive restores every numbered task and
 * resolution exactly while the restored feed keeps no SFTP authority. */
export async function restoreFeedRepairs(archive,evidence) {
  const before=rows(await records(archive)),pick=table=>before.filter(r=>r.table===table).map(r=>r.row)
  assert.ok(pick('c_program_feeds').every(row=>row.enabled===0&&!Object.hasOwn(row,'credentials_sealed')&&row.lease_id===null),'export strips provider execution authority')
  assert.deepEqual(pick('c_feed_repair_proposals').map(row=>row.status),['accepted'])
  assert.equal(pick('c_feed_repair_tasks').length,1);assert.equal(pick('c_feed_repair_resolutions').length,1)
  const missed=pick('c_program_health').find(row=>row.kind==='missed')
  const root=await fresh();let server
  try {
    const port=await freePort()
    await command(root,['setup','--owner-email','owner'+'@'+'harbourfinch.example','--port',String(port)])
    await mkdir(join(root,'exports'),{recursive:true})
    await command(root,['export','--output','exports/before.rer'])
    const empty=rows(await records(join(root,'exports/before.rer')))
    for(const [name,table,change] of [
      ['task-date','c_feed_repair_tasks',row=>{row.delivery_date='2031-06-29'}],
      ['task-source','c_feed_repair_tasks',row=>{row.missed_seq=pick('c_program_health').find(h=>h.kind==='covered').seq}],
      ['resolution','c_feed_repair_resolutions',row=>{row.covered_seq=missed.seq}],
      ['proposal','c_feed_repair_proposals',row=>{const e=JSON.parse(row.evidence);e.findings[0].deadline='2031-06-30T09:00:00.000Z';row.evidence=JSON.stringify(e)}],
    ]) {
      const path=`exports/invalid-${name}.rer`
      await writeFile(join(root,path),await tampered(archive,table,change),{mode:0o600})
      assert.match(await command(root,['import','--input',path,'--yes'],{expected:4}),/coaster_feed_repairs/)
      await command(root,['export','--output',`exports/after-${name}.rer`])
      assert.deepEqual(rows(await records(join(root,`exports/after-${name}.rer`))),empty,'malformed repair evidence writes no domain records')
    }
    await copyFile(archive,join(root,'exports/source.rer'))
    await command(root,['import','--input','exports/source.rer','--yes'])
    await command(root,['export','--output','exports/restored.rer'])
    await copyFile(join(root,'exports/restored.rer'),join(evidence,'feed-repairs-restored.rer'))
    assert.deepEqual(rows(await records(join(root,'exports/restored.rer'))),before,'real CLI restore keeps every proposal, numbered task, resolution and history line exactly')
    server=await start(root,port,{clock:Date.parse('2031-07-02T18:00:00Z')})
    await server.scheduled(Date.parse('2031-07-02T18:00:00Z'))
    await server.close();server=undefined
    await command(root,['export','--output','exports/after-tick.rer'])
    const after=rows(await records(join(root,'exports/after-tick.rer')))
    for(const table of ['c_program_feeds','c_program_deliveries','c_program_health','c_feed_repair_proposals','c_feed_repair_tasks','c_feed_repair_resolutions','c_card_charges'])
      assert.deepEqual(after.filter(r=>r.table===table),before.filter(r=>r.table===table),'a restored installation cannot execute the feed or change repair evidence')
    console.log('PROBE AGENT-004 restore: real CLI export and import -> identical proposal, numbered task, resolution and history, disabled SFTP; forged task, source, resolution and proposal -> refusal before writes')
  } finally {await server?.close();await rm(root,{recursive:true,force:true})}
}
