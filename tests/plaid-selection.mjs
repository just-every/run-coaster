import assert from 'node:assert/strict';
import { plaidSetup, page } from './plaid-sync.mjs';
import { plaidTransaction } from './fixtures/plaid.mjs';

/** A Link Item can contain other bank accounts; only the person's explicit verified selection becomes a feed. */
export async function selectedPlaidJourney() {
  const t=await plaidSetup(),{h,edge}=t;
  try {
    edge.accounts=[{account_id:'synthetic-coaster-203',mask:'1008',type:'credit',subtype:'credit card'},{account_id:'synthetic-coaster-370',mask:'2009',type:'depository',subtype:'checking'},{account_id:'synthetic-coaster-371',mask:'3000',type:'loan',subtype:'student'}];
    const link=await h.post('plaid/link',{scope:'personal',consent:true},t.employee);
    const c=await h.post('plaid/exchange',{link:link.id,publicToken:'synthetic-coaster-372',consent:true,selectedAccounts:['synthetic-coaster-203']},t.employee);
    assert.deepEqual(c.accounts,[{id:'synthetic-coaster-203',last4:'1008',type:'credit',subtype:'credit card'}]);
    assert.equal(c.estimatedUsdMinor,250);
    const path=`plaid/connections/${c.id}`;
    await h.post(path+'/assign',{account:c.accounts[0].id,employee:t.email,category:t.category},t.employee);
    edge.pages.push(page([plaidTransaction(),{transaction_id:'synthetic-coaster-373',account_id:'synthetic-coaster-370',amount:99,pending:false,iso_currency_code:'USD',date:'2026-10-15',name:'Private unselected bank expense'}]));
    assert.equal((await h.post(path+'/sync',{},t.employee)).expenses,1);
    const transactions=(await h.get(path+'/transactions',t.employee)).transactions;
    assert.equal(transactions.length,1);assert.equal(transactions[0].amount_minor,4250);
    assert.ok(!JSON.stringify((await h.db.prepare('SELECT * FROM c_plaid_transactions').all()).results).includes('Private unselected bank expense'));
    assert.ok(!JSON.stringify((await h.db.prepare('SELECT * FROM c_plaid_connections').all()).results).includes('synthetic-coaster-370'));
    const bad=await h.post('plaid/link',{scope:'personal',consent:true},t.other);
    await h.post('plaid/exchange',{link:bad.id,publicToken:'synthetic-coaster-374',consent:true,selectedAccounts:['synthetic-coaster-unverified']},t.other,409);
    assert.equal((await h.get('plaid/connections',t.other)).connections.every(connection=>connection.status!=='connected'),true);
  }finally{await h.close();}
}
