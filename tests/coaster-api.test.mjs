import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { agency, harness, receipt } from './harness.mjs'

const root='/api/coaster/public-api'
const keySend=(h,token,path,body)=>h.send(root+'/v1/'+path,body,'',{authorization:'Bearer '+token})
async function setup(h) {
  const team=await agency(h)
  await h.post('settings/members',{email:'owner@harbourfinch.example',name:'synthetic-coaster-1',employee:true,finance:true,approver:'priya@harbourfinch.example'})
  return team
}
async function credential(h,scopes,extra={}) { return h.post('public-api/keys',{label:'synthetic-coaster-2',scopes,...extra}) }
let nativeSequence=100
async function createNativeClaim(h,t) {
  let c=await h.post('claims',{title:'synthetic-coaster-3'},t.sam)
  c=await h.post(`claims/${c.id}/items`,{version:c.version,kind:'receipt',date:new Date().toISOString().slice(0,10),merchant:`synthetic-coaster-${nativeSequence++}`,explanation:'synthetic-coaster-22',amount:'24.00',allocations:[{category:t.c.travel}]},t.sam)
  return c
}

test('API scoped keys prepare only own drafts, expose resource projections and invalidate on access changes',async()=>{
  const h=await harness()
  try {
    const t=await setup(h)
    for(const cookie of [t.sam,t.priya,t.morgan]) await h.post('public-api/keys',{label:'synthetic-coaster-5',scopes:['claims:read']},cookie,403)
    const bad=await h.send(root+'/keys',{label:'synthetic-coaster-6',scopes:['unknown:write']},h.owner);assert.equal(bad.status,400)
    await h.post('public-api/keys',{label:'synthetic-coaster-6',scopes:['claims:read'],expiresInDays:91},h.owner,400)
    await h.post('public-api/keys',{label:'synthetic-coaster-6',scopes:['claims:read'],member:'sam@harbourfinch.example'},h.owner,403)
    assert.equal((await h.get('public-api/keys')).data.length,0,'refused grants leave no credentials')
    const scopes=['claims:read','claims:write','expenses:read','expenses:write','receipts:read','receipts:write','people:read','cards:read','batches:read','payments:read','reports:read']
    const key=await credential(h,scopes,{expiresInDays:1})
    assert.ok(key.token.startsWith('cpa_'));assert.ok(key.expiresAt>Date.now()&&key.expiresAt<=Date.now()+86400000)
    assert.ok(!(await h.get('public-api/keys')).data.some(k=>'token' in k||'token_hash' in k))
    assert.equal((await h.send(root+'/keys',{label:'synthetic-coaster-27',scopes:['claims:read']},'',{authorization:'Bearer '+key.token})).status,401,'a credential cannot mint another credential')
    assert.equal((await h.send(root+'/v1/claims',undefined,'',{authorization:'Bearer '+key.token,'x-coaster-acting-for':'sam@harbourfinch.example'})).status,403)
    const readKey=await credential(h,['claims:read'])
    assert.equal((await keySend(h,readKey.token,'claims',{title:'synthetic-coaster-7'})).status,403)
    assert.equal((await keySend(h,readKey.token,'people')).status,403)
    let r=await keySend(h,key.token,'claims',{title:'synthetic-coaster-8'});assert.equal(r.status,200);let c=r.value
    const input={claimId:c.id,version:c.version,kind:'receipt',date:new Date().toISOString().slice(0,10),merchant:'synthetic-coaster-9',amount:'12.34',allocations:[{category:t.c.travel}]}
    r=await keySend(h,key.token,'expenses',input);assert.equal(r.status,200);c=r.value.claim
    assert.equal((await keySend(h,key.token,'expenses',{...input,version:1})).status,409)
    let items=(await keySend(h,key.token,`expenses?claimId=${c.id}`)).value.data;assert.equal(items.length,1);assert.equal(items[0].amount_minor,1234)
    assert.equal((await keySend(h,key.token,`expenses/${items[0].id}`)).value.id,items[0].id)
    r=await keySend(h,key.token,`expenses/${items[0].id}`,{...input,version:c.version,amount:'20.00'});assert.equal(r.status,200);c=r.value.claim
    r=await keySend(h,key.token,`claims/${c.id}/receipts`,{version:c.version,item:items[0].id,...await receipt('bistro')});assert.equal(r.status,200);c=r.value.claim
    const receiptId=r.value.receipt
    assert.equal((await keySend(h,key.token,`receipts?claimId=${c.id}`)).value.data.length,1)
    assert.equal((await keySend(h,key.token,`receipts/${receiptId}`)).status,200)
    const claimProjection=(await keySend(h,key.token,`claims/${c.id}`)).value
    assert.equal(claimProjection.total_minor,2000);assert.ok(!('receipts' in claimProjection)&&!('items' in claimProjection))
    const other=await createNativeClaim(h,t)
    assert.equal((await keySend(h,key.token,`claims/${other.id}`)).status,403)
    assert.equal((await keySend(h,key.token,'expenses',{...input,claimId:other.id,version:other.version})).status,403)
    for(const route of [`claims/${c.id}/submit`,`claims/${c.id}/decision`,`batches/x/release`,`batches/x/paid`,'keys','settings/business']) assert.equal((await keySend(h,key.token,route,{})).status,403)
    for(const route of ['cards','batches','payments','people','reports/aging','reports/spend?by=category&from=2026-01-01&to=2026-12-31']) assert.equal((await keySend(h,key.token,route)).status,200,route)
    const agent=await h.post('agent-keys',{label:'synthetic-coaster-10'})
    assert.equal((await keySend(h,agent.token,'claims')).status,401)
    assert.equal((await h.send('/api/coaster/agent/context',undefined,'',{authorization:'Bearer '+key.token})).status,401)
    assert.equal((await h.send('/api/coaster/claims',{title:'synthetic-coaster-11'},'',{authorization:'Bearer '+key.token})).status,401)
    const history=await h.get(`claims/${c.id}`);assert.ok(history.events.some(e=>e.detail.apiCredential===key.id&&e.detail.channel==='public-api'))
    let submitted=await h.post(`claims/${c.id}/submit`,{version:c.version},h.owner)
    assert.equal((await keySend(h,key.token,`claims/${c.id}/title`,{version:submitted.version,title:'synthetic-coaster-23'})).status,409)
    submitted=await h.post(`claims/${c.id}/decision`,{version:submitted.version,revision:submitted.revision,decision:'returned',reason:'synthetic-coaster-24'},t.priya)
    assert.equal((await keySend(h,key.token,`claims/${c.id}/receipts`,{version:submitted.version,...await receipt('bistro')})).status,409,'returned claims require native action')
    await h.post('public-api/keys/'+readKey.id+'/revoke',{})
    assert.equal((await keySend(h,readKey.token,'claims')).status,401)
    await h.post('settings/members',{email:'owner@harbourfinch.example',name:'synthetic-coaster-12',employee:true,approver:'priya@harbourfinch.example'})
    assert.equal((await keySend(h,key.token,'claims')).status,401,'membership edits invalidate the grant rather than widening it')
  } finally {await h.close()}
})

test('API OAuth requires explicit native owner consent, exact redirect and single-use PKCE S256',async()=>{
  const h=await harness()
  try {
    await setup(h)
    const client=await h.post('public-api/oauth/clients',{label:'synthetic-coaster-13',redirectUri:'https://synthetic-coaster-14.example/callback'})
    const verifier='synthetic-coaster-15-'.padEnd(64,'x'),challenge=createHash('sha256').update(verifier).digest('base64url')
    const consent={client_id:client.client_id,redirect_uri:client.redirect_uri,response_type:'code',code_challenge_method:'S256',code_challenge:challenge,scopes:['claims:read'],state:'synthetic-coaster-16',consent:true}
    await h.post('public-api/oauth/authorize',{...consent,redirect_uri:client.redirect_uri+'/other'},h.owner,400)
    await h.post('public-api/oauth/authorize',{...consent,consent:false},h.owner,400)
    await h.post('public-api/oauth/authorize',{...consent,code_challenge_method:'plain'},h.owner,400)
    const granted=await h.post('public-api/oauth/authorize',consent),redirect=new URL(granted.redirect_uri)
    assert.equal(redirect.searchParams.get('state'),consent.state)
    const form={grant_type:'authorization_code',client_id:client.client_id,redirect_uri:client.redirect_uri,code:redirect.searchParams.get('code'),code_verifier:verifier}
    assert.equal((await h.send(root+'/oauth/token',{...form,code_verifier:'synthetic-coaster-17'.padEnd(64,'x')})).status,400)
    const token=await h.send(root+'/oauth/token',form);assert.equal(token.status,200);assert.equal(token.value.expires_in,3600);assert.ok(!token.value.refresh_token)
    assert.equal((await h.send(root+'/oauth/token',form)).status,400,'consumed code cannot issue a second token')
    assert.equal((await keySend(h,token.value.access_token,'claims')).status,200)
    assert.equal((await keySend(h,token.value.access_token,'claims',{title:'synthetic-coaster-18'})).status,403)
    await h.post(`public-api/oauth/clients/${client.client_id}/revoke`,{})
    assert.equal((await keySend(h,token.value.access_token,'claims')).status,401)
  } finally {await h.close()}
})

test('API consented signed webhook outbox announces native approval and external payment recording, retries and revokes',async()=>{
  const received=[];let fail=false
  const h=await harness({webhookEdge:async request=>{received.push({url:request.url,body:await request.text(),headers:request.headers});return request.url.endsWith('/synthetic-coaster-25')?new Response(null,{status:302,headers:{location:'http://127.0.0.1/synthetic-coaster-26'}}):new Response(null,{status:fail?503:204})}})
  const tick=async(hours=0)=>(await h.mf.getWorker()).scheduled({scheduledTime:Date.now()+hours*3600000,cron:'17 * * * *'})
  try {
    const t=await setup(h),before=await createNativeClaim(h,t)
    let c=await h.post(`claims/${before.id}/submit`,{version:before.version},t.sam)
    await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved',acknowledge:true},t.priya)
    await tick();assert.equal(received.length,0,'nothing leaves before consent')
    const subscription={destination:'https://8.8.8.8/synthetic-coaster-19',events:['claim.approved','payment.settled'],consent:true}
    for(const destination of ['http://8.8.8.8/x','https://127.0.0.1/x','https://10.0.0.1/x','https://169.254.169.254/x','https://100.64.0.1/x','https://[::1]/x','https://localhost/x','https://synthetic-coaster-20.example/x','https://8.8.8.8/x?secret=value']) await h.post('public-api/webhooks',{...subscription,destination},h.owner,400)
    await h.post('public-api/webhooks',{...subscription,consent:false},h.owner,400)
    await h.post('public-api/webhooks',subscription,t.sam,403)
    const hook=await h.post('public-api/webhooks',subscription)
    assert.ok(hook.secret.startsWith('cpw_'))
    assert.ok(!(await h.get('public-api/webhooks')).data.some(x=>'secret' in x||'secret_sealed' in x))
    await tick();assert.equal(received.length,0,'old events are not replayed to a new destination')
    c=await createNativeClaim(h,t);c=await h.post(`claims/${c.id}/submit`,{version:c.version},t.sam)
    c=await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved',acknowledge:true},t.priya)
    fail=true;await tick();assert.equal(received.length,1)
    let deliveries=(await h.get('public-api/webhooks')).deliveries;assert.equal(deliveries[0].attempt,1);assert.equal(deliveries[0].last_status,503)
    await tick();assert.equal(received.length,1,'backoff prevents immediate duplicate retry')
    fail=false;await tick(2);assert.equal(received.length,2)
    let batch=await h.post('batches',{claims:[c.id]},t.morgan)
    batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:2400},t.morgan)
    await h.paid(batch.id,batch.version,{reference:'synthetic-coaster-21',paidOn:new Date().toISOString().slice(0,10)},t.morgan)
    await tick(3);assert.equal(received.length,3)
    const seen=received.map(item=>{
      const timestamp=item.headers.get('x-coaster-timestamp'),actual=item.headers.get('x-coaster-signature')
      assert.equal(actual,'v1='+createHmac('sha256',hook.secret).update(timestamp+'.'+item.body).digest('hex'))
      const payload=JSON.parse(item.body);assert.deepEqual(Object.keys(payload).sort(),['id','record','time','type']);assert.deepEqual(Object.keys(payload.record).sort(),['id','status'])
      assert.equal(item.headers.get('x-coaster-event-id'),payload.id);return payload
    })
    assert.equal(seen[0].type,'claim.approved');assert.equal(seen[0].record.id,c.id);assert.equal(seen[0].record.status,'approved')
    assert.equal(seen[1].id,seen[0].id,'retry preserves event identity');assert.equal(received[0].body,received[1].body)
    assert.equal(seen[2].type,'payment.settled');assert.equal(seen[2].record.id,batch.id);assert.equal(seen[2].record.status,'reimbursed')
    deliveries=(await h.get('public-api/webhooks')).deliveries;assert.ok(deliveries.every(d=>d.delivered_at))
    await tick(4);assert.equal(received.length,3,'delivered event does not send twice')
    await h.post(`public-api/webhooks/${hook.id}/revoke`,{})
    c=await createNativeClaim(h,t);c=await h.post(`claims/${c.id}/submit`,{version:c.version},t.sam);await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved',acknowledge:true},t.priya)
    await tick(5);assert.equal(received.length,3,'revocation stops later events')
    const redirectHook=await h.post('public-api/webhooks',{...subscription,destination:'https://8.8.8.8/synthetic-coaster-25',events:['claim.approved']})
    c=await createNativeClaim(h,t);c=await h.post(`claims/${c.id}/submit`,{version:c.version},t.sam);await h.post(`claims/${c.id}/decision`,{version:c.version,revision:c.revision,decision:'approved',acknowledge:true},t.priya)
    await tick(6);assert.equal(received.length,4,'a redirect is not followed to its private Location')
    const redirected=(await h.get('public-api/webhooks')).deliveries.find(d=>d.subscription_id===redirectHook.id)
    assert.equal(redirected.last_status,302);assert.equal(redirected.delivered_at,null)
    await h.post(`public-api/webhooks/${redirectHook.id}/revoke`,{});await tick(8);assert.equal(received.length,4,'revoked pending retries stay stopped')

  } finally {await h.close()}
})
