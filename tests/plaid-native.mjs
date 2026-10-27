import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { plaidFixture, plaidConfig } from './fixtures/plaid.mjs';
const root='plaid';
const route=part=>[root,part].join('/');
const start=(h,scope,cookie=h.owner)=>h.post(route('link'),{scope,consent:true},cookie);
const finish=(h,link,publicToken,cookie=h.owner,status=200)=>h.post(route('exchange'),{link,publicToken,consent:true},cookie,status);

export async function companyPlaidJourney(){
  const edge=plaidFixture(),h=await harness({clock:Date.now(),plaidEdge:r=>edge.fetch(r)});
  try {
    const admin=await h.person('synthetic-coaster-210@example.test',{admin:true,employee:true});
    const denied=[];
    for(const [i,roles]of [{cardAdmin:true},{manager:true},{auditor:true},{bookkeeper:true}].entries())denied.push(await h.person(`synthetic-coaster-${211+i}@example.test`,roles));
    await h.post(route('settings'),plaidConfig,admin,403);
    await h.post(route('settings'),plaidConfig);
    const session=await h.db.prepare('SELECT se.id,se.created_at FROM oa_sessions se JOIN oa_operators o ON o.id=se.operator_id WHERE o.email=?').bind('synthetic-coaster-210@example.test').first();
    await h.db.prepare('UPDATE oa_sessions SET created_at=0 WHERE id=?').bind(session.id).run();
    const staleRequests=edge.calls.length;
    await h.post(route('link'),{scope:'company',consent:true},admin,401);assert.equal(edge.calls.length,staleRequests);
    await h.db.prepare('UPDATE oa_sessions SET created_at=? WHERE id=?').bind(session.created_at,session.id).run();
    const initial=await h.get(route('settings'));assert.equal(initial.accountMonthlyMinor,250);assert.equal(initial.monthToDateMinor,0);
    for(const cookie of denied){
      const before=edge.calls.length;
      await h.post(route('link'),{scope:'company',consent:true},cookie,403);
      assert.equal(edge.calls.length,before);
    }
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_plaid_links').first()).n,0);
    assert.equal((await h.send('/api/coaster/'+route('link'),{scope:'company',consent:true},admin,{origin:'https://unrelated.example'})).status,403);
    const delegateAddress='synthetic-coaster-215@example.test',delegate=await h.person(delegateAddress,{employee:true});
    await h.post('delegates',{delegate:delegateAddress,level:'full'},admin);
    const beforeDelegation=edge.calls.length,acting={'x-coaster-acting-for':'synthetic-coaster-210@example.test'};
    const delegated=await h.send('/api/coaster/'+route('link'),{scope:'company',consent:true},delegate,acting);
    assert.equal(delegated.status,200,'Full delegates retain the company connection row');
    const grant=await h.db.prepare('SELECT id FROM c_delegates WHERE grantor_email=? AND delegate_email=?').bind('synthetic-coaster-210@example.test',delegateAddress).first();
    await h.post(`delegates/${grant.id}/revoke`,{},admin);
    assert.equal((await h.send('/api/coaster/'+route('exchange'),{link:delegated.value.id,publicToken:'synthetic-coaster-219',consent:true},delegate,acting)).status,403);
    assert.equal(edge.calls.length,beforeDelegation+1,'revoked delegates send no exchange request');
    const key=await h.post('agent-keys',{label:'Synthetic Plaid refusal'},admin);
    assert.equal((await h.send('/api/coaster/'+route('link'),{scope:'company',consent:true},'',{authorization:'Bearer '+key.token})).status,401);
    assert.equal(edge.calls.length,beforeDelegation+1);
    const link=await start(h,'company',admin);assert.equal(link.accountMonthlyMinor,250);
    const stolen=await finish(h,link.id,'synthetic-coaster-220',h.owner,403);assert.ok(stolen.error);
    const c=await finish(h,link.id,'synthetic-coaster-220',admin);
    assert.deepEqual(c.accounts,[{id:'synthetic-coaster-203',last4:'1008',type:'credit',subtype:'credit card'}]);
    assert.equal(c.estimatedUsdMinor,250);assert.equal((await h.get(route('settings'))).monthToDateMinor,250);
    const count=edge.calls.length;
    await finish(h,link.id,'synthetic-coaster-220',admin,409);assert.equal(edge.calls.length,count,'consumed requests never exchange twice');
    const rows=await h.db.prepare('SELECT * FROM c_plaid_connections').all();
    assert.equal(rows.results.length,1);assert.ok(!JSON.stringify(rows).includes('Should never be retained'));assert.ok(!JSON.stringify(rows).includes('9'.repeat(16)));
    assert.ok(!JSON.stringify(await h.db.prepare('SELECT * FROM c_plaid_settings').all()).includes(plaidConfig.secret));assert.ok(!JSON.stringify(rows).includes('synthetic-coaster-access-'));
    assert.ok(!rows.results[0].credentials_sealed.includes(plaidConfig.secret));
    const visible=await h.get(route('connections'),admin);
    assert.equal(visible.connections.length,1);assert.ok(!JSON.stringify(visible).includes('Should never be retained'));assert.ok(!JSON.stringify(visible).includes('account_number'));
    for(const cookie of denied){
      assert.deepEqual((await h.get(route('connections'),cookie)).connections,[]);
      await h.post(route(`connections/${c.id}/disconnect`),{},cookie,403);
    }
    const events=(await h.db.prepare("SELECT * FROM c_events WHERE action LIKE 'plaid-%' ORDER BY seq").all()).results;
    assert.deepEqual(events.map(e=>e.action),['plaid-settings-saved','plaid-link-started','plaid-link-started','plaid-exchange-reserved','plaid-connection-pending','plaid-accounts-verified','plaid-connected']);
    assert.ok(events.every((e,i)=>e.actor_email && e.at && (!i || e.seq>events[i-1].seq)));
    await assert.rejects(h.db.prepare('DELETE FROM c_events WHERE id=?').bind(events[0].id).run(),/history is permanent/);
    await assert.rejects(h.db.prepare("UPDATE c_events SET action='changed' WHERE id=?").bind(events[0].id).run(),/history is permanent/);
    edge.failRemove=true;
    const refusal=await h.post(route(`connections/${c.id}/disconnect`),{},admin,502);
    assert.ok(!JSON.stringify(refusal).includes(plaidConfig.secret));
    assert.equal((await h.get(route('connections'),admin)).connections.length,1,'failed removal retains local custody for explicit reconciliation');
    edge.failRemove=false;
    await h.post(route(`connections/${c.id}/disconnect`),{},admin);
    for(const call of edge.calls){const payload=JSON.stringify(call.body);assert.ok(!payload.includes('synthetic-coaster-210@example.test'));assert.ok(!payload.includes('owner@harbourfinch.example'));assert.ok(!payload.includes('Should never be retained'));}
    assert.equal(edge.items.size,0);assert.equal((await h.get(route('connections'),admin)).connections.length,0);
    assert.equal((await h.get(route('settings'))).monthToDateMinor,250,'disconnect does not erase recorded costs');
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM c_events WHERE action='plaid-disconnected'").first()).n,1);
  }finally{await h.close();}
}

export async function personalPlaidJourney(){
  const edge=plaidFixture(),h=await harness({clock:Date.now(),plaidEdge:r=>edge.fetch(r)});
  try {
    await h.post('settings'+ '/' + 'business',{name:'Synthetic Coaster',currency:'USD',timezone:'UTC',receiptThreshold:''});
    const managerEmail='synthetic-coaster-237@example.test', manager=await h.person(managerEmail,{manager:true,employee:true});
    const email='synthetic-coaster-230@example.test',employee=await h.person(email,{employee:true},managerEmail);
    const other=await h.person('synthetic-coaster-231@example.test',{employee:true});
    const finance=await h.person('synthetic-coaster-232@example.test',{finance:true,employee:true});
    await h.post(route('settings'),{...plaidConfig,monthlyCap:'2.50'});
    const l=await start(h,'personal',employee),c=await finish(h,l.id,'synthetic-coaster-233',employee);
    assert.equal((await h.get(route('connections'),employee)).connections.length,1);
    for(const cookie of [other,finance,h.owner]){
      assert.deepEqual((await h.get(route('connections'),cookie)).connections,[]);
      await h.post(route(`connections/${c.id}/disconnect`),{},cookie,403);
    }
    let count=edge.calls.length;
    await h.post(route('link'),{scope:'personal',consent:true},other,409);
    assert.equal(edge.calls.length,count,'full cap refuses before creating another provider connection');
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_plaid_connections').first()).n,1);
    assert.equal((await h.get(route('settings'))).monthToDateMinor,250);
    await h.post(route('settings'),{...plaidConfig,version:1,monthlyCap:'10.00'});
    const expired=await start(h,'company',finance);await h.db.prepare('UPDATE c_plaid_links SET expires_at=0 WHERE id=?').bind(expired.id).run();
    count=edge.calls.length;await finish(h,expired.id,'synthetic-coaster-235',finance,409);assert.equal(edge.calls.length,count);
    const revoked=await start(h,'company',finance);
    await h.post('settings'+ '/' + 'members',{email:'synthetic-coaster-232@example.test',name:'Synthetic',employee:true,finance:false});
    count=edge.calls.length;await finish(h,revoked.id,'synthetic-coaster-236',finance,403);assert.equal(edge.calls.length,count);
    // Both people start under the same remaining budget; only one can activate it.
    await h.post('settings' + '/' + 'members',{email:'synthetic-coaster-232@example.test',name:'Synthetic',employee:true,finance:true});
    await h.post(route('settings'),{...plaidConfig,version:2,monthlyCap:'5.00'});
    const pair=await Promise.all([start(h,'personal',other),start(h,'personal',finance)]);
    const outcomes=await Promise.all(pair.map((link,i)=>h.send('/api/coaster/'+route('exchange'),{link:link.id,publicToken:'synthetic-coaster-'+(238+i),consent:true},[other,finance][i])));
    assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409]);
    assert.equal((await h.get(route('settings'))).monthToDateMinor,500);
    for(const cookie of [other,finance]){
      const held=(await h.get(route('connections'),cookie)).connections;
      assert.equal(held.length,outcomes[[other,finance].indexOf(cookie)].status===200?1:0,'the refused concurrent exchange creates no provider item');
      if(held.length){assert.equal(held[0].status,'connected');await h.post(route(`connections/${held[0].id}/disconnect`),{},cookie);}
    }
    await h.post(route('settings'),{...plaidConfig,version:3,monthlyCap:'7.50'});
    const lost=await start(h,'company',finance);edge.loseExchange=true;
    const beforeLost=edge.calls.length;
    await finish(h,lost.id,'synthetic-coaster-241',finance,502);
    await finish(h,lost.id,'synthetic-coaster-241',finance,409);
    assert.equal(edge.calls.length,beforeLost+1,'an uncertain exchange is never resent');
    assert.equal((await h.get(route('settings'))).monthToDateMinor,750,'unknown exchange costs retain their reservation');
    await h.post(route('link'),{scope:'company',consent:true},finance,409);
    let claim=await h.post('claims',{title:'Manual expenses remain available'},employee);assert.ok(claim.id);
    const category=await h.post('settings'+ '/' + 'categories',{name:'Office',accountCode:'6500',taxCode:'NONE'});
    claim=await h.post(`claims/${claim.id}/items`,{version:claim.version,kind:'receipt',date:'2026-01-01',merchant:'Synthetic',amount:'1.00',allocations:[{category:category.id}],explanation:'Synthetic expense'},employee);
    claim=await h.post(`claims/${claim.id}/submit`,{version:claim.version},employee);
    claim=await h.post(`claims/${claim.id}/decision`,{version:claim.version,revision:claim.revision,decision:'rejected',reason:'Synthetic rejection',acknowledge:true},manager);
    await h.post('settings'+ '/' + 'members',{email,name:'Synthetic',employee:true,active:false});
    await h.post('settings'+ '/' + 'members' + '/' + 'erase',{email});
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_plaid_connections').first()).n,0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_plaid_links WHERE member_email=?').bind(email).first()).n,0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_claims WHERE id=?').bind(claim.id).first()).n,1);
    assert.equal((await h.get(route('settings'))).monthToDateMinor,750);
  }finally{await h.close();}
}

if(process.argv.includes('--run')) {
  await companyPlaidJourney();
  await personalPlaidJourney();
  console.log(JSON.stringify({source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),companyPlaidJourney:'PASS',personalPlaidJourney:'PASS',verifyCoverage:'manual journey; not loaded by push Verify'}));
}
