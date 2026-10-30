import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness, receipt } from './harness.mjs'
import { personalInput, importPersonalStatement, personalPath } from './personal-spend-kit.mjs'

test('CARD-002 cardholders record exact unpaid company-card obligations once, preserving native money and private authority through undo and reimport', async () => {
  const h=await harness()
  try {
    const t=await agency(h), employee=(await h.get('state',t.sam)).actor.email
    const imported=await importPersonalStatement(h.post,t.c.office,employee)
    let d=await h.get(`claims/${imported.claims[0]}`,t.sam)
    const path=personalPath(d.claim.id), first=d.items[0], second=d.items[1]
    const state=()=>h.db.prepare('SELECT (SELECT COUNT(*) FROM c_card_personal_spend) AS marks,(SELECT COUNT(*) FROM c_events) AS events,(SELECT SUM(version) FROM c_claims) AS versions').first()
    const before=await state()
    for(const actor of [h.owner,t.morgan,t.priya,t.alex]) await h.post(path,{version:d.claim.version,item:first.id,charge:first.card_charge_id,confirm:true},actor,403)
    assert.deepEqual(await state(),before)
    await h.get(`claims/${d.claim.id}`,h.owner,403)
    const delegate=await h.post('delegates',{delegate:(await h.get('state',t.alex)).actor.email,level:'full'},t.sam)
    assert.ok(delegate)
    const delegated=await h.send('/api/coaster/'+path,{version:d.claim.version,item:first.id,charge:first.card_charge_id,confirm:true},t.alex,{'x-coaster-acting-for':employee})
    assert.equal(delegated.status,403)
    const key=await h.post('agent-keys',{label:'synthetic-coaster-1'},t.sam)
    assert.equal((await h.send('/api/coaster/'+path,{version:d.claim.version,item:first.id,charge:first.card_charge_id,confirm:true},'',{authorization:`Bearer ${key.token}`})).status,401)
    await h.post(path,{version:d.claim.version,item:first.id,charge:first.card_charge_id,confirm:false},t.sam,400)
    await h.post(path,{version:d.claim.version-1,item:first.id,charge:first.card_charge_id,confirm:true},t.sam,409)
    await h.post(path,{version:d.claim.version,item:first.id,charge:second.card_charge_id,confirm:true},t.sam,409)
    // A real receipt and manually entered reimbursable expense coexist with the classified charge.
    const upload=await h.post(`claims/${d.claim.id}/receipts`,{version:d.claim.version,item:first.id,...await receipt('bistro')},t.sam)
    d=await h.get(`claims/${d.claim.id}`,t.sam)
    assert.ok(upload.receipt)
    await h.post(`claims/${d.claim.id}/items`,{version:d.claim.version,kind:'receipt',date:'2026-05-10',merchant:'synthetic-coaster-3',amount:'7.89',allocations:[{category:t.c.office}],explanation:'Synthetic missing receipt'},t.sam)
    d=await h.get(`claims/${d.claim.id}`,t.sam)
    const facts=d.items, charges=(await h.db.prepare('SELECT * FROM c_card_charges ORDER BY id').all()).results
    const rec=await h.post(`statements/${imported.file}/reconcile`,{last4:'8839',openingBalance:'0.00'})
    const marked=await h.post(path,{version:d.claim.version,item:first.id,charge:first.card_charge_id,confirm:true},t.sam)
    assert.deepEqual(marked.balances,[{currency:'AUD',outstandingMinor:1234}])
    const once=await state()
    await h.post(path,{version:d.claim.version,item:first.id,charge:first.card_charge_id,confirm:true},t.sam,409)
    d=await h.get(`claims/${d.claim.id}`,t.sam)
    await h.post(path,{version:d.claim.version,item:first.id,charge:first.card_charge_id,confirm:true},t.sam,409)
    assert.deepEqual(await state(),once,'replay and repeated marking write nothing')
    await h.post(path,{version:d.claim.version,item:second.id,charge:second.card_charge_id,confirm:true},t.sam)
    d=await h.get(`claims/${d.claim.id}`,t.sam)
    assert.equal(d.claim.total_minor,789)
    assert.deepEqual(d.items.map(({personal_spend,...i})=>i),facts.map(({personal_spend,...i})=>i),'receipt, coding, amounts and immutable facts are unchanged')
    assert.deepEqual((await h.db.prepare('SELECT * FROM c_card_charges ORDER BY id').all()).results,charges)
    assert.deepEqual(d.personalSpend.balances,[{currency:'AUD',outstandingMinor:3580}])
    assert.deepEqual(d.items.filter(i=>i.card_charge_id).map(i=>i.personal_spend.outstanding_minor),[1234,2346])
    assert.deepEqual(await h.get(`statements/reconciliations/${rec.id}`),rec,'classification does not change statement reconciliation')
    const other=await h.get('personal-spend',t.alex);assert.deepEqual(other.balances,[]);assert.deepEqual(other.charges,[])
    const immutable=(await h.get('personal-spend',t.sam)).charges
    for(const method of ['PUT','PATCH','DELETE']) assert.equal((await h.mf.dispatchFetch(h.origin+'/api/coaster/'+path,{method,headers:{origin:h.origin,cookie:t.sam,'content-type':'application/json'},body:'{}'})).status,404)
    await assert.rejects(h.db.prepare('UPDATE c_card_personal_spend SET outstanding_minor=0').run(),/permanent/)
    await assert.rejects(h.db.prepare('DELETE FROM c_card_personal_spend').run(),/permanent/)
    // Undo may remove the untouched second charge, but its unpaid obligation remains; the receipt protects the first.
    const undo=await h.post(`statements/${imported.file}/undo`,{})
    assert.equal(undo.removed,1)
    assert.deepEqual((await h.get('personal-spend',t.sam)).charges,immutable)
    const input=personalInput(t.c.office), preview=await h.post('statements/preview',input)
    const again=await h.post('statements/commit',{...input,fingerprint:preview.fingerprint})
    assert.equal(again.importable,1)
    d=await h.get(`claims/${again.claims[0]}`,t.sam)
    assert.equal(d.items.find(i=>i.merchant==='synthetic-coaster-2').personal_spend.outstanding_minor,2346)
    assert.deepEqual((await h.get('personal-spend',t.sam)).charges,immutable)
    // Submitted and retracted claims remain ineligible even if their status becomes draft again.
    d=await h.get(`claims/${d.claim.id}`,t.sam)
    const reimported=d.items.find(i=>i.merchant==='synthetic-coaster-2')
    await h.post(`claims/${d.claim.id}/receipts`,{version:d.claim.version,item:reimported.id,...await receipt('hotel')},t.sam)
    d=await h.get(`claims/${d.claim.id}`,t.sam)
    await h.post(`claims/${d.claim.id}/submit`,{version:d.claim.version},t.sam)
    d=await h.get(`claims/${d.claim.id}`,t.sam)
    await h.post(path,{version:d.claim.version,item:first.id,charge:first.card_charge_id,confirm:true},t.sam,409)
    await h.post(`claims/${d.claim.id}/retract`,{version:d.claim.version},t.sam)
    d=await h.get(`claims/${d.claim.id}`,t.sam)
    await h.post(path,{version:d.claim.version,item:first.id,charge:first.card_charge_id,confirm:true},t.sam,409)
    const events=(await h.db.prepare("SELECT * FROM c_events WHERE action='card-charge-marked-personal' ORDER BY seq").all()).results
    assert.equal(events.length,2);assert.ok(events[0].seq<events[1].seq)
    assert.ok(events.every(e=>e.actor_email===employee&&JSON.parse(e.detail).channel==='app'))
    console.log('PROBE CARD-002 native money: statement import and personal marking -> AUD 12.34 + 23.46 = 35.80 unpaid; reimbursement remains 7.89; repeated and foreign writes refused; undo and reimport preserve both obligations')
  } finally {await h.close()}
})

test('Personal spend fences concurrent classification, claim changes and authority withdrawal at both commit guards without partial writes', async () => {
  let pause,h
  h=await harness({d1Barrier:async request=>{
    if(request.url.endsWith('/before-personal-spend')&&pause){const action=pause;pause=null;await action()}
    return new Response('open')
  }})
  try {
    const t=await agency(h),employee=(await h.get('state',t.sam)).actor.email
    const imported=await importPersonalStatement(h.post,t.c.office,employee)
    let d=await h.get(`claims/${imported.claims[0]}`,t.sam)
    const path=personalPath(d.claim.id),item=d.items[0]
    const body=()=>({version:d.claim.version,item:item.id,charge:item.card_charge_id,confirm:true})
    const snapshot=async()=>Promise.all(['c_claims','c_items','c_card_charges','c_card_personal_spend','c_events'].map(async table=>(await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results))
    pause=()=>h.post(`claims/${d.claim.id}/title`,{version:d.claim.version,title:'synthetic-coaster-4'},t.sam)
    await h.post(path,body(),t.sam,409)
    assert.equal((await h.get('personal-spend',t.sam)).charges.length,0)
    d=await h.get(`claims/${d.claim.id}`,t.sam)
    // A trigger represents a change during the batch, after the first guard passed.
    for(const change of [
      `UPDATE c_claims SET version=version+1 WHERE id='${d.claim.id}';`,
      `UPDATE oa_sessions SET revoked_at='2026-01-01T00:00:00Z' WHERE id IN (SELECT s.id FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id WHERE lower(o.email)='${employee}');`,
      `UPDATE c_claims SET employee_email=(SELECT email FROM c_members WHERE email<>'${employee}' LIMIT 1) WHERE id='${d.claim.id}';`,
    ]) {
      await h.db.prepare(`CREATE TRIGGER synthetic_personal_change AFTER INSERT ON c_card_personal_spend BEGIN ${change} END`).run()
      const before=await snapshot()
      await h.post(path,body(),t.sam,409)
      assert.deepEqual(await snapshot(),before,'the second guard rolls back classification, history and the concurrent mutation')
      await h.db.prepare('DROP TRIGGER synthetic_personal_change').run()
    }
    const responses=await Promise.all([h.send('/api/coaster/'+path,body(),t.sam),h.send('/api/coaster/'+path,body(),t.sam)])
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,409])
    assert.equal((await h.get('personal-spend',t.sam)).charges.length,1)
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM c_events WHERE action='card-charge-marked-personal'").first()).n,1)
    d=await h.get(`claims/${d.claim.id}`,t.sam)
    const second=d.items[1],before=await snapshot()
    pause=()=>h.db.prepare("UPDATE oa_sessions SET revoked_at='2026-01-01T00:00:00Z' WHERE operator_id IN (SELECT id FROM oa_operators WHERE email=?)").bind(employee).run()
    await h.post(path,{version:d.claim.version,item:second.id,charge:second.card_charge_id,confirm:true},t.sam,409)
    assert.deepEqual(await snapshot(),before,'revoked native authority cannot finish marking or append history')
    await h.get('personal-spend',t.sam,401)
    console.log('PROBE CARD-002 concurrency and authority: two simultaneous confirmations -> one record; stale claim and revoked session -> 409 with no classification or history write; second-guard mutations roll back')
  } finally {await h.close()}
})

test('Personal debt retains opaque financial identity through erasure and refuses source reimport that would resurrect a departed cardholder', async () => {
  const h=await harness()
  try {
    const t=await agency(h),employee=(await h.get('state',t.sam)).actor.email
    const input=personalInput(t.c.office),imported=await importPersonalStatement(h.post,t.c.office,employee)
    let d=await h.get(`claims/${imported.claims[0]}`,t.sam)
    const item=d.items[0]
    await h.post(personalPath(d.claim.id),{version:d.claim.version,item:item.id,charge:item.card_charge_id,confirm:true},t.sam)
    await h.post(`statements/${imported.file}/undo`,{})
    const original=(await h.get('personal-spend',t.sam)).charges[0]
    // Finish the remaining draft through the native submission and rejection doors before erasure.
    d=await h.get(`claims/${d.claim.id}`,t.sam)
    await h.post(`claims/${d.claim.id}/items`,{version:d.claim.version,kind:'receipt',date:'2026-05-12',merchant:'synthetic-coaster-5',amount:'1.00',allocations:[{category:t.c.office}],explanation:'Synthetic receipt unavailable'},t.sam)
    d=await h.get(`claims/${d.claim.id}`,t.sam)
    await h.post(`claims/${d.claim.id}/submit`,{version:d.claim.version},t.sam)
    d=await h.get(`claims/${d.claim.id}`,t.sam)
    await h.post(`claims/${d.claim.id}/decision`,{version:d.claim.version,revision:d.claim.revision,decision:'rejected',reason:'Synthetic claim closed'},t.priya)
    const member=(await h.get('state')).members.find(m=>m.email===employee)
    await h.post('settings/members',{email:employee,name:member.name,employee:true,active:false})
    await h.post('settings/members/erase',{email:employee})
    const personal=(await h.db.prepare('SELECT * FROM c_card_personal_spend').all()).results
    assert.equal(personal.length,1);assert.match(personal[0].employee_email,/^former-member-/)
    assert.equal(personal[0].actor_email,personal[0].employee_email)
    assert.equal(personal[0].outstanding_minor,1234);assert.equal(personal[0].source_key,original.source_key)
    const rows=(await h.db.prepare("SELECT * FROM c_events WHERE action='card-charge-marked-personal'").all()).results
    assert.equal(rows[0].actor_email,personal[0].employee_email)
    assert.ok(!JSON.stringify([personal,rows]).includes(employee),'neither classification nor its history retains the erased address')
    await h.get('personal-spend',t.sam,401)
    const alex=(await h.get('state',t.alex)).actor.email
    await h.post('statements/cards',{issuer:input.issuer,last4:'8839',employee:alex})
    const preview=await h.post('statements/preview',input),before=(await h.db.prepare('SELECT COUNT(*) AS n FROM c_events').first()).n
    await h.post('statements/commit',{...input,fingerprint:preview.fingerprint},h.owner,409)
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_events').first()).n,before)
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_card_charges').first()).n,0)
    console.log('PROBE CARD-002 erasure: ordinary erasure -> opaque debtor with unchanged AUD 12.34 unpaid; departed session and reimport under another holder refused without writes')
  } finally {await h.close()}
})
