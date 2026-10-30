import assert from 'node:assert/strict'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { command, fresh, freePort } from './browser-runtime.mjs'
import { records, rows, tampered } from './browser-archive.mjs'

/** Real CLI recovery and pre-write refusal of re-sealed financial contradictions. */
export async function personalSpendArchive(root, evidence) {
  await command(root,['export','--output','exports/personal-spend.rer'])
  const archive=join(root,'exports/personal-spend.rer'),source=rows(await records(archive))
  const personal=source.filter(r=>r.table==='c_card_personal_spend').map(r=>r.row)
  assert.equal(personal.length,2)
  assert.deepEqual(personal.map(p=>p.outstanding_minor).sort((a,b)=>a-b),[1234,2346])
  assert.equal(source.filter(r=>r.table==='c_events'&&r.row.action==='card-charge-marked-personal').length,2)
  const destination=await fresh()
  try {
    await command(destination,['setup','--owner-email',['owner','harbourfinch.example'].join('@'),'--port',String(await freePort())])
    await mkdir(join(destination,'exports'),{recursive:true})
    await command(destination,['export','--output','exports/before.rer'])
    const before=rows(await records(join(destination,'exports/before.rer')))
    for(const [name,change] of Object.entries({
      classification:p=>{p.classification='business'},
      balance:p=>{p.outstanding_minor=0},
      principal:p=>{p.amount_minor+=1;p.outstanding_minor+=1},
      identity:p=>{p.source_key='0'.repeat(64)},
      history:p=>{p.event_id='synthetic-coaster-6'},
      attribution:p=>{p.actor_email='synthetic-coaster-7'},
    })) {
      await writeFile(join(destination,'exports/invalid.rer'),await tampered(archive,'c_card_personal_spend',change),{mode:0o600})
      const output=await command(destination,['import','--input','exports/invalid.rer','--yes'],{expected:4})
      assert.match(output,/coaster_personal_spend/,`malformed ${name} is refused by staged validation`)
      await command(destination,['export','--output','exports/after.rer'])
      assert.deepEqual(rows(await records(join(destination,'exports/after.rer'))),before,`malformed ${name} writes nothing`)
    }
    await copyFile(archive,join(destination,'exports/personal-spend.rer'))
    await command(destination,['import','--input','exports/personal-spend.rer','--yes'])
    await command(destination,['export','--output','exports/restored.rer'])
    assert.deepEqual(rows(await records(join(destination,'exports/restored.rer'))),source,'real CLI restore preserves every charge, obligation, receipt, coding and numbered history row exactly')
    await copyFile(archive,join(evidence,'personal-spend.rer'))
    console.log('PROBE CARD-002 archive: real CLI export and restore -> identical financial and history rows; six re-sealed classification, balance, source and attribution corruptions refused before destination writes')
  } finally {await rm(destination,{recursive:true,force:true})}
}
