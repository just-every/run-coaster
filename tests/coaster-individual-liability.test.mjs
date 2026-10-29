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
    const source=(await h.db.prepare('SELECT * FROM c_card_charges ORDER BY id').all()).results;
    assert.equal(source.length,6);assert.ok(source.every(c=>c.program_id===f.feed.id&&c.liability==='individual'));
    const path=`claims/${f.claim.id}/items/classify`,body={version:f.claim.version,item:f.items[0].id,personal:true};
    for(const who of [h.owner,f.manager,f.finance,f.other]) await h.post(path,body,who,403);
    assert.equal((await h.send('/api/coaster/'+path,body,f.employee,{origin:'https://unrelated.example'})).status,403);
    await h.post(path,{...body,version:0},f.employee,409);
    await h.post(path,{...body,personal:'true'},f.employee,400);
    const key=await h.post('agent-keys',{label:'synthetic-coaster-1240'},f.employee);
    assert.equal((await h.send('/api/coaster/'+path,body,'',{authorization:`Bearer ${key.token}`})).status,401);
    assert.deepEqual((await h.get(`claims/${f.claim.id}`,f.employee)).items,f.items,'refusals preserve all expenses');
    await h.post(`feeds/program/${f.feed.id}/disconnect`,{version:f.feed.version,consent:true},f.finance);
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
    assert.deepEqual(keys.map(k=>k.key),f.items.filter(i=>i.amount_minor<=4000).map(i=>'card:'+i.card_transaction_key).sort());
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_card_ledger').first()).n,0);
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
