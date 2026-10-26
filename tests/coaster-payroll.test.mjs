import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {gustoFixture} from './fixtures/payroll.mjs';
import {connectFixture,payrollBatch} from './payroll-kit.mjs';

test('Payroll preserves the reviewed split, waits for exact provider confirmation, and retains immutable numbered history',async()=>{
  const edge=gustoFixture(),h=await harness({gustoEdge:r=>edge.fetch(r)});
  try {
    const t=await payrollBatch(h);let batch=t.batch;
    await connectFixture(h,edge,t.memberEmail);
    const root=`batches/${batch.id}/payroll`;
    const review=await h.get(root);
    assert.deepEqual(review.lines.map(l=>[l.reimbursementMinor,l.taxableMinor]),[[1000,1200]],'non-accountable expense plus actual taxable stipend flow into wages');
    await h.post(root,{version:batch.version,payroll:edge.payrollId,consent:true},h.owner,409);
    batch=await h.post(`batches/${batch.id}/release`,{version:batch.version});
    await h.post(root,{version:batch.version,payroll:edge.payrollId,consent:true});
    assert.equal(edge.writes.length,1);
    const compensation=edge.payroll.employee_compensations[0];
    assert.deepEqual(compensation.reimbursements.map(r=>[r.description,r.amount]),[['Existing reimbursement','2.00'],['Coaster RB-0001','10.00']]);
    assert.deepEqual(compensation.fixed_compensations.map(f=>[f.name,f.amount]),[['Bonus','15.00'],['Salary','1000.00']]);
    assert.equal((await h.get(`batches/${batch.id}`)).batch.status,'approved');
    for(const id of t.claims)assert.equal((await h.get(`claims/${id}`,t.employee)).claim.status,'batched');
    assert.equal((await h.post(root+'/confirm',{})).confirmed,false);
    const current=(await h.get(`batches/${batch.id}`)).batch;
    await h.post(`batches/${batch.id}/paid`,{version:current.version,reference:'synthetic-coaster-121',paidOn:'2031-06-13'},t.finance,409);
    edge.payroll={...edge.payroll,processed:true,processing_request:{status:'submit_success'}};
    compensation.fixed_compensations[0].amount='15.01';
    await h.post(root+'/confirm',{},h.owner,409);
    assert.equal((await h.get(`batches/${batch.id}`)).batch.status,'approved');
    compensation.fixed_compensations[0].amount='15.00';
    assert.equal((await h.post(root+'/confirm',{})).confirmed,true);
    assert.equal((await h.post(root+'/confirm',{})).confirmed,true,'confirmed readback is idempotent');
    for(const id of t.claims)assert.equal((await h.get(`claims/${id}`,t.employee)).claim.status,'reimbursed');
    assert.equal((await h.get(`batches/${batch.id}`)).batch.paid_reference,`Gusto ${edge.payrollId}`);
    const history=(await h.get('history')).lines.filter(e=>e.action.startsWith('payroll-')||e.action==='batch-reimbursed');
    assert.deepEqual(history.map(e=>e.action),['payroll-connected','payroll-employee-mapped','payroll-prepare-requested','payroll-handoff-reserved','payroll-handoff-sent','batch-reimbursed']);
    assert.ok(history.every((e,i)=>e.actor_email==='owner@harbourfinch.example'&&e.at&&e.channel==='app'&&(!i||e.seq>history[i-1].seq)));
    assert.ok(!JSON.stringify(history).includes('synthetic-coaster-120'));
    for(const method of ['PUT','PATCH','DELETE'])assert.notEqual((await h.mf.dispatchFetch(h.origin+'/api/coaster/history/'+history[0].id,{method,headers:{cookie:h.owner,origin:h.origin,'content-type':'application/json'},body:'{}'})).status,200);
    await assert.rejects(h.db.prepare('UPDATE c_events SET action=? WHERE seq=?').bind('changed',history[0].seq).run(),/history is permanent/);
    await assert.rejects(h.db.prepare('DELETE FROM c_events WHERE seq=?').bind(history[0].seq).run(),/history is permanent/);
    await assert.rejects(h.db.prepare("UPDATE c_payroll_handoffs SET lines='[]'").run(),/immutable/);
    assert.equal(edge.writes.length,1);
  } finally {await h.close();}
});

test('Payroll refuses unauthorized handoffs and recovers a lost provider acknowledgement without another payment write',async()=>{
  const edge=gustoFixture(),h=await harness({gustoEdge:r=>edge.fetch(r)});
  try {
    const t=await payrollBatch(h),root=['payroll','gusto'].join('/');
    const admin=await h.person('synthetic-coaster-130@example.invalid',{admin:true});
    for(const cookie of [t.employee,t.manager,t.finance,admin]){
      await h.post(root+'/connect',{company:edge.company,token:'synthetic-coaster-120',consent:true},cookie,403);
      await h.get(root,cookie,403);
    }
    const before=h.outbound.length;
    await h.post(root+'/connect',{company:edge.company,token:'synthetic-coaster-120'},h.owner,400);
    assert.equal(h.outbound.length,before);
    await connectFixture(h,edge,t.memberEmail);
    let batch=await h.post(`batches/${t.batch.id}/release`,{version:t.batch.version});
    const path=`batches/${batch.id}/payroll`,body={version:batch.version,payroll:edge.payrollId,consent:true};
    for(const cookie of [t.employee,t.manager,t.finance,admin])await h.post(path,body,cookie,403);
    assert.equal((await h.send('/api/coaster/'+path,body,h.owner,{origin:'https://foreign.example'})).status,403);
    const ownerSession=await h.db.prepare("SELECT s.id,s.created_at FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id WHERE o.role='owner'").first();
    await h.db.prepare('UPDATE oa_sessions SET created_at=? WHERE id=?').bind(Date.now()-11*60000,ownerSession.id).run();
    await h.post(path,body,h.owner,401);
    await h.db.prepare('UPDATE oa_sessions SET created_at=? WHERE id=?').bind(ownerSession.created_at,ownerSession.id).run();
    edge.hold=async request=>{
      if(new URL(request.url).pathname.endsWith('/prepare')){
        edge.hold=null;
        await h.post(root+'/disconnect',{});
      }
    };
    await h.post(path,body,h.owner,409);
    assert.equal(edge.writes.length,0,'connection withdrawal after provider preparation prevents the payment update');
    assert.equal((await h.get(path)).handoff,null);
    await connectFixture(h,edge,t.memberEmail);
    edge.lostAck=true;
    await h.post(path,body,h.owner,502);
    assert.equal((await h.get(path)).handoff.status,'reserved');
    await h.post(path,body,h.owner,409);
    assert.equal(edge.writes.length,1);
    assert.equal((await h.post(path+'/confirm',{})).handoff.status,'sent');
    await h.post(root+'/disconnect',{});
    const stopped=h.outbound.length;
    await h.post(path+'/confirm',{},h.owner,409);
    assert.equal(h.outbound.length,stopped,'disconnect prevents physical provider access');
    await connectFixture(h,edge,t.memberEmail);
    edge.payroll={...edge.payroll,processed:true};
    assert.equal((await h.post(path+'/confirm',{})).confirmed,true);
    assert.equal(edge.writes.length,1,'reconnection reconciles the original reserved effect');
  } finally {await h.close();}
});
