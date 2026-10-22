// AGENT-005: read the actual submitted evidence in the approver's claim panel.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { api } from './browser-journey.mjs'

export async function inspectPolicyReview(person, origin, claimId, width, evidence, shots, phase='submitted') {
 const {page,context}=person,detail=await api(context,origin,`claims/${claimId}`)
 const frozen=detail.revisions.at(-1).snapshot.policyReview
 const section=page.getByRole('region',{name:'Policy review',exact:true})
 await section.getByRole('heading',{name:`Policy review · revision ${detail.claim.revision}`,exact:true}).waitFor()
 assert.equal(frozen.recommendations.length,detail.revisions.at(-1).snapshot.items.length)
 assert.match(await section.innerText(),/This advice grants no approval/)
 for(const r of frozen.recommendations){
  for(const reason of r.reasons)assert.ok((await section.innerText()).includes(reason.message),'AGENT-005 actual evaluator reason is visible')
 }
 for(const disclosure of await section.getByText('Review evidence',{exact:true}).all())if(!await disclosure.evaluate(el=>el.parentElement.open))await disclosure.click()
 for(const r of frozen.recommendations)if(r.evidence.receipt)assert.ok((await section.innerText()).includes(r.evidence.receipt.sha256),'AGENT-005 exact receipt citation is visible')
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`AGENT-005 no overflow at ${width}`)
 const path=join(evidence,`policy-review-${phase}-${width}.jpg`);await section.screenshot({path,type:'jpeg',quality:85});shots.push({screen:`policy-review-${phase}`,viewport:width,path})
 return frozen
}

/** AGENT-005 / FEED-004: owner consent and both per-expense approval forms in
 * native screens. Set-up calls use the same signed-in public API as the app. */
export async function policyAgentScreens(browser,root,server,evidence){
 const {readFile}=await import('node:fs/promises'),{session,PEOPLE}=await import('./browser-journey.mjs'),{assertAccessible}=await import('./browser-accessibility.mjs');
 const origin=server.origin;
 for(const width of [1440,390]){
  const owner=await session(browser,root,origin,'owner',width),employee=await session(browser,root,origin,'employee',width),manager=await session(browser,root,origin,'manager',width),finance=await session(browser,root,origin,'finance',width);
  try{
   const state=await api(owner.context,origin,'state'),category=state.categories.find(c=>c.name==='Meals').id,currency=state.business.currency;
   const rules=await api(owner.context,origin,'coding/automatic/rules');
   if(!rules.rules.some(r=>r.merchant==='Lunch'&&r.active))await api(owner.context,origin,'coding/automatic/rules',{version:rules.version,scope:'finance',merchant:'Lunch',coding:{category},active:true});
   const shot=async(page,name,target=page)=>{await assertAccessible(page,`${name} at ${width}`);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name} fits ${width}`);await target.screenshot({path:join(evidence,`${name}-${width}.png`)});};
   await owner.page.goto(origin+'/app#/settings');await owner.page.reload();
   const envelope=owner.page.getByRole('region',{name:'Policy agent envelope',exact:true});
   await envelope.getByLabel('Enable the policy agent envelope',{exact:true}).check();await envelope.getByLabel('Envelope expense limit',{exact:true}).fill('100.00');
   const consent=envelope.getByLabel('I authorize qualifying approvals on my behalf',{exact:true});assert.equal(await consent.isChecked(),false);await consent.check();
   await shot(owner.page,'policy-agent-consent',envelope);
   await Promise.all([owner.page.waitForResponse(r=>r.url().endsWith('/settings/approval-envelope')&&r.status()===200),envelope.getByRole('button',{name:'Save policy agent envelope',exact:true}).click()]);
   const granted=(await api(owner.context,origin,'state')).approvalEnvelope;assert.equal(granted.enabled,1);
   await api(owner.context,origin,'settings/audit-sample',{percent:'100'});
   async function original(name,fixture,merchant,total,date){
    await employee.page.goto(origin+'/app#/claims');await employee.page.reload();
    const inbox=employee.page.getByRole('region',{name:'Receipt inbox',exact:true});
    await inbox.getByLabel('Upload receipts',{exact:true}).setInputFiles({name,mimeType:'image/png',buffer:await readFile(`tests/fixtures/policy-review/synthetic-coaster-${fixture}.png`)});
    const row=inbox.locator('.receipt-inbox-list > li').filter({has:employee.page.getByRole('link',{name,exact:true})});await row.getByRole('link',{name,exact:true}).waitFor();
    const receipt=(await api(employee.context,origin,'receipt-inbox')).receipts.find(r=>r.name===name);
    await api(employee.context,origin,`receipt-inbox/${receipt.id}/card-match`,{expectedSequence:receipt.lifecycleSequence,enabled:true,merchant,date,total,currency,notice:receipt.matchChoice.notice});return receipt.id;
   }
   async function statement(name,rows){
    const issuer=`${name} ${width}`;await api(owner.context,origin,'statements/cards',{issuer,last4:'1111',employee:PEOPLE.employee});
    const body={format:'csv',name:`${name}-${width}.csv`,issuer,category,content:'Date,Merchant,Amount,Id\n'+rows.map(([merchant,amount,date],i)=>`${date},${merchant},${amount},synthetic-coaster-${width}-${name}-${i}`).join('\n'),mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',transactionId:'Id',wholeFileLast4:'1111'}};
    const preview=await api(owner.context,origin,'statements/preview',body);return api(owner.context,origin,'statements/commit',{...body,fingerprint:preview.fingerprint});
   }
   async function submitMixed(job,flagged){
    let detail=await api(employee.context,origin,`claims/${job.claims[0]}`),item=detail.items.find(i=>i.merchant===flagged);
    const changed=await api(employee.context,origin,`claims/${detail.claim.id}/items`,{version:detail.claim.version,item:item.id,kind:'receipt',date:item.spent_on,merchant:item.merchant,amount:(item.amount_minor/100).toFixed(2),receipt:item.receipt_id,category,explanation:'This expense needs a person to review its exception'});
    await employee.page.goto(origin+`/app#/claims/${changed.id}`);await employee.page.reload();
    await Promise.all([employee.page.waitForResponse(r=>r.url().endsWith(`/claims/${changed.id}/submit`)&&r.status()===200),employee.page.getByRole('button',{name:'Submit for approval',exact:true}).click()]);
    return api(manager.context,origin,`claims/${changed.id}`);
   }
   await original(`synthetic-coaster-agent-lunch-${width}.png`,6001,'Lunch','60.00','2026-10-02');await original(`synthetic-coaster-agent-dinner-${width}.png`,6002,'Dinner','180.00','2026-10-02');
   const mixed=await statement('agent',[['Lunch','60.00','2026-10-02'],['Dinner','180.00','2026-10-02']]);const tick=await server.scheduled();assert.equal(tick.status,200);
   const detail=await submitMixed(mixed,'Dinner');assert.equal(detail.claim.status,'submitted');assert.equal(detail.revisions.at(-1).snapshot.expenseApprovals.length,1);assert.equal(detail.revisions.at(-1).snapshot.expenseApprovals[0].source,'agent');
   await manager.page.goto(origin+`/app#/approvals/${detail.claim.id}`);await manager.page.reload();
   const review=manager.page.getByRole('region',{name:'Policy review',exact:true});await review.getByText(`Approved by policy agent v${granted.version}`,{exact:true}).waitFor();await review.getByText('Coding needs review.',{exact:false}).waitFor();
   await review.getByRole('button',{name:'Agree with Lunch recommendation',exact:true}).click();await review.getByRole('button',{name:'Disagree with Dinner recommendation',exact:true}).click();await review.getByText(/\(50.0%\)/).waitFor();
   for(const disclosure of await review.getByText('Review evidence',{exact:true}).all())await disclosure.click();await shot(manager.page,'policy-agent-cited-review',review);
   await owner.page.reload();await envelope.getByLabel('Enable the policy agent envelope',{exact:true}).uncheck();
   await Promise.all([owner.page.waitForResponse(r=>r.url().endsWith('/settings/approval-envelope')&&r.status()===200),envelope.getByRole('button',{name:'Save policy agent envelope',exact:true}).click()]);
   await envelope.getByText('No active approval envelope',{exact:true}).waitFor();await shot(owner.page,'policy-agent-revoked',envelope);
   await original(`synthetic-coaster-agent-next-${width}.png`,6003,'Lunch','60.00','2026-10-03');const next=await statement('revoked',[['Lunch','60.00','2026-10-03']]);await server.scheduled();
   let nextDetail=await api(employee.context,origin,`claims/${next.claims[0]}`);const nextClaim=await api(employee.context,origin,`claims/${nextDetail.claim.id}/submit`,{version:nextDetail.claim.version});assert.equal(nextClaim.status,'submitted');nextDetail=await api(manager.context,origin,`claims/${nextClaim.id}`);assert.equal(nextDetail.revisions[0].snapshot.expenseApprovals,undefined);assert.equal(nextDetail.revisions[0].snapshot.policyReview.recommendations[0].evidence.agentEligible,true);
   // Same mixed-report foundation, now with APPROVE-004's rule instead of an envelope.
   const policy=(await api(owner.context,origin,'policy')).versions[0];
   await api(owner.context,origin,'policy',{rules:[...policy.rules.map(r=>'limit_minor'in r?{...r,limit:(r.limit_minor/100).toFixed(2)}:r),...policy.rules.some(r=>r.kind==='blocked-merchant'&&r.merchant==='Flagged Dinner')?[]:[{kind:'blocked-merchant',merchant:'Flagged Dinner',hard:false}]]});
   const rule=await api(owner.context,origin,'settings/approval-rule',{enabled:true,limit:'75.00'});
   await original(`synthetic-coaster-rule-lunch-${width}.png`,6004,'Lunch','40.00','2026-10-02');await original(`synthetic-coaster-rule-dinner-${width}.png`,6005,'Flagged Dinner','40.00','2026-10-20');
   const cards=await statement('rule',[['Lunch','40.00','2026-10-02'],['Flagged Dinner','40.00','2026-10-20']]);await server.scheduled();const cardClaim=await submitMixed(cards,'Flagged Dinner');assert.equal(cardClaim.claim.status,'submitted');assert.equal(cardClaim.revisions[0].snapshot.expenseApprovals[0].actor,`rule v${rule.version}`);
   await manager.page.goto(origin+`/app#/approvals/${cardClaim.claim.id}`);await manager.page.reload();await review.getByText(`Approved by rule v${rule.version}`,{exact:true}).waitFor();await shot(manager.page,'card-rule-mixed-review',review);
   await finance.page.goto(origin+'/app#/batches');await finance.page.reload();const sample=finance.page.getByRole('region',{name:'Audit sample',exact:true});await sample.getByText(new RegExp(`rule v${rule.version}.*expense approval`)).waitFor();await shot(finance.page,'card-expense-audit-sample',sample);
   await api(owner.context,origin,'settings/approval-rule',{enabled:false});
  }finally{await owner.context.close();await employee.context.close();await manager.context.close();await finance.context.close();}
 }
}

// The combined proof uses an independent US installation so it does not change
// the existing AUD baseline journeys or their immutable financial fixtures.
if(process.argv[1]&&import.meta.url===(await import('node:url')).pathToFileURL(process.argv[1]).href){
 const {chromium}=await import('@playwright/test'),{fresh,freePort,command,start}=await import('./browser-runtime.mjs'),{session,setUp,api}=await import('./browser-journey.mjs'),{mkdir,rm,writeFile}=await import('node:fs/promises'),{resolve}=await import('node:path'),{execFileSync}=await import('node:child_process');
 const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/policy-agent-proof');let root,server,browser;
 try{
  await mkdir(evidence,{recursive:true});root=await fresh();await command(root,['install']);const port=await freePort();await command(root,['setup','--owner-email','owner@harbourfinch.example','--port',String(port)]);server=await start(root,port);browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
  const owner=await session(browser,root,server.origin,'owner',1440);await setUp(owner,server.origin);await api(owner.context,server.origin,'settings/business',{name:'Synthetic Coaster',currency:'USD',timezone:'America/New_York',receiptThreshold:''});await owner.context.close();
  await policyAgentScreens(browser,root,server,evidence);
  await writeFile(join(evidence,'result.json'),JSON.stringify({sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),widths:[1440,390],clauses:['AGENT-005','FEED-004']},null,2)+'\n');console.log('AGENT-005 / FEED-004 envelope, citations, explicit agreement, revocation, mixed rule approval and samples passed at 1440/390');
 }finally{await browser?.close();await server?.close();if(root)await rm(root,{recursive:true,force:true});}
}
