// Native preparation through the built app. Each run owns its runtime and synthetic sessions.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFile, readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { command, fresh, freePort, start } from '../browser-runtime.mjs'
import { records, rows } from '../browser-archive.mjs'
import { importCloseStatement } from '../close-statement-kit.mjs'
import { api, session, setUp } from '../browser-journey.mjs'
import { assertAccessible } from '../browser-accessibility.mjs'

export async function runPreparationJourney() {
const evidence = resolve(process.env.COASTER_EVIDENCE ?? '.cache/agent-preparation-proof')
await mkdir(evidence,{recursive:true})
let root=process.env.COASTER_AGENT_ROOT, origin=process.env.COASTER_AGENT_ORIGIN, server, browser
const results=[], tag=Date.now(), month=process.env.COASTER_AGENT_MONTH ?? '2026-05'
async function shot(page,name,width) {
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`no overflow: ${name} ${width}`)
  await assertAccessible(page,`${name} ${width}`)
  await page.screenshot({path:join(evidence,`${name}-${width}.png`),fullPage:true})
  await page.screenshot({path:join(evidence,`${name}-viewport-${width}.png`)})
}
try {
  if(!origin) {
    root=await fresh()
    const port=await freePort()
    await command(root,['setup','--owner-email','owner@harbourfinch.example','--port',String(port)])
    server=await start(root,port);origin=server.origin
  }
  browser=await chromium.launch({headless:true,...(process.env.COASTER_CHROMIUM?{executablePath:process.env.COASTER_CHROMIUM}:{}),args:['--use-mock-keychain','--password-store=basic','--no-sandbox']})
  const owner=await session(browser,root,origin,'owner',1440)
  if(!process.env.COASTER_AGENT_ROOT) await setUp(owner,origin)
  try {
    for(const width of [1440,390]) {
      const employee=await session(browser,root,origin,'employee',width)
      try {
        const state=await api(employee.context,origin,'state'), cats=Object.fromEntries(state.categories.map(c=>[c.name,c.id]))
        const from=month+(width===1440?'-10':'-20'), to=month+(width===1440?'-11':'-21')
        let c=await api(employee.context,origin,'claims',{title:`Native sources ${width} ${tag}`})
        const file=Buffer.concat([await readFile('tests/fixtures/receipts/bistro.png'),Buffer.from(`synthetic-coaster-${width}-${tag}`)])
        for(let i=0;i<6;i++) {
          let receipt
          if(i===0) {const upload=await api(employee.context,origin,`claims/${c.id}/receipts`,{version:c.version,name:`synthetic-coaster-${width}.png`,base64:file.toString('base64')});c=upload.claim;receipt=upload.receipt}
          c=await api(employee.context,origin,`claims/${c.id}/items`,{version:c.version,kind:'receipt',date:from,merchant:`Native purchase ${width}-${tag}-${i}`,amount:`${i+10}.00`,allocations:[{category:cats['Office supplies']}],receipt,explanation:i?'Receipt unavailable; employee review required':''})
        }
        c=await api(employee.context,origin,`claims/${c.id}/items`,{version:c.version,kind:'mileage',date:from,merchant:'Airport mileage entered by employee',distance:'10',allocations:[{category:cats.Car}]})
        const locations=await api(employee.context,origin,['per-diem','locations'].join('/')+'?method=gsa'), chicago=locations.locations.find(l=>l.label.startsWith('Chicago'))
        c=await api(employee.context,origin,`claims/${c.id}/items`,{version:c.version,kind:'per_diem',date:from,perDiem:{method:'gsa',locationId:chicago.id,endDate:to,component:'mie'},manualRate:'1.5',allocations:[{category:cats.Travel}]})
        const page=employee.page
        await page.goto(origin+'/app#/claims');await page.reload()
        const controls=page.locator('details').filter({has:page.getByText('Prepare a trip or expense review',{exact:true})})
        await controls.locator('summary').click()
        await controls.getByLabel('Proposed trip title',{exact:true}).fill(`Native trip ${width} ${tag}`)
        await controls.getByLabel('Trip start',{exact:true}).fill(from);await controls.getByLabel('Trip end',{exact:true}).fill(to)
        await controls.getByLabel(new RegExp(`Native sources ${width} ${tag}`)).check()
        await controls.getByRole('button',{name:'Prepare trip proposal',exact:true}).click()
        let strip=page.getByRole('region',{name:'Prepared for you'})
        await strip.getByText(`prepared “Native trip ${width} ${tag}” for your review.`).waitFor()
        await strip.locator('summary').click()
        await strip.getByText(/Airport mileage entered/).waitFor()
        await shot(page,'trip-proposal',width)
        const proposed=(await api(employee.context,origin,'state')).proposals.find(p=>p.payload.title===`Native trip ${width} ${tag}`)
        assert.equal(proposed.payload.items.length,8)
        assert.equal(proposed.payload.items.at(-1).perDiem.method,'gsa')
        await strip.getByRole('button',{name:'Accept as draft',exact:true}).click()
        await page.getByRole('heading',{name:`Native trip ${width} ${tag}`,exact:true}).waitFor()
        const trip=(await api(employee.context,origin,'state')).claims.find(c=>c.title===`Native trip ${width} ${tag}`)
        assert.equal((await api(employee.context,origin,`claims/${trip.id}`)).items.length,8)
        await shot(page,'trip-accepted',width)
        await page.goto(origin+'/app#/claims');await page.reload()
        const reviewControls=page.locator('details').filter({has:page.getByText('Prepare a trip or expense review',{exact:true})})
        await reviewControls.locator('summary').click()
        await reviewControls.getByLabel('Claim to review',{exact:true}).selectOption(trip.id)
        await reviewControls.getByRole('button',{name:'Prepare expense review',exact:true}).click()
        strip=page.getByRole('region',{name:'Prepared for you'})
        await strip.getByRole('button',{name:'Accept review plan',exact:true}).waitFor()
        await strip.locator('summary').click()
        await shot(page,'expense-review',width)
        await strip.getByRole('button',{name:'Accept review plan',exact:true}).click()
        await page.getByRole('heading',{name:`Native trip ${width} ${tag}`,exact:true}).waitFor()
        await page.getByRole('button',{name:'Submit for approval',exact:true}).click()
        await page.locator('.detail .badge',{hasText:'Submitted'}).waitFor()
        await shot(page,'trip-submitted',width)
        const ownerDoor=(path,body)=>api(owner.context,origin,path,body)
        const holder=(await api(employee.context,origin,'state')).actor.email
        const statement=await importCloseStatement(ownerDoor,cats['Office supplies'],holder,{last4:width===1440?'8831':'8832',key:`synthetic-coaster-${width}-831`})
        let rec=await statement.open()
        const unknown=await importCloseStatement(ownerDoor,cats['Office supplies'],holder,{last4:width===1440?'8833':'8834',start:null,credit:false,key:`synthetic-coaster-${width}-833`})
        await unknown.open()
        await importCloseStatement(ownerDoor,cats['Office supplies'],holder,{last4:width===1440?'8835':'8836',start:null,end:null,credit:false,key:`synthetic-coaster-${width}-835`})
        await owner.page.setViewportSize({width,height:1000});await owner.page.goto(origin+'/app#/batches');await owner.page.reload()
        const close=owner.page.locator('details').filter({has:owner.page.getByText('Prepare month-end checklist',{exact:true})})
        await close.locator('summary').click()
        await close.getByLabel('Close period start',{exact:true}).fill(month+'-01');await close.getByLabel('Close period end',{exact:true}).fill(month+'-28')
        await close.getByRole('button',{name:'Prepare checklist',exact:true}).click()
        const closeStrip=owner.page.getByRole('region',{name:'Prepared for you'})
        await closeStrip.getByRole('button',{name:'Accept checklist',exact:true}).waitFor();await closeStrip.locator('summary').click()
        await shot(owner.page,'month-end-checklist',width)
        if(width===1440) {
          const displayed=await closeStrip.innerText()
          assert.match(displayed,/2026-04-20 to 2026-06-05/)
          assert.match(displayed,/1 unresolved differences/)
          assert.match(displayed,/Balance difference:.*2\.01/)
          assert.match(displayed,/period boundaries unverified/)
          assert.match(displayed,/imported charges without a reconciliation/)
          assert.match(displayed,/External ledger clearance unverified/)
        }
        rec=await ownerDoor(`statements/reconciliations/${rec.id}/resolve`,{line:2,resolution:'credit',note:'Synthetic refund reviewed'})
        await closeStrip.getByRole('button',{name:'Accept checklist',exact:true}).click()
        await closeStrip.getByRole('alert').filter({hasText:'Close inputs changed'}).waitFor()
        await shot(owner.page,'month-end-stale-review',width)
        const current=(await api(owner.context,origin,'state')).proposals.find(p=>p.payload.preparation==='close')
        await ownerDoor(`proposals/${current.id}/decline`,{})
        await ownerDoor(`statements/reconciliations/${rec.id}/close`,{})
        await owner.page.reload()
        const refreshed=owner.page.locator('details').filter({has:owner.page.getByText('Prepare month-end checklist',{exact:true})})
        await refreshed.locator('summary').click()
        await refreshed.getByLabel('Close period start',{exact:true}).fill(month+'-01');await refreshed.getByLabel('Close period end',{exact:true}).fill(month+'-28')
        await refreshed.getByRole('button',{name:'Prepare checklist',exact:true}).click()
        await closeStrip.getByRole('button',{name:'Accept checklist',exact:true}).waitFor();await closeStrip.locator('summary').click()
        await shot(owner.page,'month-end-native-reconciled',width)
        if(width===1440) {
          const displayed=await closeStrip.innerText()
          assert.match(displayed,/native reconciliation verified/)
          assert.match(displayed,/Native card ledger matches the statement/)
          assert.match(displayed,/Balance difference:.*0\.00/)
          assert.match(displayed,/Resolved/)
          assert.match(displayed,/External ledger clearance unverified/)
        }
        const batchesBefore=(await api(owner.context,origin,'state')).batches.length
        await closeStrip.getByRole('button',{name:'Accept checklist',exact:true}).click()
        await closeStrip.waitFor({state:'detached'})
        assert.equal((await api(owner.context,origin,'state')).batches.length,batchesBefore)
        await page.goto(origin+'/app#/claims');await page.reload()
        await page.getByRole('button',{name:'New claim',exact:true}).click()
        const dismiss=page.getByRole('button',{name:'Close new claim',exact:true})
        await dismiss.focus()
        assert.equal(await dismiss.evaluate(el=>getComputedStyle(el,'::after').visibility),'visible')
        await shot(page,'native-control-tooltip',width)
        await dismiss.click()
        const conversationMessage=width===1440?'Denver client trip, Oct 6–8':'Denver client trip, Oct 16–18'
        const conversationDate=width===1440?'2026-10-06':'2026-10-16'
        const photos=[]
        for(let i=0;i<4;i++) photos.push({date:conversationDate,merchant:`Conversation receipt ${width}-${i}`,amount:`${i+1}.00`,category:cats.Travel,receipt:{name:`synthetic-coaster-${i}.png`,base64:Buffer.concat([file,Buffer.from(`synthetic-coaster-${width}-${i}`)]).toString('base64')}})
        const conversation=await api(employee.context,origin,'conversation',{message:conversationMessage,year:2026,receipts:photos,manualRate:'1.50'})
        await page.goto(origin+'/app#/claims');await page.reload()
        const conversationStrip=page.getByRole('region',{name:'Prepared for you'})
        await conversationStrip.getByText(/What is the business purpose/).waitFor()
        await shot(page,'conversation-proposal',width)
        if(width===1440) {
          assert.equal(conversation.proposal.payload.items.length,5)
          assert.equal(conversation.reviewRequired,true)
        }
        await conversationStrip.getByRole('button',{name:'Accept as draft',exact:true}).click()
        await page.getByRole('heading',{name:conversationMessage,exact:true}).waitFor()
        await shot(page,'conversation-draft',width)
        if(width===1440) {
          const state=await api(employee.context,origin,'state'),prepared=state.claims.find(c=>c.title==='Denver client trip, Oct 6–8')
          const detail=await api(employee.context,origin,`claims/${prepared.id}`)
          assert.equal(detail.claim.status,'draft');assert.equal(detail.receipts.length,4);assert.equal(detail.items.length,5)
        }
        results.push({width,trip:trip.id,items:8,submitted:true,closeAccepted:true})
      } finally {await employee.context.close()}
    }
  } finally {await owner.context.close()}
  await browser.close();browser=null
  if(server) {
    await server.close();server=null
    await command(root,['export','--output','exports/close-evidence.rer'])
    const archive=join(root,'exports/close-evidence.rer'), exported=await records(archive)
    const table=name=>rows(exported).filter(r=>r.table===name).map(r=>r.row)
    assert.ok(table('c_proposals').some(p=>JSON.parse(p.payload).cardEvidence?.statements.some(s=>s.verified)))
    assert.ok(table('c_card_statement_resolutions').length>0)
    assert.ok(table('c_card_ledger').length>0)
    assert.ok(table('c_events').some(e=>e.action==='proposal-accepted'))
    const destination=await fresh()
    try {
      await command(destination,['setup','--owner-email','owner@harbourfinch.example','--port',String(await freePort())])
      await mkdir(join(destination,'exports'),{recursive:true})
      await copyFile(archive,join(destination,'exports/close-evidence.rer'))
      await command(destination,['import','--input','exports/close-evidence.rer','--yes'])
      await command(destination,['export','--output','exports/close-restored.rer'])
      assert.deepEqual(rows(await records(join(destination,'exports/close-restored.rer'))),rows(exported),'real CLI restore preserves every proposal, reconciliation, native ledger and numbered history row exactly')
      await copyFile(archive,join(evidence,'close-evidence.rer'))
    } finally {await rm(destination,{recursive:true,force:true})}
  }
  await writeFile(join(evidence,'native-preparations.json'),JSON.stringify({head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),results},null,2)+'\n')
  console.log('Native preparation screens passed at 1440 and 390')
} finally {
  if(browser)await browser.close()
  if(server)await server.close()
  if(root&&!process.env.COASTER_AGENT_ROOT)await rm(root,{recursive:true,force:true})
}

}
