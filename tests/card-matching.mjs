// CAPTURE-004 / FEED-004: native consent, hourly matching, questions and undo at 1440/390, followed by public CLI restore.
import assert from 'node:assert/strict'
import {chromium} from '@playwright/test'
import {copyFile,mkdir,readFile,rm,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {command,fresh,freePort,start} from './browser-runtime.mjs'
import {api,PEOPLE,session,setUp} from './browser-journey.mjs'
import {records,rows} from './browser-archive.mjs'
import {rejectMatchingArchives} from './matching-archive.mjs'
import {statementScreens,statementPrivacyScreens} from './browser-statements.mjs'
import {codingScreens} from './browser-coding.mjs'
import {readingEdge,readingScreens} from './browser-reading.mjs'
import {programFeedScreens} from './browser-program-feed.mjs'
import {automaticCodingScreens} from './browser-auto-coding.mjs'
import {importPrivateStatements,scanStatementArchive,rejectUnsafeStatementArchives,verifyPrivateStatementDownloads} from './statement-archive.mjs'

const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/card-matching-proof')
const notice="When this receipt matches one of your card charges, Coaster attaches it automatically. Approvers and finance can see the receipt, its file name and the total, currency and date you entered once that expense is submitted — by you, your delegate or the owner's scheduled submission."
await mkdir(evidence,{recursive:true})
let root,restored,server,browser,readerEdge
const launch=()=>chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),args:['--use-mock-keychain','--password-store=basic','--no-sandbox']})
const statementDoor=(context,origin)=>({post:(path,body)=>api(context,origin,path,body),get:path=>api(context,origin,path),download:async id=>{const response=await context.request.get(`${origin}/api/coaster/statements/${id}/file`);assert.equal(response.status(),200);return {bytes:await response.body(),disposition:response.headers()['content-disposition']}}})
const chosen=[]
const [part,of]=(process.env.MATCH_REFUSALS??'0/1').split('/').map(Number)
assert.ok(Number.isInteger(part)&&Number.isInteger(of)&&of>0&&part>=0&&part<of,'MATCH_REFUSALS must be part/of')
try {
  root=await fresh();await command(root,['install']);const port=await freePort()
  readerEdge=await readingEdge();await mkdir(join(root,'.cache'),{recursive:true});await writeFile(join(root,'.cache/reading-answers.json'),JSON.stringify({AI_ENABLED:'true',AI_API_KEY:'synthetic-coaster-6000',AI_BASE_URL:readerEdge.url}),{mode:0o600})
  await command(root,['setup','--owner-email','owner@harbourfinch.example','--port',String(port),'--answers','.cache/reading-answers.json'])
  server=await start(root,port);browser=await launch()
  const owner=await session(browser,root,server.origin,'owner',1440);await setUp(owner,server.origin)
  const category=(await api(owner.context,server.origin,'state')).categories.find(c=>c.name==='Office supplies').id
  const privateStatements=await importPrivateStatements(statementDoor(owner.context,server.origin),category,PEOPLE.employee)
  await statementPrivacyScreens(browser,root,server.origin,privateStatements,evidence)
  await api(owner.context,server.origin,'statements/cards',{issuer:'Synthetic Card',last4:'1111',employee:PEOPLE.employee})
  const importRows=async(name,amount,merchant,count=1,date='2026-10-02')=>{
    const input={format:'csv',name,issuer:'Synthetic Card',category,content:'Date,Merchant,Amount,Id\n'+Array.from({length:count},(_,i)=>`${date},${merchant},${amount},${name}-${i}`).join('\n'),mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',transactionId:'Id',wholeFileLast4:'1111'}}
    const preview=await api(owner.context,server.origin,'statements/preview',input)
    return api(owner.context,server.origin,'statements/commit',{...input,fingerprint:preview.fingerprint})
  }
  for(const [index,width] of [1440,390].entries()) {
    const employee=await session(browser,root,server.origin,'employee',width),{page,context}=employee
    const name=`card-receipt-${width}.png`,amount=(10+index*100).toFixed(2)
    await page.goto(server.origin+'/app#/claims')
    const inbox=page.getByRole('region',{name:'Receipt inbox',exact:true})
    await inbox.getByLabel('Upload receipts',{exact:true}).setInputFiles({name,mimeType:'image/png',buffer:await readFile('tests/fixtures/receipts/bistro.png')})
    const row=inbox.locator('.receipt-inbox-list > li').filter({has:page.getByRole('link',{name,exact:true})})
    await row.locator('summary').filter({hasText:`Card matching for ${name}`}).click()
    await row.getByText(notice,{exact:true}).waitFor()
    const acknowledgment=row.getByRole('checkbox',{name:'I understand when this receipt will be shared',exact:true})
    assert.equal(await acknowledgment.isChecked(),false,'consent is never preselected')
    await row.getByLabel('Receipt merchant',{exact:true}).fill('Bistro')
    await row.getByLabel('Purchase date',{exact:true}).fill('2026-10-02')
    await row.getByLabel('Receipt total',{exact:true}).fill(amount)
    assert.equal(await row.getByLabel('Receipt currency',{exact:true}).inputValue(),'AUD')
    await row.getByRole('button',{name:'Match to my card charge',exact:true}).click()
    await row.getByRole('alert').filter({hasText:'Read and acknowledge'}).waitFor()
    await acknowledgment.check();await row.getByText(notice,{exact:true}).scrollIntoViewIfNeeded()
    await page.screenshot({path:join(evidence,`matching-notice-${width}.png`),fullPage:true})
    const [optedIn]=await Promise.all([
      page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/card-match')),
      row.getByRole('button',{name:'Match to my card charge',exact:true}).click(),
    ])
    assert.equal(optedIn.status(),200,await optedIn.text())
    let receipt=(await api(context,server.origin,'receipt-inbox')).receipts.find(r=>r.name===name)
    assert.equal(receipt.matchChoice.enabled,true)
    const uniqueJob=await importRows(`unique-${width}.csv`,amount,'Harbour View Bistro')
    assert.equal((await api(context,server.origin,'receipt-inbox')).receipts.find(r=>r.id===receipt.id).attachment,null)
    let rule=await api(owner.context,server.origin,'settings/card-matching')
    await api(owner.context,server.origin,'settings/card-matching',{version:rule.version,enabled:false,windowDays:7,tipPercent:20,fxPercent:5})
    await page.reload();await row.locator('summary').filter({hasText:`Card matching for ${name}`}).click()
    await row.getByText(/Automatic matching is turned off for this business/).waitFor()
    await row.scrollIntoViewIfNeeded();await page.screenshot({path:join(evidence,`matching-off-${width}.png`),fullPage:true})
    const stopped=await server.scheduled();assert.equal(stopped.status,200,await stopped.text())
    assert.equal((await api(context,server.origin,'receipt-inbox')).receipts.find(r=>r.id===receipt.id).attachment,null)
    rule=await api(owner.context,server.origin,'settings/card-matching')
    await api(owner.context,server.origin,'settings/card-matching',{version:rule.version,enabled:true,windowDays:7,tipPercent:20,fxPercent:5})
    const tick=await server.scheduled();assert.equal(tick.status,200,await tick.text())
    await page.reload();await row.getByText(/Attached to/).waitFor()
    receipt=(await api(context,server.origin,'receipt-inbox')).receipts.find(r=>r.id===receipt.id)
    assert.equal(receipt.lifecycle.at(-1).actorEmail,'automation: card match');chosen.push(receipt.id)
    await row.scrollIntoViewIfNeeded();await page.screenshot({path:join(evidence,`matching-attached-${width}.png`),fullPage:true})
    await page.goto(server.origin+`/app#/claims/${receipt.attachment.claimId}`)
    await page.getByText(/Attached automatically to this card charge/).first().waitFor()
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
    await page.screenshot({path:join(evidence,`matching-basis-${width}.png`),fullPage:true})
    await page.goto(server.origin+'/app#/claims')
    await row.locator('summary').filter({hasText:`Detach ${name}`}).click()
    const [detached]=await Promise.all([
      page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith(`/receipt-inbox/${receipt.id}/detach`)),
      row.getByRole('button',{name:'Detach receipt',exact:true}).click(),
    ])
    assert.equal(detached.status(),200,await detached.text())
    receipt=(await api(context,server.origin,'receipt-inbox')).receipts.find(r=>r.id===receipt.id)
    assert.equal(receipt.attachment,null);assert.equal(receipt.matchChoice.enabled,false)
    await api(context,server.origin,`receipt-inbox/${receipt.id}/card-match`,{expectedSequence:receipt.lifecycleSequence,enabled:true,merchant:'Bistro',date:'2026-10-02',total:amount,currency:'AUD',notice})
    const replay=await server.scheduled();assert.equal(replay.status,200,await replay.text())
    assert.equal((await api(context,server.origin,'receipt-inbox')).receipts.find(r=>r.id===receipt.id).attachment,null)
    const undo=await api(owner.context,server.origin,`statements/${uniqueJob.file}/undo`,{});assert.equal(undo.removed,1)
    await importRows(`unique-${width}.csv`,amount,'Harbour View Bistro')
    const reimport=await server.scheduled();assert.equal(reimport.status,200,await reimport.text())
    assert.equal((await api(context,server.origin,'receipt-inbox')).receipts.find(r=>r.id===receipt.id).attachment,null,'statement re-import never resurrects an undone pair')
    // Two same-amount charges ask. The native answer is a person attach, never a guessed automation line.
    const tieName=`question-${width}.png`,tieAmount=(30+index*300).toFixed(2)
    await page.reload();await inbox.getByLabel('Upload receipts',{exact:true}).setInputFiles({name:tieName,mimeType:'image/png',buffer:await readFile('tests/fixtures/receipts/bistro.png')})
    await inbox.getByRole('link',{name:tieName,exact:true}).waitFor()
    const tie=(await api(context,server.origin,'receipt-inbox')).receipts.find(r=>r.name===tieName)
    await api(context,server.origin,`receipt-inbox/${tie.id}/card-match`,{expectedSequence:tie.lifecycleSequence,enabled:true,merchant:'Bistro',date:'2026-10-02',total:tieAmount,currency:'AUD',notice})
    await importRows(`ties-${width}.csv`,tieAmount,'Bistro',2)
    const delivery=await server.scheduled();assert.equal(delivery.status,200,await delivery.text())
    await page.reload()
    const tied=inbox.locator('.receipt-inbox-list > li').filter({has:page.getByRole('link',{name:tieName,exact:true})})
    await tied.locator('summary').filter({hasText:`Card matching for ${tieName}`}).click()
    const question=tied.getByRole('region',{name:`Match question for ${tieName}`,exact:true})
    await question.getByText('Which card charge belongs with this receipt? Coaster will not guess.').waitFor()
    assert.equal(await question.getByRole('button',{name:'This one',exact:true}).count(),2)
    await question.scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
    await page.screenshot({path:join(evidence,`matching-question-${width}.png`),fullPage:true})
    const [attached]=await Promise.all([
      page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith(`/receipt-inbox/${tie.id}/attach`)),
      question.getByRole('button',{name:'This one',exact:true}).last().click(),
    ])
    assert.equal(attached.status(),200,await attached.text())
    const answered=(await api(context,server.origin,'receipt-inbox')).receipts.find(r=>r.id===tie.id)
    assert.equal(answered.lifecycle.at(-1).actorEmail,PEOPLE.employee);assert.equal(answered.lifecycle.at(-1).channel,'app')
    chosen.push(tie.id);await context.close()
  }
  // Freeze an automatic basis in a real submitted revision so restore also checks the shared evidence.
  const employee=await session(browser,root,server.origin,'employee',1440)
  const upload=await employee.context.request.post(server.origin+'/api/coaster/receipt-inbox',{multipart:{file:{name:'synthetic-submitted-match.png',mimeType:'image/png',buffer:await readFile('tests/fixtures/receipts/bistro.png')},source:'upload'},headers:{origin:server.origin}})
  assert.equal(upload.status(),200);const submittedOriginal=(await upload.json()).receipt
  await api(employee.context,server.origin,`receipt-inbox/${submittedOriginal.id}/card-match`,{expectedSequence:0,enabled:true,merchant:'Bistro',date:'2026-09-02',total:'555.55',currency:'AUD',notice})
  await importRows('synthetic-submitted-match.csv','555.55','Bistro',1,'2026-09-02')
  await importRows('synthetic-kept-match.csv','1.00','Synthetic Other',1,'2026-09-02')
  const scheduled=await server.scheduled();assert.equal(scheduled.status,200,await scheduled.text())
  const attachment=(await api(employee.context,server.origin,'receipt-inbox')).receipts.find(r=>r.id===submittedOriginal.id).attachment
  assert.ok(attachment)
  let detail=await api(employee.context,server.origin,`claims/${attachment.claimId}`)
  for(const item of detail.items) {
    await api(employee.context,server.origin,`claims/${detail.claim.id}/items`,{version:detail.claim.version,item:item.id,kind:'receipt',date:item.spent_on,merchant:item.merchant,amount:(item.amount_minor/100).toFixed(2),category:item.allocations[0].category_id,receipt:item.receipt_id,explanation:'Synthetic statement evidence; distinct posted transactions'})
    detail=await api(employee.context,server.origin,`claims/${attachment.claimId}`)
  }
  const submitted=await api(employee.context,server.origin,`claims/${detail.claim.id}/submit`,{version:detail.claim.version})
  const manager=await session(browser,root,server.origin,'manager',1440)
  await api(manager.context,server.origin,`claims/${detail.claim.id}/decision`,{version:submitted.version,revision:submitted.revision,decision:'approved',hold:[attachment.itemId],reason:'Synthetic review of the matched charge',acknowledge:true})
  const held=(await api(employee.context,server.origin,'state')).claims.find(c=>c.title.endsWith('(held)'))
  assert.ok(held)
  const heldDetail=await api(employee.context,server.origin,`claims/${held.id}`)
  assert.equal(heldDetail.claim.held_from,detail.claim.id)
  assert.deepEqual(JSON.parse(heldDetail.items[0].card_match_basis),JSON.parse(detail.items.find(i=>i.id===attachment.itemId).card_match_basis))
  await api(manager.context,server.origin,`claims/${held.id}/release`,{version:held.version,acknowledge:true})
  await manager.context.close();await employee.context.close()
  await statementScreens(browser,root,server.origin,owner,evidence)
  await codingScreens(browser,root,server.origin,evidence)
  if(part===0){await automaticCodingScreens(browser,root,server.origin,evidence);await readingScreens(browser,root,server.origin,evidence,readerEdge);await programFeedScreens(browser,root,server,evidence)}
  // FEED-005: reconciled and closed statements (their resolutions, ledger and history) ride the same archive round trip.
  const kept=(await api(owner.context,server.origin,'statements')).files.find(f=>f.name==='synthetic-kept-match.csv')
  const reconciliation=await api(owner.context,server.origin,`statements/${kept.id}/reconcile`,{last4:'1111',openingBalance:'0.00',statementBalance:'1.00'})
  const closedStatement=await api(owner.context,server.origin,`statements/reconciliations/${reconciliation.id}/close`,{})
  assert.deepEqual([closedStatement.ledger.cardAccountMinor,closedStatement.ledger.matches],[100,true])
  await owner.context.close();await browser.close();browser=undefined;await server.close();server=undefined
  await command(root,['export','--output','exports/matching.rer'])
  const archive=join(root,'exports/matching.rer');await copyFile(archive,join(evidence,'matching.rer'))
  await scanStatementArchive(archive)
  restored=await fresh();await command(restored,['install']);const restorePort=await freePort()
  await command(restored,['setup','--owner-email','owner@harbourfinch.example','--port',String(restorePort)])
  await mkdir(join(restored,'exports'),{recursive:true});await command(restored,['export','--output','exports/empty.rer'])
  const empty=rows(await records(join(restored,'exports/empty.rer')))
  await rejectUnsafeStatementArchives(restored,archive,{part,of})
  const refusals=await rejectMatchingArchives(restored,archive,empty,{part,of})
  await copyFile(archive,join(restored,'exports/matching.rer'))
  await command(restored,['import','--input','exports/matching.rer','--yes'])
  await command(restored,['export','--output','exports/restored.rer'])
  assert.deepEqual(rows(await records(join(restored,'exports/restored.rer'))),rows(await records(archive)),'matching, rule versions, masked statement originals, rejections and private history round trip exactly')
  await scanStatementArchive(join(restored,'exports/restored.rer'))
  server=await start(restored,restorePort);browser=await launch()
  const restoredOwner=await session(browser,restored,server.origin,'owner',1440)
  await verifyPrivateStatementDownloads(statementDoor(restoredOwner.context,server.origin),privateStatements)
  await restoredOwner.context.close()
  const restoredEmployee=await session(browser,restored,server.origin,'employee',390)
  const before=(await api(restoredEmployee.context,server.origin,'receipt-inbox')).receipts
  for(const id of chosen) assert.ok(before.some(r=>r.id===id))
  const replay=await server.scheduled();assert.equal(replay.status,200,await replay.text())
  const after=(await api(restoredEmployee.context,server.origin,'receipt-inbox')).receipts
  assert.deepEqual(after,before,'restore and hourly replay preserve rejected pairs, existing attachments and private history')
  await restoredEmployee.context.close()
  await writeFile(join(evidence,'result.json'),JSON.stringify({clauses:['CAPTURE-004','FEED-004'],widths:[1440,390],archive:'exact round trip',refusals,shard:{part,of}},null,2)+'\n')
  console.log('CAPTURE-004 FEED-004 matching consent, questions, basis and undo at 1440/390; exact CLI archive round trip, malformed refusals and replay passed')
} finally {
  await browser?.close();await server?.close();await readerEdge?.close()
  if(restored)await rm(restored,{recursive:true,force:true})
  if(root)await rm(root,{recursive:true,force:true})
}
