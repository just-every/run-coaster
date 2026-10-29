import assert from 'node:assert/strict'
import { join } from 'node:path'
import { api, session } from '../browser-journey.mjs'

/** CAPTURE-004: use the inbox controls after manually completing the dated cash draft. */
export async function attachmentJourney(browser,root,origin,evidence,shots,siteOrigin) {
  for(const width of [1440,390]) {
    const employee=await session(browser,root,origin,'employee',width)
    try {
      const receipt=(await api(employee.context,origin,'receipt-inbox')).receipts.find(r=>r.cashDraft)
      let detail=await api(employee.context,origin,`claims/${receipt.cashDraft.claim_id}`)
      const state=await api(employee.context,origin,'state')
      if(!detail.items.length) {
        await employee.page.goto(origin+`/app#/claims/${detail.claim.id}`)
        await employee.page.getByRole('button',{name:'Add expense',exact:true}).click()
        const form=employee.page.locator('form.item-form')
        await form.getByLabel('Date',{exact:true}).fill(receipt.cashDraft.expense_date)
        await form.getByLabel('Merchant',{exact:true}).fill('Harbour View Bistro')
        await form.getByLabel('Amount',{exact:true}).fill('64.50')
        await form.getByLabel('Category',{exact:true}).selectOption(state.categories.find(c=>c.name==='Meals'&&c.active===1).id)
        await form.getByRole('button',{name:'Add expense',exact:true}).click()
        await form.waitFor({state:'detached'})
        detail=await api(employee.context,origin,`claims/${detail.claim.id}`)
        // Returning to the inbox keeps the same app and proves the claim choices update after editing.
        await employee.page.getByRole('link',{name:'Back to claims',exact:true}).click()
      } else await employee.page.goto(origin+'/app#/claims')
      const card=employee.page.getByRole('region',{name:'Receipt inbox',exact:true}).locator('.receipt-inbox-list > li').filter({has:employee.page.getByRole('link',{name:receipt.name,exact:true})})
      await card.getByText(`Attach ${receipt.name} to an expense`,{exact:true}).click()
      await card.getByLabel('Claim',{exact:true}).selectOption(detail.claim.id)
      await card.getByLabel('Expense',{exact:true}).selectOption(detail.items[0].id)
      await card.getByText('Approvers and finance can see this receipt once the expense is submitted.',{exact:true}).waitFor()
      await card.scrollIntoViewIfNeeded()
      let path=join(evidence,`attach-notice-${width}.png`);await employee.page.screenshot({path});shots.push({path,width})
      await card.getByRole('button',{name:'Attach receipt',exact:true}).click()
      await card.getByText(/^Attached to/).waitFor()
      detail=await api(employee.context,origin,`claims/${detail.claim.id}`)
      assert.equal(detail.items[0].receipt_sha256,receipt.sha256)
      const downloaded=await employee.context.request.get(origin+`/api/coaster/receipts/${detail.items[0].receipt_id}`)
      assert.equal(downloaded.status(),200);assert.equal((await downloaded.body()).length,receipt.size)
      await card.scrollIntoViewIfNeeded();path=join(evidence,`attached-${width}.png`);await employee.page.screenshot({path});shots.push({path,width})
      await card.getByText(/^Attached to/).getByRole('link').click()
      await employee.page.getByRole('link',{name:`Open receipt ${receipt.name}`,exact:true}).waitFor()
      path=join(evidence,`claim-receipt-${width}.png`);await employee.page.screenshot({path,fullPage:true});shots.push({path,width})
      await employee.page.getByRole('link',{name:'Back to claims',exact:true}).click()
      await card.getByText(`Detach ${receipt.name}`,{exact:true}).click()
      await card.getByRole('button',{name:'Detach receipt',exact:true}).click()
      await card.getByText(`Attach ${receipt.name} to an expense`,{exact:true}).waitFor()
      assert.equal((await api(employee.context,origin,`claims/${detail.claim.id}`)).items[0].receipt_id,null)
      await card.getByText('Private receipt history',{exact:true}).click()
      await card.scrollIntoViewIfNeeded();path=join(evidence,`detached-${width}.png`);await card.screenshot({path});shots.push({path,width})
      if(width===390) {
        await card.getByText(`Attach ${receipt.name} to an expense`,{exact:true}).click()
        await card.getByLabel('Claim',{exact:true}).selectOption(detail.claim.id)
        await card.getByLabel('Expense',{exact:true}).selectOption(detail.items[0].id)
        await card.getByRole('button',{name:'Attach receipt',exact:true}).click()
        await card.getByText(/^Attached to/).waitFor()
      }
      assert.equal(await employee.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      await employee.page.goto(siteOrigin+'/docs/claims')
      await employee.page.getByText('Inbox originals keep their 10 MB limit and are stored once.',{exact:false}).waitFor()
      const docPath=join(evidence,`attachment-help-${width}.png`);await employee.page.screenshot({path:docPath,fullPage:true});shots.push({path:docPath,width})
    } finally {await employee.context.close()}
  }
}

/** Native cash-window confirmation and scheduled draft screens at both widths. */
export async function cashWindowJourney(browser, root, origin, evidence, shots, schedule) {
  for (const width of [1440,390]) {
    const owner=await session(browser,root,origin,'owner',width)
    try {
      await owner.page.goto(origin+'/app#/settings')
      const section=owner.page.getByRole('region',{name:'Cash receipt draft window',exact:true})
      await section.getByLabel('Cash draft window (days)',{exact:true}).fill('1')
      await section.getByRole('button',{name:'Review cash draft window',exact:true}).click()
      await section.getByText('1 existing older unattached receipts will become eligible. Receipts are checked again before each draft opens.',{exact:true}).waitFor()
      await section.scrollIntoViewIfNeeded()
      assert.equal(await owner.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      let path=join(evidence,`cash-window-confirm-${width}.png`)
      await owner.page.screenshot({path});shots.push({screen:'CAPTURE-004 finance confirms older-original count',viewport:width,path})
      const saved=owner.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/coaster/settings/cash-draft-window'&&response.request().method()==='POST')
      await section.getByRole('button',{name:'Confirm cash draft window',exact:true}).click()
      assert.equal((await saved).status(),200,'the setting is committed before the scheduled delivery')
      await section.getByText('Current window: 1 days',{exact:true}).waitFor()
    } finally {await owner.context.close()}
  }
  // Vite's documented local scheduled-handler door calls the unchanged production hourly handler.
  assert.equal((await fetch(origin+'/cdn-cgi/handler/scheduled')).status,404,'the app listener keeps runtime triggers private')
  const scheduled=await schedule()
  assert.equal(scheduled.status,200,await scheduled.text())
  for(const width of [1440,390]) {
    const employee=await session(browser,root,origin,'employee',width)
    try {
      const originals=(await api(employee.context,origin,'receipt-inbox')).receipts
      const drafts=originals.filter(r=>r.cashDraft)
      assert.equal(drafts.length,1)
      const detail=await api(employee.context,origin,`claims/${drafts[0].cashDraft.claim_id}`)
      assert.equal(detail.claim.status,'draft');assert.deepEqual(detail.items,[])
      await employee.page.goto(origin+'/app#/claims')
      const pending=employee.page.getByText(/Cash draft · needs details · expense date/)
      await pending.waitFor();await pending.scrollIntoViewIfNeeded()
      assert.equal(await employee.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      const path=join(evidence,`cash-draft-inbox-${width}.png`)
      await employee.page.screenshot({path});shots.push({screen:'CAPTURE-004 private needs-details draft',viewport:width,path})
      await pending.getByRole('link',{name:'Open draft claim'}).click()
      await employee.page.getByRole('button',{name:'Add expense',exact:true}).waitFor()
    } finally {await employee.context.close()}
  }
}
