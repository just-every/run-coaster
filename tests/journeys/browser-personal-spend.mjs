import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { command, fresh, freePort, start } from '../browser-runtime.mjs'
import { api, session, setUp } from '../browser-journey.mjs'
import { assertAccessible } from '../browser-accessibility.mjs'
import { importPersonalStatement, personalInput } from '../personal-spend-kit.mjs'
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
    const beforeMark=await api(employee.context,server.origin,`claims/${imported.claims[0]}`)
    await api(employee.context,server.origin,`claims/${imported.claims[0]}/receipts`,{version:beforeMark.claim.version,item:beforeMark.items[0].id,name:'synthetic-coaster-1.png',base64:(await readFile('tests/fixtures/receipts/bistro.png')).toString('base64')})
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
    await page.locator('.detail').getByRole('status').filter({hasText:'Your personal company-card balance: AUD 35.80 unpaid'}).waitFor()
    const detail=await api(employee.context,server.origin,`claims/${imported.claims[0]}`)
    assert.equal(detail.claim.total_minor,0)
    assert.deepEqual(detail.personalSpend.balances,[{currency:'AUD',outstandingMinor:3580}])
    const beforeUndo=await api(employee.context,server.origin,'personal-spend')
    const undone=await api(owner.context,server.origin,`statements/${imported.file}/undo`,{})
    assert.equal(undone.removed,1,'the attached original protects its source charge from undo')
    const input=personalInput(category),preview=await api(owner.context,server.origin,['statements','preview'].join('/'),input)
    const reimported=await api(owner.context,server.origin,['statements','commit'].join('/'),{...input,fingerprint:preview.fingerprint})
    const restoredDetail=await api(employee.context,server.origin,`claims/${reimported.claims[0]}`)
    assert.deepEqual(await api(employee.context,server.origin,'personal-spend'),beforeUndo,'undo and reimport retain every original obligation and history identity')
    assert.deepEqual(restoredDetail.items.map(i=>i.personal_spend.outstanding_minor),[1234,2346])
    // Exercise personal classification after the scheduler moved the expense into its own private draft.
    const movedImport=await importPersonalStatement((path,body)=>api(owner.context,server.origin,path,body),category,state.actor.email,{last4:'8841',key:'synthetic-coaster-9',merchant:'synthetic-coaster-9'})
    await api(owner.context,server.origin,'settings/business',{name:'Harbour & Finch Studio',currency:'AUD',timezone:'Australia/Sydney',perDiem:'75.00',receiptThreshold:'20.00'})
    await api(owner.context,server.origin,'settings/auto-submit',{schedule:'daily'})
    await server.scheduled(Date.parse('2026-06-01T00:00:00Z'))
    const submitted=await api(employee.context,server.origin,`claims/${movedImport.claims[0]}`)
    assert.equal(submitted.claim.status,'submitted')
    const heldId=submitted.events.find(e=>e.action==='auto-report-split').detail.heldClaim
    const held=await api(employee.context,server.origin,`claims/${heldId}`)
    assert.equal(held.claim.status,'draft')
    assert.equal((await owner.context.request.get(server.origin+`/api/coaster/claims/${heldId}`)).status(),403)
    await page.goto(server.origin+`/app#/claims/${heldId}`)
    const moved=line('synthetic-coaster-9-2')
    await moved.getByText('Mark personal spend',{exact:true}).click()
    await moved.getByLabel('I owe the company this full posted amount',{exact:true}).check()
    await moved.getByRole('button',{name:'Confirm personal spend',exact:true}).click()
    await moved.getByRole('status').filter({hasText:'You owe AUD 23.46'}).waitFor()
    await page.locator('.detail').getByRole('status').filter({hasText:'Your personal company-card balance: AUD 59.26 unpaid'}).waitFor()
    const privateMarks=(await api(employee.context,server.origin,'personal-spend')).charges.filter(p=>p.amount_minor===2346)
    const privateIds=new Set(privateMarks.map(p=>p.id))
    const privateMark=e=>e.action==='card-charge-marked-personal'&&privateIds.has(e.detail.personalSpend)
    assert.ok(!(await api(owner.context,server.origin,'history?q=card-charge-marked-personal')).lines.some(privateMark))
    assert.ok(!(await api(owner.context,server.origin,`claims/${movedImport.claims[0]}`)).events.some(privateMark))
    const pack=await owner.context.request.get(server.origin+'/api/coaster/audit-pack?from=2026-01-01&to=2026-12-31')
    assert.equal(pack.status(),200)
    const bytes=await pack.body()
    for(const id of privateIds)assert.ok(!bytes.includes(Buffer.from(id)))
    // Assert the changed behavior once; capture the resulting screen at both required widths.
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1100})
      if(width===390) await page.getByRole('main',{name:/Claim CL-/}).waitFor()
      else await page.locator('.detail[role=complementary]').waitFor()
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
    await writeFile(join(evidence,'personal-spend-results.json'),JSON.stringify({head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),widths:[1440,390],balances:[1234,2346,2346],outstandingMinor:5926,reimbursableMinor:0,archive:'exact',malformedRefusals:6},null,2)+'\n')
    console.log('PROBE CARD-002 screens: built native claim at 1440 and 390 -> explicit confirmation, exact unpaid balances, no overflow, readable text, tooltips and accessible controls')
  } finally {
    await employee?.context.close();await owner?.context.close();await browser?.close();await server?.close()
    if(root)await rm(root,{recursive:true,force:true})
  }
}
