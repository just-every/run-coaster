// CAPTURE-004 / FEED-004: native consent, hourly matching, questions and undo at 1440/390, followed by public CLI restore.
import assert from 'node:assert/strict'
import {chromium} from '@playwright/test'
import {copyFile,mkdir,readFile,rm,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {command,fresh,freePort,start} from './browser-runtime.mjs'
import {api,PEOPLE,session,setUp} from './browser-journey.mjs'
import {records,rows,tampered} from './browser-archive.mjs'

const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/card-matching-proof')
const notice="When this receipt matches one of your card charges, Coaster attaches it automatically. Approvers and finance can see the receipt, its file name and the total, currency and date you entered once that expense is submitted — by you, your delegate or the owner's scheduled submission."
await mkdir(evidence,{recursive:true})
let root,restored,server,browser
const launch=()=>chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
const chosen=[]
try {
  root=await fresh();await command(root,['install']);const port=await freePort()
  await command(root,['setup','--owner-email','owner@harbourfinch.example','--port',String(port)])
  server=await start(root,port);browser=await launch()
  const owner=await session(browser,root,server.origin,'owner',1440);await setUp(owner,server.origin)
  const category=(await api(owner.context,server.origin,'state')).categories.find(c=>c.name==='Office supplies').id
  await api(owner.context,server.origin,'statements/cards',{issuer:'Synthetic Card',last4:'1111',employee:PEOPLE.employee})
  const importRows=async(name,amount,merchant,count=1)=>{
    const input={format:'csv',name,issuer:'Synthetic Card',category,content:'Date,Merchant,Amount,Id\n'+Array.from({length:count},(_,i)=>`2026-10-02,${merchant},${amount},${name}-${i}`).join('\n'),mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',transactionId:'Id',wholeFileLast4:'1111'}}
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
    await row.getByRole('button',{name:'Match to my card charge',exact:true}).click()
    await page.waitForTimeout(150)
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
    await row.getByRole('button',{name:'Detach receipt',exact:true}).click()
    await page.waitForTimeout(150)
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
    await question.getByRole('button',{name:'This one',exact:true}).last().click()
    await page.waitForTimeout(150)
    const answered=(await api(context,server.origin,'receipt-inbox')).receipts.find(r=>r.id===tie.id)
    assert.equal(answered.lifecycle.at(-1).actorEmail,PEOPLE.employee);assert.equal(answered.lifecycle.at(-1).channel,'app')
    chosen.push(tie.id);await context.close()
  }
  // Freeze an automatic basis in a real submitted revision so restore also checks the shared evidence.
  const employee=await session(browser,root,server.origin,'employee',1440)
  const upload=await employee.context.request.post(server.origin+'/api/coaster/receipt-inbox',{multipart:{file:{name:'synthetic-submitted-match.png',mimeType:'image/png',buffer:await readFile('tests/fixtures/receipts/bistro.png')},source:'upload'},headers:{origin:server.origin}})
  assert.equal(upload.status(),200);const submittedOriginal=(await upload.json()).receipt
  await api(employee.context,server.origin,`receipt-inbox/${submittedOriginal.id}/card-match`,{expectedSequence:0,enabled:true,merchant:'Bistro',date:'2026-10-02',total:'555.55',currency:'AUD',notice})
  await importRows('synthetic-submitted-match.csv','555.55','Bistro')
  const scheduled=await server.scheduled();assert.equal(scheduled.status,200,await scheduled.text())
  const attachment=(await api(employee.context,server.origin,'receipt-inbox')).receipts.find(r=>r.id===submittedOriginal.id).attachment
  assert.ok(attachment)
  let detail=await api(employee.context,server.origin,`claims/${attachment.claimId}`)
  for(const item of detail.items) {
    await api(employee.context,server.origin,`claims/${detail.claim.id}/items`,{version:detail.claim.version,item:item.id,kind:'receipt',date:item.spent_on,merchant:item.merchant,amount:(item.amount_minor/100).toFixed(2),category:item.allocations[0].category_id,explanation:'Synthetic statement evidence; distinct posted transactions'})
    detail=await api(employee.context,server.origin,`claims/${attachment.claimId}`)
  }
  await api(employee.context,server.origin,`claims/${detail.claim.id}/submit`,{version:detail.claim.version})
  await employee.context.close()
  await owner.context.close();await browser.close();browser=undefined;await server.close();server=undefined
  await command(root,['export','--output','exports/matching.rer'])
  const archive=join(root,'exports/matching.rer');await copyFile(archive,join(evidence,'matching.rer'))
  restored=await fresh();await command(restored,['install']);const restorePort=await freePort()
  await command(restored,['setup','--owner-email','owner@harbourfinch.example','--port',String(restorePort)])
  await mkdir(join(restored,'exports'),{recursive:true});await command(restored,['export','--output','exports/empty.rer'])
  const empty=rows(await records(join(restored,'exports/empty.rer')))
  const alterBasis=change=>(event,input)=>{
    const data=JSON.parse(event.match_data);change(data);event.match_data=JSON.stringify(data)
    for(const {row} of rows(input).filter(r=>r.table==='c_receipts'))
      if(row.capture_receipt_id===event.receipt_id&&row.claim_id===event.claim_id&&row.card_match_basis)row.card_match_basis=event.match_data
  }
  const automated=r=>r.channel==='schedule'
  const cases=[
    ['match_choice','c_capture_lifecycle',r=>r.kind==='match-details',r=>{const d=JSON.parse(r.match_data);d.totalMinor=0;r.match_data=JSON.stringify(d)}],
    ['match_basis','c_capture_lifecycle',r=>r.channel==='schedule',r=>{r.on_behalf_of='foreign@dev.localhost'}],
    ['card_charge','c_card_charges',()=>true,r=>{r.card_id='missing-card'}],
    ['match_rejection','c_card_match_rejections',()=>true,r=>{r.transaction_key='card:forged'}],
    ['match_basis_snapshot','c_revisions',()=>true,r=>{const snapshot=JSON.parse(r.snapshot);const item=snapshot.items.find(i=>i.card_match_basis);const data=JSON.parse(item.card_match_basis);data.differenceMinor+=1;item.card_match_basis=JSON.stringify(data);r.snapshot=JSON.stringify(snapshot)}],
    ['match_basis_rule','c_capture_lifecycle',automated,alterBasis(d=>{d.ruleVersion=999})],
    ['match_basis_total','c_capture_lifecycle',automated,alterBasis(d=>{d.enteredTotalMinor+=1})],
    ['match_basis_difference','c_capture_lifecycle',automated,alterBasis(d=>{d.differenceMinor+=1})],
    ['match_basis_currency','c_capture_lifecycle',automated,alterBasis(d=>{d.enteredCurrency='USD'})],
    ['match_basis_date','c_capture_lifecycle',automated,alterBasis(d=>{d.enteredDate='2026-10-01'})],
    ['match_basis_private_field','c_capture_lifecycle',automated,alterBasis(d=>{d.merchant='synthetic-private-details'})],
    ['match_basis_withdrawn','c_capture_lifecycle',r=>r.kind==='match-details',(r)=>{r.kind='match-withdrawn';r.match_data=null}],
    ['match_history_discarded','c_capture_lifecycle',r=>r.kind==='match-details',(r)=>{r.kind='discarded';r.reason='synthetic-discarded';r.match_data=null}],
    ['match_history_merged','c_capture_lifecycle',r=>r.kind==='match-details',(r,input)=>{r.kind='merged';r.reason='synthetic-merged';r.match_data=null;r.survivor_id=rows(input).find(i=>i.table==='c_capture_receipts'&&i.row.id!==r.receipt_id).row.id}],
    ['card_charge_employee','c_card_charges',()=>true,r=>{r.employee_email='synthetic-foreign@example.test'}],
  ]
  for(const [code,table,pick,change] of cases) {
    await writeFile(join(restored,`exports/${code}.rer`),await tampered(archive,table,change,pick),{mode:0o600})
    const result=await command(restored,['import','--input',`exports/${code}.rer`,'--yes'],{expected:4})
    assert.match(result,new RegExp(code==='match_basis'?'coaster_capture_lifecycle_provenance':code.startsWith('card_charge')?'coaster_card_charge':code.startsWith('match_history')?'coaster_capture_history':code.startsWith('match_basis_')?'coaster_capture_match_basis':'coaster_capture_'+code))
    await command(restored,['export','--output',`exports/unchanged-${code}.rer`])
    assert.deepEqual(rows(await records(join(restored,`exports/unchanged-${code}.rer`))),empty,'malformed match archive writes nothing')
  }
  await copyFile(archive,join(restored,'exports/matching.rer'))
  await command(restored,['import','--input','exports/matching.rer','--yes'])
  await command(restored,['export','--output','exports/restored.rer'])
  assert.deepEqual(rows(await records(join(restored,'exports/restored.rer'))),rows(await records(archive)),'matching, rule versions, masked statement originals, rejections and private history round trip exactly')
  server=await start(restored,restorePort);browser=await launch()
  const restoredEmployee=await session(browser,restored,server.origin,'employee',390)
  const before=(await api(restoredEmployee.context,server.origin,'receipt-inbox')).receipts
  for(const id of chosen) assert.ok(before.some(r=>r.id===id))
  const replay=await server.scheduled();assert.equal(replay.status,200,await replay.text())
  const after=(await api(restoredEmployee.context,server.origin,'receipt-inbox')).receipts
  assert.deepEqual(after,before,'restore and hourly replay preserve rejected pairs, existing attachments and private history')
  await restoredEmployee.context.close()
  await writeFile(join(evidence,'result.json'),JSON.stringify({clauses:['CAPTURE-004','FEED-004'],widths:[1440,390],archive:'exact round trip',refusals:cases.map(c=>c[0])},null,2)+'\n')
  console.log('CAPTURE-004 FEED-004 matching consent, questions, basis and undo at 1440/390; exact CLI archive round trip, malformed refusals and replay passed')
} finally {
  await browser?.close();await server?.close()
  if(restored)await rm(restored,{recursive:true,force:true})
  if(root)await rm(root,{recursive:true,force:true})
}
