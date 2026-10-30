// Late card evidence runs through the built Worker and the consolidated matching journey.
import assert from 'node:assert/strict'
import {expect} from '@playwright/test'
import {join} from 'node:path'
import {api,session} from '../browser-journey.mjs'

export async function cardChaseScreens(browser,root,server,owner,importRows,evidence) {
  await api(owner.context,server.origin,'settings/reminders',{days:'1,3,5',quietFrom:'20',quietUntil:'8',escalateAfter:''})
  for(const width of [1440,390]) {
    const employee=await session(browser,root,server.origin,'employee',width)
    const manager=await session(browser,root,server.origin,'manager',width)
    try {
      const result=await importRows(`late-evidence-${width}.csv`,'12.00','Client supplies',1,'2026-06-01')
      const id=result.claims[0], detail=()=>api(employee.context,server.origin,`claims/${id}`)
      // The consolidated fixture uses Sydney: 02:17 UTC is outside its quiet hours.
      for(const day of ['2026-06-02','2026-06-04','2026-06-08']) await server.scheduled(new Date(day+'T02:17:00Z').getTime())
      const reminders=d=>d.events.filter(e=>e.action==='reminder-sent'&&e.detail.item.startsWith('card-evidence:'))
      let before=await detail()
      for(const item of before.items) {
        await api(employee.context,server.origin,`claims/${id}/items`,{version:before.claim.version,item:item.id,kind:'receipt',date:item.spent_on,merchant:item.merchant,amount:(item.amount_minor/100).toFixed(2),category:item.allocations[0].category_id,description:'Client supplies',explanation:'Synthetic missing card receipt; employee will append evidence after review'})
        before=await detail()
      }
      const submitted=await api(employee.context,server.origin,`claims/${id}/submit`,{version:before.claim.version})
      await api(manager.context,server.origin,`claims/${id}/decision`,{version:submitted.version,revision:submitted.revision,decision:'approved',acknowledge:true})
      const frozen=(await detail()).revisions, page=employee.page
      await page.goto(server.origin+'/app#/claims/'+id)
      await expect(page.getByRole('button',{name:'Attach card receipt',exact:true})).toBeVisible()
      if(width===1440) {
        assert.equal(reminders(before).length,3)
        await tooltipProof(page,page.getByRole('link',{name:'Back to claims',exact:true}))
      }
      const shot=async name=>{
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
        await page.screenshot({path:join(evidence,`${width}-${name}.png`),fullPage:true})
      }
      await shot('missing-evidence')
      await page.getByLabel('Missing card receipt',{exact:true}).setInputFiles('tests/fixtures/receipts/officeworks.png')
      await page.getByRole('button',{name:'Attach card receipt',exact:true}).click()
      await expect(page.getByRole('link',{name:'Open receipt officeworks.png',exact:true})).toBeVisible()
      if(width===1440) {
        await tooltipProof(page,page.getByRole('link',{name:'Open receipt officeworks.png',exact:true}))
        await api(owner.context,server.origin,'settings/reminders',{days:'1,3,5,6',quietFrom:'20',quietUntil:'8',escalateAfter:''})
        await server.scheduled(new Date('2026-06-09T02:17:00Z').getTime())
        const after=await detail()
        assert.equal(reminders(after).length,3)
        assert.deepEqual(after.revisions,frozen)
        await expect(page.getByText('Receipt added after submission; earlier revisions unchanged.',{exact:true})).toBeVisible()
        await api(owner.context,server.origin,'settings/reminders',{days:'1,3,5',quietFrom:'20',quietUntil:'8',escalateAfter:''})
      }
      await shot('evidence-attached')
    } finally {await employee.context.close();await manager.context.close()}
  }
}

/** The same real tooltip must appear immediately on focus and after its hover delay. */
export async function tooltipProof(page, control) {
  await control.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await control.focus();
  const focused = await control.evaluate(element => {
    const tip = getComputedStyle(element, '::after');
    return { content: tip.content, visibility: tip.visibility, opacity: tip.opacity };
  });
  assert.ok(focused.content && !['none', 'normal', '""'].includes(focused.content), 'focused icon control exposes tooltip text');
  assert.equal(focused.visibility, 'visible', 'tooltip is immediately visible on focus');
  assert.equal(focused.opacity, '1');
  await control.evaluate(element => element.blur());
  await page.mouse.move(0, 0);
  await control.hover();
  assert.equal(await control.evaluate(element => getComputedStyle(element, '::after').visibility), 'hidden', 'hover tooltip waits before appearing');
  await page.waitForTimeout(350);
  assert.equal(await control.evaluate(element => getComputedStyle(element, '::after').visibility), 'visible', 'hover tooltip appears after the short delay');
  await page.mouse.move(0, 0);
}
