// Real API, native sessions, D1 and scheduled Worker; only Intuit's network edge is faked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness } from './harness.mjs'

import { desktopEdge } from './fixtures/desktop.mjs'

test('ACCT-007 Desktop scheduled SOAP catalog, posting replay and isolated error retry use the native role fences and immutable audit history',async()=>{
  const {agency}=await import('./harness.mjs'),h=await harness()
  try {
    const t=await agency(h),root=['accounting','desktop'].join('/'),edge=await desktopEdge(h)
    const admin=await h.person('synthetic-coaster-90@example.invalid',{admin:true}),book=await h.person('synthetic-coaster-91@example.invalid',{bookkeeper:true})
    const unchanged=async(run)=>{const before=await h.db.prepare('SELECT count(*) AS n FROM c_events').first();await run();assert.deepEqual(await h.db.prepare('SELECT count(*) AS n FROM c_events').first(),before)}
    await unchanged(()=>h.post(root+'/connect',{consent:true,company:'synthetic-coaster-1.QBW'},book,403))
    await unchanged(()=>h.post(root+'/sync',{},admin,403))
    for(const [n,role] of [[111,'employee'],[112,'manager'],[113,'auditor'],[114,'cardAdmin']]) {
      const denied=await h.person(`synthetic-coaster-${n}@example.invalid`,{[role]:true})
      await unchanged(()=>h.post(root+'/connect',{consent:true,company:'synthetic-coaster-1.QBW'},denied,403))
      await unchanged(()=>h.post(root+'/sync',{},denied,403))
      await unchanged(()=>h.post(root+'/mappings',{name:'payable',kind:'Account',listId:'synthetic-coaster-2'},denied,403))
    }
    await h.post(root+'/connect',{company:'synthetic-coaster-1.QBW'},admin,400)
    const connected=await h.post(root+'/connect',{consent:true,company:'synthetic-coaster-1.QBW'},admin)
    assert.match(connected.configuration,/<RunEveryNMinutes>60/);assert.ok(!connected.configuration.includes(connected.password))
    assert.match(await edge.soap('authenticate',{strUserName:'wrong',strPassword:connected.password}),/nvu/)
    await edge.open(connected.configuration,connected.password);await edge.drain()
    let state=await h.get(root,book);assert.deepEqual([...new Set(state.catalog.map(c=>c.kind))].sort(),['Account','Class','Customer','Employee','Vendor'])
    const map=async(name,id,kind='Account')=>h.post(root+'/mappings',{name,listId:id,kind},book)
    await map('account:6300','synthetic-coaster-1');await map('payable','synthetic-coaster-2');await map('bank','synthetic-coaster-3');await map('vendor:sam@harbourfinch.example','synthetic-coaster-6','Vendor')
    await unchanged(()=>h.post(root+'/mappings',{name:'payable',kind:'Account',listId:'synthetic-coaster-1'},admin,403))
    let claim=await h.post('claims',{title:'synthetic-coaster-92'},t.sam)
    claim=await h.post(`claims/${claim.id}/items`,{version:claim.version,kind:'receipt',date:'2026-09-10',merchant:'synthetic-coaster-93',amount:'42.00',category:t.c.meals,explanation:'synthetic-coaster-94'},t.sam)
    claim=await h.post(`claims/${claim.id}/submit`,{version:claim.version},t.sam)
    claim=await h.post(`claims/${claim.id}/decision`,{version:claim.version,revision:claim.revision,decision:'approved',acknowledge:true},t.priya)
    let batch=await h.post('batches',{claims:[claim.id]},t.morgan)
    batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:4200},t.jordan)
    const card=await h.post(['statements','cards'].join('/'),{issuer:'synthetic-coaster-96',last4:'1111',employee:'sam@harbourfinch.example'})
    const input={format:'csv',name:'synthetic-coaster-97.csv',issuer:'synthetic-coaster-96',category:t.c.meals,content:'Date,Merchant,Amount,Id\n2026-09-12,synthetic-coaster-98,12.30,synthetic-coaster-99',mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',transactionId:'Id',wholeFileLast4:'1111'}}
    const imported=await h.post(['statements','commit'].join('/'),{...input,fingerprint:(await h.post(['statements','preview'].join('/'),input,t.morgan)).fingerprint},t.morgan)
    const cardDetail=await h.get('claims/'+imported.claims[0],t.sam),item=cardDetail.items[0]
    let cardClaim=await h.post(`claims/${cardDetail.claim.id}/items`,{version:cardDetail.claim.version,item:item.id,kind:'receipt',date:item.spent_on,merchant:item.merchant,amount:'12.30',category:t.c.meals,explanation:'synthetic-coaster-100'},t.sam)
    cardClaim=await h.post(`claims/${cardClaim.id}/submit`,{version:cardClaim.version},t.sam)
    await h.post(`claims/${cardClaim.id}/decision`,{version:cardClaim.version,revision:cardClaim.revision,decision:'approved',acknowledge:true},t.priya)
    await map('card:'+card.id,'synthetic-coaster-3')
    const file=(await h.get('statements')).files.find(f=>f.name===input.name)
    const opened=await h.post(`statements/${file.id}/reconcile`,{last4:'1111',openingBalance:'10.00',statementBalance:'22.30'},t.morgan)
    const closed=await h.post(['statements','reconciliations',opened.id,'close'].join('/'),{},t.morgan)
    const journal=closed.ledger.entries.find(e=>e.kind==='opening')
    await map('account:'+journal.debit_account,'synthetic-coaster-1');await map('account:'+journal.credit_account,'synthetic-coaster-3')
    // Web Connector's own hourly run queues the reviewed batch without pressing manual sync.
    await edge.open(connected.configuration,connected.password);await edge.drain('BillAdd')
    assert.match(edge.sent.find(r=>r.kind==='CreditCardChargeAdd').request,/<Amount>12.30<\/Amount>/)
    assert.match(edge.sent.find(r=>r.kind==='JournalEntryAdd').request,/<Amount>10.00<\/Amount>/)
    const postedJournal=edge.sent.find(r=>r.kind==='JournalEntryAdd').request
    const journalTotal=side=>[...postedJournal.matchAll(new RegExp(`<Journal${side}Line>[\\s\\S]*?<Amount>([\\d.]+)</Amount>[\\s\\S]*?</Journal${side}Line>`,'g'))].reduce((total,line)=>total+Math.round(Number(line[1])*100),0)
    assert.equal(journalTotal('Debit'),1000)
    assert.equal(journalTotal('Credit'),journalTotal('Debit'),'the posted journal balances exactly')
    assert.equal(edge.sent.filter(r=>r.kind==='JournalEntryAdd').length,1,'purchase lines already represented by card charges are not journaled again')
    state=await h.get(root,book);const failed=state.requests.find(r=>r.kind==='BillAdd');assert.equal(failed.status,'failed');assert.equal(failed.message,'Account is inactive')
    await unchanged(()=>h.post(root+'/retry/'+failed.id,{},admin,403))
    const before=edge.sent.length
    await h.post(root+'/retry/'+failed.id,{},book)
    // Continue through the protocol; only the explicitly failed financial request is retried.
    await edge.open(connected.configuration,connected.password);await edge.drain()
    const bills=edge.sent.slice(before).filter(r=>!r.kind.endsWith('Query'));assert.equal(bills.length,1);assert.equal(bills[0].id,failed.id);assert.match(bills[0].request,/<Amount>42.00<\/Amount>/)
    assert.equal((await h.get(`batches/${batch.id}`,t.morgan)).batch.total_minor,4200)
    await edge.open(connected.configuration,connected.password);await edge.drain();assert.equal(edge.sent.filter(r=>r.kind==='BillAdd').length,2,'one failed attempt and one success, never another posting')
    batch=await h.paid(batch.id,batch.version,{reference:'synthetic-coaster-95',paidOn:'2026-09-11'},t.jordan)
    await edge.open(connected.configuration,connected.password);await edge.drain()
    assert.equal(edge.sent.filter(r=>r.kind==='BillPaymentCheckAdd').length,1);assert.match(edge.sent.find(r=>r.kind==='BillPaymentCheckAdd').request,/<PaymentAmount>42.00<\/PaymentAmount>/)
    await edge.open(connected.configuration,connected.password);await edge.drain();assert.equal(edge.sent.filter(r=>r.kind==='BillPaymentCheckAdd').length,1)
    assert.equal(edge.sent.filter(r=>r.kind==='CreditCardChargeAdd').length,1)
    assert.equal(edge.sent.filter(r=>r.kind==='JournalEntryAdd').length,1)
    for(const method of ['PUT','PATCH','DELETE']) {const response=await h.mf.dispatchFetch(h.origin+'/api/coaster/history',{method,headers:{cookie:h.owner,origin:h.origin}});assert.equal(response.status,404)}
    const lines=(await h.get('history')).lines.filter(l=>l.action.startsWith('desktop-'))
    assert.ok(lines.some(l=>l.action==='desktop-connected'&&l.actor_email==='synthetic-coaster-90@example.invalid'))
    assert.ok(lines.some(l=>l.action==='desktop-sync-started'&&l.channel==='schedule'))
    assert.ok(lines.every((l,i)=>!i||l.seq>lines[i-1].seq));assert.ok(lines.every(l=>l.at&&'agent'in l))
    await assert.rejects(()=>h.db.prepare("UPDATE c_events SET action='changed' WHERE action='desktop-connected'").run(),/permanent/)
    await assert.rejects(()=>h.db.prepare("DELETE FROM c_events WHERE action='desktop-connected'").run(),/permanent/)
    await h.post(root+'/disconnect',{},admin)
    assert.equal((await h.get(root,book)).connected,false)
    await h.post(root+'/connect',{consent:true,company:'different.QBW'},h.owner,409)
    for(const allowed of [h.owner,t.morgan]) {
      await h.post(root+'/connect',{consent:true,company:'synthetic-coaster-1.QBW'},allowed)
      await h.post(root+'/sync',{},allowed)
      await h.post(root+'/disconnect',{},allowed)
    }
    assert.match(await edge.soap('authenticate',{strUserName:connected.configuration.match(/<UserName>(.*?)<\/UserName>/)[1],strPassword:connected.password}),/nvu/)
  } finally {await h.close()}
})
