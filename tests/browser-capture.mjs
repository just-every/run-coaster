// The one phone smoke: take a receipt through intake, private provenance and
// reasoned discard. Bulk formats, matching and custody run in the HTTP journey.
import assert from 'node:assert/strict'
import { assertAccessible } from './browser-accessibility.mjs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { api, session } from './browser-journey.mjs'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')

export async function captureJourney(browser,root,origin,width,evidence,shots){
  const employee=await session(browser,root,origin,'employee',width),{page,context}=employee
  try{
    await page.goto(origin+'/app#/claims')
    const inbox=page.getByRole('region',{name:'Receipt inbox',exact:true}),bytes=await readFile('tests/fixtures/receipts/bistro.png'),name='phone-bistro.png'
    await inbox.getByLabel('Photograph a receipt',{exact:true}).setInputFiles({name,mimeType:'image/png',buffer:bytes})
    const link=inbox.getByRole('link',{name,exact:true});await link.waitFor()
    const original=(await api(context,origin,'receipt-inbox')).receipts.find(r=>r.name===name)
    assert.equal(original.source,'camera');assert.equal(original.sha256,hash(bytes))
    assert.deepEqual(await (await context.request.get(origin+original.downloadUrl)).body(),bytes)
    const active=inbox.getByRole('region',{name:'Active receipts',exact:true}),row=active.locator('.receipt-inbox-list > li').filter({has:page.getByRole('link',{name,exact:true})})
    await row.getByText('File provenance',{exact:true}).click()
    await row.scrollIntoViewIfNeeded()
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'the receipt inbox fits the phone')
    await assertAccessible(page,'phone receipt');
    let path=join(evidence,'capture-provenance-390.png');await page.screenshot({path,fullPage:true});shots.push({screen:'phone receipt provenance',viewport:width,path})
    const reason='Sam Taylor (EMPLOYEE@DEV.LOCALHOST) kept this duplicate for the records.'
    await row.locator('summary').filter({hasText:`Discard ${name}`}).click()
    await row.getByLabel('Reason',{exact:true}).fill(reason)
    await row.getByRole('button',{name:'Discard receipt',exact:true}).click()
    const discarded=inbox.getByRole('region',{name:'Discarded receipts',exact:true})
    await discarded.getByRole('link',{name,exact:true}).waitFor()
    assert.equal(await active.getByRole('link',{name,exact:true}).count(),0)
    const kept=(await api(context,origin,'receipt-inbox')).receipts.find(r=>r.id===original.id)
    assert.equal(kept.disposition,'discarded');assert.equal(kept.lifecycle[0].reason,reason)
    assert.deepEqual(await (await context.request.get(origin+kept.downloadUrl)).body(),bytes)
    await discarded.scrollIntoViewIfNeeded();path=join(evidence,'capture-discarded-390.png');await page.screenshot({path,fullPage:true});shots.push({screen:'phone private history',viewport:width,path})
  }finally{await context.close()}
}

export async function assertRestoredInbox(context,origin,before){
  const after=(await api(context,origin,'receipt-inbox')).receipts,ordered=rows=>[...rows].sort((a,b)=>a.id.localeCompare(b.id))
  assert.deepEqual(ordered(after),ordered(before))
  for(const receipt of after){const response=await context.request.get(origin+receipt.downloadUrl);assert.equal(response.status(),200);assert.equal(hash(await response.body()),receipt.sha256)}
}
