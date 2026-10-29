import assert from 'node:assert/strict';
import { issuerServer } from './fixtures/feed/server.mjs';

const n = i => `synthetic-coaster-${i}`;
export async function individualProgram(h, {beforeIngest}={}) {
  const issuer=await issuerServer();
  try {
    await h.post('settings' + '/' + 'business',{name:n(1200),currency:'USD',timezone:'UTC',receiptThreshold:'10000'});
    const manager=await h.person(`${n(1201)}@example.test`,{employee:true,manager:true});
    const address=`${n(1202)}@example.test`,employee=await h.person(address,{employee:true},`${n(1201)}@example.test`);
    const finance=await h.person(`${n(1203)}@example.test`,{employee:true,finance:true});
    const other=await h.person(`${n(1204)}@example.test`,{employee:true});
    const category=await h.post('settings' + '/' + 'categories',{name:n(1205),accountCode:'6100',taxCode:'synthetic-coaster-1242'});
    const config={...issuer.credentials,issuer:n(1206),category:category.id,liability:'individual',consent:true,mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',card:'Card',transactionId:'Transaction',sequence:'Sequence'}};
    await h.post('statements' + '/' + 'cards',{issuer:config.issuer,last4:'1111',employee:address});
    const feed=await h.post('feeds' + '/' + 'program',config,finance);
    assert.equal(feed.liability,'individual');
    await beforeIngest?.({employee,finance,manager,address,category});
    const content='Date,Merchant,Amount,Card,Transaction,Sequence\n'+[10,20,30,40,50,60].map((amount,i)=>`2031-06-10,${n(1210+i)},${amount}.00,1111,${n(1220+i)},${n(1230)}`).join('\n');
    issuer.files.set(n(1231)+'.csv',content);
    const worker=await h.mf.getWorker();
    const tick=iso=>worker.scheduled({scheduledTime:new Date(iso),cron:'17 * * * *'});
    await tick('2031-06-10T10:17:00Z');
    const state=await h.get('feeds' + '/' + 'program',finance);
    assert.equal(state.feeds[0].error,null);assert.equal(state.deliveries.length,1);assert.equal(state.deliveries[0].charges,6);
    const claim=(await h.get('state',employee)).claims[0];
    let detail=await h.get(`claims/${claim.id}`,employee);
    assert.equal(detail.items.length,6);assert.equal(detail.claim.total_minor,21000);
    assert.deepEqual(detail.items.map(i=>i.card_liability),Array(6).fill('individual'));
    issuer.files.set(n(1232)+'.csv',content);
    await tick('2031-06-10T11:17:00Z');
    assert.equal((await h.get('feeds' + '/' + 'program',finance)).deliveries.length,1);
    assert.deepEqual((await h.get(`claims/${claim.id}`,employee)).items,detail.items);
    return {issuer,employee,finance,manager,other,address,category,feed,config,claim:detail.claim,items:detail.items,tick};
  } catch(error) { await issuer.close(); throw error; }
}
export async function classifyAndBatch(h, f) {
  let claim=f.claim;
  const personals=f.items.filter(i=>['synthetic-coaster-1214','synthetic-coaster-1215'].includes(i.merchant));
  assert.equal(personals.length,2);
  for(const item of personals) claim=await h.post(`claims/${claim.id}/items/classify`,{version:claim.version,item:item.id,personal:true},f.employee);
  assert.equal(claim.total_minor,10000);
  const personal=personals[0];
  claim=await h.post(`claims/${claim.id}/items`,{version:claim.version,item:personal.id,kind:'receipt',date:personal.spent_on,merchant:personal.merchant,amount:(personal.amount_minor/100).toFixed(2),category:f.category.id,description:'synthetic-coaster-1260',card_personal:0,card_liability:'company'},f.employee);
  assert.equal(claim.total_minor,10000,'ordinary expense editing cannot remove the personal classification');
  claim=await h.post(`claims/${claim.id}/submit`,{version:claim.version},f.employee);
  assert.equal(claim.status,'submitted');
  claim=await h.post(`claims/${claim.id}/decision`,{version:claim.version,revision:claim.revision,decision:'approved',acknowledge:true},f.manager);
  assert.equal(claim.total_minor,10000);
  const batch=await h.post('batches',{claims:[claim.id]},f.finance);
  assert.equal(batch.total_minor,10000);
  const detail=await h.get(`batches/${batch.id}`,f.finance);
  assert.deepEqual(detail.people.map(p=>({email:p.email,amount:p.amountMinor})),[{email:f.address,amount:10000}]);
  assert.deepEqual(detail.lines.map(l=>({merchant:l.merchant,amount:l.amountMinor})).sort((a,b)=>a.merchant.localeCompare(b.merchant)),[10,20,30,40].map((amount,i)=>({merchant:`synthetic-coaster-${1210+i}`,amount:amount*100})));
  return {claim,batch,detail};
}
