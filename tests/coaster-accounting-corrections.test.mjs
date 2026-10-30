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
const state = async h => Object.fromEntries(await Promise.all(['c_account_corrections','c_batch_coding','c_claims','c_revisions','c_decisions','c_items','c_allocations','c_events','c_batches','c_batch_claims','c_qbd_requests','c_reimbursement_keys'].map(async table => [table, await rows(h,table)])));
const evidence = async (h,c) => (await h.get(`claims/${c.id}`));
const preserved = d => ({ revisions: d.revisions, decisions: d.decisions, items: d.items, receipts: d.receipts, exceptions: d.exceptions, total: d.claim.total_minor, approver: d.claim.approver_email });

// One money journey follows a correction from submitted evidence through immutable exports.
test('Native account corrections preserve submitted facts, enforce role and revision limits, and freeze exact export coding', async () => {
  const h = await harness();
  try {
    const { t, create, approve } = await correctionClaims(h);
    const cap = (await h.post('allowances', { name: 'synthetic-coaster-1', type: 'cap', period: 'yearly', amount: '500.00', startsOn: '2026-01-01' }, t.morgan)).all[0];
    let c = await create('Client materials', t.sam, { allowance: cap.id }), d = await evidence(h,c), original = preserved(d);
    assert.equal(d.items[0].allowance_id, cap.id);
    assert.equal(d.items[0].claimed_minor, null, 'the manual receipt is fully within its allowance cap');
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
    const keysBefore = await rows(h,'c_reimbursement_keys');
    let batch = await h.post('batches',{claims:[c.id]},t.morgan);
    const frozen = await rows(h,'c_batch_coding');
    assert.equal(frozen[0].correction_sequence,6);
    assert.equal(batch.total_minor,11000);
    before = await state(h);
    await h.post(correctionPath(c),correctionBody(await evidence(h,c)),h.owner,409);
    assert.deepEqual(await state(h),before,'batched claims refuse corrections');
    batch = await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:11000},t.morgan);
    const detail = await h.get(`batches/${batch.id}`,t.morgan);
    assert.deepEqual(detail.lines.map(l=>[l.account,l.amountMinor]),[['6800',6000],['6200',4000],['GST paid',1000]]);
    assert.equal(detail.lines.reduce((n,l)=>n+l.amountMinor,0),detail.people.reduce((n,p)=>n+p.amountMinor,0));
    for (const format of ['csv','xlsx']) {
      const response=await h.mf.dispatchFetch(`${h.origin}/api/coaster/batches/${batch.id}/accounting.${format}`,{headers:{cookie:t.morgan}});
      assert.equal(response.status,200);
      const table=format==='xlsx'?worksheet(Buffer.from(await response.arrayBuffer())):(await response.text()).trim().split('\r\n').map(line=>line.split('","').map(v=>v.replace(/^"|"$/g,'')));
      const header=table.shift(),account=header.indexOf('account_code'),amount=header.indexOf('amount');
      assert.deepEqual(table.map(row=>[row[account],Number(row[amount])]),[['6800',60],['6200',40],['GST paid',10]],format+' keeps corrected codes and independent exact amounts');
      assert.equal(table.reduce((n,row)=>n+Number(row[amount]),0),110);
    }
    const csv = await h.send(`/api/coaster/batches/${batch.id}/reimbursements.csv`,undefined,t.morgan);
    assert.match(csv.text,/110\.00/);
    assert.equal(keysBefore.length,0); assert.equal((await rows(h,'c_reimbursement_keys')).length,1);
    assert.deepEqual(await rows(h,'c_batch_coding'),frozen); assert.deepEqual(await rows(h,'c_revisions'),originalBytes);
    const corrections = await rows(h,'c_account_corrections');
    for (const table of ['c_account_corrections','c_batch_coding']) {
      await assert.rejects(h.db.prepare(`DELETE FROM ${table}`).run(),/permanent/);
      await assert.rejects(h.db.prepare(`UPDATE ${table} SET revision=revision+1`).run(),/permanent/);
    }
    const history = (await h.get('history?q='+`CL-${String(c.number).padStart(4,'0')}`)).lines.filter(l=>l.action==='account-code-corrected');
    assert.equal(history.length,6); assert.deepEqual(history.map(l=>l.detail.sequence),[1,2,3,4,5,6]);
    assert.ok(history.every((l,i)=>l.seq>0&&(!i||l.seq>history[i-1].seq)));
    assert.equal(corrections.length,6);
    // A removed purchase is not part of a later posting of its former batch.
    let removed = await approve(await create('Removed purchase', t.sam, { fixture: 'hotel' }));
    let peer = await h.post('claims', { title: 'Retained purchase' }, t.sam);
    peer = await h.post(`claims/${peer.id}/items`, { version: peer.version, kind: 'receipt', date: '2026-03-11', merchant: 'synthetic-coaster-2', amount: '20.00', category: t.c.office, explanation: 'Retained purchase' }, t.sam);
    peer = await approve(await h.post(`claims/${peer.id}/submit`, { version: peer.version }, t.sam));
    let former = await h.post('batches', { claims: [removed.id, peer.id] }, t.morgan);
    const selection = await rows(h,'c_batch_coding');
    former = await h.post(`batches/${former.id}/remove`, { version: former.version, claim: removed.id }, t.morgan);
    former = await h.post(`batches/${former.id}/approve`, { version: former.version, expectedTotal: 2000 }, t.morgan);
    await h.post(['accounting','desktop','connect'].join('/'), { consent: true, company: 'synthetic-coaster-1.QBW' });
    await h.post(['accounting','desktop','sync'].join('/'), {}, t.morgan);
    assert.ok((await rows(h,'c_qbd_requests')).some(r => JSON.parse(r.payload).batch === former.id), 'the former batch has a real queued ledger posting');
    const removedBefore = await evidence(h,removed), postedBefore = await state(h);
    assert.equal(removedBefore.accountCoding.mayCorrect,true);
    removed = await h.post(correctionPath(removed), correctionBody(removedBefore), h.owner);
    const removedAfter = await evidence(h,removed);
    assert.equal(removedAfter.accountCoding.corrections.at(-1).after_account,'6750');
    assert.deepEqual(preserved(removedAfter),preserved(removedBefore));
    assert.deepEqual(await rows(h,'c_batch_coding'),selection,'the former batch keeps its immutable coding selection');
    const refusedBefore = await state(h);
    await h.post(correctionPath(peer),correctionBody(await evidence(h,peer)),h.owner,409);
    assert.deepEqual(await state(h),refusedBefore,'a purchase still in the posted batch remains refused');
    assert.deepEqual((await state(h)).c_reimbursement_keys,postedBefore.c_reimbursement_keys,'the correction changes no reimbursement identity');

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
    for (const scenario of ['batch','authority','revision','posting','authority-after']) {
      let c=await create('Client '+scenario); if(scenario!=='revision') c=await approve(c);
      const d=await evidence(h,c);
      if(scenario==='authority-after') await h.db.prepare(`CREATE TRIGGER synthetic_correction_withdrawal AFTER INSERT ON c_account_corrections BEGIN UPDATE c_members SET is_finance=0 WHERE email='${financeEmail}'; END`).run();
      pause=true;
      const reached=new Promise(r=>{arrived=r});
      const pending=h.send('/api/coaster/'+correctionPath(c),correctionBody(d),finance);
      await reached;
      if(scenario==='batch') await h.post('batches',{claims:[c.id]},t.morgan);
      if(scenario==='authority') await h.post(['settings','members'].join('/'),{email:financeEmail,name:'Finance',employee:true});
      if(scenario==='revision') await h.post(`claims/${c.id}/retract`,{version:c.version},t.sam);
      if(scenario==='posting') await h.db.prepare("INSERT INTO c_qbd_requests(id,source,kind,payload,status,created_at) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(),'synthetic-coaster-1','BillAdd',JSON.stringify({claim:c.id}),'uncertain','2026-04-01T00:00:00Z').run();
      const before=await state(h); release(); const r=await pending;
      assert.equal(r.status,409,r.text); assert.deepEqual(await state(h),before,scenario+' fences every correction write');
      if(scenario==='authority') await h.post(['settings','members'].join('/'),{email:financeEmail,name:'Finance',finance:true});
      if(scenario==='authority-after') await h.db.prepare('DROP TRIGGER synthetic_correction_withdrawal').run();
    }
  } finally { release?.(); await h.close(); }
});
