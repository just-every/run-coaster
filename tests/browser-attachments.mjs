import assert from 'node:assert/strict'
import { join } from 'node:path'
import { api, session } from './browser-journey.mjs'

/** CAPTURE-004: use the inbox controls after manually completing the dated cash draft. */
export async function attachmentJourney(browser,root,origin,evidence,shots) {
  for(const width of [1440,390]) {
    const employee=await session(browser,root,origin,'employee',width)
    try {
      const receipt=(await api(employee.context,origin,'receipt-inbox')).receipts.find(r=>r.cashDraft)
      let detail=await api(employee.context,origin,`claims/${receipt.cashDraft.claim_id}`)
      const state=await api(employee.context,origin,'state')
      if(!detail.items.length) {
        await api(employee.context,origin,`claims/${detail.claim.id}/items`,{version:detail.claim.version,kind:'receipt',date:receipt.cashDraft.expense_date,merchant:'Harbour Hotel folio',amount:'64.50',category:state.categories.find(c=>c.active===1).id})
        detail=await api(employee.context,origin,`claims/${detail.claim.id}`)
      }
      await employee.page.goto(origin+'/app#/claims')
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
      await card.getByText(`Detach ${receipt.name}`,{exact:true}).click()
      await card.getByRole('button',{name:'Detach receipt',exact:true}).click()
      await card.getByText(`Attach ${receipt.name} to an expense`,{exact:true}).waitFor()
      assert.equal((await api(employee.context,origin,`claims/${detail.claim.id}`)).items[0].receipt_id,null)
      await card.scrollIntoViewIfNeeded();path=join(evidence,`detached-${width}.png`);await employee.page.screenshot({path});shots.push({path,width})
      if(width===390) {
        await card.getByText(`Attach ${receipt.name} to an expense`,{exact:true}).click()
        await card.getByLabel('Claim',{exact:true}).selectOption(detail.claim.id)
        await card.getByLabel('Expense',{exact:true}).selectOption(detail.items[0].id)
        await card.getByRole('button',{name:'Attach receipt',exact:true}).click()
        await card.getByText(/^Attached to/).waitFor()
      }
      assert.equal(await employee.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      await employee.page.goto(origin+'/docs/claims')
      await employee.page.getByText('Inbox originals keep their 10 MB limit and are stored once.',{exact:false}).waitFor()
      const docPath=join(evidence,`attachment-help-${width}.png`);await employee.page.screenshot({path:docPath,fullPage:true});shots.push({path:docPath,width})
    } finally {await employee.context.close()}
  }
}
