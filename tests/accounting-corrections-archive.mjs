import assert from 'node:assert/strict'
import {copyFile,mkdir,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fresh,freePort,command} from './browser-runtime.mjs'
import {records,rows,tampered} from './browser-archive.mjs'

/** Real export and empty-installation restore; staged malformed chains and selections write nothing. */
export async function accountingCorrectionsArchive(root,evidence,ownerEmail){
 const archive=join(evidence,'accounting-corrections.rer'),exportName='exports/accounting-corrections.rer'
 await command(root,['export','--output',exportName]);await copyFile(join(root,exportName),archive)
 const before=rows(await records(archive)),corrections=before.filter(r=>r.table==='c_coding_corrections')
 assert.ok(corrections.length>=2);assert.ok(before.some(r=>r.table==='c_batch_coding'&&r.row.correction_id))
 const history=before.filter(r=>r.table==='c_events'&&r.row.action==='account-code-corrected')
 assert.equal(history.length,corrections.length);assert.ok(history.every(r=>r.row.seq>0&&r.row.actor_email&&r.row.at))
 let restored
 try{
  restored=await fresh();await command(restored,['setup','--owner-email',ownerEmail,'--port',String(await freePort())])
  await mkdir(join(restored,'exports'),{recursive:true})
  await command(restored,['export','--output','exports/before.rer'])
  const empty=rows(await records(join(restored,'exports/before.rer')))
  for(const [name,table,change] of [
   ['revision','c_coding_corrections',r=>r.revision+=100],
   ['chain','c_coding_corrections',r=>r.before_code='synthetic-coaster-wrong'],
   ['allocation','c_coding_corrections',r=>r.allocation+=100],
   ['selection','c_batch_coding',r=>r.account_code='synthetic-coaster-wrong'],
  ]){
   await writeFile(join(restored,'exports/malformed.rer'),await tampered(archive,table,change),{mode:0o600})
   const refused=await command(restored,['import','--input','exports/malformed.rer','--yes'],{expected:4})
   assert.match(refused,/coaster_accounting_corrections/,name)
   await command(restored,['export','--output',`exports/after-${name}.rer`])
   assert.deepEqual(rows(await records(join(restored,`exports/after-${name}.rer`))),empty,`${name} refused before any write`)
  }
  await copyFile(archive,join(restored,'exports/valid.rer'))
  await command(restored,['import','--input','exports/valid.rer','--yes'])
  await command(restored,['export','--output','exports/restored.rer'])
  const after=rows(await records(join(restored,'exports/restored.rer')))
  assert.deepEqual(after,before,'every portable record, correction chain, original snapshot and numbered history field restores exactly')
  console.log('PROBE ACCT-008 archive: real CLI export and empty restore -> exact portable rows; malformed revision, allocation, chain and frozen selection -> refused with no writes')
 }finally{if(restored)await rm(restored,{recursive:true,force:true})}
}
