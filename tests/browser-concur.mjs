// MOVE-002: the owner uses the Concur form, reviewed mapping and undo at both widths.
import assert from 'node:assert/strict'
import { expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { api } from './browser-journey.mjs'

export async function concurJourney(owner, origin, width, evidence, shots) {
 const {page,context}=owner
 await page.setViewportSize({width,height:1000});await page.goto(origin+'/app#/move-in')
 const section=page.getByRole('region',{name:'SAP Concur',exact:true})
 const employee=crypto.randomUUID(),manager=crypto.randomUUID(),category=crypto.randomUUID()
 const data={members:[{key:employee,email:`concur-${width}@example.com`,name:`Jordan Concur ${width}`},{key:manager,email:`concur-manager-${width}@example.com`,name:`Dana Concur ${width}`,manager:true}],categories:[{key:category,name:`Business meals ${width} · ${category.slice(0,6)}`,accountCode:'6310',taxCode:'NONE'}],chains:[{key:crypto.randomUUID(),employee,steps:[manager]}],policies:[{key:crypto.randomUUID(),name:'US client meals',rules:[{kind:'per-expense-limit',category,limit:'70'}]}]}
 const shot=async name=>{const path=join(evidence,`${name}-${width}.jpg`);await section.screenshot({path,type:'jpeg',quality:85});shots.push({screen:name,viewport:width,path})}
 await section.getByLabel('Concur configuration JSON',{exact:true}).setInputFiles({name:'concur-configuration.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))})
 await section.getByRole('button',{name:'Preview Concur configuration',exact:true}).click()
 await section.getByText('Configuration preview · nothing imported yet',{exact:true}).waitFor()
 const before=await api(context,origin,'state');assert.ok(!before.members.some(m=>m.email===data.members[0].email),'MOVE-002 preview never creates people')
 await shot('concur-configuration-preview')
 await section.getByRole('button',{name:'Import Concur configuration',exact:true}).click()
 await section.getByRole('status').filter({hasText:'Concur configuration imported'}).waitFor()
 const state=await api(context,origin,'state'),person=state.members.find(m=>m.email===data.members[0].email),cat=state.categories.find(c=>c.name===data.categories[0].name)
 assert.equal(person.active,0);assert.ok(cat)
 await section.getByLabel('Concur accounting extract',{exact:true}).setInputFiles({name:'concur-sae-v4.txt',mimeType:'text/plain',buffer:Buffer.from((await readFile('tests/fixtures/concur-sae-v4.txt','utf8')).replaceAll('|USD|',`|${before.business.currency}|`))})
 await section.getByLabel('Concur receipt ZIP with image index',{exact:true}).setInputFiles({name:'concur-receipts.zip',mimeType:'application/zip',buffer:await readFile('tests/fixtures/concur-receipts.zip')})
 await section.getByRole('button',{name:'Preview Concur history',exact:true}).click()
 await section.getByLabel('Employee EMP-17',{exact:true}).selectOption(person.email)
 await section.getByLabel('Expense type Business Meals',{exact:true}).selectOption(cat.id)
 await section.getByRole('button',{name:'Preview Concur history',exact:true}).click()
 await section.getByRole('button',{name:'Import Concur history',exact:true}).waitFor()
 await expect(section.getByRole('button',{name:'Import Concur history',exact:true})).toBeEnabled()
 assert.match(await section.innerText(),/85\.00/)
 await shot('concur-history-preview')
 await section.getByRole('button',{name:'Import Concur history',exact:true}).click()
 await section.getByRole('status').filter({hasText:'Concur history imported'}).waitFor()
 const imported=(await api(context,origin,'import')).history.filter(h=>h.source==='concur'&&h.kind==='expense')
 assert.equal(imported.length,2);assert.equal(imported.reduce((n,i)=>n+i.amountMinor,0),8500)
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`MOVE-002 no overflow at ${width}`)
 await shot('concur-imported')
 const jobs=page.getByRole('region',{name:'Imports',exact:true})
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/coaster/import/undo')&&r.status()===200),jobs.getByRole('button',{name:'Undo import',exact:true}).first().click()])
 await page.getByRole('status').filter({hasText:'Import undone'}).waitFor()
 assert.equal((await api(context,origin,'import')).history.filter(h=>h.source==='concur').length,0)
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/coaster/import/undo')&&r.status()===200),jobs.getByRole('button',{name:'Undo import',exact:true}).first().click()])
 assert.ok(!(await api(context,origin,'state')).members.some(m=>m.email===person.email),'MOVE-002 undo removes untouched imported people')
 await shot('concur-undone')
}

// MOVE-001 uses the same native owner review and undo doors as other incumbents.
export async function expensifyJourney(owner,origin,width,evidence,shots){
 const {page,context}=owner;
 await page.setViewportSize({width,height:1000});await page.goto(origin+'/app#/move-in');
 // CSV-only history remains a public door when no image files are selected.
 const prior=await api(context,origin,'state'),legacy=page.getByRole('region',{name:'Import a file',exact:true}),legacyId=`synthetic-coaster-legacy-${width}`;
 const legacyCsv=`reportID,reportName,accountEmail,status,transactionID,created,merchant,amount,currency,receiptFilename\n${legacyId},Legacy report ${width},${legacyId}@example.test,Closed,${legacyId}-expense,2026-09-01,Legacy meal,25.00,${prior.business.currency},legacy.png\n`;
 await legacy.getByLabel('Expensify receipt files',{exact:true}).setInputFiles([]);
 await legacy.getByLabel('Expensify CSV',{exact:true}).setInputFiles({name:`${legacyId}.csv`,mimeType:'text/csv',buffer:Buffer.from(legacyCsv)});
 await legacy.getByRole('button',{name:'Preview',exact:true}).click();await expect(legacy.getByRole('button',{name:'Import 1 report',exact:true})).toBeEnabled();
 await legacy.getByRole('button',{name:'Import 1 report',exact:true}).click();await page.getByRole('region',{name:'Imported history',exact:true}).getByRole('cell',{name:`Legacy report ${width}`,exact:true}).waitFor();
 assert.ok((await api(context,origin,'import')).history.some(h=>h.reportId===legacyId));
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/coaster/import/undo')&&r.status()===200),page.getByRole('region',{name:'Imports',exact:true}).getByRole('button',{name:'Undo import',exact:true}).first().click()]);
 assert.ok(!(await api(context,origin,'import')).history.some(h=>h.reportId===legacyId));await page.reload();
 const section=page.getByRole('region',{name:'Expensify configuration',exact:true});
 const employee=crypto.randomUUID(),manager=crypto.randomUUID(),category=crypto.randomUUID(),tag=crypto.randomUUID(),card=crypto.randomUUID();
 const data={members:[{key:employee,email:`synthetic-coaster-${width}@example.com`,name:`Expensify employee ${width}`},{key:manager,email:`synthetic-coaster-manager-${width}@example.com`,name:`Expensify manager ${width}`,manager:true}],categories:[{key:category,name:`Expensify meals ${width}`,accountCode:'6310',taxCode:'NONE'}],chains:[{key:crypto.randomUUID(),employee,steps:[manager]}],tags:[{key:tag,name:`Client synthetic-coaster-${width}`}],cards:[{key:card,issuer:`Synthetic Coaster ${width}`,last4:String(width).padStart(4,'0'),employee}],policies:[{key:crypto.randomUUID(),name:'US expense limit',rules:[{kind:'per-expense-limit',category,limit:'70.00'}]}],unmappedSetting:true};
 const capture=async(name,target=section)=>{const path=join(evidence,`${name}-${width}.jpg`);await target.screenshot({path,type:'jpeg',quality:85});shots.push({screen:name,viewport:width,path});};
 await section.getByLabel('Expensify policy JSON',{exact:true}).setInputFiles({name:'expensify-policy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
 await section.getByRole('button',{name:'Preview configuration',exact:true}).click();await section.getByText('Preview · nothing imported yet',{exact:true}).waitFor();
 assert.ok(!(await api(context,origin,'state')).members.some(m=>m.email===data.members[0].email));
 await expect(section.getByText(/unmappedSetting kept/)).toBeVisible();await capture('expensify-configuration-preview');
 await section.getByRole('button',{name:'Import configuration',exact:true}).click();await section.getByRole('status').waitFor();
 const state=await api(context,origin,'state');assert.equal(state.members.find(m=>m.email===data.members[0].email).active,0);
 const csv=`reportID,reportName,accountEmail,status,transactionID,created,merchant,amount,currency,receiptFilename\nsynthetic-coaster-${width},Expensify report ${width},${data.members[0].email},Closed,synthetic-coaster-expense-${width},2026-10-01,Bistro,60.00,${state.business.currency},meal.png\n`;
 const file=page.getByRole('region',{name:'Import a file',exact:true});
 await file.getByLabel('Expensify CSV',{exact:true}).setInputFiles({name:'expensify.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
 await file.getByLabel('Expensify receipt files',{exact:true}).setInputFiles({name:'meal.png',mimeType:'image/png',buffer:await readFile('tests/fixtures/receipts/bistro.png')});
 await file.getByRole('button',{name:'Preview',exact:true}).click();await file.getByText('Preview · nothing imported yet',{exact:true}).waitFor();
 await expect(file.getByText(/1 reports · 1 expenses · 1 receipts/)).toBeVisible();await capture('expensify-receipt-preview',file);
 await file.getByRole('button',{name:'Import 1 report',exact:true}).click();await file.getByRole('status').filter({hasText:'Imported 1 report'}).waitFor();
 const history=page.getByRole('region',{name:'Imported history',exact:true});await history.getByText('Bistro · meal.png · receipt retained',{exact:true}).waitFor();await capture('expensify-imported-receipt',history);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`MOVE-001 no overflow at ${width}`);
 const jobs=page.getByRole('region',{name:'Imports',exact:true});
 for(let i=0;i<2;i++){
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/coaster/import/undo')&&r.status()===200),jobs.getByRole('button',{name:'Undo import',exact:true}).first().click()]);
  await page.getByRole('status').filter({hasText:'Import undone'}).waitFor();
 }
 assert.ok(!(await api(context,origin,'state')).members.some(m=>m.email===data.members[0].email));
 assert.ok(!(await api(context,origin,'import')).history.some(h=>h.reportId===`synthetic-coaster-${width}`));await capture('expensify-undone',jobs);
}
