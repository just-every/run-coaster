import {webcrypto} from 'node:crypto';
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
    const stored=(await h.db.prepare('SELECT token_sealed FROM c_gusto_connection').first()).token_sealed;
    const [iv,cipher]=stored.split('.').map(value=>Buffer.from(value,'base64'));
    const key=await webcrypto.subtle.importKey('raw',await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode('coaster-public-webhook-v1\0local-test-secret-not-production-0123456789')),'AES-GCM',false,['decrypt']);
    const decrypt=company=>webcrypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('gusto:'+company)},key,cipher);
    assert.equal(new TextDecoder().decode(await decrypt(edge.company)),'synthetic-coaster-120','live custody is authenticated ciphertext bound to the installation secret and company');
    await assert.rejects(decrypt('synthetic-coaster-999'));
    assert.ok(!JSON.stringify(await h.get(['payroll','gusto'].join('/'))).includes(stored),'ciphertext is not exposed by the connection door');
    const root=`batches/${batch.id}/payroll`;
    const review=await h.get(root);
    assert.deepEqual(review.lines.map(l=>[l.reimbursementMinor,l.taxableMinor]),[[1000,1200]],'non-accountable expense plus actual taxable stipend flow into wages');
    await h.post(root,{version:batch.version,payroll:edge.payrollId,consent:true},h.owner,409);
    batch=await h.post(`batches/${batch.id}/release`,{version:batch.version});
    edge.uncalculated=true;
    const sent=await h.post(root,{version:batch.version,payroll:edge.payrollId,consent:true});
    assert.equal(sent.status,'sent');
    assert.equal(edge.writes.length,1);
    const financialEvidence=(await h.db.prepare('SELECT expected FROM c_payroll_handoffs').first()).expected;
    assert.ok(!financialEvidence.includes('Salary')&&!financialEvidence.includes('1000.00'),'unrelated salary amounts are not retained');
    const compensation=edge.payroll.employee_compensations[0];
    assert.deepEqual(compensation.reimbursements.map(r=>[r.description,r.amount]),[['Existing reimbursement','2.00'],['Coaster RB-0001','10.00']]);
    assert.deepEqual(compensation.fixed_compensations.map(f=>[f.name,f.amount]),[['Bonus','15.00'],['Salary','1000.00']]);
    assert.equal((await h.get(`batches/${batch.id}`)).batch.status,'approved');
    for(const id of t.claims)assert.equal((await h.get(`claims/${id}`,t.employee)).claim.status,'batched');
    assert.equal((await h.post(root+'/confirm',{})).confirmed,false);
    const current=(await h.get(`batches/${batch.id}`)).batch;
    await h.post(`batches/${batch.id}/paid`,{version:current.version,reference:'synthetic-coaster-121',paidOn:'2031-06-13'},t.finance,409);
    edge.uncalculated=false;
    edge.payroll={...edge.payroll,processed:true,processing_request:{status:'submit_success'}};
    compensation.fixed_compensations[0].amount='15.01';
    await h.post(root+'/confirm',{},h.owner,409);
    assert.equal((await h.get(`batches/${batch.id}`)).batch.status,'approved');
    compensation.fixed_compensations[0].amount='15.00';
    for(const receipt of [{company_uuid:'synthetic-coaster-999'},{payroll_uuid:'synthetic-coaster-999'},{employee_compensations:[{employee_uuid:edge.employee,total_reimbursement:'12.01'}]}]){
      edge.receipt=receipt;
      await h.post(root+'/confirm',{},h.owner,409);
      assert.equal((await h.get(`batches/${batch.id}`)).batch.status,'approved');
      for(const id of t.claims)assert.equal((await h.get(`claims/${id}`,t.employee)).claim.status,'batched');
    }
    edge.receipt=null;
    assert.equal((await h.post(root+'/confirm',{})).confirmed,true);
    assert.equal((await h.post(root+'/confirm',{})).confirmed,true,'confirmed readback is idempotent');
    for(const id of t.claims)assert.equal((await h.get(`claims/${id}`,t.employee)).claim.status,'reimbursed');
    assert.equal((await h.get(`batches/${batch.id}`)).batch.paid_reference,`Gusto ${edge.payrollId}`);
    const history=(await h.get('history')).lines.filter(e=>e.action.startsWith('payroll-')||e.action==='batch-reimbursed');
    assert.deepEqual(history.map(e=>e.action),['payroll-connected','payroll-employee-mapped','payroll-prepare-requested','payroll-handoff-reserved','payroll-handoff-sent','batch-reimbursed']);
    assert.ok(history.every((e,i)=>e.actor_email==='owner@harbourfinch.example'&&e.at&&e.channel==='app'&&e.agent===null&&(!i||e.seq>history[i-1].seq)));
    assert.ok(!JSON.stringify(history).includes('synthetic-coaster-120'));
    for(const method of ['PUT','PATCH','DELETE'])assert.notEqual((await h.mf.dispatchFetch(h.origin+'/api/coaster/history/'+history[0].id,{method,headers:{cookie:h.owner,origin:h.origin,'content-type':'application/json'},body:'{}'})).status,200);
    await assert.rejects(h.db.prepare('UPDATE c_events SET action=? WHERE seq=?').bind('changed',history[0].seq).run(),/history is permanent/);
    await assert.rejects(h.db.prepare('DELETE FROM c_events WHERE seq=?').bind(history[0].seq).run(),/history is permanent/);
    await assert.rejects(h.db.prepare("UPDATE c_payroll_handoffs SET lines='[]'").run(),/immutable/);
    assert.equal(edge.writes.length,1);
    await h.post(['settings', 'members'].join('/'),{email:t.memberEmail,name:'Sam Taylor',employee:true,active:false});
    const erased=await h.post('settings/members/erase',{email:t.memberEmail});
    const retained=await h.db.prepare('SELECT * FROM c_payroll_handoffs').first();
    assert.ok(!retained.lines.includes(t.memberEmail));
    assert.equal(JSON.parse(retained.lines)[0].email,erased.retained.subject);
    assert.deepEqual([retained.status,JSON.parse(retained.lines)[0].reimbursementMinor,JSON.parse(retained.lines)[0].taxableMinor],['confirmed',1000,1200]);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_gusto_employees').first()).n,0,'erasure drops payroll identity mappings');
    await assert.rejects(h.db.prepare('DELETE FROM c_payroll_handoffs WHERE batch_id=?').bind(batch.id).run(),/immutable/);
    await h.post(['settings', 'retention'].join('/'),{years:1});
    // Use stored instants and explicit scheduler instants, never a date-boundary assumption.
    const latest=(await h.db.prepare('SELECT MAX(updated_at) AS at FROM c_claims WHERE batch_id=?').bind(batch.id).first()).at;
    const tick=days=>h.mf.getWorker().then(worker=>worker.scheduled({scheduledTime:new Date(Date.parse(latest)+days*86400000),cron:'17 * * * *'}));
    await tick(300);
    assert.equal((await h.get('retention')).proposal,null);
    await tick(370);
    const proposal=(await h.get('retention')).proposal;
    assert.deepEqual(proposal.claims.map(unit=>[unit.batch,unit.claims.map(c=>c.id).sort()]),[[batch.id,[...t.claims].sort()]]);
    const hold=(await h.post('legal-holds',{scope:'business',reason:'Payroll review'})).holds.find(hold=>!hold.released_at);
    const refused=await h.post(`retention/${proposal.id}/confirm`,{});
    assert.deepEqual(refused.expired,[]);
    assert.equal(refused.skipped.length,2);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_payroll_handoffs WHERE batch_id=?').bind(batch.id).first()).n,1);
    await h.get(`batches/${batch.id}`);
    await h.post(`legal-holds/${hold.id}/release`,{});
    await tick(371);
    const next=(await h.get('retention')).proposal;
    assert.equal((await h.post(`retention/${next.id}/confirm`,{})).expired.length,2);
    await h.get(`batches/${batch.id}`,h.owner,404);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_payroll_handoffs WHERE batch_id=?').bind(batch.id).first()).n,0,'handoff expires only with its whole paid batch');
  } finally {await h.close();}
});

test('Payroll refuses unauthorized handoffs and recovers a lost provider acknowledgement without another payment write',async()=>{
  const edge=gustoFixture(),h=await harness({gustoEdge:r=>edge.fetch(r)});
  edge.payroll.employee_compensations[0].fixed_compensations=edge.payroll.employee_compensations[0].fixed_compensations.filter(f=>f.name!=='Bonus');
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
    await h.post(['settings', 'members'].join('/'),{email:'owner@harbourfinch.example',name:'Rose Owner',employee:true});
    await h.post('delegates',{delegate:'synthetic-coaster-130@example.invalid',level:'full'});
    const beforeRefusal=h.outbound.length;
    assert.equal((await h.send('/api/coaster/'+path,body,admin,{'x-coaster-acting-for':'owner@harbourfinch.example'})).status,403,'even a full owner delegate cannot hand off payroll');
    const agent=await h.post('agent-keys',{label:'Payroll preparation'});
    assert.equal((await h.send('/api/coaster/'+path,body,'',{authorization:`Bearer ${agent.token}`})).status,401,'a valid agent credential confers no native execution authority');
    assert.equal(h.outbound.length,beforeRefusal,'refused delegated and agent sends never contact Gusto');
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
    edge.earnings={default:[],custom:[]};
    await h.post(path,body,h.owner,409);
    assert.equal(edge.writes.length,0,'a taxable earning is never invented outside the provider catalog');
    edge.earnings={default:[{name:'Bonus'}],custom:[]};
    edge.lostAck=true;
    await h.post(path,body,h.owner,502);
    assert.equal((await h.get(path)).handoff.status,'reserved');
    await h.post(path,body,h.owner,409);
    assert.equal(edge.writes.length,1);
    edge.uncalculated=true;
    assert.equal((await h.post(path+'/confirm',{})).handoff.status,'reserved','an uncalculated response cannot resolve a lost acknowledgement');
    edge.uncalculated=false;
    assert.equal((await h.post(path+'/confirm',{})).handoff.status,'sent');
    await h.post(root+'/disconnect',{});
    const stopped=h.outbound.length;
    await h.post(path+'/confirm',{},h.owner,409);
    assert.equal(h.outbound.length,stopped,'disconnect prevents physical provider access');
    await connectFixture(h,edge,t.memberEmail);
    edge.payroll={...edge.payroll,processed:true};
    assert.equal((await h.post(path+'/confirm',{})).confirmed,true);
    assert.equal(edge.writes.length,1,'reconnection reconciles the original reserved effect');
    assert.equal(edge.payroll.employee_compensations[0].fixed_compensations.find(f=>f.name==='Bonus').amount,'12.00','a provider-listed earning can be added without inventing a job allocation');
  } finally {await h.close();}
});

test('Payroll refuses an owner’s own claim and unsupported currency, and selects only the earliest eligible regular run',async()=>{
  for(const options of [{ownClaim:true},{currency:'CAD'},{}]){
    const edge=gustoFixture(),h=await harness({gustoEdge:r=>edge.fetch(r)});
    try {
      const t=await payrollBatch(h,options);
      edge.employees[0].email=t.memberEmail;
      await connectFixture(h,edge,t.memberEmail);
      let batch=t.batch;
      if(options.ownClaim){
        await h.post(['settings', 'members'].join('/'),{email:'morgan@harbourfinch.example',name:'Morgan',employee:true,finance:true,release:true,approver:'priya@harbourfinch.example'});
        batch=await h.post(`batches/${batch.id}/release`,{version:batch.version},t.finance);
      }else batch=await h.post(`batches/${batch.id}/release`,{version:batch.version});
      const path=`batches/${batch.id}/payroll`,body={version:batch.version,payroll:edge.payrollId,consent:true};
      const before=h.outbound.length;
      if(options.ownClaim||options.currency){
        await h.post(path,body,h.owner,options.ownClaim?403:409);
        assert.equal(h.outbound.length,before);
      }else{
        const later={...edge.payroll,payroll_uuid:'synthetic-coaster-140',check_date:'2031-06-20'};
        const offCycle={...edge.payroll,payroll_uuid:'synthetic-coaster-141',check_date:'2031-06-01',off_cycle:true};
        const processed={...edge.payroll,payroll_uuid:'synthetic-coaster-142',check_date:'2031-05-01',processed:true};
        edge.runs=[later,offCycle,processed,edge.payroll];
        assert.deepEqual((await h.get(path)).payrolls.map(run=>run.payroll_uuid),[edge.payrollId]);
        for(const payroll of [later.payroll_uuid,offCycle.payroll_uuid,processed.payroll_uuid])await h.post(path,{...body,payroll},h.owner,409);
        assert.equal(edge.writes.length,0);
        assert.equal((await h.get(path)).handoff,null);
        await h.post(path,body);
        assert.equal((await h.get(path)).handoff.payroll_uuid,edge.payrollId);
        assert.equal(edge.writes.length,1);
      }
    }finally{await h.close();}
  }
});

test('A native batch crossing Gusto’s employee page limit reconciles every person and confirms only the complete receipt',async()=>{
  const edge=gustoFixture(),h=await harness({gustoEdge:r=>edge.fetch(r)});
  try {
    await h.post('settings/business',{name:'Harbour and Finch Studio',currency:'USD',timezone:'UTC',receiptThreshold:''});
    const category=(await h.post('settings/categories',{name:'Office',accountCode:'6500',taxCode:'NONE'})).id;
    const managerEmail='synthetic-coaster-200@example.invalid',manager=await h.person(managerEmail,{manager:true});
    const workers=Array.from({length:101},(_,i)=>({uuid:`synthetic-coaster-${300+i}`,email:`synthetic-coaster-${500+i}@example.invalid`,first_name:'Synthetic',last_name:`Employee ${i}`,terminated:false}));
    edge.employees=workers;
    edge.payroll={...edge.payroll,employee_compensations:workers.map(e=>({employee_uuid:e.uuid,version:'synthetic-coaster-700',excluded:false,payment_method:'Direct Deposit',reimbursements:[],fixed_compensations:[{name:'Bonus',amount:'0.00',job_uuid:'synthetic-coaster-701'}]}))};
    const root=['payroll','gusto'].join('/');
    await h.post(root+'/connect',{company:edge.company,token:'synthetic-coaster-120',consent:true});
    const claims=[];
    for(const worker of workers){
      const cookie=await h.person(worker.email,{employee:true},managerEmail,{'CF-Connecting-IP':`198.51.100.${workers.indexOf(worker)+1}`});
      let claim=await h.post('claims',{title:'Office purchase'},cookie);
      claim=await h.post(`claims/${claim.id}/items`,{version:claim.version,kind:'receipt',date:'2026-04-10',merchant:'Office stationery',amount:'1.00',allocations:[{category}],explanation:'Synthetic acceptance expense'},cookie);
      claim=await h.post(`claims/${claim.id}/submit`,{version:claim.version},cookie);
      claim=await h.post(`claims/${claim.id}/decision`,{version:claim.version,revision:claim.revision,decision:'approved',acknowledge:true},manager);
      claims.push(claim.id);
      await h.post(root+'/employees',{email:worker.email,employee:worker.uuid});
    }
    let batch=await h.post('batches',{claims});
    batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:10100});
    batch=await h.post(`batches/${batch.id}/release`,{version:batch.version});
    const path=`batches/${batch.id}/payroll`;
    edge.uncalculated=true;
    await h.post(path,{version:batch.version,payroll:edge.payrollId,consent:true});
    assert.deepEqual(edge.writes.map(w=>w.employee_compensations.length),[100,1]);
    assert.equal(edge.payroll.employee_compensations.length,workers.length);
    assert.ok(edge.payroll.employee_compensations.every(e=>e.reimbursements.length===1&&e.reimbursements[0].amount==='1.00'));
    assert.equal((await h.get(`batches/${batch.id}`)).batch.status,'approved');
    edge.uncalculated=false;
    edge.payroll={...edge.payroll,processed:true};
    assert.equal((await h.post(path+'/confirm',{})).confirmed,true);
    assert.equal((await h.get(`batches/${batch.id}`)).batch.status,'reimbursed');
    const paid=(await h.get('state')).claims.filter(c=>claims.includes(c.id));
    assert.equal(paid.length,workers.length);
    assert.ok(paid.every(c=>c.status==='reimbursed'));
  } finally {await h.close();}
});
