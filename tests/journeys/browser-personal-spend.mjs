import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { command, fresh, freePort, start } from '../browser-runtime.mjs'
import { api, session, setUp } from '../browser-journey.mjs'
import { assertAccessible } from '../browser-accessibility.mjs'
import { importPersonalStatement } from '../personal-spend-kit.mjs'
import { personalSpendArchive } from '../personal-spend-archive.mjs'

export async function runPersonalSpendJourney() {
  const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/personal-spend-proof')
  await mkdir(evidence,{recursive:true})
  let root,server,browser,owner,employee
  try {
    root=await fresh()
    const port=await freePort()
    await command(root,['setup','--owner-email',['owner','harbourfinch.example'].join('@'),'--port',String(port)])
    server=await start(root,port)
    browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']})
    owner=await session(browser,root,server.origin,'owner',1440)
    await setUp(owner,server.origin)
    employee=await session(browser,root,server.origin,'employee',1440)
    const state=await api(employee.context,server.origin,'state'),category=state.categories.find(c=>c.name==='Office supplies').id
    const imported=await importPersonalStatement((path,body)=>api(owner.context,server.origin,path,body),category,state.actor.email)
    const page=employee.page
    await page.goto(server.origin+`/app#/claims/${imported.claims[0]}`)
    const line=merchant=>page.locator('.line').filter({has:page.locator('strong').filter({hasText:merchant})})
    const first=line('synthetic-coaster-1'),second=line('synthetic-coaster-2')
    await first.getByText('Mark personal spend',{exact:true}).click()
    await first.getByRole('button',{name:'Confirm personal spend',exact:true}).click()
    await first.getByRole('alert').filter({hasText:'Confirm that you owe'}).waitFor()
    await first.getByLabel('I owe the company this full posted amount',{exact:true}).check()
    await first.getByRole('button',{name:'Confirm personal spend',exact:true}).click()
    await first.getByRole('status').filter({hasText:'You owe AUD 12.34'}).waitFor()
    await second.getByText('Mark personal spend',{exact:true}).click()
    await second.getByLabel('I owe the company this full posted amount',{exact:true}).check()
    await second.getByRole('button',{name:'Confirm personal spend',exact:true}).click()
    await second.getByRole('status').filter({hasText:'You owe AUD 23.46'}).waitFor()
    await page.getByRole('status').filter({hasText:'Your personal company-card balance: AUD 35.80 unpaid'}).waitFor()
    const detail=await api(employee.context,server.origin,`claims/${imported.claims[0]}`)
    assert.equal(detail.claim.total_minor,0)
    assert.deepEqual(detail.personalSpend.balances,[{currency:'AUD',outstandingMinor:3580}])
    // Assert the changed behavior once; capture the resulting screen at both required widths.
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1100})
      await assertAccessible(page,`personal spend ${width}`)
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      const small=await page.locator('.detail').evaluate(panel=>[...panel.querySelectorAll('p,button,summary,label')].filter(e=>e.getBoundingClientRect().width&&e.textContent.trim()).filter(e=>parseFloat(getComputedStyle(e).fontSize)<13).map(e=>e.textContent))
      assert.deepEqual(small,[],'changed claim controls keep readable text')
      const icons=await page.locator('.detail').evaluate(panel=>[...panel.querySelectorAll('button,a')].filter(e=>e.querySelector('svg')&&!e.textContent.trim()).filter(e=>!e.dataset.tooltip).map(e=>e.getAttribute('aria-label')))
      assert.deepEqual(icons,[],'icon-only controls on the touched claim screen have tooltips')
      await page.screenshot({path:join(evidence,`personal-spend-${width}.png`),fullPage:true})
      if(width===1440) {
        const close=page.getByRole('link',{name:'Back to claims',exact:true})
        await close.focus()
        assert.equal(await close.getAttribute('data-tooltip'),'Back to claims')
      }
    }
    await employee.context.close();employee=null
    await owner.context.close();owner=null
    await browser.close();browser=null
    await server.close();server=null
    await personalSpendArchive(root,evidence)
    await writeFile(join(evidence,'personal-spend-results.json'),JSON.stringify({head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),widths:[1440,390],balances:[1234,2346],outstandingMinor:3580,reimbursableMinor:0,archive:'exact',malformedRefusals:6},null,2)+'\n')
    console.log('PROBE CARD-002 screens: built native claim at 1440 and 390 -> explicit confirmation, exact unpaid balances, no overflow, readable text, tooltips and accessible controls')
  } finally {
    await employee?.context.close();await owner?.context.close();await browser?.close();await server?.close()
    if(root)await rm(root,{recursive:true,force:true})
  }
}
