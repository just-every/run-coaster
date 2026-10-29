import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness } from './harness.mjs'
import { closePeriod, importCloseStatement, prepareClose } from './close-statement-kit.mjs'

const proposalRows = h => h.db.prepare('SELECT * FROM c_proposals ORDER BY id').all().then(r => r.results)
const history = h => h.db.prepare('SELECT * FROM c_events ORDER BY seq').all().then(r => r.results)
const financial = async h => {
  const tables = ['c_claims','c_items','c_card_charges','c_card_statements','c_card_statement_resolutions','c_card_ledger','c_batches','c_reimbursement_keys']
  return Promise.all(tables.map(async table => [table, (await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results]))
}
async function unchangedRefusal(h, id, act) {
  const before = [await proposalRows(h), await history(h), await financial(h)]
  await act()
  assert.deepEqual([await proposalRows(h), await history(h), await financial(h)], before, 'refused review changes no proposal, history or financial record')
  assert.equal((await proposalRows(h)).find(p => p.id === id).status, 'proposed')
}

test('Close review assesses overlapping native statements, missing reconciliation and exact differences without posting or changing accruals', async () => {
  const h = await harness()
  try {
    const t = await agency(h), employee = (await h.get('state', t.sam)).actor.email
    const door = (path, body) => h.post(path, body)
    const overlap = await importCloseStatement(door, t.c.office, employee)
    let rec = await overlap.open()
    const outside = await importCloseStatement(door, t.c.office, employee, { last4:'8822', start:'20260401',end:'20260430',date:'20260410',credit:false,key:'synthetic-coaster-822' })
    await outside.open()
    const after = await importCloseStatement(door, t.c.office, employee, { last4:'8823', start:'20260601',end:'20260630',date:'20260610',credit:false,key:'synthetic-coaster-823' })
    await after.open()
    const unknown = await importCloseStatement(door, t.c.office, employee, { last4:'8824', start:null,credit:false,key:'synthetic-coaster-824' })
    await unknown.open()
    const missing = await importCloseStatement(door, t.c.office, employee, { last4:'8825',start:null,end:null,credit:false,key:'synthetic-coaster-825' })
    const before = await financial(h), outbound = h.outbound.length
    let p = await prepareClose(h)
    assert.deepEqual(p.payload.cardEvidence.statements.map(s => s.card.last4).sort(), ['8821','8824'])
    const assessment = p.payload.cardEvidence.statements.find(s => s.id === rec.id)
    assert.deepEqual([assessment.period,assessment.status,assessment.unresolved,assessment.statementMinor,assessment.coasterMinor,assessment.differenceMinor,assessment.verified], [{start:'2026-04-20',end:'2026-06-05'},'open',1,1033,1234,-201,false])
    assert.deepEqual(assessment.differences.map(d => [d.descriptor,d.amountMinor,d.resolution]), [['Synthetic close refund',201,null]])
    assert.equal(p.payload.cardEvidence.statements.find(s => s.card.last4 === '8824').periodKnown,false)
    assert.equal(p.payload.cardEvidence.statements.find(s => s.card.last4 === '8824').verified,false)
    assert.deepEqual(p.payload.cardEvidence.missing.map(s => [s.file,s.last4,s.amountMinor]), [[missing.file,'8825',1234]])
    assert.ok(p.payload.checklist.some(s => s.label.includes('period boundaries unverified')))
    assert.ok(!JSON.stringify(p.payload).includes('Synthetic close purchase'), 'private draft descriptions are excluded from aggregates')
    assert.equal(p.payload.accrualMinor,3702)
    assert.deepEqual(p.payload.departments.map(d => [d.amountMinor,d.unsubmittedMinor]), [[3702,3702]])
    assert.deepEqual(await financial(h),before,'preparation changes no financial records')
    const totals = p.payload.departments
    // A balance restatement changes the assessment without changing claim totals.
    await h.post(`statements/${overlap.file}/reconcile`, {last4:overlap.last4,openingBalance:'1.00'})
    await unchangedRefusal(h,p.id,()=>h.post(`proposals/${p.id}/accept`,{},h.owner,409))
    p = await prepareClose(h)
    assert.equal(p.payload.cardEvidence.statements.find(s=>s.id===rec.id).differenceMinor,-301)
    assert.deepEqual(p.payload.departments,totals)
    await h.post(`statements/${overlap.file}/reconcile`,{last4:overlap.last4,openingBalance:'0.00'})
    p = await prepareClose(h)
    rec = await h.post(`statements/reconciliations/${rec.id}/resolve`,{line:2,resolution:'credit',note:'Synthetic refund reviewed'})
    await unchangedRefusal(h,p.id,()=>h.post(`proposals/${p.id}/accept`,{},h.owner,409))
    p = await prepareClose(h)
    const resolved = p.payload.cardEvidence.statements.find(s=>s.id===rec.id)
    assert.deepEqual([resolved.unresolved,resolved.differenceMinor,resolved.verified],[0,0,false],'resolved is still open')
    assert.equal(resolved.differences[0].resolution.resolution,'credit')
    await h.post(`statements/reconciliations/${rec.id}/close`,{})
    await unchangedRefusal(h,p.id,()=>h.post(`proposals/${p.id}/accept`,{},h.owner,409))
    p = await prepareClose(h)
    const closed = p.payload.cardEvidence.statements.find(s=>s.id===rec.id)
    assert.equal(closed.verified,true)
    assert.deepEqual([closed.ledger.cardAccountMinor,closed.ledger.statementMinor,closed.ledger.matches],[1033,1033,true])
    assert.ok(p.payload.checklist.some(s=>s.label.includes('Ledger clearance')),'native closure does not establish external clearance')
    // An existing imported file newly entering reconciliation invalidates the prior review.
    const newStatement = await importCloseStatement(door,t.c.office,employee,{last4:'8826',credit:false,key:'synthetic-coaster-826'})
    p = await prepareClose(h)
    await newStatement.open()
    await unchangedRefusal(h,p.id,()=>h.post(`proposals/${p.id}/accept`,{},h.owner,409))
    p = await prepareClose(h)
    const stable = await financial(h)
    await h.post(`proposals/${p.id}/accept`,{})
    await unchangedAcceptedRefusal(h,p.id)
    assert.deepEqual(await financial(h),stable,'acceptance records review only, including the exact native ledger')
    assert.equal(h.outbound.length,outbound,'no posting or chase is sent')
  } finally { await h.close() }
})

async function unchangedAcceptedRefusal(h,id) {
  const before = [await proposalRows(h),await history(h)]
  await h.post(`proposals/${id}/accept`,{},h.owner,409)
  assert.deepEqual([await proposalRows(h),await history(h)],before)
}

test('Close preparation and acceptance fence concurrent source changes at both guards and refuse delegates and agent keys without writes', async () => {
  let h, pause
  h = await harness({d1Barrier:async request=>{
    if(request.url.endsWith('/before-close-review') && pause) {const action=pause;pause=null;await action()}
    return new Response('open')
  }})
  try {
    const t=await agency(h), employee=(await h.get('state',t.sam)).actor.email
    const file=await importCloseStatement((path,body)=>h.post(path,body),t.c.office,employee,{credit:false})
    const rec=await file.open(), change=()=>h.post(`statements/${file.file}/reconcile`,{last4:file.last4,openingBalance:'1.00'})
    const before=await proposalRows(h)
    pause=change
    await h.post(['preparations','close'].join('/'),closePeriod,h.owner,409)
    assert.deepEqual(await proposalRows(h),before,'first preparation guard refuses source changed after its read')
    let p=await prepareClose(h)
    pause=()=>h.post(`statements/${file.file}/reconcile`,{last4:file.last4,openingBalance:'2.00'})
    const eventsBefore=(await history(h)).filter(e=>e.action==='proposal-accepted')
    await h.post(`proposals/${p.id}/accept`,{},h.owner,409)
    assert.equal((await proposalRows(h)).find(row=>row.id===p.id).status,'proposed')
    assert.deepEqual((await history(h)).filter(e=>e.action==='proposal-accepted'),eventsBefore)
    // Simulate a source changing inside the write transaction. The second guard
    // must roll the whole transaction back, including the trigger's mutation.
    for(const operation of ['INSERT','UPDATE']) {
      await h.db.prepare(`CREATE TRIGGER synthetic_close_change AFTER ${operation} ON c_proposals BEGIN UPDATE c_card_statements SET opening_minor=opening_minor+1 WHERE id='${rec.id}'; END`).run()
      const snapshot=[await proposalRows(h),await history(h),await financial(h)]
      if(operation==='INSERT') await h.post(['preparations','close'].join('/'),closePeriod,h.owner,409)
      else await h.post(`proposals/${p.id}/accept`,{},h.owner,409)
      assert.deepEqual([await proposalRows(h),await history(h),await financial(h)],snapshot,'second guard rolls back source, proposal and history')
      await h.db.prepare('DROP TRIGGER synthetic_close_change').run()
      p=await prepareClose(h)
    }
    const owner=(await h.get('state')).actor.email
    await h.post(['settings','members'].join('/'),{email:owner,name:'Native owner',employee:true})
    await h.post('delegates',{delegate:employee,level:'full'})
    const key=await h.post('agent-keys',{label:'synthetic-coaster-827'},t.sam)
    const snapshot=[await proposalRows(h),await history(h),await financial(h)]
    for(const [path,body] of [[['preparations','close'].join('/'),closePeriod],[`proposals/${p.id}/accept`,{}]]) {
      assert.equal((await h.send('/api/coaster/'+path,body,t.sam,{'x-coaster-acting-for':owner})).status,403)
      assert.equal((await h.send('/api/coaster/'+path,body,'',{authorization:`Bearer ${key.token}`})).status,401)
    }
    await h.post(['preparations','close'].join('/'),closePeriod,t.morgan,403)
    assert.deepEqual([await proposalRows(h),await history(h),await financial(h)],snapshot)
    await h.post(`proposals/${p.id}/accept`,{})
  } finally {await h.close()}
})
