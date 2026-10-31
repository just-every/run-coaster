import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { command, fresh, freePort, start } from '../browser-runtime.mjs'
import { api, session, setUp, PEOPLE } from '../browser-journey.mjs'
import { issuerServer } from '../fixtures/feed/server.mjs'
import { restoreFeedRepairs } from '../feed-repairs-archive.mjs'

const n=value=>`synthetic-coaster-${value}`
const ownerAddress='owner'+'@'+'harbourfinch.example'
const mapping={dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',card:'Card',transactionId:'Transaction',sequence:'Sequence',periodStart:'Period start',periodEnd:'Period end'}

/** AGENT-004 native screens: a real SFTP miss, the agent's cited proposal, explicit confirmation, a refused early
 * resolution and resolution by the validated late delivery, at 1440 and 390, then exact CLI restore. */
export async function runFeedRepairJourney() {
  const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/feed-repairs-proof')
  await mkdir(evidence,{recursive:true})
  let root,server,browser,owner,issuer
  try {
    root=await fresh();const port=await freePort()
    await command(root,['setup','--owner-email',ownerAddress,'--port',String(port)])
    server=await start(root,port,{clock:Date.parse('2031-06-30T18:00:00Z')})
    issuer=await issuerServer()
    browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
    owner=await session(browser,root,server.origin,'owner',1440)
    await setUp(owner,server.origin)
    await api(owner.context,server.origin,'settings/business',{name:n(3100),currency:'AUD',timezone:'UTC',receiptThreshold:'10000'})
    const state=await api(owner.context,server.origin,'state'),category=state.categories.find(c=>c.account_code==='6300').id
    await api(owner.context,server.origin,'statements/cards',{issuer:n(3101),last4:'1111',employee:PEOPLE.employee})
    // The connection form itself is the FEED-003 journey's; this journey starts from a connected calendar feed.
    await api(owner.context,server.origin,['feeds','program'].join('/'),{...issuer.credentials,issuer:n(3101),category,intervalMinutes:60,consent:true,mapping,deliveryTime:'09:00',deliveryTimezone:'UTC',graceMinutes:60,expectedFrom:'2031-06-30'})
    await server.scheduled(Date.parse('2031-06-30T09:17:00Z'))
    await server.scheduled(Date.parse('2031-06-30T10:17:00Z'))
    const {page}=owner
    page.setDefaultTimeout(15000)
    const shot=async(name,region)=>{
      for(const width of [1440,390]) {
        await page.setViewportSize({width,height:1000});await region.scrollIntoViewIfNeeded()
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`feed repair overflow ${width}`)
        await region.screenshot({path:join(evidence,`${name}-${width}.png`)})
      }
      await page.setViewportSize({width:1440,height:1000})
    }
    const open=async()=>{
      await page.goto(server.origin+'/app#/settings');await page.reload()
      const repairs=page.getByRole('region',{name:'Scheduled card program feed',exact:true}).getByRole('group',{name:'Repair tasks for '+n(3101),exact:true})
      await repairs.getByRole('heading',{name:'Repair tasks',exact:true}).waitFor()
      return repairs
    }
    let repairs=await open()
    assert.match(await repairs.innerText(),/No repair tasks for this feed/)
    await repairs.getByRole('button',{name:'Prepare repair proposal',exact:true}).click()
    const proposal=repairs.getByRole('group',{name:'Repair proposal',exact:true})
    await proposal.waitFor()
    const text=await proposal.innerText()
    assert.match(text,/Feed repair agent: prepared one repair task for your review/)
    assert.match(text,/Missed delivery 2031-06-30 · deadline with grace 2031-06-30T10:00:00.000Z · health line #1 recorded 2031-06-30T10:17:00.000Z/)
    assert.match(text,/Missing delivery: the last successful directory poll \(2031-06-30T10:17:00.000Z\)/)
    const report=proposal.getByRole('link',{name:'Coverage report for 2031-06-30',exact:true})
    const csv=await owner.context.request.get(new URL(await report.getAttribute('href'),server.origin).href)
    assert.equal(csv.status(),200);assert.match(await csv.text(),/"2031-06-30","uncovered"/,'the cited coverage report shows the uncovered date')
    assert.equal(await proposal.getByRole('link',{name:'Review connection settings',exact:true}).getAttribute('href'),'/app#/settings')
    await shot('repair-proposal',repairs)
    await proposal.getByRole('button',{name:'Open repair tasks',exact:true}).click()
    assert.match(await proposal.getByRole('alert').innerText(),/Confirm opening these repair tasks/,'confirmation is explicit')
    await proposal.getByLabel('Open these tasks for me; no connection, credential or schedule changes',{exact:true}).check()
    await proposal.getByRole('button',{name:'Open repair tasks',exact:true}).click()
    await proposal.waitFor({state:'detached'})
    assert.match(await repairs.innerText(),new RegExp(`Repair task #1 · 2031-06-30 · Open · assigned to ${ownerAddress} · opened .* from the Feed repair agent proposal · deadline 2031-06-30T10:00:00.000Z · health line #1 · missing delivery`))
    await repairs.getByRole('button',{name:'Prepare repair proposal',exact:true}).click()
    await repairs.getByRole('status').filter({hasText:'No new repair proposal: 2031-06-30 is tracked by task #1.'}).waitFor()
    assert.equal(await repairs.getByRole('group',{name:'Repair proposal',exact:true}).count(),0,'repeated analysis proposes no second task')
    await repairs.getByRole('button',{name:'Resolve task #1',exact:true}).click()
    assert.match(await repairs.getByRole('alert').innerText(),/No validated delivery covers 2031-06-30 yet; the repair task stays open/)
    await shot('repair-task-open',repairs)
    issuer.files.set(n(3102)+'.csv','Date,Merchant,Amount,Card,Transaction,Sequence,Period start,Period end\n2031-06-30,'+n(3103)+',31.17,1111,'+n(3104)+','+n(3105)+',2031-06-30,2031-06-30\n')
    await server.scheduled(Date.parse('2031-06-30T11:17:00Z'))
    repairs=await open()
    await repairs.getByRole('button',{name:'Resolve task #1',exact:true}).click()
    await repairs.getByText(new RegExp(`Resolved by ${ownerAddress} at .* with validated delivery ${n(3102)}.csv \\(sequence ${n(3105)}, health line #2\\)`)).waitFor()
    assert.match(await repairs.innerText(),/Repair task #1 · 2031-06-30 · Resolved/)
    assert.equal(await repairs.getByRole('button',{name:'Resolve task #1',exact:true}).count(),0)
    await shot('repair-task-resolved',repairs)
    await page.setViewportSize({width:390,height:1000})
    const menu=page.locator('summary[data-tooltip="Account menu"]');await menu.waitFor();await menu.focus()
    assert.equal(await menu.evaluate(el=>getComputedStyle(el,'::after').visibility),'visible','the icon-only account menu shows its tooltip at once on focus')
    await owner.context.close();owner=undefined;await browser.close();browser=undefined;await server.close();server=undefined
    await command(root,['export','--output','exports/feed-repairs.rer'])
    const archive=join(evidence,'feed-repairs.rer');await copyFile(join(root,'exports/feed-repairs.rer'),archive)
    const requests=issuer.requests.length
    await restoreFeedRepairs(archive,evidence)
    assert.equal(issuer.requests.length,requests,'restored repair evidence makes no provider connection')
    console.log('Feed repair proposal, explicit confirmation, refused and validated resolution shown at 1440 and 390; public CLI restore passed')
  } catch(error) { if(owner) { await owner.page.screenshot({path:join(evidence,'failure.png'),fullPage:true}); console.log((await owner.page.locator('[role=alert]').allTextContents()).join('\n')); } throw error;
  } finally {await owner?.context.close();await browser?.close();await server?.close();await issuer?.close();if(root)await rm(root,{recursive:true,force:true})}
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await runFeedRepairJourney()
