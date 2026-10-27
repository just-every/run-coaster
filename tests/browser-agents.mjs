// Native preparation through the built app. Each run owns its runtime and synthetic sessions.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fresh, freePort, start } from './browser-runtime.mjs'
import { api, session, setUp } from './browser-journey.mjs'
import { assertAccessible } from './browser-accessibility.mjs'

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
    execFileSync('git',['config','user.name','Run Edit Run fleet'],{cwd:root})
    execFileSync('git',['config','user.email','fleet@runeditrun.com'],{cwd:root})
    server=await start(root,await freePort());origin=server.origin
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
        await owner.page.setViewportSize({width,height:1000});await owner.page.goto(origin+'/app#/batches');await owner.page.reload()
        const close=owner.page.locator('details').filter({has:owner.page.getByText('Prepare month-end checklist',{exact:true})})
        await close.locator('summary').click()
        await close.getByLabel('Close period start',{exact:true}).fill(month+'-01');await close.getByLabel('Close period end',{exact:true}).fill(month+'-28')
        await close.getByRole('button',{name:'Prepare checklist',exact:true}).click()
        const closeStrip=owner.page.getByRole('region',{name:'Prepared for you'})
        await closeStrip.getByRole('button',{name:'Accept checklist',exact:true}).waitFor();await closeStrip.locator('summary').click()
        await shot(owner.page,'month-end-checklist',width)
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
  await writeFile(join(evidence,'native-preparations.json'),JSON.stringify({head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),results},null,2)+'\n')
  console.log('Native preparation screens passed at 1440 and 390')
} finally {
  if(browser)await browser.close()
  if(server)await server.close()
  if(root&&!process.env.COASTER_AGENT_ROOT)await rm(root,{recursive:true,force:true})
}
