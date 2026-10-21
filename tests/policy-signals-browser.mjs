// POLICY-002 own screens and end states only, at desktop and phone width.
import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir,rm } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import { fresh,command,freePort,start } from './browser-runtime.mjs'
import { api,session,setUp } from './browser-journey.mjs'
import { imageSignalCases,patternSignalCases,cardSignalCases } from './receipt-signal-scenarios.mjs'
const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/policy-signals-proof')
await mkdir(evidence,{recursive:true})
let root,server,browser
try {
 root=await fresh();await command(root,['install']);const port=await freePort()
 await command(root,['setup','--owner-email','owner@harbourfinch.example','--port',String(port)])
 server=await start(root,port)
 browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 const owner=await session(browser,root,server.origin,'owner',1440);await setUp(owner,server.origin)
 for(const width of [1440,390]) {
  const employee=await session(browser,root,server.origin,'employee',width),finance=await session(browser,root,server.origin,'finance',width),manager=await session(browser,root,server.origin,'manager',width)
  const state=await api(owner.context,server.origin,'state'),t={sam:employee.context,alex:finance.context,morgan:finance.context,priya:manager.context,c:{office:state.categories.find(c=>c.name==='Office supplies').id}}
  const h={post:(path,body,who=owner.context)=>api(who,server.origin,path,body),get:(path,who=owner.context)=>api(who,server.origin,path)}
  const images=await imageSignalCases(h,t,' '+width),patterns=await patternSignalCases(h,t,' '+width)
  const card=await cardSignalCases(h,t,{
   suffix:'-'+width,
   async upload(bytes,name,context) {
    const response=await context.request.post(server.origin+'/api/coaster/receipt-inbox',{headers:{origin:server.origin},multipart:{file:{name,mimeType:'image/png',buffer:bytes}}})
    assert.equal(response.status(),200);return (await response.json()).receipt
   },
   tick:async()=>{const response=await server.scheduled();assert.equal(response.status,200)}
  })
  const page=finance.page
  async function screenshot(name) {
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name} overflow at ${width}`)
   await page.screenshot({path:join(evidence,`${name}-${width}.png`),fullPage:true})
  }
  async function openClaim(title) {
   await page.goto(server.origin+'/app');await page.getByRole('navigation',{name:'Coaster'}).getByRole('link',{name:'Claims',exact:true}).click()
   await page.getByRole('link',{name:new RegExp(title)}).first().click()
   await page.getByRole('heading',{name:title,exact:true}).waitFor()
  }
  await openClaim(images.claim.title)
  const region=page.getByRole('region',{name:'Receipt and spend signals',exact:true})
  for(const result of images.results)for(const signal of result.signals)assert.ok((await region.innerText()).includes(signal.reason))
  await screenshot('image-signals-submitted')
  await page.goto(server.origin+'/app#/claims/'+card.claim.id)
  await page.getByRole('heading',{name:card.claim.title,exact:true}).waitFor()
  assert.ok((await region.innerText()).includes(card.signal.reason))
  await screenshot('card-receipt-disagreement')
  await openClaim(patterns.claim.title)
  await page.getByLabel('Split purchase review note',{exact:true}).first().fill('Legitimate separate purchases; supplier evidence checked.')
  await page.getByRole('button',{name:'Record split purchase review',exact:true}).first().click()
  await region.getByText(/Reviewed by.*Legitimate separate purchases/).waitFor()
  await screenshot('signals-reviewed')
  const c=patterns.claim
  const approved=await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved',acknowledge:true},manager.context)
  let batch=await h.post('batches',{claims:[c.id]},finance.context)
  batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:approved.total_minor},finance.context)
  batch=await h.post(`batches/${batch.id}/release`,{version:batch.version})
  await h.post(`batches/${batch.id}/paid`,{version:batch.version,reference:'synthetic-coaster-'+width,paidOn:'2026-06-20'},finance.context)
  await page.reload();await page.getByText('Reimbursed',{exact:true}).first().waitFor()
  assert.equal((await h.get(`claims/${c.id}`,finance.context)).claim.status,'reimbursed')
  await screenshot('signals-paid-unresolved')
  await page.getByRole('navigation',{name:'Coaster'}).getByRole('link',{name:'Batches',exact:true}).click()
  await page.getByRole('region',{name:'Exception queue',exact:true}).waitFor()
  assert.ok((await page.getByRole('region',{name:'Exception queue',exact:true}).innerText()).includes('possible, needs review'))
  await screenshot('finance-signal-queue')
  for(const person of [employee,finance,manager])await person.context.close()
 }
 await owner.context.close()
 console.log('POLICY-002 1440/390 image, review, paid-with-unresolved and finance queue screens: '+evidence)
} finally {if(browser)await browser.close();if(server)await server.close();if(root)await rm(root,{recursive:true,force:true})}
