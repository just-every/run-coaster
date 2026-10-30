// One correction flow at desktop width; the same changed screens are recorded once at phone width.
import assert from 'node:assert/strict'
import {chromium} from '@playwright/test'
import {mkdir,readFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {fresh,freePort,start,command} from '../browser-runtime.mjs'
import {api,session,setUp,PEOPLE} from '../browser-journey.mjs'
import {accountingCorrectionsArchive} from '../accounting-corrections-archive.mjs'

export async function runAccountingCorrectionJourney(){
 const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/accounting-corrections-proof')
 await mkdir(evidence,{recursive:true})
 const ownerEmail=['owner','harbourfinch.example'].join(String.fromCharCode(64))
 let root,server,browser
 try{
  root=await fresh();const port=await freePort()
  await command(root,['setup','--owner-email',ownerEmail,'--port',String(port)])
  server=await start(root,port)
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
  const owner=await session(browser,root,server.origin,'owner',1440);await setUp(owner,server.origin)
  const employee=await session(browser,root,server.origin,'employee',1440),manager=await session(browser,root,server.origin,'manager',1440)
  const state=await api(owner.context,server.origin,'state'),category=state.categories.find(c=>c.account_code==='6500').id
  const cap=(await api(owner.context,server.origin,'allowances',{name:'synthetic-coaster-cap',type:'cap',period:'yearly',amount:'30.00',startsOn:'2026-01-01'})).all.find(a=>a.name==='synthetic-coaster-cap')
  async function claim(n,capped=false){
   let c=await api(employee.context,server.origin,'claims',{title:`synthetic-coaster-${n}`})
   const bytes=Buffer.concat([await readFile('tests/fixtures/receipts/officeworks.png'),Buffer.from(c.id)])
   const upload=await api(employee.context,server.origin,`claims/${c.id}/receipts`,{version:c.version,name:`synthetic-coaster-${n}.png`,base64:bytes.toString('base64')})
   c=await api(employee.context,server.origin,`claims/${c.id}/items`,{version:upload.claim.version,kind:'receipt',date:'2026-06-10',merchant:`synthetic-coaster-${n}`,amount:'42.00',receipt:upload.receipt,category,explanation:'Client purchase',...(capped?{allowance:cap.id}:{})})
   return api(employee.context,server.origin,`claims/${c.id}/submit`,{version:c.version})
  }
  let c=await claim(1,true);const original=await api(owner.context,server.origin,`claims/${c.id}`),page=owner.page
  await page.goto(server.origin+`/app#/claims/${c.id}`)
  const section=page.getByLabel('Account coding for synthetic-coaster-1',{exact:true})
  await section.getByText('Correct account',{exact:true}).click()
  await section.getByLabel('New account code',{exact:true}).fill('6970')
  await section.getByLabel('Correction reason',{exact:true}).fill('Client work belongs in the project account')
  await section.getByRole('button',{name:'Save account correction',exact:true}).click()
  await section.getByText('Account 6970 · submitted 6500',{exact:true}).waitFor()
  let detail=await api(owner.context,server.origin,`claims/${c.id}`);c=detail.claim
  assert.deepEqual(detail.revisions,original.revisions);assert.equal(detail.items[0].amount_minor,3000);assert.equal(detail.items[0].claimed_minor,4200)
  await section.getByText('Correct account',{exact:true}).click()
  await section.getByLabel('New account code',{exact:true}).fill('6971')
  await section.getByLabel('Correction reason',{exact:true}).fill('Reviewed final account')
  await section.getByRole('button',{name:'Save account correction',exact:true}).click()
  await section.getByText('Account 6971 · submitted 6500',{exact:true}).waitFor()
  await section.getByText('Account correction history',{exact:true}).click()
  assert.match(await section.textContent(),/6500 → 6970/);assert.match(await section.textContent(),/6970 → 6971/)
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:1000});await section.scrollIntoViewIfNeeded()
   await section.screenshot({path:join(evidence,`account-correction-${width}.png`)})
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  }
  detail=await api(owner.context,server.origin,`claims/${c.id}`);c=detail.claim
  c=await api(manager.context,server.origin,`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved',acknowledge:true})
  let second=await claim(2);second=await api(manager.context,server.origin,`claims/${second.id}/decision`,{version:second.version,revision:second.revision,decision:'approved',acknowledge:true})
  let batch=await api(owner.context,server.origin,'batches',{claims:[c.id,second.id]})
  batch=await api(owner.context,server.origin,`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:7200})
  await page.setViewportSize({width:1440,height:1000});await page.goto(server.origin+`/app#/batches/${batch.id}`)
  const row=page.getByRole('row').filter({has:page.getByRole('link',{name:'CL-'+String(c.number).padStart(4,'0'),exact:true})})
  await row.getByRole('button',{name:'Take out',exact:true}).click()
  await page.getByText('The previous review is retained in history. Review the remaining claims again before release or export.',{exact:true}).waitFor()
  const removed=await api(owner.context,server.origin,`batches/${batch.id}`)
  assert.equal(removed.batch.total_minor,4200);assert.equal(removed.batch.status,'draft');assert.ok(removed.events.some(e=>e.action==='batch-approved'))
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:1000})
   await page.screenshot({path:join(evidence,`reviewed-batch-removal-${width}.png`),fullPage:true})
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  }
  // The existing account menu and panel-close controls keep their focus tooltip.
  const close=page.locator('[data-tooltip="Back to list"]')
  if(await close.count()){await close.focus();assert.equal(await close.evaluate(el=>getComputedStyle(el,'::after').visibility),'visible')}
  c=(await api(owner.context,server.origin,`claims/${c.id}`)).claim
  const corrected=await api(owner.context,server.origin,`claims/${c.id}`)
  c=await api(owner.context,server.origin,`claims/${c.id}/coding-corrections`,{version:c.version,revision:c.revision,item:corrected.items[0].id,allocation:0,sequence:2,accountCode:'6972',reason:'Correction after reviewed removal'})
  let later=await api(owner.context,server.origin,'batches',{claims:[c.id]})
  later=await api(owner.context,server.origin,`batches/${later.id}/approve`,{version:later.version,expectedTotal:3000})
  const file=await owner.context.request.get(server.origin+`/api/coaster/batches/${later.id}/accounting.csv`)
  assert.equal(file.status(),200);assert.match(await file.text(),/"6972"/)
  await Promise.all([owner.context.close(),employee.context.close(),manager.context.close()]);await browser.close();browser=undefined
  await server.close();server=undefined
  await accountingCorrectionsArchive(root,evidence,ownerEmail)
  console.log('PROBE ACCT-008 UI: native correction form and reviewed-batch removal -> effective and original coding, capped amount, history and renewed review shown at 1440 and 390')
 }finally{if(browser)await browser.close();if(server)await server.close();if(root)await rm(root,{recursive:true,force:true})}
}
