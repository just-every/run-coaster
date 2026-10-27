import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {hrisAddress,hrisFixture,hrisRoot,setupHris,applyHris} from './hris-kit.mjs';

test('HRIS reviews hires and manager changes, preserves roles and hands off termination before immediate access loss',async()=>{
  const edge=hrisFixture(),h=await harness({gustoEdge:r=>edge.fetch(r)});
  try {
    await setupHris(h,edge);
    const hire=edge.employees[1];
    await applyHris(h,hire);
    let native=await h.db.prepare('SELECT * FROM c_members WHERE email=?').bind(hire.email).first();
    assert.deepEqual([native.name,native.active,native.is_employee,native.is_manager,native.is_finance,native.is_admin,native.may_release,native.approver_email],['Alex Hire',1,1,0,0,0,0,edge.employees[0].email]);
    const employee=await h.person(hire.email,{employee:true},edge.employees[0].email);
    const replacement=await h.person(hrisAddress('803'),{employee:true,manager:true});
    edge.employees.push({uuid:'synthetic-coaster-803',email:hrisAddress('803'),first_name:'Casey',last_name:'Manager',terminated:false});
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
    await h.post(['settings', 'members'].join('/'),{email:hire.email,name:hire.first_name,employee:true,manager:true,finance:true,release:true,approver:edge.employees[2].email});
    const subordinate=await h.person(hrisAddress('804'),{employee:true},hire.email);
    const category=(await h.post(['settings', 'categories'].join('/'),{name:'Office',accountCode:'6500',taxCode:'NONE'})).id;
    let claim=await h.post('claims',{title:'Office purchase'},subordinate);
    claim=await h.post(`claims/${claim.id}/items`,{version:claim.version,kind:'receipt',date:'2026-04-10',merchant:'Office',amount:'2.00',allocations:[{category}],explanation:'Synthetic evidence'},subordinate);
    claim=await h.post(`claims/${claim.id}/submit`,{version:claim.version},subordinate);
    // A private original attached to an unsubmitted posted charge must stay with the departed person.
    const form=new FormData();form.append('file',new Blob([await readFile('tests/fixtures/receipts/bistro.png')],{type:'image/png'}),'synthetic-coaster-private.png');form.append('source','upload');
    const uploadRequest=new Request(h.origin+'/api/coaster/receipt-inbox',{method:'POST',headers:{origin:h.origin,cookie:employee},body:form});
    const upload=await h.mf.dispatchFetch(uploadRequest.url,{method:'POST',headers:Object.fromEntries(uploadRequest.headers),body:await uploadRequest.arrayBuffer()});
    assert.equal(upload.status,200);const original=(await upload.json()).receipt;
    await h.post('statements/cards',{issuer:'Synthetic HRIS card',last4:'8822',employee:hire.email});
    const file={format:'csv',name:'synthetic-coaster-hris.csv',issuer:'Synthetic HRIS card',category,content:'Posted,Merchant,Amount,Id\n2026-04-10,Office,2.00,synthetic-coaster-hris-charge',mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Posted',description:'Merchant',amount:'Amount',transactionId:'Id',wholeFileLast4:'8822'}};
    const plan=await h.post('statements/preview',file);
    const imported=await h.post('statements/commit',{...file,fingerprint:plan.fingerprint});
    const cardClaim=await h.get(`claims/${imported.claims[0]}`,employee);
    await h.post(`receipt-inbox/${original.id}/attach`,{expectedSequence:0,claimId:cardClaim.claim.id,itemId:cardClaim.items[0].id,version:cardClaim.claim.version},employee);
    assert.equal((await h.get('receipt-inbox',employee)).receipts.find(r=>r.id===original.id).attachment.claimId,cardClaim.claim.id);
    await h.post('delegates',{grantor:hire.email,delegate:hrisAddress('804'),level:'full'});
    assert.equal((await h.send('/api/coaster/state',undefined,subordinate,{'x-coaster-acting-for':hire.email})).status,200);
    hire.terminated=true;
    await applyHris(h,hire,{successor:hrisAddress('804')},h.owner,409);
    assert.equal((await h.get('state',employee)).actor.email,hire.email);
    await applyHris(h,hire,{successor:edge.employees[2].email});
    await h.get('state',employee,403);
    assert.equal((await h.send('/api/coaster/state',undefined,subordinate,{'x-coaster-acting-for':hire.email})).status,403,'termination immediately fences the departed grantor delegation');
    assert.equal((await h.get(`claims/${claim.id}`,replacement)).claim.approver_email,edge.employees[2].email);
    native=await h.db.prepare('SELECT * FROM c_members WHERE email=?').bind(hire.email).first();
    assert.deepEqual([native.active,native.is_manager,native.is_finance,native.may_release],[0,1,1,1]);
    const handed=(await h.get('statements')).charges.find(c=>c.id===cardClaim.items[0].card_charge_id);
    assert.equal(handed.employee_email,edge.employees[2].email);
    const successorClaim=await h.get(`claims/${handed.claim_id}`,replacement);
    assert.equal(successorClaim.items.length,1);assert.equal(successorClaim.items[0].receipt_id,null);
    assert.equal((await h.db.prepare('SELECT owner_email FROM c_capture_receipts WHERE id=?').bind(original.id).first()).owner_email,hire.email);
    assert.ok(!(await h.get('receipt-inbox',replacement)).receipts.some(r=>r.id===original.id));
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_card_handoffs').first()).n,1);
    await applyHris(h,hire,{successor:edge.employees[2].email});
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_card_handoffs').first()).n,1,'replayed termination does not repeat the local handoff');
    assert.equal(edge.writes.length,0,'HRIS makes no payroll or card-provider writes');
    assert.ok(h.outbound.filter(r=>r.url.startsWith('https://api.gusto-demo.com')).every(r=>r.method==='GET'&&!r.body),'termination is also read-only at the Gusto boundary');
    const history=(await h.get('history')).lines.filter(e=>e.action.startsWith('hris-'));
    assert.deepEqual(history.map(e=>e.action),['hris-connected',...Array(6).fill('hris-synced')]);
    assert.deepEqual(history.at(-1).detail.after,{name:'Alexandra Hire',manager:edge.employees[2].email,active:false});
    const ownerAddress=(await h.get('state')).actor.email;
    assert.ok(history.every((e,i)=>e.actor_email===ownerAddress&&e.channel==='app'&&e.at&&(!i||e.seq>history[i-1].seq)));
    for(const method of ['PUT','PATCH','DELETE'])assert.notEqual((await h.mf.dispatchFetch(h.origin+'/api/coaster/history/'+history[0].seq,{method,headers:{cookie:h.owner,origin:h.origin,'content-type':'application/json'},body:'{}'})).status,200);
    await assert.rejects(h.db.prepare('DELETE FROM c_events WHERE seq=?').bind(history[0].seq).run(),/history is permanent/);
    await assert.rejects(h.db.prepare("UPDATE c_events SET action='changed' WHERE seq=?").bind(history[0].seq).run(),/history is permanent/);
    hire.terminated=false;
    await applyHris(h,hire,{},h.owner,409);
    await h.post(`claims/${claim.id}/decision`,{version:(await h.get(`claims/${claim.id}`,replacement)).claim.version,revision:claim.revision,decision:'approved',acknowledge:true},replacement);
    await h.post(['settings','members','erase'].join('/'),{email:hire.email},h.owner,409);
    const erasable={uuid:'synthetic-coaster-805',email:hrisAddress('805'),first_name:'Departed',last_name:'Colleague',terminated:false};
    edge.employees.push(erasable);await applyHris(h,erasable);
    erasable.first_name='Former';await applyHris(h,erasable);
    erasable.terminated=true;await applyHris(h,erasable);
    const erased=await h.post(['settings', 'members', 'erase'].join('/'),{email:erasable.email});
    assert.equal(erased.removed.hrisMappings,1);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_hris_mappings WHERE email=?').bind(erasable.email).first()).n,0);
    const retained=JSON.stringify((await h.get('history')).lines.filter(e=>e.action==='hris-synced'));
    for(const value of [erasable.email,'Departed Colleague','Former Colleague'])assert.ok(!retained.includes(value),'HRIS history erases historical personal names and addresses');
  }finally{await h.close();}
});

test('HRIS connection matrix refuses unsafe identities, stale review and withdrawn authority with no native or provider writes',async()=>{
  const edge=hrisFixture(),h=await harness({gustoEdge:r=>edge.fetch(r)});
  try{
    await h.post(['settings', 'business'].join('/'),{name:'Harbour and Finch',currency:'USD',timezone:'UTC'});
    const connect={company:edge.company,token:'synthetic-coaster-810',consent:true};
    for(const role of ['cardAdmin','manager','auditor','bookkeeper','employee']){
      const cookie=await h.person(hrisAddress(role.toLowerCase()),{[role]:true});
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
      const address=hrisAddress(role.toLowerCase()),cookie=await h.person(address,{[role]:true});
      await h.post(hrisRoot+'/connect',{...connect,consent:false},cookie,400);
      await h.post(hrisRoot+'/connect',connect,cookie);
      const disconnectRequests=h.outbound.length,disconnectEvents=(await h.db.prepare('SELECT COUNT(*) n FROM c_events').first()).n;
      for(const body of [{},{company:edge.company,consent:false},{company:'synthetic-coaster-wrong-company',consent:true}])await h.post(hrisRoot+'/disconnect',body,cookie,400);
      assert.equal(h.outbound.length,disconnectRequests);
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_events').first()).n,disconnectEvents);
      const status=await h.get(hrisRoot,cookie);
      assert.equal(status.connection.company_uuid,edge.company);
      assert.ok(!JSON.stringify(status).includes('synthetic-coaster-810'));
      const sealed=(await h.db.prepare('SELECT token_sealed FROM c_hris_connection').first()).token_sealed;
      assert.ok(!sealed.includes(connect.token));
      await h.get(['payroll','gusto'].join('/'),cookie,403);
      await h.post(hrisRoot+'/disconnect',{company:edge.company,consent:true},cookie);
      assert.equal((await h.get(hrisRoot,cookie)).connection,null);
      await h.post(hrisRoot+'/connect',connect,cookie);
      const preview=await h.get(hrisRoot+'/preview',cookie);
      if(role==='finance'){
        const before=h.outbound.length;
        await h.post(hrisRoot+'/sync',{employee:edge.employees[0].uuid,email:edge.employees[0].email,fingerprint:preview.fingerprint,consent:true},cookie,403);
        assert.equal(h.outbound.length,before,'finance connection rights confer no People writes');
        await h.post(['settings','members'].join('/'),{email:edge.employees[1].email,name:'Not authorized',admin:true},cookie,403);
        assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_hris_mappings').first()).n,0);
      }
      await h.post(['settings', 'members'].join('/'),{email:address,name:'Changed role',employee:true});
      const before=h.outbound.length;
      await h.post(hrisRoot+'/sync',{employee:edge.employees[0].uuid,email:edge.employees[0].email,fingerprint:preview.fingerprint,consent:true},cookie,role==='admin'?401:403);
      assert.equal(h.outbound.length,before);
      await h.post(hrisRoot+'/disconnect',{company:edge.company,consent:true});
    }
    await setupHris(h,edge);
    await applyHris(h,edge.employees[1],{email:(await h.get('state')).actor.email},h.owner,403);
    const delegateEmail=hrisAddress('820'),delegate=await h.person(delegateEmail,{employee:true});
    const grantor=hrisAddress('admin');
    await h.post(['settings', 'members'].join('/'),{email:grantor,name:'Admin',admin:true});
    const acting={'x-coaster-acting-for':grantor};
    const send=(suffix,body)=>h.send('/api/coaster/'+hrisRoot+suffix,body,delegate,acting);
    const grant=await h.post('delegates',{grantor,delegate:delegateEmail,level:'full'});
    const delegated=await send('/preview');assert.equal(delegated.status,200);
    await h.post(hrisRoot+'/disconnect',{company:edge.company,consent:true});
    assert.equal((await send('/connect',connect)).status,200,'live Full admin delegate connects with explicit provider consent');
    await applyHris(h,edge.employees[0]);
    const currentDelegated=await send('/preview');assert.equal(currentDelegated.status,200);
    const body={employee:edge.employees[1].uuid,email:edge.employees[1].email,fingerprint:currentDelegated.value.fingerprint,consent:true};
    assert.equal((await send('/sync',{...body,consent:false})).status,400);
    assert.equal((await send('/sync',body)).status,200,'live Full admin delegate applies within People authority');
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_hris_mappings WHERE employee_uuid=?').bind(edge.employees[1].uuid).first()).n,1);
    const lines=(await h.get('history')).lines.filter(e=>e.action.startsWith('hris-')&&e.actor_email===delegateEmail);
    assert.deepEqual(lines.map(e=>e.action),['hris-connected','hris-synced']);
    assert.ok(lines.every(e=>e.detail.actingFor===grantor&&e.channel==='app'&&e.at),'delegate history names actor, grantor, channel and time');
    assert.equal((await send('/disconnect',{company:edge.company,consent:true})).status,200);
    await h.post(hrisRoot+'/connect',connect);
    const submit=await h.post('delegates',{grantor,delegate:delegateEmail,level:'submit'});
    for(const [suffix,payload] of [['/preview',undefined],['/connect',connect],['/disconnect',{}],['/sync',{consent:true}]]){
      assert.equal((await send(suffix,payload)).status,403,'Submit-only delegation has no HRIS authority');
    }
    await h.post(`delegates/${submit.id}/revoke`,{});
    const renewed=await h.post('delegates',{grantor,delegate:delegateEmail,level:'full'});
    assert.equal((await send('/preview')).status,200);
    await h.post(`delegates/${renewed.id}/revoke`,{});
    const requests=h.outbound.length;
    for(const [suffix,payload] of [['/preview',undefined],['/connect',connect],['/disconnect',{}],['/sync',body]])assert.equal((await send(suffix,payload)).status,403);
    assert.equal(h.outbound.length,requests,'withdrawn grant makes no provider request');
    await applyHris(h,edge.employees[0]);
    await applyHris(h,edge.employees[1]);
    await applyHris(h,edge.employees[1],{email:(await h.get('state')).actor.email},h.owner,409);

    const peer={uuid:'synthetic-coaster-830',email:hrisAddress('830'),first_name:'No',last_name:'Authority',terminated:false};
    await h.person(peer.email,{employee:true});edge.employees.push(peer);await applyHris(h,peer);
    edge.employees[1].manager_uuid=peer.uuid;
    await applyHris(h,edge.employees[1],{},h.owner,409);
    assert.equal((await h.db.prepare('SELECT is_manager FROM c_members WHERE email=?').bind(peer.email).first()).is_manager,0,'provider manager references create no native approver authority');
    const before=(await h.get(hrisRoot+'/preview')).fingerprint;
    edge.employees[1].manager_uuid='synthetic-coaster-unknown';
    await applyHris(h,edge.employees[1],{},h.owner,409);
    assert.equal((await h.db.prepare('SELECT approver_email FROM c_members WHERE email=?').bind(edge.employees[1].email).first()).approver_email,edge.employees[0].email);
    edge.hold=async request=>{if(new URL(request.url).pathname.endsWith('/employees')){edge.hold=null;await h.post(hrisRoot+'/disconnect',{company:edge.company,consent:true});}};
    await h.get(hrisRoot+'/preview',h.owner,409);
    assert.ok(before);
    assert.ok(h.outbound.filter(r=>r.url.startsWith('https://api.gusto-demo.com')).every(r=>r.method==='GET'&&!r.body));
  }finally{await h.close();}
  await fullDelegationAuthority();
});

async function fullDelegationAuthority(){
  const edge=hrisFixture(),h=await harness({gustoEdge:r=>edge.fetch(r)});
  try{
    await setupHris(h,edge);
    const delegateAddress=hrisAddress('860'),delegate=await h.person(delegateAddress,{employee:true,admin:true});
    const ownerAddress=(await h.get('state')).actor.email;
    await h.post(['settings','members'].join('/'),{email:ownerAddress,name:'Owner',employee:true});
    const connect={company:edge.company,token:'synthetic-coaster-810',consent:true};
    const snapshot=async()=>JSON.stringify(await h.db.prepare('SELECT (SELECT json_group_array(json_object(\'email\',email,\'active\',active,\'admin\',is_admin,\'manager\',approver_email)) FROM c_members) people,(SELECT COUNT(*) FROM c_events) events,(SELECT COUNT(*) FROM c_hris_mappings) mappings,(SELECT COUNT(*) FROM c_hris_connection) connections').first());
    for(const role of ['owner','admin','finance']){
      const grantor=role==='owner'?ownerAddress:hrisAddress('grantor-'+role);
      if(role!=='owner')await h.person(grantor,{employee:true,[role]:true});
      await h.post('delegates',{grantor,delegate:delegateAddress,level:'full'});
      const acting={'x-coaster-acting-for':grantor};
      const send=(suffix,body)=>h.send('/api/coaster/'+hrisRoot+suffix,body,delegate,acting);
      await h.post(hrisRoot+'/disconnect',{company:edge.company,consent:true});
      const beforeConnect=h.outbound.length,unchanged=await snapshot();
      assert.equal((await send('/connect',{...connect,consent:false})).status,400);
      assert.equal(h.outbound.length,beforeConnect);assert.equal(await snapshot(),unchanged);
      assert.equal((await send('/connect',connect)).status,200);
      const review=await send('/preview');assert.equal(review.status,200);
      const hire={uuid:'synthetic-coaster-861-'+role,email:hrisAddress('861-'+role),first_name:'Delegated',last_name:'Hire',terminated:false};
      if(!edge.employees.some(p=>p.uuid===hire.uuid))edge.employees.push(hire);
      else edge.employees.find(p=>p.uuid===hire.uuid).first_name=role;
      const fresh=await send('/preview');assert.equal(fresh.status,200);
      const body={employee:hire.uuid,email:hire.email,consent:true,fingerprint:fresh.value.fingerprint};
      if(role==='finance'){
        const before=await snapshot(),requests=h.outbound.length;
        for(const person of [edge.employees[0],edge.employees[1],hire]){
          assert.equal((await send('/sync',{...body,employee:person.uuid,email:person.email})).status,403,'finance grantor cannot apply any roster change even when delegate personally holds admin');
        }
        assert.equal(h.outbound.length,requests);assert.equal(await snapshot(),before,'finance refusal has no native writes');
      }else{
        const personal=await h.get(hrisRoot+'/preview');
        assert.equal((await send('/sync',{...body,fingerprint:personal.fingerprint})).status,409,'review is bound to the acting authority');
        assert.equal((await send('/sync',body)).status,200);
        const native=await h.db.prepare('SELECT is_employee,is_admin,is_finance FROM c_members WHERE email=?').bind(hire.email).first();
        assert.deepEqual(native,{is_employee:1,is_admin:0,is_finance:0});
        hire.manager_uuid=edge.employees[0].uuid;
        await applyHris(h,edge.employees[0]);
        const managerReview=await send('/preview');
        assert.equal((await send('/sync',{...body,fingerprint:managerReview.value.fingerprint})).status,200,'People-authorized delegate applies manager change');
        assert.equal((await h.db.prepare('SELECT approver_email FROM c_members WHERE email=?').bind(hire.email).first()).approver_email,edge.employees[0].email);
        hire.terminated=true;
        const terminationReview=await send('/preview');
        assert.equal((await send('/sync',{...body,fingerprint:terminationReview.value.fingerprint})).status,200,'People-authorized delegate applies termination');
        assert.equal((await h.db.prepare('SELECT active FROM c_members WHERE email=?').bind(hire.email).first()).active,0);
        const line=(await h.get('history')).lines.filter(e=>e.action==='hris-synced').at(-1);
        assert.equal(line.actor_email,delegateAddress);assert.equal(line.detail.actingFor,grantor);
      }
      assert.equal((await send('/disconnect',{company:edge.company,consent:true})).status,200);
      await h.post(hrisRoot+'/connect',connect);
    }
    const grantor=hrisAddress('grantor-admin'),acting={'x-coaster-acting-for':grantor};
    const send=(suffix,body)=>h.send('/api/coaster/'+hrisRoot+suffix,body,delegate,acting);
    const reviewed=await send('/preview');assert.equal(reviewed.status,200);
    const body={employee:edge.employees[1].uuid,email:edge.employees[1].email,consent:true,fingerprint:reviewed.value.fingerprint};
    // Current grantor loses People authority while retaining connection authority.
    await h.post(['settings','members'].join('/'),{email:grantor,name:'Finance now',employee:true,finance:true});
    const before=await snapshot(),requests=h.outbound.length;
    assert.equal((await send('/sync',body)).status,403);assert.equal(h.outbound.length,requests);assert.equal(await snapshot(),before);
    assert.equal((await send('/preview')).status,200,'connection review survives loss of People authority');
    await h.post(['settings','members'].join('/'),{email:grantor,name:'Admin again',employee:true,admin:true});
    // Revocation during a provider request must fence the commit as well as the next request.
    const grant=await h.post('delegates',{grantor,delegate:delegateAddress,level:'full'});
    await applyHris(h,edge.employees[0]);
    const ready=await send('/preview');
    assert.equal((await send('/sync',{...body,fingerprint:ready.value.fingerprint})).status,200,'the same actor and target can execute before withdrawal');
    const fresh=await send('/preview');
    edge.hold=async request=>{if(new URL(request.url).pathname.endsWith('/employees')){edge.hold=null;await h.post(`delegates/${grant.id}/revoke`,{});}};
    const mappings=(await h.db.prepare('SELECT COUNT(*) n FROM c_hris_mappings').first()).n;
    assert.equal((await send('/sync',{...body,fingerprint:fresh.value.fingerprint})).status,409);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM c_hris_mappings').first()).n,mappings);
    for(const departed of [grantor,delegateAddress]){
      await h.post('delegates',{grantor,delegate:delegateAddress,level:'full'});
      await h.post(['settings','members'].join('/'),{email:departed,name:'Inactive',employee:true,admin:true,active:false});
      const noWrite=await snapshot(),noRequest=h.outbound.length;
      for(const [suffix,payload] of [['/preview',undefined],['/connect',connect],['/disconnect',{company:edge.company,consent:true}],['/sync',body]])assert.equal((await send(suffix,payload)).status,departed===delegateAddress?401:403);
      assert.equal(h.outbound.length,noRequest);assert.equal(await snapshot(),noWrite);
      await h.post(['settings','members'].join('/'),{email:departed,name:'Active again',employee:true,admin:true});
    }
    const key=await h.post('agent-keys',{label:'Synthetic roster refusal'});
    const noRequest=h.outbound.length,noWrite=await snapshot();
    for(const [suffix,payload] of [['',undefined],['/preview',undefined],['/connect',connect],['/disconnect',{}],['/sync',body]]){
      assert.equal((await h.send('/api/coaster/'+hrisRoot+suffix,payload,'',{authorization:'Bearer '+key.token})).status,403);
    }
    assert.equal(h.outbound.length,noRequest);assert.equal(await snapshot(),noWrite);
  }finally{await h.close();}
}
