// MOVE-005: the owner inventories three open reports and reads undo at both widths.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { api } from './browser-journey.mjs'

export async function cutoverJourney(owner, origin, width, evidence, shots) {
 const {page,context}=owner
 await page.setViewportSize({width,height:1000});await page.goto(origin+'/app#/move-in');await page.reload()
 const section=page.getByRole('region',{name:'Expensify cutover report',exact:true})
 const shot=async name=>{const path=join(evidence,`${name}-${width}.jpg`);await section.screenshot({path,type:'jpeg',quality:85});shots.push({screen:name,viewport:width,path})}
 const csv=(await readFile('tests/fixtures/expensify-cutover.csv','utf8')).replaceAll('CUT-',`CUT-${width}-`)
 await page.getByLabel('Expensify CSV',{exact:true}).setInputFiles({name:`september-${width}.csv`,mimeType:'text/csv',buffer:Buffer.from(csv)})
 await page.getByRole('button',{name:'Preview',exact:true}).click()
 await page.getByRole('heading',{name:'Preview · nothing imported yet',exact:true}).waitFor()
 // Source status text is explicitly mapped; nothing becomes a native approval.
 for(const [source,status] of [['Open','open'],['Submitted','submitted'],['Approved','approved'],['Reimbursed','reimbursed']])
  await page.getByLabel(`Expensify “${source}” becomes`,{exact:true}).selectOption(status)
 await page.getByRole('button',{name:'Preview again with this mapping',exact:true}).click()
 await page.getByRole('button',{name:'Import 4 reports',exact:true}).click()
 await section.getByText('3 open source reports · 0 reports carried · Import completed',{exact:true}).waitFor()
 const report=await api(context,origin,'import/cutover'),job=report.imports.find(j=>j.records.some(r=>r.artifact===`september-${width}.csv`))
 assert.equal(job.counts.source,9);assert.equal(job.openReports,3)
 assert.equal(report.feedReconciled,false);assert.equal(report.openItemsCarried,false)
 const block=section.getByRole('listitem').filter({has:page.getByText('3 open source reports · 0 reports carried · Import completed',{exact:true})}).first()
 await block.getByText('Every source record',{exact:true}).click()
 await section.getByText(`Expense CUT-${width}-T1: Harbour stationery`,{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`MOVE-005 no overflow at ${width}`)
 await shot('cutover-imported')
 await page.getByRole('region',{name:'Imports',exact:true}).getByRole('button',{name:'Undo import',exact:true}).first().click()
 await section.getByText('0 open source reports · 0 reports carried · Import undone',{exact:true}).first().waitFor()
 assert.equal((await api(context,origin,'import/cutover')).imports.find(j=>j.id===job.id).counts.leftBehind,9)
 await shot('cutover-undone')
}
