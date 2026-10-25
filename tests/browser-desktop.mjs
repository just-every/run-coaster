// Native Desktop configuration and sync states; only the external Web Connector is a fixture.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fresh, freePort, start, command } from './browser-runtime.mjs'
import { api, session, setUp, PEOPLE } from './browser-journey.mjs'
import { records, rows } from './browser-archive.mjs'
import { desktopEdge } from './fixtures/desktop.mjs'

const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/desktop-proof')
await mkdir(evidence,{recursive:true})
let root=process.env.COASTER_DESKTOP_ROOT,origin=process.env.COASTER_DESKTOP_ORIGIN,server,browser,restored
const external=!!root
try {
  if(!root){root=await fresh();execFileSync('git',['config','user.name','Run Edit Run fleet'],{cwd:root});execFileSync('git',['config','user.email','fleet@runeditrun.com'],{cwd:root});server=await start(root,await freePort());origin=server.origin}
  browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
  let configured=false
  for(const width of [1440,390]) {
    const owner=await session(browser,root,origin,'owner',width)
    const employee=await session(browser,root,origin,'employee',width),manager=await session(browser,root,origin,'manager',width),finance=await session(browser,root,origin,'finance',width)
    try {
      if(!configured){await setUp(owner,origin);configured=true}
      const {page}=owner,base=['accounting','desktop'].join('/'),edge=await desktopEdge({origin,mf:{dispatchFetch:fetch}})
      await page.goto(origin+'/app#/settings')
      const section=page.getByRole('region',{name:'QuickBooks Desktop',exact:true})
      await section.getByLabel('QuickBooks company file path',{exact:true}).fill('C:\\synthetic-coaster-1.QBW')
      await section.getByLabel('I authorize hourly accounting reads and posting to this company',{exact:true}).check()
      await section.getByRole('button',{name:'Create Desktop connector',exact:true}).click()
      const password=await section.getByLabel('Connector password',{exact:true}).inputValue()
      const config=await owner.context.request.get(origin+'/api/coaster/'+base+'/configuration')
      const configuration=await config.text();assert.match(configuration,/<Scheduler>/)
      const shot=async name=>{
        await section.scrollIntoViewIfNeeded()
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Desktop overflow ${width}`)
        await section.screenshot({path:join(evidence,`${name}-${width}.png`),mask:[section.getByLabel('Connector password',{exact:true})]})
      }
      await shot('desktop-configuration')
      await edge.open(configuration,password);await edge.drain()
      await page.reload();await section.getByText(/7 accounting choices pulled/).waitFor()
      await section.getByText('Accounting catalog',{exact:true}).click()
      await shot('desktop-catalog')
      const map=async(name,id)=>{
        await section.getByLabel('Mapping name',{exact:true}).fill(name)
        await section.getByLabel('QuickBooks entry',{exact:true}).selectOption(id)
        await section.getByRole('button',{name:'Save Desktop mapping',exact:true}).click()
        await section.getByText('Mapping saved. Retry the affected failed request.',{exact:true}).waitFor()
      }
      await map('account:6300','Account|synthetic-coaster-1');await map('payable','Account|synthetic-coaster-2');await map('vendor:'+PEOPLE.employee,'Vendor|synthetic-coaster-6')
      const category=(await api(owner.context,origin,'state')).categories.find(c=>c.account_code==='6300').id
      let claim=await api(employee.context,origin,'claims',{title:'synthetic-coaster-'+width})
      claim=await api(employee.context,origin,`claims/${claim.id}/items`,{version:claim.version,kind:'receipt',date:'2026-09-10',merchant:'synthetic-coaster-'+width,amount:width===1440?'41.00':'39.00',category,explanation:'synthetic-coaster-101'})
      claim=await api(employee.context,origin,`claims/${claim.id}/submit`,{version:claim.version})
      claim=await api(manager.context,origin,`claims/${claim.id}/decision`,{version:claim.version,revision:claim.revision,decision:'approved',acknowledge:true})
      let batch=await api(finance.context,origin,'batches',{claims:[claim.id]})
      batch=await api(finance.context,origin,`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:batch.total_minor})
      await section.getByRole('button',{name:'Queue Desktop sync',exact:true}).click()
      await edge.open(configuration,password);await edge.drain('BillAdd')
      await page.reload();await section.getByText(/Account is inactive/).waitFor();await shot('desktop-failure')
      const retry=section.getByRole('button',{name:'Retry failed request',exact:true});assert.equal(await retry.count(),1);await retry.click()
      await edge.open(configuration,password);await edge.drain()
      await page.reload();await section.getByText(/BillAdd · succeeded/).last().waitFor();await shot('desktop-completed')
      const menu=page.locator('summary[data-tooltip="Account menu"]');await menu.focus()
      assert.equal(await menu.evaluate(el=>getComputedStyle(el,'::after').visibility),'visible')
      await page.screenshot({path:join(evidence,`desktop-tooltip-${width}.png`)})
      assert.equal(edge.sent.filter(r=>r.kind==='BillAdd').length,2)
      await section.getByLabel('Stop this connector and keep its posting history',{exact:true}).check()
      await section.getByRole('button',{name:'Disconnect Desktop',exact:true}).click()
    } finally {await Promise.all([owner.context.close(),employee.context.close(),manager.context.close(),finance.context.close()])}
  }
  // Actual public CLI round trip, with connector credentials absent and every numbered audit line identical.
  await command(root,['export','--output',join(evidence,'desktop.rer')])
  const before=rows(await records(join(evidence,'desktop.rer')))
  assert.equal(before.some(r=>['c_qbd_connection','c_qbd_tickets'].includes(r.table)),false)
  restored=await fresh();execFileSync('git',['config','user.name','Run Edit Run fleet'],{cwd:restored});execFileSync('git',['config','user.email','fleet@runeditrun.com'],{cwd:restored})
  await command(restored,['import','--input',join(evidence,'desktop.rer'),'--yes'])
  await command(restored,['export','--output',join(evidence,'desktop-restored.rer')])
  assert.deepEqual(rows(await records(join(evidence,'desktop-restored.rer'))),before)
  console.log('Desktop configuration, catalog, mapping, posting error and isolated retry at 1440 and 390; exact CLI archive round trip passed')
} finally {
  if(browser)await browser.close()
  if(server)await server.close()
  if(restored)await rm(restored,{recursive:true,force:true})
  if(root&&!external)await rm(root,{recursive:true,force:true})
}
