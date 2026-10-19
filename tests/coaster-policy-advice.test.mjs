// AGENT-003 through signed-in HTTP doors and the real policy/claim lifecycle.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agency, harness } from './harness.mjs'

async function fixture(h, financeOnly=false) {
  const t = await agency(h)
  await h.post('settings/business', { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', receiptThreshold: '200.00' })
  await h.post('settings/categories', { id: t.c.meals, name: 'Meals', accountCode: '6300', taxCode: 'GST', ...(financeOnly ? {} : {limit:'50.00'}) })
  if(financeOnly) await h.post('policy',{rules:[{kind:'per-expense-limit',category:t.c.meals,limit:'50.00'}]},t.morgan)
  const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
  const day = new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10)
  const create = async (merchant, amount, decide=true) => {
    let c = await h.post('claims', { title: merchant }, t.sam)
    c = await h.post(`claims/${c.id}/items`, { version: c.version, kind:'receipt', date:day, merchant, amount, allocations:[{category:t.c.meals}], explanation:'Client meeting required this venue' }, t.sam)
    c = await h.post(`claims/${c.id}/submit`, {version:c.version}, t.sam)
    if(decide) c = await h.post(`claims/${c.id}/decision`, {version:c.version, revision:c.revision, decision:'approved', acknowledge:true}, t.priya)
    return c
  }
  const claims = [await create('North client lunch','60.00'),await create('East client lunch','70.00')]
  assert.deepEqual((await h.post('policy/advice',{minutesPerException:1},t.morgan)).suggestions,[],'two approvals do not establish a recurring exception')
  claims.push(await create('West client lunch','75.00'))
  return {...t,create,claims}
}

test('AGENT-003 finance replays approved recurring exceptions with affected claims and an explicit hours estimate; owner adoption changes today’s policy only', async () => {
  const h=await harness()
  try {
    const t=await fixture(h), request={minutesPerException:4}
    await h.post('policy/advice',request,t.sam,403)
    await h.post('policy/advice',request,t.priya,403)
    await h.post('policy/advice',{minutesPerException:0},t.morgan,400)
    const key=await h.post('agent-keys',{label:'Finance assistant'},t.morgan)
    assert.equal((await h.send('/api/coaster/policy/advice',request,'',{authorization:`Bearer ${key.token}`})).status,401,'current agent keys gain no history access')
    const pending=await t.create('Pending dinner','90.00',false)
    await t.create('Compliant lunch','40.00')
    const before=await Promise.all(t.claims.map(c=>h.get(`claims/${c.id}`,t.priya)))
    const outboundBefore=h.outbound.length
    const replay=await h.post('policy/advice',request,t.morgan), s=replay.suggestions[0]
    assert.equal(h.outbound.length,outboundBefore,'policy replay has no external egress')
    assert.deepEqual([s.currentLimitMinor,s.proposedLimitMinor,s.approvedExceptions,s.before,s.after,s.estimatedHoursSaved,s.estimate],[5000,7500,3,4,1,0.2,true])
    assert.deepEqual(s.affected.map(c=>c.id).sort(),t.claims.map(c=>c.id).sort())
    assert.deepEqual(s.affected.flatMap(c=>c.expenses.map(i=>i.amountMinor)).sort((a,b)=>a-b),[6000,7000,7500])
    assert.ok(!s.affected.some(c=>c.id===pending.id),'a larger expense remains over the proposed limit')
    await h.post('policy/advice/adopt',{category:s.category,proposalToken:s.proposalToken,...request},t.morgan,403)
    const versions=(await h.get('policy',t.morgan)).versions.length
    await h.post('policy/advice/adopt',{category:s.category,proposalToken:'0'.repeat(64),...request},h.owner,409)
    assert.equal((await h.get('policy',t.morgan)).versions.length,versions,'tampering writes nothing')
    const adopted=await h.post('policy/advice/adopt',{category:s.category,proposalToken:s.proposalToken,...request})
    const active=(await h.get('policy',t.morgan)).versions[0]
    assert.ok(adopted.policyVersion>replay.policyVersion)
    assert.equal(active.effective_from,adopted.effectiveFrom)
    assert.equal(active.effective_from,new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()))
    assert.equal((await h.get('state')).categories.find(c=>c.id===t.c.meals).limit_minor,7500)
    for(let i=0;i<t.claims.length;i++) {
      const after=await h.get(`claims/${t.claims[i].id}`,t.priya)
      assert.deepEqual(after.revisions,before[i].revisions)
      assert.deepEqual(after.decisions,before[i].decisions)
      assert.deepEqual(after.exceptions,before[i].exceptions)
    }
    assert.deepEqual((await h.post('policy/advice',request,t.morgan)).suggestions,[],'adopted cap removes the recurring exception under replay')
    const newClaim=await t.create('Next lunch','75.00',false)
    assert.deepEqual((await h.get(`claims/${newClaim.id}`,t.priya)).exceptions,[])
    const audit=(await h.get('history')).lines.find(e=>e.action==='policy-advice-adopted')
    assert.ok(audit,'adoption is recorded in append-only history')
  } finally {await h.close()}
})

test('AGENT-003 stale history or policy refuses adoption; finance rules can be raised without tightening a higher cap and hard rules never become suggestions', async () => {
  const h=await harness()
  try {
    const t=await fixture(h), request={minutesPerException:3}
    const s=(await h.post('policy/advice',request,t.morgan)).suggestions[0]
    await t.create('Changed history','65.00')
    await h.post('policy/advice/adopt',{category:s.category,proposalToken:s.proposalToken,...request},h.owner,409)
    const fresh=(await h.post('policy/advice',request,t.morgan)).suggestions[0]
    await h.post('policy',{rules:[{kind:'per-expense-limit',category:t.c.meals,limit:'100.00'}]},t.morgan)
    await h.post('policy/advice/adopt',{category:fresh.category,proposalToken:fresh.proposalToken,...request},h.owner,409)
    const next=(await h.post('policy/advice',request,t.morgan)).suggestions[0]
    await h.post('policy/advice/adopt',{category:next.category,proposalToken:next.proposalToken,...request})
    assert.equal((await h.get('policy',t.morgan)).versions[0].rules[0].limit_minor,10000,'a higher finance cap stays higher')
    await h.post('settings/categories',{id:t.c.meals,name:'Meals',accountCode:'6300',taxCode:'GST',limit:'50.00'})
    await h.post('policy',{rules:[{kind:'per-expense-limit',category:t.c.meals,limit:'10.00',hard:true}]},t.morgan)
    assert.deepEqual((await h.post('policy/advice',request,t.morgan)).suggestions,[],'hard limits are not proposed for automatic relaxation')
  } finally {await h.close()}
})

test('AGENT-003 a finance-only category cap is replayed and versioned on adoption without creating an owner floor', async () => {
  const h=await harness()
  try {
    const t=await fixture(h,true), request={minutesPerException:5}
    const s=(await h.post('policy/advice',request,t.morgan)).suggestions[0]
    assert.deepEqual([s.currentLimitMinor,s.proposedLimitMinor,s.before,s.after],[5000,7500,3,0])
    await h.post('policy/advice/adopt',{category:s.category,proposalToken:s.proposalToken,...request})
    assert.equal((await h.get('state')).categories.find(c=>c.id===t.c.meals).limit_minor,null)
    assert.equal((await h.get('policy',t.morgan)).versions[0].rules[0].limit_minor,7500)
  } finally {await h.close()}
})
