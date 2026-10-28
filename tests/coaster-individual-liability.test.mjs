import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harness } from './harness.mjs';
import { individualProgram, classifyAndBatch } from './individual-liability-kit.mjs';

// One end-to-end money behavior: eligible program charges reach one reimbursement batch without changing source facts.
test('Individual-liability SFTP charges reimburse only four approved business purchases once and freeze attributable evidence',async()=>{
  const h=await harness({clock:Date.parse('2031-06-10T10:00:00Z'),bindings:origin=>({RER_DEV_ORIGIN:origin})});let f;
  try {
    f=await individualProgram(h);
    const endpoint=['feeds','program'].join('/');
    const admin=await h.person('synthetic-coaster-1290@example.test',{admin:true});
    const beforeFeeds=await h.get(endpoint,f.finance);
    const deniedRoles=[];
    for(const [n,role]of [[1295,'cardAdmin'],[1296,'auditor'],[1297,'bookkeeper']])deniedRoles.push(await h.person(`synthetic-coaster-${n}@example.test`,{[role]:true}));
    for(const who of [f.employee,f.manager,f.other,...deniedRoles]) await h.post(endpoint,f.config,who,403);
    assert.deepEqual(await h.get(endpoint,f.finance),beforeFeeds,'wrong-role requests write no program');
    const connectionGrant=await h.post('delegates',{delegate:'synthetic-coaster-1204@example.test',level:'full'},f.finance);
    const fullHeaders={'x-coaster-acting-for':'synthetic-coaster-1203@example.test'};
    const delegated=await h.send('/api/coaster/'+endpoint,{...f.config,issuer:'synthetic-coaster-1291'},f.other,fullHeaders);
    assert.equal(delegated.status,200,JSON.stringify(delegated.value));
    const stopped=await h.send(`/api/coaster/${endpoint}/${delegated.value.id}/disconnect`,{version:delegated.value.version,consent:true,liability:'company'},f.other,fullHeaders);
    assert.equal(stopped.status,200);assert.equal(stopped.value.liability,'individual');
    const connectionLine=(await h.get('history',f.finance)).lines.find(e=>e.action==='program-feed-connected'&&e.detail.feed===delegated.value.id);
    assert.equal(connectionLine.actor_email,'synthetic-coaster-1204@example.test');assert.equal(connectionLine.detail.actingFor,'synthetic-coaster-1203@example.test');
    await h.post(`delegates/${connectionGrant.id}/revoke`,{},f.finance);
    assert.equal((await h.send('/api/coaster/'+endpoint,f.config,f.other,fullHeaders)).status,403);

    for(const [who,n]of [[h.owner,1292],[admin,1293]]){
      const permitted=await h.post(endpoint,{...f.config,issuer:`synthetic-coaster-${n}`},who);
      assert.equal(permitted.liability,'individual');
      await h.post(`${endpoint}/${permitted.id}/disconnect`,{version:permitted.version,consent:true},who);
    }
    await h.post('delegates',{delegate:'synthetic-coaster-1204@example.test',level:'full'},f.employee);
    const classified=await h.send('/api/coaster/'+`claims/${f.claim.id}/items/classify`,{version:f.claim.version,item:f.items[0].id,personal:true},f.other,{'x-coaster-acting-for':f.address});
    assert.equal(classified.status,403);
    const source=(await h.db.prepare('SELECT * FROM c_card_charges ORDER BY id').all()).results;
    assert.equal(source.length,6);assert.ok(source.every(c=>c.program_id===f.feed.id&&c.liability==='individual'));
    assert.deepEqual(source.map(c=>[c.transaction_key,c.amount_minor]).sort((a,b)=>a[0].localeCompare(b[0])),[
      ['card:synthetic-coaster-1206|1111:id:synthetic-coaster-1220',1000],
      ['card:synthetic-coaster-1206|1111:id:synthetic-coaster-1221',2000],
      ['card:synthetic-coaster-1206|1111:id:synthetic-coaster-1222',3000],
      ['card:synthetic-coaster-1206|1111:id:synthetic-coaster-1223',4000],
      ['card:synthetic-coaster-1206|1111:id:synthetic-coaster-1224',5000],
      ['card:synthetic-coaster-1206|1111:id:synthetic-coaster-1225',6000],
    ]);
    const path=`claims/${f.claim.id}/items/classify`,body={version:f.claim.version,item:f.items[0].id,personal:true};
    for(const who of [h.owner,f.manager,f.finance,f.other]) await h.post(path,body,who,403);
    assert.equal((await h.send('/api/coaster/'+path,body,f.employee,{origin:'https://unrelated.example'})).status,403);
    await h.post(path,{...body,version:0},f.employee,409);
    await h.post(path,{...body,personal:'true'},f.employee,400);
    const key=await h.post('agent-keys',{label:'synthetic-coaster-1240'},f.employee);
    assert.equal((await h.send('/api/coaster/'+path,body,'',{authorization:`Bearer ${key.token}`})).status,401);
    assert.deepEqual((await h.get(`claims/${f.claim.id}`,f.employee)).items,f.items,'refusals preserve all expenses');
    await h.post(`feeds/program/${f.feed.id}/disconnect`,{version:f.feed.version,consent:true,liability:'company'},f.finance);
    let companyCsv=[...f.issuer.files.values()][0];
    for(let i=0;i<6;i++) companyCsv=companyCsv.replaceAll(`synthetic-coaster-${1210+i}`,`synthetic-coaster-${1250+i}`);
    f.issuer.files.clear();f.issuer.files.set('synthetic-coaster-1259.csv',companyCsv);
    // A separate company program proves that liability does not come from caller-controlled expense input.
    await h.post('statements' + '/' + 'cards',{issuer:'synthetic-coaster-1241',last4:'1111',employee:f.address});
    const company=await h.post('feeds' + '/' + 'program',{...f.config,issuer:'synthetic-coaster-1241',liability:'company'},f.finance);
    await f.tick('2031-06-10T12:17:00Z');
    let draft=await h.get(`claims/${f.claim.id}`,f.employee);
    const companyItems=draft.items.filter(i=>i.card_liability==='company');assert.equal(companyItems.length,6);
    assert.equal(draft.claim.total_minor,21000);
    await h.post(path,{version:draft.claim.version,item:companyItems[0].id,personal:true},f.employee,409);
    f.claim=draft.claim;f.items=draft.items.filter(i=>i.card_liability==='individual');
    const file=(await h.get('feeds' + '/' + 'program',f.finance)).deliveries.find(d=>d.feed_id===f.feed.id).file_id;
    await h.post(`statements/${file}/reconcile`,{last4:'1111',openingBalance:'0',statementBalance:'210'},f.finance,409);
    const {claim,batch}=await classifyAndBatch(h,f);
    await h.post(path,{version:claim.version,item:f.items[0].id,personal:true},f.employee,409);
    await h.post(`claims/${claim.id}/items/remove`,{version:claim.version,item:f.items[0].id},f.employee,409);
    const frozen=(await h.get(`claims/${claim.id}`,f.employee)).revisions[0].snapshot;
    assert.equal(frozen.items.length,12);assert.equal(frozen.total_minor,10000);
    assert.deepEqual(frozen.items.filter(i=>i.card_liability==='individual').map(i=>[i.merchant,i.card_personal]).sort(),[0,0,0,0,1,1].map((personal,i)=>[`synthetic-coaster-${1210+i}`,personal]));
    const keys=(await h.db.prepare('SELECT * FROM c_reimbursement_keys WHERE batch_id=? ORDER BY key').bind(batch.id).all()).results;
    assert.deepEqual(keys.map(k=>k.key),[
      'card:card:synthetic-coaster-1206|1111:id:synthetic-coaster-1220',
      'card:card:synthetic-coaster-1206|1111:id:synthetic-coaster-1221',
      'card:card:synthetic-coaster-1206|1111:id:synthetic-coaster-1222',
      'card:card:synthetic-coaster-1206|1111:id:synthetic-coaster-1223',
    ]);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_card_ledger').first()).n,0);
    await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:10000},h.owner);
    const desktop=['accounting','desktop'].join('/');
    await h.post(desktop+'/connect',{consent:true,company:'synthetic-coaster-1270.QBW'});
    await h.post(desktop+'/sync',{},f.finance);
    const requests=(await h.db.prepare("SELECT kind,payload FROM c_qbd_requests WHERE kind IN ('BillAdd','CreditCardChargeAdd')").all()).results;
    const bills=requests.filter(r=>r.kind==='BillAdd').map(r=>JSON.parse(r.payload));
    assert.deepEqual(bills.map(b=>[b.employee,b.total]),[[f.address,10000]]);
    const purchases=requests.filter(r=>r.kind==='CreditCardChargeAdd').map(r=>JSON.parse(r.payload));
    assert.equal(purchases.length,6,'only the six company charges post to a company card');
    assert.equal(purchases.reduce((n,p)=>n+p.total,0),21000);
    assert.deepEqual(purchases.flatMap(p=>p.lines.map(l=>l.merchant)).sort(),[1250,1251,1252,1253,1254,1255].map(n=>`synthetic-coaster-${n}`));

    // A different statement file on the same card cannot reinterpret the employee's liability as company debt.
    const statement={format:'ofx',name:'synthetic-coaster-1261.ofx',issuer:f.config.issuer,category:f.category.id,content:(await readFile('tests/fixtures/statements/synthetic-card.ofx','utf8')).replaceAll('<CURDEF>AUD','<CURDEF>USD')};
    const preview=await h.post('statements' + '/' + 'preview',statement,f.finance);
    const imported=await h.post('statements' + '/' + 'commit',{...statement,fingerprint:preview.fingerprint},f.finance);
    await h.post(`statements/${imported.file}/reconcile`,{last4:'1111',openingBalance:'0'},f.finance,409);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_card_statements').first()).n,0);

    await h.post('batches',{claims:[claim.id]},f.finance,409);
    assert.deepEqual((await h.db.prepare('SELECT * FROM c_card_charges WHERE program_id=? ORDER BY id').bind(f.feed.id).all()).results,source);
    for(const [sql,args]of [
      ['UPDATE c_card_charges SET amount_minor=0 WHERE id=?',[source[0].id]],
      ["UPDATE c_card_charges SET liability='company' WHERE id=?",[source[0].id]],
      ['DELETE FROM c_card_charges WHERE id=?',[source[0].id]],
      ['UPDATE c_items SET card_personal=1 WHERE id=?',[f.items[0].id]],
      ["UPDATE c_revisions SET snapshot='{}' WHERE claim_id=?",[claim.id]],
      ["UPDATE c_events SET action='changed' WHERE claim_id=?",[claim.id]],
      ['DELETE FROM c_events WHERE claim_id=?',[claim.id]],
    ])await assert.rejects(h.db.prepare(sql).bind(...args).run());
    await h.paid(batch.id,(await h.get(`batches/${batch.id}`,f.finance)).batch.version,{reference:'synthetic-coaster-1294',paidOn:'2031-06-10'},f.finance);
    const paidState=await h.get(`claims/${claim.id}`,f.employee),paidHistory=await h.get('history',f.finance);
    await h.post(path,{version:paidState.claim.version,item:f.items[0].id,personal:true},f.employee,409);
    assert.deepEqual(await h.get(`claims/${claim.id}`,f.employee),paidState,'paid classification refusal preserves the complete frozen claim');
    assert.deepEqual(await h.get('history',f.finance),paidHistory,'paid classification refusal appends no misleading history');
    const history=await h.get('history',f.finance),lines=history.lines.filter(e=>e.claim?.id===claim.id||e.batch?.id===batch.id);
    const actions=lines.map(e=>e.action);
    assert.equal(actions.filter(a=>a==='program-feed-charge-created').length,12);
    assert.equal(actions.filter(a=>a==='card-charge-classified').length,2);
    assert.ok(actions.indexOf('card-charge-classified')>actions.indexOf('program-feed-charge-created'));
    assert.ok(actions.indexOf('claim-submitted')>actions.indexOf('card-charge-classified'));
    assert.ok(actions.indexOf('batch-created')>actions.indexOf('claim-approved'));
    assert.ok(lines.every((e,i)=>Number.isInteger(e.seq)&&e.at&&e.actor_email&&e.agent===null&&e.channel===(e.action==='program-feed-charge-created'?'schedule':'app')&&(!i||e.seq>lines[i-1].seq)));
    for(const method of ['PUT','PATCH','DELETE'])for(const route of ['history',`claims/${claim.id}/items/classify`])assert.ok((await h.mf.dispatchFetch(h.origin+'/api/coaster/'+route,{method,headers:{cookie:h.owner,origin:h.origin,'content-type':'application/json'},body:JSON.stringify({action:'changed'})})).status>=400);
    assert.deepEqual(await h.get('history',f.finance),history);
    await h.post(`feeds/program/${company.id}/disconnect`,{version:company.version,consent:true},f.finance);
  }finally{await h.close();await f?.issuer.close();}
});


test('A reimbursed cash purchase cannot reimburse again when an individual card transaction arrives',async()=>{
  const h=await harness({clock:Date.parse('2031-06-10T10:00:00Z'),bindings:origin=>({RER_DEV_ORIGIN:origin})});let f;
  try {
    f=await individualProgram(h,{beforeIngest:async({employee,finance,manager,category})=>{
      let c=await h.post('claims',{title:'synthetic-coaster-1280'},employee);
      c=await h.post(`claims/${c.id}/items`,{version:c.version,kind:'receipt',date:'2031-06-10',merchant:'synthetic-coaster-1210',amount:'10.00',category:category.id},employee);
      c=await h.post(`claims/${c.id}/submit`,{version:c.version},employee);
      c=await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved',acknowledge:true},manager);
      let b=await h.post('batches',{claims:[c.id]},finance);
      b=await h.post(`batches/${b.id}/approve`,{version:b.version,expectedTotal:1000});
      await h.paid(b.id,b.version,{reference:'synthetic-coaster-1281',paidOn:'2031-06-10'},finance);
    }});
    const item=f.items.find(i=>i.amount_minor===1000);
    let c=await h.post(`claims/${f.claim.id}/items`,{version:f.claim.version,item:item.id,kind:'receipt',date:item.spent_on,merchant:item.merchant,amount:'10.00',category:f.category.id,explanation:'synthetic-coaster-1282'},f.employee);
    c=await h.post(`claims/${c.id}/submit`,{version:c.version},f.employee);
    c=await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved',acknowledge:true},f.manager);
    const before=(await h.db.prepare('SELECT * FROM c_reimbursement_keys ORDER BY key').all()).results;
    await h.post('batches',{claims:[c.id]},f.finance,409);
    assert.deepEqual((await h.db.prepare('SELECT * FROM c_reimbursement_keys ORDER BY key').all()).results,before);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_batches').first()).n,1);
  }finally{await h.close();await f?.issuer.close();}
});

test('Deactivation revokes cardholder access without transferring individual liability or classification',async()=>{
  const h=await harness({clock:Date.parse('2031-06-10T10:00:00Z'),bindings:origin=>({RER_DEV_ORIGIN:origin})});let f;
  try {
    f=await individualProgram(h);
    const source=(await h.db.prepare('SELECT * FROM c_card_charges ORDER BY id').all()).results;
    await h.post('settings'+'/'+'members',{email:f.address,name:'synthetic-coaster-1202',employee:true,active:false,successor:'synthetic-coaster-1204@example.test'});
    await h.get('state',f.employee,403);
    const body={version:f.claim.version,item:f.items[0].id,personal:true};
    await h.post(`claims/${f.claim.id}/items/classify`,body,f.employee,403);
    await h.post(`claims/${f.claim.id}/items/classify`,body,f.other,403);
    assert.deepEqual((await h.db.prepare('SELECT * FROM c_card_charges ORDER BY id').all()).results,source);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_card_handoffs').first()).n,0);
    assert.equal((await h.db.prepare('SELECT SUM(card_personal) n FROM c_items').first()).n,0);
  }finally{await h.close();await f?.issuer.close();}
});
