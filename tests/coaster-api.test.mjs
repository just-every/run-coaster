import { test } from 'node:test'
import assert from 'node:assert/strict'
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
    assert.ok(key.expiresAt>Date.now()&&key.expiresAt<=Date.now()+86400000)
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
