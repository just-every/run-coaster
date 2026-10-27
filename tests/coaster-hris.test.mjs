import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {hrisFixture,hrisRoot,setupHris,applyHris} from './hris-kit.mjs';

test('HRIS reviews hires and manager changes, preserves roles and hands off termination before immediate access loss',async()=>{
  const edge=hrisFixture(),h=await harness({gustoEdge:r=>edge.fetch(r)});
  try {
    await setupHris(h,edge);
    const hire=edge.employees[1];
    await applyHris(h,hire);
    let native=await h.db.prepare('SELECT * FROM c_members WHERE email=?').bind(hire.email).first();
    assert.deepEqual([native.name,native.active,native.is_employee,native.is_manager,native.is_finance,native.is_admin,native.approver_email],['Alex Hire',1,1,0,0,0,edge.employees[0].email]);
    const employee=await h.person(hire.email,{employee:true},edge.employees[0].email);
    const replacement=await h.person('synthetic-coaster-803@example.invalid',{employee:true,manager:true});
    edge.employees.push({uuid:'synthetic-coaster-803',email:'synthetic-coaster-803@example.invalid',first_name:'Casey',last_name:'Manager',terminated:false});
    await applyHris(h,edge.employees[2]);
    hire.manager_uuid='synthetic-coaster-803';
    const stale=await h.get(hrisRoot+'/preview');
    hire.first_name='Alexandra';
    await h.post(hrisRoot+'/sync',{employee:hire.uuid,email:hire.email,fingerprint:stale.fingerprint,consent:true},h.owner,409);
    await applyHris(h,hire);
    native=await h.db.prepare('SELECT * FROM c_members WHERE email=?').bind(hire.email).first();
    assert.deepEqual([native.name,native.approver_email,native.is_manager],['Alexandra Hire',edge.employees[2].email,0]);
    await h.get('state',employee);
    // Make this person an approver with a waiting claim; HRIS must retain their role and use the existing handoff.
    await h.post('settings/members',{email:hire.email,name:hire.first_name,employee:true,manager:true,approver:edge.employees[2].email});
    const subordinate=await h.person('synthetic-coaster-804@example.invalid',{employee:true},hire.email);
    const category=(await h.post('settings/categories',{name:'Office',accountCode:'6500',taxCode:'NONE'})).id;
    let claim=await h.post('claims',{title:'Office purchase'},subordinate);
    claim=await h.post(`claims/${claim.id}/items`,{version:claim.version,kind:'receipt',date:'2026-04-10',merchant:'Office',amount:'2.00',allocations:[{category}],explanation:'Synthetic evidence'},subordinate);
    claim=await h.post(`claims/${claim.id}/submit`,{version:claim.version},subordinate);
    hire.terminated=true;
    await applyHris(h,hire,{successor:'synthetic-coaster-804@example.invalid'},h.owner,409);
    assert.equal((await h.get('state',employee)).actor.email,hire.email);
    await applyHris(h,hire,{successor:edge.employees[2].email});
    await h.get('state',employee,403);
    assert.equal((await h.get(`claims/${claim.id}`,replacement)).claim.approver_email,edge.employees[2].email);
    native=await h.db.prepare('SELECT * FROM c_members WHERE email=?').bind(hire.email).first();
    assert.deepEqual([native.active,native.is_manager],[0,1]);
    assert.equal(edge.writes.length,0,'HRIS makes no payroll or card-provider writes');
    const history=(await h.get('history')).lines.filter(e=>e.action.startsWith('hris-'));
    assert.deepEqual(history.map(e=>e.action),['hris-connected',...Array(5).fill('hris-synced')]);
    assert.deepEqual(history.at(-1).detail.after,{name:'Alexandra Hire',manager:edge.employees[2].email,active:false});
    assert.ok(history.every((e,i)=>e.actor_email==='owner@harbourfinch.example'&&e.channel==='app'&&e.at&&(!i||e.seq>history[i-1].seq)));
    for(const method of ['PUT','PATCH','DELETE'])assert.notEqual((await h.mf.dispatchFetch(h.origin+'/api/coaster/history/'+history[0].seq,{method,headers:{cookie:h.owner,origin:h.origin,'content-type':'application/json'},body:'{}'})).status,200);
    await assert.rejects(h.db.prepare('DELETE FROM c_events WHERE seq=?').bind(history[0].seq).run(),/history is permanent/);
    await assert.rejects(h.db.prepare("UPDATE c_events SET action='changed' WHERE seq=?").bind(history[0].seq).run(),/history is permanent/);
    hire.terminated=false;
    await applyHris(h,hire,{},h.owner,409);
  }finally{await h.close();}
});

test('HRIS connection matrix refuses unsafe identities, stale review and withdrawn authority with no native or provider writes',async()=>{
  const edge=hrisFixture(),h=await harness({gustoEdge:r=>edge.fetch(r)});
  try{
    await h.post('settings/business',{name:'Harbour and Finch',currency:'USD',timezone:'UTC'});
    const connect={company:edge.company,token:'synthetic-coaster-810',consent:true};
    for(const role of ['cardAdmin','manager','auditor','bookkeeper','employee']){
      const cookie=await h.person(`synthetic-coaster-${role.toLowerCase()}@example.invalid`,{[role]:true});
      const before=h.outbound.length,events=(await h.db.prepare('SELECT COUNT(*) n FROM c_events').first()).n;
      await h.post(hrisRoot+'/connect',connect,cookie,403);
      await h.post(hrisRoot+'/disconnect',{},cookie,403);
      await h.get(hrisRoot+'/preview',cookie,403);
      await h.post(hrisRoot+'/sync',{consent:true},cookie,403);
      assert.equal(h.outbound.length,before);
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_events').first()).n,events);
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_hris_connection').first()).n,0);
    }
    for(const role of ['admin','finance']){
      const address=`synthetic-coaster-${role.toLowerCase()}@example.invalid`,cookie=await h.person(address,{[role]:true});
      await h.post(hrisRoot+'/connect',{...connect,consent:false},cookie,400);
      await h.post(hrisRoot+'/connect',connect,cookie);
      const status=await h.get(hrisRoot,cookie);
      assert.equal(status.connection.company_uuid,edge.company);
      assert.ok(!JSON.stringify(status).includes('synthetic-coaster-810'));
      const sealed=(await h.db.prepare('SELECT token_sealed FROM c_hris_connection').first()).token_sealed;
      assert.ok(!sealed.includes(connect.token));
      await h.get(['payroll','gusto'].join('/'),cookie,403);
      const preview=await h.get(hrisRoot+'/preview',cookie);
      await h.post('settings/members',{email:address,name:'Changed role',employee:true});
      const before=h.outbound.length;
      await h.post(hrisRoot+'/sync',{employee:edge.employees[0].uuid,email:edge.employees[0].email,fingerprint:preview.fingerprint,consent:true},cookie,role==='admin'?401:403);
      assert.equal(h.outbound.length,before);
      await h.post(hrisRoot+'/disconnect',{});
    }
    await setupHris(h,edge);
    await applyHris(h,edge.employees[1],{email:'owner@harbourfinch.example'},h.owner,403);
    const before=(await h.get(hrisRoot+'/preview')).fingerprint;
    edge.employees[1].manager_uuid='synthetic-coaster-unknown';
    await applyHris(h,edge.employees[1],{},h.owner,409);
    assert.equal(await h.db.prepare('SELECT 1 FROM c_members WHERE email=?').bind(edge.employees[1].email).first(),null);
    edge.hold=async request=>{if(new URL(request.url).pathname.endsWith('/employees')){edge.hold=null;await h.post(hrisRoot+'/disconnect',{});}};
    await h.get(hrisRoot+'/preview',h.owner,409);
    assert.ok(before);
    assert.ok(h.outbound.filter(r=>r.url.startsWith('https://api.gusto-demo.com')).every(r=>r.method==='GET'&&!r.body));
  }finally{await h.close();}
});
