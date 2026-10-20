// MOVE-005: the owner inventories three open reports and reads undo at both widths.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { api, session, PEOPLE } from './browser-journey.mjs'

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
 assert.equal(report.feedReconciled,false);assert.equal(job.carriedReports,0)
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


// MOVE-005: real carry API, native approval/payment, and linked inventory at both widths.
export async function cutoverCarryJourney(browser, root, owner, origin, width, evidence, shots) {
 const employee=await session(browser,root,origin,'employee',width)
 const manager=await session(browser,root,origin,'manager',width)
 const finance=await session(browser,root,origin,'finance',width)
 try {
 const lines=(await readFile('tests/fixtures/expensify-cutover.csv','utf8')).trim().split('\n')
 const csv=[lines[0],lines[1]].join('\n').replaceAll('CUT-',`CARRY-${width}-`).replace('Harbour stationery',`Harbour stationery ${width}`).replace('sam@harbourfinch.example',PEOPLE.employee).replace('priya@harbourfinch.example',PEOPLE.manager)
 const input={csv,filename:`carry-${width}.csv`,mapping:{date:'YYYY-MM-DD',statuses:{Open:'open'}}}
 const preview=await api(owner.context,origin,'import/preview',input)
 const imported=await api(owner.context,origin,'import/commit',{...input,fingerprint:preview.fingerprint})
 const category=(await api(owner.context,origin,'state')).categories.find(c=>c.name==='Office supplies').id
 let claim=await api(employee.context,origin,'import/carry',{report:`CARRY-${width}-1`,categories:{[`CARRY-${width}-T1`]:category}})
 assert.equal(claim.status,'draft');assert.equal(claim.total_minor,2400)
 await employee.page.goto(origin+`/app#/claims/${claim.id}`);await employee.page.reload()
 await employee.page.getByRole('heading',{name:'September supplies',exact:true}).waitFor()
 assert.equal(await employee.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 let path=join(evidence,`cutover-carried-draft-${width}.jpg`)
 await employee.page.screenshot({path,fullPage:true});shots.push({screen:'cutover-carried-draft',viewport:width,path})
 const detail=await api(employee.context,origin,`claims/${claim.id}`),item=detail.items[0]
 claim=await api(employee.context,origin,`claims/${claim.id}/items`,{version:claim.version,item:item.id,kind:'receipt',date:item.spent_on,merchant:item.merchant,amount:'24.00',category,explanation:'Carried from Expensify; original retained for review'})
 claim=await api(employee.context,origin,`claims/${claim.id}/submit`,{version:claim.version})
 claim=await api(manager.context,origin,`claims/${claim.id}/decision`,{version:claim.version,revision:claim.revision,decision:'approved',acknowledge:true})
 let batch=await api(finance.context,origin,'batches',{claims:[claim.id]})
 batch=await api(finance.context,origin,`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:2400})
 batch=await api(finance.context,origin,`batches/${batch.id}/release`,{version:batch.version})
 await api(finance.context,origin,`batches/${batch.id}/paid`,{version:batch.version,reference:`CUTOVER-${width}`,paidOn:new Date().toISOString().slice(0,10)})
 assert.equal((await api(employee.context,origin,`claims/${claim.id}`)).claim.status,'reimbursed')
 await api(owner.context,origin,'import/undo',{id:imported.job.id,mappingVersion:preview.mappingVersion})
 await owner.page.setViewportSize({width,height:1000});await owner.page.goto(origin+'/app#/move-in');await owner.page.reload()
 const section=owner.page.getByRole('region',{name:'Expensify cutover report',exact:true})
 const job=(await api(owner.context,origin,'import/cutover')).imports.find(j=>j.id===imported.job.id)
 assert.equal(job.carriedReports,1);assert.ok(job.records.every(r=>r.carriedClaim===claim.id))
 const block=section.getByRole('listitem').filter({has:owner.page.getByText('0 open source reports · 1 report carried · Import undone',{exact:true})}).first()
 await block.getByText('Every source record',{exact:true}).click()
 await block.getByText(/^Carried into native claim/).first().waitFor()
 assert.equal(await owner.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`MOVE-005 carried inventory fits ${width}`)
 path=join(evidence,`cutover-carried-undone-${width}.jpg`)
 await section.screenshot({path});shots.push({screen:'cutover-carried-undone',viewport:width,path})
 return {width,claim:claim.id,totalMinor:2400}
 } finally {await employee.context.close();await manager.context.close();await finance.context.close()}
}
