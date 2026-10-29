import assert from 'node:assert/strict';
import { agency, harness, receipt } from './harness.mjs';

/** One native money-flow journey: correct, decide, freeze, remove, correct again and export, preserving source evidence. */
export async function proveAccountingCorrections(options = {}) {
  let onCorrection;
  const h=await harness({...options,d1Barrier:async request=>{if(request.url.endsWith('/before-accounting-correction') && onCorrection) await onCorrection();return new Response('ok');}});
  try {
    const t=await agency(h), member=(await h.get('state',t.sam)).actor.email;
    const role = (n,flags) => h.person(['synthetic-coaster-'+n,'example.test'].join('@'), flags);
    const bookkeeper=await role(8501,{bookkeeper:true});
    const cap=(await h.post('allowances',{name:'synthetic-coaster-8502',type:'cap',member,period:'yearly',amount:'25.00',startsOn:'2026-01-01'})).all.find(a=>a.name==='synthetic-coaster-8502');
    let n=0;
    const purchase=async(title,inputs=[{kind:'receipt',amount:'40.00',allowance:cap.id}])=>{
      let c=await h.post('claims',{title},t.sam);
      for(const input of inputs) {
        let r;
        if(input.kind==='receipt') { const uploaded=await h.post(`claims/${c.id}/receipts`,{version:c.version,...await receipt('bistro')},t.sam);c=uploaded.claim;r=uploaded.receipt; }
        c=await h.post(`claims/${c.id}/items`,{version:c.version,date:'2026-06-10',merchant:'synthetic-coaster-'+(++n),description:'Client work',explanation:'Client work',receipt:r,allocations:[{category:t.c.office}],...input},t.sam);
      }
      return h.post(`claims/${c.id}/submit`,{version:c.version},t.sam);
    };
    const correct=async(c,who,code,status=200,itemIndex=0,extra={})=>{
      const view=await h.get(`claims/${c.id}/accounting-coding`), item=view.effective[itemIndex], own=view.corrections.filter(x=>x.item_id===item.id);
      return h.post(`claims/${c.id}/accounting-coding`,{version:c.version,revision:c.revision,item:item.id,sequence:own.at(-1)?.sequence??0,accounts:item.allocations.map(()=>code),reason:'Correct native account',...extra},who,status);
    };
    let c=await purchase('synthetic-coaster-8503', [{kind:'receipt',amount:'40.00',allowance:cap.id},{kind:'mileage',distance:'10'},{kind:'per_diem',days:1}]);
    const original=await h.get(`claims/${c.id}`), frozen=original.revisions[0].snapshot;
    assert.deepEqual([frozen.items[0].amount_minor,frozen.items[0].claimed_minor],[2500,4000],'a real cap has reduced the submitted manual purchase');
    const ids=[];
    for(let i=0;i<3;i++) { const result=await correct(c,t.priya,'synthetic-coaster-8510',200,i); c=result.claim;ids.push(result.corrections.at(-1).id); }
    for(const who of [h.owner,t.morgan,bookkeeper]) for(let i=0;i<3;i++) c=(await correct(c,who,'synthetic-coaster-'+(++n+8800),200,i)).claim;
    c=await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved',acknowledge:true},t.priya);
    await correct(c,t.priya,'synthetic-coaster-8511',403);
    for(const who of [h.owner,t.morgan,bookkeeper]) for(let i=0;i<3;i++) c=(await correct(c,who,'synthetic-coaster-'+(++n+8600),200,i)).claim;
    const unchanged=await h.get(`claims/${c.id}`);
    assert.deepEqual(unchanged.revisions[0].snapshot,frozen,'coding never rewrites submitted amounts, cap, kind, receipt or category');
    assert.deepEqual(unchanged.items,original.items,'source expenses stay unchanged');
    assert.equal(unchanged.claim.total_minor,original.claim.total_minor);
    assert.equal(unchanged.events.filter(e=>e.action==='accounting-coding-corrected').length,21);
    const preserved=async()=>({revisions:(await h.db.prepare('SELECT * FROM c_revisions ORDER BY claim_id,revision').all()).results,corrections:(await h.db.prepare('SELECT * FROM c_accounting_corrections ORDER BY id').all()).results,events:(await h.db.prepare('SELECT * FROM c_events ORDER BY seq').all()).results});
    const before=await preserved();
    await correct(c,h.owner,'synthetic-coaster-8512',409,0,{version:c.version-1});
    await correct(c,h.owner,'synthetic-coaster-8512',409,0,{sequence:0});
    await correct(c,h.owner,'synthetic-coaster-8512',404,0,{item:'synthetic-coaster-foreign'});
    assert.deepEqual(await preserved(),before,'stale, replayed and foreign corrections write nothing');
    for(const who of [await role(8513,{admin:true}),await role(8514,{cardAdmin:true}),t.sam,await role(8515,{auditor:true}),await role(8516,{manager:true})]) {
      const saved=await preserved();await correct(c,who,'synthetic-coaster-8517',403);assert.deepEqual(await preserved(),saved);
    }
    const key=await h.post('agent-keys',{label:'synthetic-coaster-8518'},t.morgan);
    const native=await h.send(`/api/coaster/claims/${c.id}/accounting-coding`,{},'',{authorization:'Bearer '+key.token});
    assert.equal(native.status,401,'an agent key grants no native correction authority');
    // Card and scheduled stipend expenses use the same native correction door.
    await h.post(['statements','cards'].join('/'),{issuer:'synthetic-coaster-8530',last4:'8530',employee:member});
    const statement={format:'csv',name:'synthetic-coaster-8531.csv',issuer:'synthetic-coaster-8530',category:t.c.office,content:'Date,Merchant,Amount,Id\n2026-06-10,synthetic-coaster-8531,10.00,synthetic-coaster-8531',mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',transactionId:'Id',wholeFileLast4:'8530'}};
    const preview=await h.post(['statements','preview'].join('/'),statement);
    const imported=await h.post(['statements','commit'].join('/'),{...statement,fingerprint:preview.fingerprint});
    const cardView=await h.get(`claims/${imported.claims[0]}`,t.sam);
    let card=(await h.post(`claims/${cardView.claim.id}/receipts`,{version:cardView.claim.version,item:cardView.items[0].id,...await receipt('officeworks')},t.sam)).claim;
    card=await h.post(`claims/${card.id}/submit`,{version:card.version},t.sam);
    await h.post('allowances',{name:'synthetic-coaster-8532',type:'stipend',member,category:t.c.office,period:'monthly',amount:'7.00',tax:'accountable',startsOn:'2026-06-01'});
    await (await h.mf.getWorker()).scheduled({scheduledTime:Date.parse('2026-06-02T09:17:00Z'),cron:'17 * * * *'});
    let stipend=(await h.get('state',t.sam)).claims.find(row=>row.title.includes('synthetic-coaster-8532'));
    assert.equal(stipend.status,'submitted');
    for(let expense of [card,stipend]) {
      const source=(await h.get(`claims/${expense.id}`)).revisions[0].snapshot;
      for(const who of [t.priya,h.owner,t.morgan,bookkeeper]) expense=(await correct(expense,who,'synthetic-coaster-'+(++n+8900))).claim;
      expense=await h.post(`claims/${expense.id}/decision`,{version:expense.version,revision:expense.revision,decision:'approved',acknowledge:true},t.priya);
      for(const who of [h.owner,t.morgan,bookkeeper]) expense=(await correct(expense,who,'synthetic-coaster-'+(++n+8900))).claim;
      assert.deepEqual((await h.get(`claims/${expense.id}`)).revisions[0].snapshot,source,'card charge and stipend financial evidence stay unchanged');
    }
    let batch=await h.post('batches',{claims:[c.id]},t.morgan);
    const selected=await h.db.prepare('SELECT * FROM c_batch_coding WHERE batch_id=?').bind(batch.id).first();assert.ok(JSON.parse(selected.selections).length===21);
    batch=await h.post(`batches/${batch.id}/remove`,{version:batch.version,claim:c.id},t.morgan);
    c=(await h.get(`claims/${c.id}`)).claim;
    c=(await correct(c,bookkeeper,'synthetic-coaster-8520')).claim;
    assert.deepEqual(await h.db.prepare('SELECT * FROM c_batch_coding WHERE batch_id=?').bind(batch.id).first(),selected,'removed batch selections are retained and inert');
    let reviewed=await h.post('batches',{claims:[c.id]},t.morgan);
    reviewed=await h.post(`batches/${reviewed.id}/approve`,{version:reviewed.version,expectedTotal:reviewed.total_minor});
    const exported=await h.send(`/api/coaster/batches/${reviewed.id}/accounting.csv`,undefined,t.morgan);
    assert.equal(exported.status,200);assert.ok(exported.text.includes('synthetic-coaster-8520'),'accounting CSV uses the exact new selection');
    const xlsx=await h.mf.dispatchFetch(h.origin+`/api/coaster/batches/${reviewed.id}/accounting.xlsx`,{headers:{cookie:t.morgan}});assert.equal(xlsx.status,200);assert.ok((await xlsx.arrayBuffer()).byteLength>100);
    await h.post(`batches/${reviewed.id}/remove`,{version:reviewed.version,claim:c.id,confirm:true},t.morgan,409);
    await h.post(`batches/${reviewed.id}/remove-for-coding`,{version:reviewed.version,claim:c.id},t.morgan,400);
    for(const who of [bookkeeper,t.sam,t.priya]) await h.post(`batches/${reviewed.id}/remove-for-coding`,{version:reviewed.version,claim:c.id,confirm:true},who,403);
    assert.equal((await h.get(`batches/${reviewed.id}`)).batch.version,reviewed.version,'refused ordinary and unconfirmed coding removal changes nothing');
    await h.post(`batches/${reviewed.id}/remove-for-coding`,{version:reviewed.version,claim:c.id,confirm:true},t.morgan);
    c=(await h.get(`claims/${c.id}`)).claim;c=(await correct(c,t.morgan,'synthetic-coaster-8521')).claim;
    assert.equal((await h.get(`batches/${reviewed.id}`)).batch.status,'draft','removal invalidates reviewed payment authority');
    // A different employee bill remains queued while former selections from this bill stay in the database.
    let unrelated=await purchase('synthetic-coaster-8522',[{kind:'mileage',distance:'20'}]);
    unrelated=await h.post(`claims/${unrelated.id}/decision`,{version:unrelated.version,revision:unrelated.revision,decision:'approved',acknowledge:true},t.priya);
    let queued=await h.post('batches',{claims:[unrelated.id]});queued=await h.post(`batches/${queued.id}/approve`,{version:queued.version,expectedTotal:queued.total_minor});
    await h.post(['accounting','desktop','connect'].join('/'),{company:'synthetic-coaster-8523',consent:true});
    await h.post(['accounting','desktop','sync'].join('/'),{});
    assert.ok((await h.get(['accounting','desktop'].join('/'))).requests.some(q=>q.kind==='BillAdd'&&q.status==='pending'),'the ordinary connector door queues a real bill');
    unrelated=(await h.get(`claims/${unrelated.id}`)).claim;
    unrelated=(await correct(unrelated,bookkeeper,'synthetic-coaster-8524')).claim;
    assert.equal((await h.get(`batches/${queued.id}`)).batch.status,'draft','a queued bill correction requires a new batch review');
    c=(await correct(c,h.owner,'synthetic-coaster-8525')).claim;
    // Current authority is checked again inside the write, after the native request was admitted.
    const revokeView=await h.get(`claims/${c.id}/accounting-coding`), own=revokeView.corrections.filter(row=>row.item_id===revokeView.effective[0].id);
    const body={version:c.version,revision:c.revision,item:revokeView.effective[0].id,sequence:own.at(-1).sequence,accounts:['synthetic-coaster-8540'],reason:'Correct native account'};
    let entered,release;
    const paused=new Promise(resolve=>entered=resolve),continued=new Promise(resolve=>release=resolve);
    onCorrection=async()=>{entered();await continued;};
    const pending=h.post(`claims/${c.id}/accounting-coding`,body,bookkeeper,409);
    await paused;
    const bookkeeperEmail=(await h.get('state',bookkeeper)).actor.email;
    const beforeRevocation=await preserved();
    await h.post(['settings','members'].join('/'),{email:bookkeeperEmail,name:'synthetic-coaster-8501',employee:true,bookkeeper:false});
    release();await pending;onCorrection=undefined;
    assert.deepEqual((await preserved()).corrections,beforeRevocation.corrections,'authority withdrawal aborts the admitted correction');
    assert.deepEqual((await preserved()).revisions,beforeRevocation.revisions);
    assert.equal((await h.get(`claims/${c.id}`)).claim.version,c.version);
    await correct(c,bookkeeper,'synthetic-coaster-8541',403);
    const full=await h.post('delegates',{grantor:(await h.get('state',t.morgan)).actor.email,delegate:member,level:'full'});
    const delegated=await h.send(`/api/coaster/claims/${c.id}/accounting-coding`,body,t.sam,{'x-coaster-acting-for':(await h.get('state',t.morgan)).actor.email});
    assert.equal(delegated.status,200,'an existing Full delegate keeps the coding grant');
    c=delegated.value.claim;
    const delegatedRow=delegated.value.corrections.find(row=>row.item_id===body.item && row.sequence===body.sequence+1);
    assert.equal(delegatedRow.actor_email,member);
    assert.equal(delegatedRow.on_behalf_of,(await h.get('state',t.morgan)).actor.email);
    await h.post(`delegates/${full.id}/revoke`,{});
    const afterDelegation=await preserved();
    const refusedDelegate=await h.send(`/api/coaster/claims/${c.id}/accounting-coding`,{...body,version:c.version,sequence:body.sequence+1,accounts:['synthetic-coaster-8542']},t.sam,{'x-coaster-acting-for':(await h.get('state',t.morgan)).actor.email});
    assert.equal(refusedDelegate.status,403);assert.deepEqual(await preserved(),afterDelegation,'revoked delegation cannot write or resurrect authority');
    const evidence=await h.get(`claims/${c.id}/accounting-coding`);
    assert.equal(evidence.effective[0].allocations[0].account_code,'synthetic-coaster-8540');
    assert.deepEqual(evidence.original,frozen.items);
    for(const sql of ["UPDATE c_accounting_corrections SET reason='changed'",'DELETE FROM c_accounting_corrections',"UPDATE c_batch_coding SET selections='[]'",'DELETE FROM c_batch_coding']) await assert.rejects(h.db.prepare(sql).run(),/permanent/);
    return {claim:c.id,unrelated:unrelated.id,corrections:(await h.db.prepare('SELECT * FROM c_accounting_corrections ORDER BY id').all()).results,selections:(await h.db.prepare('SELECT * FROM c_batch_coding ORDER BY batch_id,claim_id,generation').all()).results};
  } finally {await h.close();}
}
