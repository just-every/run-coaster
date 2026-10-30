import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { command, fresh, freePort, start } from '../browser-runtime.mjs'
import { api, session, setUp, PEOPLE } from '../browser-journey.mjs'
import { issuerServer } from '../fixtures/feed/server.mjs'
import { restoreFeedHealth } from '../feed-health-archive.mjs'

const n=value=>`synthetic-coaster-${value}`
const endpoint=['feeds','program'].join('/')
const ownerAddress='owner'+'@'+'harbourfinch.example'

export async function runFeedHealthJourney() {
  const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/feed-health-proof')
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
    await api(owner.context,server.origin,'settings/business',{name:n(2100),currency:'AUD',timezone:'UTC',receiptThreshold:'10000'})
    const state=await api(owner.context,server.origin,'state'),category=state.categories.find(c=>c.account_code==='6300').id
    await api(owner.context,server.origin,'statements/cards',{issuer:n(2101),last4:'1111',employee:PEOPLE.employee})
    const {page}=owner
    page.setDefaultTimeout(15000)
    const shot=async(name,region)=>{
      for(const width of [1440,390]) {
        await page.setViewportSize({width,height:1000});await region.scrollIntoViewIfNeeded()
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`feed health overflow ${width}`)
        await region.screenshot({path:join(evidence,`${name}-${width}.png`)})
      }
      await page.setViewportSize({width:1440,height:1000})
    }
    await page.goto(server.origin+'/app#/settings');await page.reload()
    const section=page.getByRole('region',{name:'Scheduled card program feed',exact:true})
    await section.getByText('Connect an SFTP program feed',{exact:true}).click()
    const fields={issuer:n(2101),host:issuer.credentials.host,port:String(issuer.credentials.port),username:issuer.credentials.username,hostKeyFingerprint:issuer.credentials.hostKeyFingerprint,directory:issuer.credentials.directory,category,intervalMinutes:'1440',deliveryTime:'09:00',deliveryTimezone:'UTC',graceMinutes:'60',expectedFrom:'2031-06-29',postedDate:'Date',transactionId:'Transaction',description:'Merchant',amount:'Amount',card:'Card',sequence:'Sequence',periodStart:'Period start',periodEnd:'Period end'}
    for(const [name,value] of Object.entries(fields)) {const input=section.locator(`[name="${name}"]`);if(name==='category')await input.selectOption(value);else await input.fill(value)}
    await section.getByLabel('Issuer-authorized private key file',{exact:true}).setInputFiles({name:n(2102)+'.pem',mimeType:'application/x-pem-file',buffer:Buffer.from(issuer.credentials.privateKey)})
    await section.getByLabel('I authorize scheduled read-only connections and imports from this issuer directory',{exact:true}).check()
    await shot('delivery-calendar',section)
    console.log('Feed browser: submitting calendar')
    await section.getByRole('button',{name:'Connect program feed',exact:true}).click()
    await section.getByRole('heading',{name:n(2101),exact:true}).waitFor()
    console.log('Feed browser: calendar connected, polling empty directory')
    await server.scheduled(Date.parse('2031-06-29T09:17:00Z'))
    console.log('Feed browser: first poll complete')
    const requestsAfterPoll=issuer.requests.length
    await server.scheduled(Date.parse('2031-06-29T10:17:00Z'))
    assert.equal(issuer.requests.length,requestsAfterPoll,'the hourly health check preserves the daily SFTP polling cadence')
    console.log('Feed browser: miss recorded')
    await page.reload()
    await section.getByRole('heading',{name:n(2101),exact:true}).waitFor()
    assert.match(await section.innerText(),/Last successful directory poll: 2031-06-29T09:17:00.000Z/)
    assert.match(await section.innerText(),/Last accepted file: None/)
    assert.match(await section.innerText(),/Missed delivery dates: 2031-06-29/)
    await section.getByText('Health history for '+n(2101),{exact:true}).click()
    assert.match(await section.innerText(),/#1 · 2031-06-29 · missed/)
    await shot('missed-delivery',section)
    const runReport=async()=>{
      await page.goto(server.origin+'/app#/settings');await page.reload()
      const reports=page.getByRole('region',{name:'Reports',exact:true}),form=reports.getByRole('button',{name:'Run report',exact:true}).locator('xpath=ancestor::form')
      await form.getByLabel('Report',{exact:true}).selectOption('feed-coverage')
      await form.getByLabel('From',{exact:true}).fill('2031-06-29');await form.getByLabel('Until',{exact:true}).fill('2031-06-30')
      await form.getByRole('button',{name:'Run report',exact:true}).click()
      await reports.getByRole('heading',{name:'Feed coverage · 2031-06-29 to 2031-06-30',exact:true}).waitFor()
      return reports
    }
    console.log('Feed browser: missed screen checked')
    let reports=await runReport()
    assert.match(await reports.locator('tbody').innerText(),/2031-06-29\s+uncovered/)
    await shot('uncovered-report',reports)
    issuer.files.set(n(2103)+'.csv','Date,Merchant,Amount,Card,Transaction,Sequence,Period start,Period end\n2031-06-28,'+n(2104)+',23.17,1111,'+n(2105)+','+n(2106)+',2031-06-29,2031-06-29\n')
    console.log('Feed browser: reading late file')
    await server.scheduled(Date.parse('2031-06-30T11:17:00Z'))
    console.log('Feed browser: late file received')
    await page.goto(server.origin+'/app#/settings');await page.reload()
    await section.getByRole('heading',{name:n(2101),exact:true}).waitFor()
    assert.match(await section.innerText(),/Last accepted file: synthetic-coaster-2103.csv/)
    assert.match(await section.innerText(),/Next expected file: 2031-07-01/)
    assert.match(await section.innerText(),/Missed delivery dates: 2031-06-30/)
    await section.getByText('Health history for '+n(2101),{exact:true}).click()
    assert.match(await section.innerText(),/2031-06-29 · covered/)
    await shot('late-delivery',section)
    await page.setViewportSize({width:390,height:1000})
    const menu=page.locator('summary[data-tooltip="Account menu"]');await menu.waitFor();await page.keyboard.press('Tab');await menu.focus()
    assert.equal(await menu.evaluate(el=>getComputedStyle(el,'::after').visibility),'visible','icon-only account menu has an immediate focus tooltip')
    await page.screenshot({path:join(evidence,'account-tooltip-390.png')})
    await page.setViewportSize({width:1440,height:1000})
    reports=await runReport()
    assert.match(await reports.locator('tbody').innerText(),/2031-06-29\s+covered/)
    assert.match(await reports.locator('tbody').innerText(),/2031-06-30\s+uncovered/)
    const response=await owner.context.request.get(new URL(await reports.getByRole('link',{name:'Download Feed coverage CSV',exact:true}).getAttribute('href'),server.origin).href)
    assert.equal(response.status(),200);assert.match(await response.text(),/"2031-06-29","covered"/)
    const form=reports.getByRole('button',{name:'Schedule report',exact:true}).locator('xpath=ancestor::form')
    await form.getByLabel('Report',{exact:true}).selectOption('feed-coverage')
    await form.getByLabel('Recipients',{exact:true}).fill(PEOPLE.finance)
    await form.getByRole('button',{name:'Schedule report',exact:true}).click()
    await reports.getByText(/Feed coverage · Last US business day/).waitFor()
    await shot('covered-report-and-schedule',reports)
    await owner.context.close();owner=undefined;await browser.close();browser=undefined;await server.close();server=undefined
    await command(root,['export','--output','exports/feed-health.rer'])
    const archive=join(evidence,'feed-health.rer');await copyFile(join(root,'exports/feed-health.rer'),archive)
    const requestsBeforeRestore=issuer.requests.length
    await restoreFeedHealth(archive,evidence)
    assert.equal(issuer.requests.length,requestsBeforeRestore,'restored feeds make no provider connection')
    assert.ok(issuer.requests.some(r=>r.operation==='read'),'browser health states came from an actual SFTP delivery')
    console.log('Feed calendar, missed and late delivery, coverage report and schedule shown at 1440 and 390; public CLI restore passed')
  } catch(error) { if(owner) { await owner.page.screenshot({path:join(evidence,'failure.png'),fullPage:true}); console.log((await owner.page.locator('[role=alert]').allTextContents()).join('\n')); } throw error;
  } finally {await owner?.context.close();await browser?.close();await server?.close();await issuer?.close();if(root)await rm(root,{recursive:true,force:true})}
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await runFeedHealthJourney()
