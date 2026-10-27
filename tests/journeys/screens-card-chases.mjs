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
      for(const day of ['2026-06-02','2026-06-04','2026-06-08']) await server.scheduled(new Date(day+'T14:17:00Z').getTime())
      const reminders=d=>d.events.filter(e=>e.action==='reminder-sent'&&e.detail.item.startsWith('card-evidence:'))
      const before=await detail()
      const submitted=await api(employee.context,server.origin,`claims/${id}/submit`,{version:before.claim.version})
      await api(manager.context,server.origin,`claims/${id}/decision`,{version:submitted.version,revision:submitted.revision,decision:'approved',acknowledge:true})
      const frozen=(await detail()).revisions, page=employee.page
      await page.goto(server.origin+'/app#/claims/'+id)
      await expect(page.getByRole('button',{name:'Attach card receipt',exact:true})).toBeVisible()
      if(width===1440) assert.equal(reminders(before).length,3)
      const shot=async name=>{
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
        await page.screenshot({path:join(evidence,`${width}-${name}.png`),fullPage:true})
      }
      await shot('missing-evidence')
      await page.getByLabel('Missing card receipt',{exact:true}).setInputFiles('tests/fixtures/receipts/officeworks.png')
      await page.getByRole('button',{name:'Attach card receipt',exact:true}).click()
      await expect(page.getByRole('link',{name:'Open receipt officeworks.png',exact:true})).toBeVisible()
      if(width===1440) {
        await api(owner.context,server.origin,'settings/reminders',{days:'1,3,5,6',quietFrom:'20',quietUntil:'8',escalateAfter:''})
        await server.scheduled(new Date('2026-06-09T14:17:00Z').getTime())
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
