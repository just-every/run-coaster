import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { address, correctionClaims, correctionPath, correctionBody } from './account-correction-kit.mjs';

function worksheet(bytes) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);
  let end=bytes.length-22;while(view.getUint32(end,true)!==0x06054b50)end--;
  let at=view.getUint32(end+16,true),sheet='';
  for(let n=view.getUint16(end+10,true);n>0;n--) {
    const size=view.getUint32(at+20,true),length=view.getUint16(at+28,true),offset=view.getUint32(at+42,true);
    const start=offset+30+view.getUint16(offset+26,true)+view.getUint16(offset+28,true);
    if(bytes.subarray(at+46,at+46+length).toString()==='xl/worksheets/sheet1.xml')sheet=bytes.subarray(start,start+size).toString();
    at+=46+length+view.getUint16(at+30,true)+view.getUint16(at+32,true);
  }
  return [...sheet.matchAll(/<row[^>]*>(.*?)<\/row>/g)].map(row=>[...row[1].matchAll(/<c\b[^>]*>(.*?)<\/c>/g)].map(cell=>cell[1].match(/<t\b[^>]*>(.*?)<\/t>/)?.[1]??cell[1].match(/<v>(.*?)<\/v>/)?.[1]??''));
}
const rows = async (h, table) => (await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
const state = async h => Object.fromEntries(await Promise.all(['c_account_corrections','c_batch_coding','c_claims','c_revisions','c_decisions','c_items','c_allocations','c_events','c_batches','c_batch_claims','c_reimbursement_keys','c_workflow_tasks','c_qbd_requests'].map(async table => [table, await rows(h,table)])));
const evidence = async (h,c) => (await h.get(`claims/${c.id}`));
const preserved = d => ({ revisions: d.revisions, decisions: d.decisions, items: d.items, receipts: d.receipts, exceptions: d.exceptions, total: d.claim.total_minor, approver: d.claim.approver_email });

// One money journey follows a correction from submitted evidence through immutable exports.
test('Native account corrections preserve submitted facts, enforce role and revision limits, and freeze exact export coding', async () => {
  const h = await harness();
  try {
    const { t, create, approve } = await correctionClaims(h);
    let c = await create(), d = await evidence(h,c), original = preserved(d);
    const foreign = await create('Another submitted purchase');
    const foreignItem = (await evidence(h,foreign)).revisions.at(-1).snapshot.items[0].id;
    let mileage=await h.post('claims',{title:'Mileage stays outside purchase corrections'},t.sam);
    mileage=await h.post(`claims/${mileage.id}/items`,{version:mileage.version,kind:'mileage',date:'2026-03-10',merchant:'Client visit',distance:'10',category:t.c.car},t.sam);
    mileage=await h.post(`claims/${mileage.id}/submit`,{version:mileage.version},t.sam);
    await h.post(['statements','cards'].join('/'),{issuer:'Synthetic Card',last4:'1111',employee:address('sam')});
    const statement={format:'csv',name:'synthetic-coaster-1.csv',issuer:'Synthetic Card',category:t.c.office,
      content:'Date,Merchant,Amount,Card,Ref\n2026-03-10,Synthetic card purchase,12.34,1111,synthetic-coaster-1\n',
      mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',card:'Card',transactionId:'Ref'}};
    const preview=await h.post(['statements','preview'].join('/'),statement);
    const imported=await h.post(['statements','commit'].join('/'),{...statement,fingerprint:preview.fingerprint});
    const cardDetail=await h.get(`claims/${imported.claims[0]}`,t.sam),cardItem=cardDetail.items[0];
    let card=await h.post(`claims/${cardDetail.claim.id}/items`,{version:cardDetail.claim.version,item:cardItem.id,kind:'receipt',date:cardItem.spent_on,merchant:cardItem.merchant,amount:'12.34',category:t.c.office,explanation:'Company card purchase'},t.sam);
    card=await h.post(`claims/${card.id}/submit`,{version:card.version},t.sam);
    for(const excluded of [mileage,card]) {
      const excludedDetail=await evidence(h,excluded),before=await state(h);
      await h.post(correctionPath(excluded),correctionBody(excludedDetail),h.owner,409);
      assert.deepEqual(await state(h),before,'non-purchase and company-card expenses cannot acquire manual account corrections');
    }
    const originalBytes = await rows(h,'c_revisions');
    for (const extra of [{ reason: '' }, { sequence: -1 }, { allocation: 3 }, { accountCode: '6500' }, { revision: c.revision - 1 }, { version: c.version - 1 }]) {
      const before = await state(h), r = await h.send('/api/coaster/' + correctionPath(c), correctionBody(d,extra), h.owner);
      assert.ok([400,409].includes(r.status),r.text); assert.deepEqual(await state(h),before);
    }
    const selfGrant=await h.post('delegates',{delegate:address('sam'),level:'full'},t.priya);
    const selfBefore=await state(h);
    assert.equal((await h.send('/api/coaster/'+correctionPath(c),correctionBody(d),t.sam,{'x-coaster-acting-for':address('priya')})).status,403,'a delegated approver cannot review their own claim');
    assert.deepEqual(await state(h),selfBefore);
    await h.post(`delegates/${selfGrant.id}/revoke`,{},t.priya);
    const cookies = { owner: h.owner, finance: await h.person(address('synthetic-coaster-finance'),{finance:true}), bookkeeper: await h.person(address('synthetic-coaster-bookkeeper'),{bookkeeper:true}), approver: t.priya };
    for (const [i, role] of ['owner','finance','bookkeeper','approver'].entries()) {
      const body = correctionBody(d,{accountCode:String(6750+i), reason: role==='finance' ? 'Requested by '+address('synthetic-coaster-finance') : 'Use the expense-specific account'});
      c = await h.post(correctionPath(c),body,cookies[role]);
      d = await evidence(h,c);
      assert.equal(d.accountCoding.sequence,i+1); assert.equal(d.accountCoding.corrections.at(-1).after_account,String(6750+i));
      assert.deepEqual(preserved(d),original,'coding overlays change no submitted or live expense facts');
      assert.deepEqual(await rows(h,'c_revisions'),originalBytes,'original submitted snapshot bytes remain exact');
      const before = await state(h);
      await h.post(correctionPath(c),body,cookies[role],409);
      assert.deepEqual(await state(h),before,'a repeated request writes nothing');
    }
    for (const [name, flags] of [['admin',{admin:true}],['card',{cardAdmin:true}],['employee',{employee:true}],['auditor',{auditor:true}],['unassigned',{manager:true}]]) {
      const person = await h.person(address('synthetic-coaster-'+name),flags), before = await state(h);
      await h.post(correctionPath(c),correctionBody(d),person,403);
      assert.deepEqual(await state(h),before,'wrong-role and unassigned corrections write nothing');
    }
    c = await approve(c); d = await evidence(h,c);
    let before = await state(h);
    await h.post(correctionPath(c),correctionBody(d),t.priya,403);
    assert.deepEqual(await state(h),before,'the routed approver cannot recode after deciding');
    original = preserved(d);
    c = await h.post(correctionPath(c),correctionBody(d,{accountCode:'6799'}),cookies.bookkeeper);
    d = await evidence(h,c); assert.deepEqual(preserved(d),original,'bookkeeper corrects an approved expense without changing its decision');
    // Full delegation retains the grantor row and the actual person's attribution.
    await h.post('delegates',{delegate:address('alex'),level:'submit'},cookies.finance);
    before = await state(h);
    let r = await h.send('/api/coaster/'+correctionPath(c),correctionBody(d),t.alex,{'x-coaster-acting-for':address('synthetic-coaster-finance')});
    assert.equal(r.status,403); assert.deepEqual(await state(h),before);
    const grant = await h.post('delegates',{delegate:address('alex'),level:'full'},cookies.finance);
    r = await h.send('/api/coaster/'+correctionPath(c),correctionBody(d,{accountCode:'6800'}),t.alex,{'x-coaster-acting-for':address('synthetic-coaster-finance')});
    assert.equal(r.status,200,r.text); c=r.value; d=await evidence(h,c);
    assert.equal(d.accountCoding.corrections.at(-1).actor_email,address('alex'));
    assert.equal(d.accountCoding.corrections.at(-1).acting_for,address('synthetic-coaster-finance'));
    await h.post(`delegates/${grant.id}/revoke`,{},cookies.finance);
    before = await state(h);
    assert.equal((await h.send('/api/coaster/'+correctionPath(c),correctionBody(d),t.alex,{'x-coaster-acting-for':address('synthetic-coaster-finance')})).status,403);
    assert.deepEqual(await state(h),before);
    const key = await h.post('agent-keys',{label:'synthetic-coaster-1'},cookies.finance);
    before = await state(h);
    assert.equal((await h.send('/api/coaster/'+correctionPath(c),correctionBody(d),'',{authorization:`Bearer ${key.token}`})).status,401);
    assert.deepEqual(await state(h),before,'agent keys gain no correction authority');
    before = await state(h);
    await h.post(correctionPath(c),correctionBody(d,{item:foreignItem}),h.owner,409);
    await h.post(correctionPath(c),correctionBody(d,{sequence:5}),h.owner,409);
    assert.deepEqual(await state(h),before,'a foreign allocation or stale sequence cannot change the exact reviewed claim');
    const keysBefore = await rows(h,'c_reimbursement_keys');
    let batch = await h.post('batches',{claims:[c.id]},t.morgan);
    const firstSelection = await rows(h,'c_batch_coding');
    assert.equal(firstSelection[0].correction_sequence,6);
    assert.equal(batch.total_minor,11000);
    before = await state(h);
    await h.post(correctionPath(c),correctionBody(await evidence(h,c)),h.owner,409);
    assert.deepEqual(await state(h),before,'batched claims refuse corrections');
    const firstBatch = batch;
    await h.post(`batches/${batch.id}/remove`,{version:batch.version,claim:c.id},t.morgan);
    d = await evidence(h,c);
    c = await h.post(correctionPath(c),correctionBody(d,{allocation:1,accountCode:'6810',reason:'Correct only the second split account'}),cookies.bookkeeper);
    d = await evidence(h,c);
    const last = d.accountCoding.corrections.at(-1);
    assert.deepEqual([last.revision,last.item_id,last.allocation_position,last.sequence,last.before_account,last.after_account],[c.revision,d.revisions.at(-1).snapshot.items[0].id,1,7,'6200','6810']);
    assert.deepEqual(preserved(d),original,'a correction to another split preserves all submitted facts and the approval');
    assert.deepEqual(await rows(h,'c_batch_coding'),firstSelection,'a later correction cannot rewrite a removed batch selection');
    batch = await h.post('batches',{claims:[c.id]},t.morgan);
    const frozen = await rows(h,'c_batch_coding');
    assert.deepEqual(frozen.map(f=>[f.batch_id,f.revision,f.correction_sequence]),[[firstBatch.id,c.revision,6],[batch.id,c.revision,7]]);
    batch = await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:11000},t.morgan);
    const detail = await h.get(`batches/${batch.id}`,t.morgan);
    assert.deepEqual(detail.lines.map(l=>[l.account,l.amountMinor]),[['6800',6000],['6810',4000],['GST paid',1000]]);
    assert.equal(detail.lines.reduce((n,l)=>n+l.amountMinor,0),detail.people.reduce((n,p)=>n+p.amountMinor,0));
    for (const format of ['csv','xlsx']) {
      const response=await h.mf.dispatchFetch(`${h.origin}/api/coaster/batches/${batch.id}/accounting.${format}`,{headers:{cookie:t.morgan}});
      assert.equal(response.status,200);
      const table=format==='xlsx'?worksheet(Buffer.from(await response.arrayBuffer())):(await response.text()).trim().split('\r\n').map(line=>line.split('","').map(v=>v.replace(/^"|"$/g,'')));
      const header=table.shift(),account=header.indexOf('account_code'),amount=header.indexOf('amount');
      assert.deepEqual(table.map(row=>[row[account],Number(row[amount])]),[['6800',60],['6810',40],['GST paid',10]],format+' keeps corrected codes and independent exact amounts');
      assert.equal(table.reduce((n,row)=>n+Number(row[amount]),0),110);
    }
    const csv = await h.send(`/api/coaster/batches/${batch.id}/reimbursements.csv`,undefined,t.morgan);
    assert.match(csv.text,/110\.00/);
    assert.equal(keysBefore.length,0); assert.equal((await rows(h,'c_reimbursement_keys')).length,1);
    assert.deepEqual(await rows(h,'c_batch_coding'),frozen); assert.deepEqual(await rows(h,'c_revisions'),originalBytes);
    const corrections = await rows(h,'c_account_corrections');
    before = await state(h);
    for (const method of ['PUT','PATCH','DELETE']) {
      const response=await h.mf.dispatchFetch(`${h.origin}/api/coaster/${correctionPath(c)}/${last.id}`,{method,headers:{cookie:h.owner,origin:h.origin,'content-type':'application/json'},body:JSON.stringify({accountCode:'6900'})});
      assert.ok([404,405].includes(response.status),'no public method edits or deletes correction evidence');
    }
    assert.deepEqual(await state(h),before);
    for (const table of ['c_account_corrections','c_batch_coding']) {
      await assert.rejects(h.db.prepare(`DELETE FROM ${table}`).run(),/permanent/);
      await assert.rejects(h.db.prepare(`UPDATE ${table} SET revision=revision+1`).run(),/permanent/);
    }
    const history = (await h.get('history?q='+`CL-${String(c.number).padStart(4,'0')}`)).lines.filter(l=>l.action==='account-code-corrected');
    assert.equal(history.length,7); assert.deepEqual(history.map(l=>l.detail.sequence),[1,2,3,4,5,6,7]);
    assert.ok(history.every((l,i)=>l.seq>0&&(!i||l.seq>history[i-1].seq)));
    assert.equal(corrections.length,7);
    // Erasure removes a former actor's identity from overlay reasons and numbered evidence.
    const erasedEmail=address('synthetic-coaster-finance');
    await h.post(['settings','members'].join('/'),{email:erasedEmail,name:'synthetic-coaster-finance',finance:true,active:false});
    await h.post(['settings','members','erase'].join('/'),{email:erasedEmail});
    const erased=await rows(h,'c_account_corrections'),events=await rows(h,'c_events');
    assert.ok(!JSON.stringify([erased,events]).includes(erasedEmail));
    assert.match(erased[1].reason,/former-member-[0-9a-f]{8}/);
    before=await state(h);
    await h.post(correctionPath(c),correctionBody(d),cookies.finance,401);
    assert.deepEqual(await state(h),before,'erased credentials cannot replay a correction');
  } finally { await h.close(); }
});

test('Correction commit fences concurrent batching, posting, revision changes and authority withdrawal without partial writes', async () => {
  let pause, arrived, release;
  const h = await harness({ d1Barrier: async request => {
    if (pause && new URL(request.url).pathname==='/before-account-correction') { pause=false; arrived(); await new Promise(r=>{release=r}); }
    return new Response('open');
  }});
  try {
    const {t,create,approve} = await correctionClaims(h);
    const financeEmail = address('synthetic-coaster-finance'), finance = await h.person(financeEmail,{finance:true});
    for (const scenario of ['batch','authority','revision','correction','assignment','decision','posting','authority-after','posting-after','version-after']) {
      let c=await create('Client '+scenario); if(!['revision','assignment','decision'].includes(scenario)) c=await approve(c);
      const d=await evidence(h,c);
      if(scenario==='authority-after') await h.db.prepare(`CREATE TRIGGER synthetic_correction_withdrawal AFTER INSERT ON c_account_corrections BEGIN UPDATE c_members SET is_finance=0 WHERE email='${financeEmail}'; END`).run();
      if(scenario==='posting-after') await h.db.prepare(`CREATE TRIGGER synthetic_correction_posting AFTER INSERT ON c_account_corrections BEGIN INSERT INTO c_qbd_requests(id,source,kind,payload,status,created_at) VALUES('synthetic-coaster-race','synthetic-coaster-race','BillAdd',json_object('claim',NEW.claim_id),'pending',NEW.at); END`).run();
      if(scenario==='version-after') await h.db.prepare('CREATE TRIGGER synthetic_correction_version AFTER INSERT ON c_account_corrections BEGIN UPDATE c_claims SET version=version+1 WHERE id=NEW.claim_id; END').run();
      pause=true;
      const reached=new Promise(r=>{arrived=r});
      const pending=h.send('/api/coaster/'+correctionPath(c),correctionBody(d),['assignment','decision'].includes(scenario)?t.priya:finance);
      await reached;
      if(scenario==='batch') await h.post('batches',{claims:[c.id]},t.morgan);
      if(scenario==='authority') await h.post(['settings','members'].join('/'),{email:financeEmail,name:'Finance',employee:true});
      if(scenario==='revision') await h.post(`claims/${c.id}/retract`,{version:c.version},t.sam);
      if(scenario==='correction') await h.post(correctionPath(c),correctionBody(d,{accountCode:'6820'}),h.owner);
      if(scenario==='assignment') await h.post(`claims/${c.id}/reassign`,{version:c.version,approver:address('jordan'),reason:'New current reviewer'});
      if(scenario==='decision') await approve(c);
      if(scenario==='posting') await h.db.prepare("INSERT INTO c_qbd_requests(id,source,kind,payload,status,created_at) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(),'synthetic-coaster-1','BillAdd',JSON.stringify({claim:c.id}),'uncertain','2026-04-01T00:00:00Z').run();
      const before=await state(h); release(); const r=await pending;
      assert.equal(r.status,409,r.text); assert.deepEqual(await state(h),before,scenario+' fences every correction write');
      if(scenario==='authority') await h.post(['settings','members'].join('/'),{email:financeEmail,name:'Finance',finance:true});
      if(scenario==='authority-after') await h.db.prepare('DROP TRIGGER synthetic_correction_withdrawal').run();
      if(scenario==='posting-after') await h.db.prepare('DROP TRIGGER synthetic_correction_posting').run();
      if(scenario==='version-after') await h.db.prepare('DROP TRIGGER synthetic_correction_version').run();
    }
    for(const status of ['pending','sent','uncertain','succeeded','failed']) {
      const c=await approve(await create('Existing posting '+status)),d=await evidence(h,c);
      await h.db.prepare('INSERT INTO c_qbd_requests(id,source,kind,payload,status,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),'synthetic-coaster-'+status,'BillAdd',JSON.stringify({claim:c.id}),status,'2026-04-01T00:00:00Z').run();
      const before=await state(h);
      await h.post(correctionPath(c),correctionBody(d),finance,409);
      assert.deepEqual(await state(h),before,'an existing '+status+' posting cannot be corrected or replayed');
    }
  } finally { release?.(); await h.close(); }
});
