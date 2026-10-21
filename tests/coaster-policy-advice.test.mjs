// AGENT-003 through signed-in HTTP doors and the real policy/claim lifecycle.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness } from './harness.mjs'

async function fixture(h, financeOnly=false) {
  const t = await agency(h)
  await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', receiptThreshold: '200.00' })
  await h.post('settings/categories', { id: t.c.meals, name: 'Meals', accountCode: '6300', taxCode: 'GST', ...(financeOnly ? {} : {limit:'50.00'}) })
  if(financeOnly) await h.post('policy',{rules:[{kind:'per-expense-limit',category:t.c.meals,limit:'50.00'}]},t.morgan)
  const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
  const day = new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10)
  const create = async (merchant, amount, decide=true) => {
    let c = await h.post('claims', { title: merchant }, t.sam)
    c = await h.post(`claims/${c.id}/items`, { version: c.version, kind:'receipt', date:day, merchant, amount, allocations:[{category:t.c.meals}], explanation:'Client meeting required this venue' }, t.sam)
    c = await h.post(`claims/${c.id}/submit`, {version:c.version}, t.sam)
    if(decide) c = await h.post(`claims/${c.id}/decision`, {version:c.version, revision:c.revision, decision:'approved', acknowledge:true}, t.priya)
    return c
  }
  const claims = [await create('North client lunch','60.00'),await create('East client lunch','70.00')]
  assert.deepEqual((await h.post('policy/advice',{minutesPerException:1},t.morgan)).suggestions,[],'two approvals do not establish a recurring exception')
  claims.push(await create('West client lunch','75.00'))
  return {...t,create,claims}
}

test('AGENT-003 finance replays approved recurring exceptions with affected claims and an explicit hours estimate; owner adoption changes today’s policy only', async () => {
  const h=await harness()
  try {
    const t=await fixture(h), request={minutesPerException:4}
    await h.post('policy/advice',request,t.sam,403)
    await h.post('policy/advice',request,t.priya,403)
    await h.post('policy/advice',{minutesPerException:0},t.morgan,400)
    const key=await h.post('agent-keys',{label:'Finance assistant'},t.morgan)
    assert.equal((await h.send('/api/coaster/policy/advice',request,'',{authorization:`Bearer ${key.token}`})).status,401,'current agent keys gain no history access')
    const pending=await t.create('Pending dinner','90.00',false)
    await t.create('Compliant lunch','40.00')
    const before=await Promise.all(t.claims.map(c=>h.get(`claims/${c.id}`,t.priya)))
    const outboundBefore=h.outbound.length
    const replay=await h.post('policy/advice',request,t.morgan), s=replay.suggestions[0]
    assert.equal(h.outbound.length,outboundBefore,'policy replay has no external egress')
    assert.deepEqual([s.currentLimitMinor,s.proposedLimitMinor,s.approvedExceptions,s.before,s.after,s.estimatedHoursSaved,s.estimate],[5000,7500,3,4,1,0.2,true])
    assert.deepEqual(s.affected.map(c=>c.id).sort(),t.claims.map(c=>c.id).sort())
    assert.deepEqual(s.affected.flatMap(c=>c.expenses.map(i=>i.amountMinor)).sort((a,b)=>a-b),[6000,7000,7500])
    assert.ok(!s.affected.some(c=>c.id===pending.id),'a larger expense remains over the proposed limit')
    await h.post('policy/advice/adopt',{category:s.category,proposalToken:s.proposalToken,...request},t.morgan,403)
    const versions=(await h.get('policy',t.morgan)).versions.length
    await h.post('policy/advice/adopt',{category:s.category,proposalToken:'0'.repeat(64),...request},h.owner,409)
    assert.equal((await h.get('policy',t.morgan)).versions.length,versions,'tampering writes nothing')
    const adopted=await h.post('policy/advice/adopt',{category:s.category,proposalToken:s.proposalToken,...request})
    const active=(await h.get('policy',t.morgan)).versions[0]
    assert.ok(adopted.policyVersion>replay.policyVersion)
    assert.equal(active.effective_from,adopted.effectiveFrom)
    assert.equal(active.effective_from,new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()))
    assert.equal((await h.get('state')).categories.find(c=>c.id===t.c.meals).limit_minor,7500)
    for(let i=0;i<t.claims.length;i++) {
      const after=await h.get(`claims/${t.claims[i].id}`,t.priya)
      assert.deepEqual(after.revisions,before[i].revisions)
      assert.deepEqual(after.decisions,before[i].decisions)
      assert.deepEqual(after.exceptions,before[i].exceptions)
    }
    assert.deepEqual((await h.post('policy/advice',request,t.morgan)).suggestions,[],'adopted cap removes the recurring exception under replay')
    const newClaim=await t.create('Next lunch','75.00',false)
    assert.deepEqual((await h.get(`claims/${newClaim.id}`,t.priya)).exceptions,[])
    const audit=(await h.get('history')).lines.find(e=>e.action==='policy-advice-adopted')
    assert.ok(audit,'adoption is recorded in append-only history')
  } finally {await h.close()}
})

test('AGENT-003 stale history or policy refuses adoption; finance rules can be raised without tightening a higher cap and hard rules never become suggestions', async () => {
  const h=await harness()
  try {
    const t=await fixture(h), request={minutesPerException:3}
    const s=(await h.post('policy/advice',request,t.morgan)).suggestions[0]
    await t.create('Changed history','65.00')
    await h.post('policy/advice/adopt',{category:s.category,proposalToken:s.proposalToken,...request},h.owner,409)
    const fresh=(await h.post('policy/advice',request,t.morgan)).suggestions[0]
    await h.post('policy',{rules:[{kind:'per-expense-limit',category:t.c.meals,limit:'100.00'}]},t.morgan)
    await h.post('policy/advice/adopt',{category:fresh.category,proposalToken:fresh.proposalToken,...request},h.owner,409)
    const next=(await h.post('policy/advice',request,t.morgan)).suggestions[0]
    await h.post('policy/advice/adopt',{category:next.category,proposalToken:next.proposalToken,...request})
    assert.equal((await h.get('policy',t.morgan)).versions[0].rules[0].limit_minor,10000,'a higher finance cap stays higher')
    await h.post('settings/categories',{id:t.c.meals,name:'Meals',accountCode:'6300',taxCode:'GST',limit:'50.00'})
    await h.post('policy',{rules:[{kind:'per-expense-limit',category:t.c.meals,limit:'10.00',hard:true}]},t.morgan)
    assert.deepEqual((await h.post('policy/advice',request,t.morgan)).suggestions,[],'hard limits are not proposed for automatic relaxation')
  } finally {await h.close()}
})

test('AGENT-003 a finance-only category cap is replayed and versioned on adoption without creating an owner floor', async () => {
  const h=await harness()
  try {
    const t=await fixture(h,true), request={minutesPerException:5}
    const s=(await h.post('policy/advice',request,t.morgan)).suggestions[0]
    assert.deepEqual([s.currentLimitMinor,s.proposedLimitMinor,s.before,s.after],[5000,7500,3,0])
    await h.post('policy/advice/adopt',{category:s.category,proposalToken:s.proposalToken,...request})
    assert.equal((await h.get('state')).categories.find(c=>c.id===t.c.meals).limit_minor,null)
    assert.equal((await h.get('policy',t.morgan)).versions[0].rules[0].limit_minor,7500)
  } finally {await h.close()}
})

test('AGENT-003 every current finance rule kind surfaces recurring approvals and previews a removal without changing the owner floor or history', async () => {
  const h = await harness()
  try {
    const t = await agency(h)
    await h.post('settings/business', {name:'Juniper Design',currency:'AUD',timezone:'Australia/Sydney',receiptThreshold:'10000'})
    const cat=t.c.office, yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10), old=new Date(Date.now()-10*86400000).toISOString().slice(0,10)
    let trip=await h.post('requests',{title:'Field work',estimate:'200',purpose:'Client visit'},t.sam)
    trip=await h.post(`requests/${trip.id}/decision`,{version:trip.version,decision:'approved'},t.priya)
    const allRules=[
      {kind:'per-expense-limit',category:cat,limit:'1'}, {kind:'attendee-limit',category:cat,limit:'1'},
      {kind:'daily-limit',category:cat,limit:'1'}, {kind:'monthly-limit',category:cat,limit:'1'}, {kind:'trip-limit',category:cat,limit:'1'},
      {kind:'receipt-threshold',limit:'1'}, {kind:'required-field',category:cat,field:'Engagement'},
      {kind:'blocked-category',category:cat}, {kind:'blocked-merchant',merchant:'Recurring merchant'},
      {kind:'weekend'}, {kind:'holiday'}, {kind:'approval-required',category:cat}, {kind:'deadline',days:2},
    ]
    for(const rule of allRules) {
      await h.post('policy',{rules:[rule]},t.morgan)
      let c=await h.post('claims',{title:`Recurring ${rule.kind}`},t.sam)
      const date=rule.kind==='holiday'?'2026-01-19':rule.kind==='weekend'?'2026-01-18':rule.kind==='deadline'?old:yesterday
      for(let i=0;i<3;i++) c=await h.post(`claims/${c.id}/items`,{version:c.version,kind:'receipt',date,merchant:rule.kind==='blocked-merchant'?'Recurring merchant':`${rule.kind} purchase ${i}`,amount:String(10+i),allocations:[{category:cat}],explanation:'Approved client work outside standard policy',...(rule.kind==='trip-limit'?{request:trip.id}:{})},t.sam)
      c=await h.post(`claims/${c.id}/submit`,{version:c.version},t.sam)
      c=await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved',acknowledge:true,override:'Client engagement approved; override recorded'},t.priya)
      const saved=await h.get(`claims/${c.id}`,t.sam), traffic=h.outbound.length
      const replay=await h.post('policy/advice',{minutesPerException:6},t.morgan)
      assert.equal(h.outbound.length,traffic)
      const s=replay.ruleSuggestions.find(s=>s.kind===rule.kind)
      assert.ok(s,`recurring ${rule.kind} has a supported proposal`)
      assert.equal(s.approvedExceptions,3,rule.kind)
      assert.ok(s.affected.some(a=>a.id===c.id && a.expenses.length===3),rule.kind)
      assert.ok(s.before>s.after,rule.kind)
      assert.ok(s.estimatedHoursSaved>0,rule.kind)
      assert.equal(s.approval.estimatedReviewHoursDelta,-s.estimatedHoursSaved)
      assert.equal(s.reimbursement.awaitingReimbursementMinor>=3300,true)
      assert.deepEqual((await h.get(`claims/${c.id}`,t.sam)).revisions,saved.revisions)
      assert.deepEqual((await h.get(`claims/${c.id}`,t.sam)).decisions,saved.decisions)
    }
    await h.post('policy',{rules:[{kind:'weekend',hard:true}]},t.morgan)
    assert.deepEqual((await h.post('policy/advice',{minutesPerException:6},t.morgan)).ruleSuggestions,[],'hard rules never get automatic relaxation suggestions')
  } finally { await h.close() }
})

test('AGENT-003 finance previews tightening, approval effort and reimbursement eligibility; only the owner adopts the exact preview and historical payment stays unchanged',async()=>{
  const h=await harness()
  try {
    const t=await fixture(h),minutesPerException=4
    let batch=await h.post('batches',{claims:t.claims.map(c=>c.id)},t.morgan)
    batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:20500},t.morgan)
    await h.paid(batch.id, batch.version, { reference:'External payroll 910',paidOn:new Date().toISOString().slice(0,10)},t.morgan)
    const original=await h.get(`claims/${t.claims[0].id}`,t.sam)
    const proposedRules=[{kind:'per-expense-limit',category:t.c.meals,limit:'55',hard:true}]
    const versions=(await h.get('policy',t.morgan)).versions.length
    const {preview:p}=await h.post('policy/advice',{minutesPerException,proposedRules},t.morgan)
    assert.equal((await h.get('policy',t.morgan)).versions.length,versions,'preview is nonwriting')
    assert.equal(p.reimbursement.recordedReimbursedMinor,20500)
    assert.deepEqual([p.reimbursement.eligibleBeforeMinor,p.reimbursement.eligibleAfterMinor],[20500,0])
    assert.equal(p.affected.length,3)
    assert.ok(p.affected.every(c=>!c.blockedBefore && c.blockedAfter && c.status==='reimbursed'))
    assert.equal(p.approval.predictedDecisionTime,null)
    const details=await Promise.all(t.claims.map(c=>h.get(`claims/${c.id}`,t.sam)))
    const expectedObserved=details.reduce((sum,d)=>sum+Math.max(0,(Date.parse(d.decisions.find(d=>d.decision==='approved').at)-Date.parse(d.revisions[0].submitted_at))/3600000),0)
    assert.equal(p.approval.observedHoursOnAffectedClaims,expectedObserved)
    assert.ok(p.estimatedHoursSaved<0)
    const body={minutesPerException,proposedRules,proposalToken:p.proposalToken}
    await h.post('policy/advice/adopt',body,t.morgan,403)
    await h.post('policy/advice/adopt',{...body,proposedRules:[]},h.owner,409)
    await h.post('policy/advice',{minutesPerException,proposedRules:[{kind:'deadline',days:0}]},t.morgan,400)
    assert.equal((await h.get('policy',t.morgan)).versions.length,versions)
    await t.create('History changed after preview','40.00',false)
    await h.post('policy/advice/adopt',body,h.owner,409)
    await h.post('policy',{rules:[]},t.morgan)
    await h.post('policy/advice/adopt',body,h.owner,409)
    const activeVersionBefore=(await h.get('policy',t.morgan)).versions[0].version
    const refreshed=(await h.post('policy/advice',{minutesPerException,proposedRules},t.morgan)).preview
    const adopted=await h.post('policy/advice/adopt',{...body,proposalToken:refreshed.proposalToken})
    assert.ok(adopted.policyVersion>activeVersionBefore)
    const active=(await h.get('policy',t.morgan)).versions[0]
    assert.deepEqual(active.rules,[{kind:'per-expense-limit',category:t.c.meals,limit_minor:5500,hard:true}])
    assert.equal(active.configuration.categories.find(c=>c.id===t.c.meals).limit_minor,5000,'finance candidate cannot remove the owner floor')
    const after=await h.get(`claims/${t.claims[0].id}`,t.sam)
    assert.deepEqual(after.revisions,original.revisions)
    assert.deepEqual(after.decisions,original.decisions)
    assert.equal(after.claim.status,'reimbursed')
    assert.equal((await h.get('history')).lines.filter(e=>e.action==='policy-advice-adopted').length,1)
    const fresh=await h.post('claims',{title:'New strict rule'},t.sam)
    const item=await h.post(`claims/${fresh.id}/items`,{version:fresh.version,kind:'receipt',date:new Date().toISOString().slice(0,10),merchant:'Strict dinner',amount:'60',allocations:[{category:t.c.meals}],explanation:'Outside rule'},t.sam)
    await h.post(`claims/${item.id}/submit`,{version:item.version},t.sam,409)
  }finally{await h.close()}
})

test('FEED-004 AGENT-003 card spend replays tightening and relaxation without becoming reimbursement or changing posted evidence', async () => {
  const h = await harness()
  try {
    const t = await agency(h)
    await h.post('settings/business', { name:'Harbour & Finch Studio', currency:'AUD', timezone:'Australia/Sydney', receiptThreshold:'200.00' })
    await h.post('settings/categories', { id:t.c.meals, name:'Meals', accountCode:'6300', taxCode:'GST' })
    await h.post('policy', { rules:[{kind:'per-expense-limit',category:t.c.meals,limit:'30.00'}] }, t.morgan)
    const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
    const day = today.replaceAll('-', '')
    const input = { format:'ofx', name:'replay.ofx', issuer:'Synthetic Replay Card', category:t.c.meals,
      content:`OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>AUD<CCACCTFROM><ACCTID>1111</CCACCTFROM><BANKTRANLIST><DTSTART>${day}<DTEND>${day}${[48.20,120,23.45].map((amount,i)=>`<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${day}<TRNAMT>-${amount.toFixed(2)}<FITID>REPLAY-${i}<NAME>Replay merchant ${i}</STMTTRN>`).join('')}</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>` }
    await h.post('statements/cards', {issuer:input.issuer,last4:'1111',employee:'sam@harbourfinch.example'})
    const preview = await h.post('statements/preview', input, t.morgan)
    const posted = await h.post('statements/commit', {...input,fingerprint:preview.fingerprint}, t.morgan)
    const cardClaim = posted.claims[0]
    for (const item of (await h.get(`claims/${cardClaim}`,t.sam)).items) {
      const c = (await h.get(`claims/${cardClaim}`,t.sam)).claim
      await h.post(`claims/${cardClaim}/items`,{version:c.version,item:item.id,kind:'receipt',date:item.spent_on,merchant:item.merchant,amount:(item.amount_minor/100).toFixed(2),category:t.c.meals,explanation:'Company card business purchase'},t.sam)
    }
    // A mixed report must keep its cash reimbursement while excluding every card amount.
    await h.post(`claims/${cardClaim}/items`, {version:(await h.get(`claims/${cardClaim}`,t.sam)).claim.version,kind:'receipt',date:today,merchant:'Cash taxi',amount:'10.00',category:t.c.meals,explanation:'Paid personally'}, t.sam)
    const approve = async id => {
      let c = (await h.get(`claims/${id}`,t.sam)).claim
      c = await h.post(`claims/${id}/submit`,{version:c.version},t.sam)
      return h.post(`claims/${id}/decision`,{version:c.version,revision:c.revision,decision:'approved',acknowledge:true},t.priya)
    }
    await approve(cardClaim)
    let paid = await h.post('claims',{title:'Paid cash meal'},t.sam)
    paid = await h.post(`claims/${paid.id}/items`,{version:paid.version,kind:'receipt',date:today,merchant:'Cash meal',amount:'40.00',category:t.c.meals,explanation:'Client meal'},t.sam)
    paid = await approve(paid.id)
    let batch = await h.post('batches',{claims:[paid.id]},t.morgan)
    batch = await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:4000},t.morgan)
    await h.paid(batch.id,batch.version,{reference:'Replay cash payment',paidOn:today},t.morgan)
    const ids = [cardClaim,paid.id]
    const before = await Promise.all(ids.map(id=>h.get(`claims/${id}`,t.sam)))
    const charges = (await h.get('statements',t.morgan)).charges
    const cardItems = before[0].items.filter(i=>i.card_charge_id)
    const request = proposedRules=>h.post('policy/advice',{minutesPerException:4,proposedRules},t.morgan)
    const tight = (await request([{kind:'per-expense-limit',category:t.c.meals,limit:'20.00',hard:true}])).preview
    assert.deepEqual([tight.before,tight.after],[3,4])
    assert.deepEqual(tight.reimbursement,{eligibleBeforeMinor:5000,eligibleAfterMinor:0,recordedReimbursedMinor:4000,awaitingReimbursementMinor:1000,estimate:true})
    const changed = tight.affected.find(c=>c.id===cardClaim)
    assert.equal(changed.amountMinor,20165)
    assert.deepEqual(changed.expenses.map(i=>i.id).sort(),cardItems.map(i=>i.id).sort())
    for (const item of cardItems) {
      const effect = changed.expenses.find(i=>i.id===item.id)
      assert.equal(effect.before.length,item.amount_minor>3000?1:0)
      assert.equal(effect.after.length,1)
      assert.ok(effect.after[0].hard)
      assert.equal(effect.amountMinor,item.amount_minor)
    }
    const relaxed = (await request([])).preview
    assert.deepEqual([relaxed.before,relaxed.after],[3,0])
    assert.deepEqual(relaxed.reimbursement,{eligibleBeforeMinor:5000,eligibleAfterMinor:5000,recordedReimbursedMinor:4000,awaitingReimbursementMinor:1000,estimate:true})
    assert.deepEqual(relaxed.affected.find(c=>c.id===cardClaim).expenses.map(i=>i.id).sort(),cardItems.filter(i=>i.amount_minor>3000).map(i=>i.id).sort())
    assert.ok(relaxed.affected.flatMap(c=>c.expenses).every(i=>i.before.length===1 && i.after.length===0))
    assert.deepEqual((await h.get('statements',t.morgan)).charges,charges)
    assert.deepEqual(await Promise.all(ids.map(id=>h.get(`claims/${id}`,t.sam))),before,'both previews preserve charges, revisions, decisions and recorded payment')
  } finally { await h.close() }
})
