import { assertAccessible } from './browser-accessibility.mjs'
// The browser's paid network edge is synthetic. Actual model quality is proved separately by receipt-reading-quality.mjs.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { api, session } from './browser-journey.mjs'

export async function readingEdge() {
  const label = JSON.parse(await readFile('tests/fixtures/receipts/reader/synthetic-coaster-1001.json', 'utf8'))
  const edge = { fail: false, omitTip: false }
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* consume the real model request without recording originals or credentials */ }
    if (edge.fail) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'synthetic-coaster-6001' } })); return }
    const fields = Object.fromEntries(Object.entries(label.values).map(([name, value]) => [name, { value: name === 'lineItems' ? value.map(item => ({ ...item, confidence: .99, regions: label.regions.lineItems })) : value, confidence: .99, regions: label.regions[name] }]))
    if(edge.omitTip){fields.total.value=(Number(label.values.total)-Number(label.values.tip)).toFixed(2);fields.total.confidence=.6;}
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: 'completed', model: 'gpt-4.1-2025-04-14', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(fields) }] }], usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { ...edge, get omitTip(){return edge.omitTip},set omitTip(value){edge.omitTip=value}, get fail() { return edge.fail }, set fail(value) { edge.fail = value }, url: `http://127.0.0.1:${server.address().port}/v1`, label, async close() { await new Promise(resolve => server.close(resolve)) } }
}

export async function readingScreens(browser, root, origin, evidence, edge) {
  for (const width of [1440, 390]) {
    const owner = await session(browser, root, origin, 'owner', width), employee = await session(browser, root, origin, 'employee', width)
    try {
      await owner.page.goto(origin + '/app#/settings')
      const settings = owner.page.getByRole('heading', { name: 'Receipt reading', exact: true }).locator('..').locator('..')
      await settings.getByRole('button', { name: 'Manage receipt reading', exact: true }).click()
      await settings.getByLabel('Enable receipt reading', { exact: true }).check()
      await settings.getByLabel('I authorize sending explicitly selected receipts to the configured AI provider', { exact: true }).check()
      await shot(owner.page, settings, evidence, 'reading-settings', width)
      await settings.getByRole('button', { name: 'Save receipt reading', exact: true }).click()
      await settings.getByRole('button', { name: 'Save receipt reading', exact: true }).waitFor()
      await employee.page.goto(origin + '/app#/claims')
      const inbox = employee.page.getByRole('region', { name: 'Receipt inbox', exact: true }), name = `synthetic-coaster-${width + 6000}.png`
      await inbox.getByLabel('Upload receipts', { exact: true }).setInputFiles({ name, mimeType: 'image/png', buffer: await readFile('tests/fixtures/receipts/reader/synthetic-coaster-1001.png') })
      const row = inbox.locator('.receipt-inbox-list > li').filter({ has: employee.page.getByRole('link', { name, exact: true }) })
      await row.getByText(`Read ${name}`, { exact: true }).click()
      const consent = row.getByLabel('I authorize sending this original to the configured AI provider for receipt reading and coding suggestions', { exact: true })
      assert.equal(await consent.isChecked(), false)
      await row.getByRole('button', { name: 'Read receipt', exact: true }).click()
      await row.getByRole('alert').filter({ hasText: 'Explicit consent' }).waitFor()
      await consent.check()
      edge.fail = true
      await row.getByRole('button', { name: 'Read receipt', exact: true }).click()
      await row.getByRole('button', { name: 'Read receipt again', exact: true }).waitFor()
      await shot(employee.page, row, evidence, 'reading-failed', width)
      edge.fail = false
      await row.getByRole('button', { name: 'Read receipt again', exact: true }).click()
      await row.getByRole('button', { name: 'Show total on page 1', exact: true }).waitFor()
      await shot(employee.page, row, evidence, 'reading-values', width)
      await row.getByRole('button', { name: 'Show total on page 1', exact: true }).click()
      const image = row.getByRole('img', { name: 'Original receipt showing Total', exact: true })
      await image.waitFor(); await image.evaluate(img => img.complete ? Promise.resolve() : new Promise(resolve => img.onload = resolve))
      await shot(employee.page, row.getByRole('region', { name: 'Receipt field evidence' }), evidence, 'reading-region', width)
      await row.getByRole('button', { name: 'Close field evidence', exact: true }).click()
      await row.getByText('Correct receipt values', { exact: true }).click()
      await row.getByLabel('Correct total', { exact: true }).fill('60.00')
      await row.getByRole('button', { name: 'Save receipt corrections', exact: true }).click()
      await row.getByText('Subtotal, sales tax and tip do not equal the final total', { exact: true }).first().waitFor()
      await shot(employee.page, row, evidence, 'reading-conflict', width)
      await row.getByLabel('Correct total', { exact: true }).fill(edge.label.values.total)
      await row.getByRole('button', { name: 'Save receipt corrections', exact: true }).click()
      await row.getByText('Reading history', { exact: true }).click()
      await row.getByText(/corrected/).first().waitFor()
      await shot(employee.page, row, evidence, 'reading-corrected', width)
      await row.getByText('My standing matching choice', { exact: true }).click()
      const standing = row.getByRole('button', { name: 'Save my reading matching choice', exact: true }).locator('..').locator('..')
      const standingChoice = standing.getByLabel('Choose matching for my future read originals when the required fields are confident', { exact: true })
      assert.equal(await standingChoice.isChecked(), false)
      await standingChoice.check(); await standing.getByLabel('I understand when these receipts will be shared', { exact: true }).check()
      await standing.getByRole('button', { name: 'Save my reading matching choice', exact: true }).click()
      await shot(employee.page, standing, evidence, 'reading-standing-choice', width)
      await standingChoice.uncheck(); await standing.getByRole('button', { name: 'Save my reading matching choice', exact: true }).click()
      const match = row.getByRole('button', { name: 'Use reviewed reading for card matching', exact: true }).locator('..').locator('..')
      await match.getByLabel('I understand when this receipt will be shared', { exact: true }).check()
      await match.getByRole('button', { name: 'Use reviewed reading for card matching', exact: true }).click()
      await shot(employee.page, row, evidence, 'reading-matching-choice', width)
      const uploaded = (await api(employee.context, origin, 'receipt-inbox')).receipts.find(receipt => receipt.name === name)
      assert.equal(uploaded.matchChoice.enabled, true); assert.equal(uploaded.matchChoice.details.totalMinor, 5828)
      await row.getByRole('button', { name: 'Prepare expense from reviewed reading', exact: true }).click()
      const expense = row.getByRole('heading', { name: 'Expense from receipt reading', exact: true }).locator('..').locator('..')
      assert.equal(await expense.getByLabel('Amount paid', { exact: true }).inputValue(), edge.label.values.total)
      assert.equal(await expense.getByLabel('Paid to', { exact: true }).inputValue(), edge.label.values.merchant)
      await shot(employee.page, expense, evidence, 'reading-expense-prefill', width)
      await expense.getByLabel('Expense category', { exact: true }).selectOption({ label: 'Meals' })
      await expense.getByLabel('Conversion rate', { exact: true }).fill('1.52')
      await expense.getByRole('button', { name: 'Add to report', exact: true }).click()
      await employee.page.waitForURL(/#\/claims\//)
      const detail = await api(employee.context, origin, `claims/${new URL(employee.page.url()).hash.split('/').at(-1)}`)
      assert.ok(detail.items.some(item => item.merchant === edge.label.values.merchant && item.original_minor === 5828 && item.original_currency === 'USD'))
      await shot(employee.page, employee.page.getByRole('button', { name: `Change ${edge.label.values.merchant}`, exact: true }).last().locator('..').locator('..').locator('..'), evidence, 'reading-expense-saved', width)
    } finally { edge.fail = false; await owner.context.close(); await employee.context.close() }
  }
}
async function shot(page, target, evidence, name, width) {
  await assertAccessible(page, `${name} at ${width}`)
  await target.scrollIntoViewIfNeeded()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} fits ${width}`)
  await page.screenshot({ path: join(evidence, `${name}-${width}.png`), fullPage: true })
  await page.screenshot({ path: join(evidence, `${name}-${width}-viewport.png`), fullPage: false })
  await target.screenshot({ path: join(evidence, `${name}-${width}-detail.png`) })
}

export async function costScreens(browser,root,origin,evidence,edge){
 for(const width of [1440,390]){
  const owner=await session(browser,root,origin,'owner',width),employee=await session(browser,root,origin,'employee',width)
  try{
   await owner.page.goto(origin+'/app#/settings');const panel=owner.page.getByRole('region',{name:'Provider costs',exact:true});await panel.getByRole('button',{name:'Save provider costs'}).waitFor()
   let settings=await api(owner.context,origin,'settings/receipt-reading');if(settings.enabled)settings=await api(owner.context,origin,'settings/receipt-reading',{version:settings.version,enabled:false,model:settings.model,threshold:settings.threshold});
   await panel.getByLabel('Priced AI model',{exact:true}).fill(settings.model);await panel.getByLabel('USD per million input tokens',{exact:true}).fill('2');await panel.getByLabel('USD per million output tokens',{exact:true}).fill('8');await panel.getByLabel('USD reservation per page',{exact:true}).fill('0.01');await panel.getByLabel('Monthly USD cap',{exact:true}).fill('20')
   await Promise.all([owner.page.waitForResponse(r=>r.url().endsWith('/settings/provider-costs')&&r.request().method()==='POST'&&r.status()===200),panel.getByRole('button',{name:'Save provider costs'}).click()]);await shot(owner.page,panel,evidence,'provider-costs-before-reading',width)
   await api(owner.context,origin,'settings/receipt-reading',{version:settings.version,enabled:true,consent:true,model:settings.model,threshold:settings.threshold})
   const name=`synthetic-coaster-${width+7200}.png`,uploaded=await employee.context.request.post(origin+'/api/coaster/receipt-inbox',{headers:{origin},multipart:{file:{name,mimeType:'image/png',buffer:await readFile('tests/fixtures/receipts/reader/synthetic-coaster-1001.png')}}});assert.equal(uploaded.status(),200);const original=(await uploaded.json()).receipt
   const read=await api(employee.context,origin,`receipt-inbox/${original.id}/reading`,{expectedSequence:0,expectedReadingSequence:0,consent:true});assert.equal(read.history.at(-1).usage.cost.usdMicros,1000)
   await owner.page.reload();await panel.getByText('Per-page provider usage',{exact:true}).click();await panel.getByText(/USD 0.001000 per page/).first().waitFor();await shot(owner.page,panel,evidence,'provider-costs-after-reading',width)
   await panel.getByLabel('Monthly USD cap',{exact:true}).fill('0');await Promise.all([owner.page.waitForResponse(r=>r.url().endsWith('/settings/provider-costs')&&r.request().method()==='POST'&&r.status()===200),panel.getByRole('button',{name:'Save provider costs'}).click()]);await panel.getByRole('status').filter({hasText:'paused'}).waitFor();await shot(owner.page,panel,evidence,'provider-costs-paused',width)
   const paused=await api(employee.context,origin,`receipt-inbox/${original.id}/reading`,{expectedSequence:0,expectedReadingSequence:read.sequence,consent:true});assert.equal(paused.history.at(-1).errorCode,'budget_exhausted')
   await employee.page.goto(origin+'/app#/claims');await employee.page.reload();const row=employee.page.getByRole('region',{name:'Receipt inbox',exact:true}).locator('.receipt-inbox-list > li').filter({has:employee.page.getByRole('link',{name,exact:true})});await row.getByText(`Read ${name}`,{exact:true}).click();await row.getByText(/AI provider budget is exhausted/).waitFor();await shot(employee.page,row,evidence,'reading-paused-manual-available',width)
   const state=await api(owner.context,origin,'state');let manual=await api(employee.context,origin,'claims',{title:'Manual entry after AI cap '+width});manual=await api(employee.context,origin,`claims/${manual.id}/items`,{version:manual.version,kind:'receipt',date:'2026-10-23',merchant:'synthetic-coaster-'+(width+7250),amount:'12.34',allocations:[{category:state.categories.find(c=>c.name==='Office supplies').id}]});await employee.page.goto(origin+'/app#/claims/'+manual.id);await employee.page.getByText('synthetic-coaster-'+(width+7250),{exact:false}).first().waitFor();await shot(employee.page,employee.page.locator('.detail'),evidence,'manual-expense-after-ai-cap',width)
   await panel.getByLabel('Monthly USD cap',{exact:true}).fill('');await Promise.all([owner.page.waitForResponse(r=>r.url().endsWith('/settings/provider-costs')&&r.request().method()==='POST'&&r.status()===200),panel.getByRole('button',{name:'Save provider costs'}).click()])
  }finally{await owner.context.close();await employee.context.close()}
 }
}

export async function questionScreens(browser,root,origin,evidence,edge){
 for(const width of [1440,390]){
  const owner=await session(browser,root,origin,'owner',width),employee=await session(browser,root,origin,'employee',width)
  try{
   const state=await api(owner.context,origin,'state'),email=(await api(employee.context,origin,'state')).actor.email,category=state.categories.find(c=>c.name==='Office supplies').id,label=edge.label.values
   const name=`synthetic-coaster-${width+7300}.png`,uploaded=await employee.context.request.post(origin+'/api/coaster/receipt-inbox',{headers:{origin},multipart:{file:{name,mimeType:'image/png',buffer:await readFile('tests/fixtures/receipts/reader/synthetic-coaster-1001.png')}}});assert.equal(uploaded.status(),200);const original=(await uploaded.json()).receipt
   edge.omitTip=true;await api(employee.context,origin,`receipt-inbox/${original.id}/reading`,{expectedSequence:0,expectedReadingSequence:0,consent:true});edge.omitTip=false
   const issuer='synthetic-coaster-'+(width+7400),last4=label.last4
   await api(owner.context,origin,'statements/cards',{issuer,last4,employee:email})
   const input={format:'csv',name:name+'.csv',issuer,category,content:`Date,Merchant,Amount,Id\n${label.date},${label.merchant},${label.total},${name}`,mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',transactionId:'Id',wholeFileLast4:last4}}
   const preview=await api(owner.context,origin,'statements/preview',input),job=await api(owner.context,origin,'statements/commit',{...input,fingerprint:preview.fingerprint}),detail=await api(employee.context,origin,'claims/'+job.claims[0])
   await api(employee.context,origin,`receipt-inbox/${original.id}/attach`,{expectedSequence:0,claimId:detail.claim.id,itemId:detail.items[0].id,version:detail.claim.version})
   await employee.page.goto(origin+'/app#/claims');await employee.page.reload();const row=employee.page.getByRole('region',{name:'Receipt inbox',exact:true}).locator('.receipt-inbox-list > li').filter({has:employee.page.getByRole('link',{name,exact:true})});await row.getByText(`Read ${name}`,{exact:true}).click()
   const question=row.getByRole('region',{name:'Receipt question',exact:true});await question.getByRole('img',{name:'Original receipt total crop',exact:true}).waitFor();assert.ok((await question.innerText()).includes('49.92'));assert.ok((await question.innerText()).includes('58.28'));await shot(employee.page,question,evidence,'receipt-question-with-crop',width)
   await question.getByLabel('Confirmed receipt total',{exact:true}).fill(label.total);const currency=question.getByLabel('Confirmed receipt currency',{exact:true});if(await currency.count())await currency.fill(label.currency);await question.getByLabel('Confirmed receipt tip',{exact:true}).fill(label.tip);await question.getByLabel('I checked these values and authorize saving them on this expense',{exact:true}).check()
   await Promise.all([employee.page.waitForResponse(r=>r.url().endsWith(`/receipt-inbox/${original.id}/question`)&&r.request().method()==='POST'&&r.status()===200),question.getByRole('button',{name:'Confirm receipt answer'}).click()]);await question.waitFor({state:'detached'})
   await employee.page.goto(origin+'/app#/claims/'+detail.claim.id);await employee.page.getByText(/Receipt answer confirmed: 58.28 USD/).waitFor();await shot(employee.page,employee.page.locator('.detail'),evidence,'receipt-answer-expense',width)
   const close=employee.page.locator('a.panel-close');if(await close.count()){await employee.page.keyboard.press('Tab');await close.focus();assert.equal(await close.evaluate(el=>getComputedStyle(el,'::after').visibility),'visible')}
  }finally{edge.omitTip=false;await owner.context.close();await employee.context.close()}
 }
}

// Bounded own-screen proof, also callable independently of the larger matching journey.
if(process.argv[1]&&new URL(import.meta.url).pathname===await (await import('node:fs/promises')).realpath(process.argv[1])){
 const {fresh,command,freePort,start}=await import('./browser-runtime.mjs'),{chromium}=await import('@playwright/test'),{mkdir,writeFile,rm}=await import('node:fs/promises'),{resolve}=await import('node:path'),{setUp}=await import('./browser-journey.mjs');
 const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/reading-proof');await mkdir(evidence,{recursive:true});let root,server,browser,edge;
 try{root=await fresh();await command(root,['install']);edge=await readingEdge();await mkdir(join(root,'.cache'),{recursive:true});await writeFile(join(root,'.cache/reading-answers.json'),JSON.stringify({AI_ENABLED:'true',AI_API_KEY:'synthetic-coaster-6000',AI_BASE_URL:edge.url}),{mode:0o600});const port=await freePort();await command(root,['setup','--owner-email','owner@harbourfinch.example','--port',String(port),'--answers','.cache/reading-answers.json']);server=await start(root,port);browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});const owner=await session(browser,root,server.origin,'owner',1440);await setUp(owner,server.origin);await owner.context.close();await readingScreens(browser,root,server.origin,evidence,edge);await costScreens(browser,root,server.origin,evidence,edge);await questionScreens(browser,root,server.origin,evidence,edge);console.log('Receipt reading, costs and question screens passed at 1440/390');}
 finally{if(browser)await browser.close();if(server)await server.close();if(edge)await edge.close();if(root)await rm(root,{recursive:true,force:true})}
}
