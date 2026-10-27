import assert from 'node:assert/strict';
export function plaidFixture() {
  const calls=[], items=new Map();let sequence=0;
  return {calls,items,failRemove:false,loseExchange:false,async fetch(request) {
    const path=new URL(request.url).pathname,b=await request.json();calls.push({path,body:b});
    assert.equal(b.client_id,'synthetic-coaster-200');assert.equal(b.secret,'synthetic-coaster-201');
    if(path==='/link/token/create')return Response.json({link_token:'synthetic-coaster-link-'+(++sequence),expiration:'2099-01-01T00:00:00Z'});
    if(path==='/item/public_token/exchange'){
      const id='synthetic-coaster-item-'+b.public_token;items.set(id,true);
      if(this.loseExchange){this.loseExchange=false;throw new Error('Synthetic lost exchange acknowledgement');}
      return Response.json({item_id:id,access_token:'synthetic-coaster-access-'+b.public_token});
    }
    if(path==='/accounts/get')return Response.json({item:{item_id:b.access_token.replace('synthetic-coaster-access-','synthetic-coaster-item-')},accounts:[{account_id:'synthetic-coaster-203',mask:'1008',name:'Should never be retained',type:'credit',subtype:'credit card',balances:{current:12345},account_number:'9'.repeat(16)}]});
    if(path==='/item/remove'){if(this.failRemove)return Response.json({error:plaidConfig.secret},{status:500});items.delete(b.access_token.replace('synthetic-coaster-access-','synthetic-coaster-item-'));return Response.json({request_id:'synthetic-coaster-204'});}
    assert.fail('Unexpected Plaid request '+path);
  }};
}
export const plaidConfig={version:0,clientId:'synthetic-coaster-200',secret:'synthetic-coaster-201',accountMonthly:'2.50',monthlyCap:'5.00',consent:true};
