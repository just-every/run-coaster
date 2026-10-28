import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';

/** A real dynamic Sandbox item changes pending and posted source facts on refresh. */
export async function dynamicPlaidLifecycle({h,connection,employee,email,category,access,sandbox,observed,readiness,cookie=h.owner}) {
  const path=`plaid/connections/${connection.id}`;
  for(const account of connection.accounts)await h.post(path+'/assign',{account:account.id,employee:email,category},cookie);
  const syncUntil=async predicate=>{
    for(let attempt=0;attempt<31;attempt++){
      const result=await h.send('/api/coaster/'+path+'/sync',{},cookie);
      if(!(result.status===200||result.status===502&&readiness()))throw new Error('Dynamic native sync HTTP '+result.status+': '+result.value.error);
      if(result.status===200){const transactions=(await h.get(path+'/transactions',cookie)).transactions;if(predicate(transactions))return transactions;}
      if(attempt<30)await delay(2000);
    }
    assert.fail('Dynamic Sandbox update did not appear within its bounded readiness window');
  };
  const initial=await syncUntil(rows=>rows.some(row=>row.status==='pending')&&rows.some(row=>row.status==='posted'));
  const credit=connection.accounts.find(account=>account.type==='credit');assert.ok(credit);
  const candidate=initial.find(row=>row.status==='pending'&&row.account_id===credit.id&&row.amount_minor>0&&initial.filter(other=>other.amount_minor===row.amount_minor).length===1);assert.ok(candidate,'A real pending credit-card purchase exists');assert.equal(candidate.item_id,null);
  const raw=observed.get(candidate.transaction_id);assert.ok(raw);
  const rule=await h.get('settings/card-matching');await h.post('settings/card-matching',{version:rule.version,enabled:true,windowDays:7,tipPercent:0,fxPercent:0});
  const form=new FormData();form.append('file',new File([await readFile('tests/fixtures/receipts/officeworks.png')],'synthetic-coaster-dynamic.png',{type:'image/png'}));form.append('source','upload');
  const request=new Request(h.origin+'/api/coaster/receipt-inbox',{method:'POST',headers:{origin:h.origin,cookie:employee},body:form});
  const response=await h.mf.dispatchFetch(request.url,{method:'POST',headers:Object.fromEntries(request.headers),body:await request.arrayBuffer()});assert.equal(response.status,200);
  const uploaded=await response.json(),receipt=uploaded.receipt.id;
  await h.post(`receipt-inbox/${receipt}/card-match`,{expectedSequence:0,enabled:true,merchant:raw.merchant_name||raw.name,date:raw.authorized_date||raw.date,total:(Math.round(raw.amount*100)/100).toFixed(2),currency:raw.iso_currency_code,last4:credit.last4,notice:uploaded.receipt.matchChoice.notice},employee);
  assert.equal((await h.get('receipt-inbox',employee)).receipts.find(row=>row.id===receipt).attachment,null);
  const before=new Map(initial.filter(row=>row.status==='posted').map(row=>[row.transaction_id,{...row}]));
  await sandbox('/transactions/refresh',{access_token:access});
  const updated=await syncUntil(rows=>rows.some(row=>observed.get(row.transaction_id)?.pending_transaction_id===candidate.transaction_id&&row.status==='posted'));
  const posted=updated.find(row=>observed.get(row.transaction_id)?.pending_transaction_id===candidate.transaction_id&&row.status==='posted');
  assert.ok(posted.item_id);assert.equal(updated.find(row=>row.transaction_id===candidate.transaction_id).status,'removed');
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM c_items WHERE id=?').bind(posted.item_id).first()).n,1);
  const item=await h.db.prepare('SELECT * FROM c_items WHERE id=?').bind(posted.item_id).first();assert.equal(item.amount_minor,Math.round(observed.get(posted.transaction_id).amount*100));assert.ok(item.receipt_id);
  assert.equal((await h.get('receipt-inbox',employee)).receipts.find(row=>row.id===receipt).attachment.itemId,item.id);
  assert.equal((await h.post(path+'/sync',{},cookie)).expenses,0);
  assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM c_capture_lifecycle WHERE receipt_id=? AND kind='attached'").bind(receipt).first()).n,1);
  return {proof:{pendingToPosted:true,removedPending:true,pendingReceiptAttachedOnce:true,replay:true},before,updated,syncUntil};
}

/** Separate qualification: this must fail when the provider fixture supplies no posted correction. */
export async function dynamicPostedCorrections({h,access,sandbox,observed,before,updated,syncUntil}) {
  const changedPosted=rows=>rows.filter(row=>before.has(row.transaction_id)&&row.status==='review'&&['amount_minor','merchant','spent_on','posted_on','provider_amount'].some(field=>row[field]!==before.get(row.transaction_id)[field]));
  for(let generation=0;generation<2&&!changedPosted(updated).length;generation++){
    await delay(31_000); // The provider permits two item refreshes per minute.
    for(const row of updated.filter(row=>row.status==='posted'&&!before.has(row.transaction_id)))before.set(row.transaction_id,{...row});
    const pending=new Set(updated.filter(row=>row.status==='pending').map(row=>row.transaction_id));
    await sandbox('/transactions/refresh',{access_token:access});
    updated=await syncUntil(rows=>rows.some(row=>pending.has(observed.get(row.transaction_id)?.pending_transaction_id)&&row.status==='posted'));
  }
  const modified=changedPosted(updated);
  assert.ok(modified.length,'The actual dynamic refresh changes previously posted source facts');
  for(const changed of modified){const old=before.get(changed.transaction_id),expense=await h.db.prepare('SELECT amount_minor,merchant,spent_on FROM c_items WHERE id=?').bind(old.item_id).first();assert.deepEqual(expense,{amount_minor:old.amount_minor,merchant:old.merchant,spent_on:old.spent_on});}
  return {modifiedPosted:modified.length};
}
