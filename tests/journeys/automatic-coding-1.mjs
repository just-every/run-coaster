// Assertion phases used by the surviving public-door journey.
import assert from 'node:assert/strict'
import { harness } from '../harness.mjs'

import { n, path, fixture, setup, manual, simplified } from '../automatic-coding-quality.mjs'

async function withSetup(run){const h=await harness();try{await run(h,await setup(h))}finally{await h.close()}}

export async function preserveAutomaticCoding1() {
  // CODE-002 native rules, personal corrections, source rates and untouched statement undo use exact guarded public flows
  await (()=>withSetup(async(h,t)=>{
  const merchant=n(8000),first=t.fields(0),corrected=t.fields(2)
  await h.post(`${path}/rules`,{version:0,scope:'finance',merchant,coding:first},t.sam,403)
  const financeRule=await t.rule(merchant,{...first,memo:n(8001)})
  await t.rule(merchant,corrected,'personal',t.sam)
  let preview=await h.post(`${path}/preview`,{merchant:`  ${merchant.toUpperCase()}  `,values:{}},t.sam)
  assert.deepEqual(simplified(preview.fields,t),{category:0,class:0,project:0});assert.ok(preview.evidence.every(e=>e.source==='merchant-rule'&&e.reason))
  await h.get(`${path}/rates`,t.sam,403)
  const pending=await t.statement([{id:n(8002),merchant,amount:'4.12'}]);let detail=await h.get(`claims/${pending.claims[0]}`,t.sam),item=detail.items[0]
  const undone=await h.post(`statements/${pending.file}/undo`,{},t.finance);assert.equal(undone.removed,1,'untouched category/memo suggestions are system coding, so statement undo removes them')
  const decision=(d,values,action='override')=>h.post(`${path}/suggestions/${d.items.at(-1).codingSuggestions.find(s=>s.status==='pending').id}/decision`,{claimVersion:d.claim.version,action,values},t.sam)
  const second=await t.statement([{id:n(8003),merchant,amount:'4.13'}]);detail=await h.get(`claims/${second.claims[0]}`,t.sam)
  await decision(detail,corrected)
  assert.equal((await h.post(`statements/${second.file}/undo`,{},t.finance)).removed,0,'a human override stays when the original statement is undone')
  const third=await t.statement([{id:n(8004),merchant,amount:'4.14'}]);detail=await h.get(`claims/${third.claims[0]}`,t.sam);await decision(detail,corrected)
  const accepted=await t.statement([{id:n(8007),merchant,amount:'4.18'}]);detail=await h.get(`claims/${accepted.claims[0]}`,t.sam);await decision(detail,undefined,'accept')
  assert.equal((await h.post(`statements/${accepted.file}/undo`,{},t.finance)).removed,0,'explicitly accepted automatic coding is human-confirmed and stays')
  await t.rule(n(8008),{category:t.cats[0].id})
  const sameDefault=await t.statement([{id:n(8009),merchant:n(8008),amount:'4.19'}]);detail=await h.get(`claims/${sameDefault.claims[0]}`,t.sam);await decision(detail,undefined,'accept')
  assert.equal((await h.post(`statements/${sameDefault.file}/undo`,{},t.finance)).removed,0,'confirmation stays even when the proposed category equals the import default')
  // Finance rules continue to win even after personal corrections; disabling the rule exposes personal behavior.
  await h.post(`${path}/rules`,{version:(await h.get(`${path}/rules`,t.finance)).version,id:financeRule.saved,scope:'finance',merchant,coding:first,active:false},t.finance)
  const personal=(await h.get(`${path}/rules`,t.sam)).rules[0]
  await h.post(`${path}/rules`,{version:(await h.get(`${path}/rules`,t.sam)).version,id:personal.id,scope:'personal',merchant,coding:corrected,active:false},t.sam)
  const fourth=await t.statement([{id:n(8005),merchant,amount:'4.15'}]);detail=await h.get(`claims/${fourth.claims[0]}`,t.sam)
  assert.deepEqual(simplified(detail.items.at(-1).codingSuggestions.at(-1).fields,t),{category:2,class:2,project:2},'two overrides teach this person the corrected coding')
  assert.ok(detail.items.at(-1).codingSuggestions.at(-1).evidence.every(e=>e.source==='learned-person'))
  const others=await t.statement([{id:n(8006),merchant,amount:'4.16'}],'2222');const other=await h.get(`claims/${others.claims[0]}`,t.alex)
  assert.equal(other.items[0].codingSuggestions.length,0,'another employee never learns from someone else’s private draft corrections')
  const rates=await h.get(`${path}/rates`,t.finance),ruleRate=rates.rules.find(r=>r.id===financeRule.saved)
  assert.equal(ruleRate.overridden,2);assert.equal(ruleRate.accepted,1);assert.equal(ruleRate.rate,33.33)
  assert.ok(rates.sources.some(r=>r.source==='merchant-rule'&&r.overridden===2))
  const activeRule=await t.rule(n(8010),{...first,memo:n(8011)})
  const human=await h.post(`${path}/preview`,{merchant:n(8010),values:{...corrected,memo:n(8012)}},t.sam)
  assert.deepEqual(human.appliedFields,[],'no source overwrites human-filled category, dimensions or memo')
  let catalog=await h.get('coding');await h.post('coding/values',{version:catalog.version,id:t.values.class[0],active:false})
  preview=await h.post(`${path}/preview`,{merchant:n(8010),values:{}},t.sam)
  assert.deepEqual(preview.appliedFields,[]);assert.match(preview.flags[0].reason,/archived/)
  assert.ok((await h.get(`${path}/rules`,t.finance)).flags.some(f=>f.rule_id===activeRule.saved))
  const blocked=await t.statement([{id:n(8013),merchant:n(8010),amount:'4.17'}]);detail=await h.get(`claims/${blocked.claims[0]}`,t.sam)
  assert.equal(detail.items.at(-1).codingSuggestions.length,0)
}))()
  // CODE-002 receipt coding stays private, carries human choices through charge arrival and attachment, and approver feedback preserves frozen revisions
  await (()=>withSetup(async(h,t)=>{
  const merchant=fixture.cases[0].merchant,rule=await t.rule(merchant,{...t.fields(0),memo:n(8301)})
  const uploaded=await t.upload({id:n(8302),merchant}),id=uploaded.receipt.id
  await h.get(`${path}/suggestions?receipt=${id}`,t.finance,404)
  const current=await h.get(`${path}/suggestions?receipt=${id}`,t.sam)
  await h.post(`${path}/receipts/${id}`,{version:current.context.version,merchant,values:{...t.fields(2),memo:n(8303)}},t.sam)
  const original=await h.get(`${path}/suggestions?receipt=${id}`,t.sam)
  assert.equal(original.suggestions[0].status,'override')
  const imported=await t.statement([{id:n(8304),merchant,amount:fixture.cases[0].amount}]);let detail=await h.get(`claims/${imported.claims[0]}`,t.sam),item=detail.items.at(-1)
  await h.post(`receipt-inbox/${id}/attach`,{expectedSequence:0,claimId:detail.claim.id,itemId:item.id,version:detail.claim.version},t.sam)
  detail=await h.get(`claims/${detail.claim.id}`,t.sam);item=detail.items.at(-1)
  assert.equal(item.allocations[0].category_id,t.cats[2].id);assert.deepEqual(item.coding,t.fields(2).dimensions);assert.equal(item.description,n(8303))
  assert.deepEqual((await h.get(`${path}/suggestions?receipt=${id}`,t.sam)).context.values,original.context.values,'a later charge never changes coding entered on the original')

  const another=await t.upload({id:n(8305),merchant,receipt:fixture.cases[1].receipt}),posted=await t.statement([{id:n(8306),merchant,amount:fixture.cases[1].amount}]);detail=await h.get(`claims/${posted.claims[0]}`,t.sam);item=detail.items.at(-1)
  const corrected=await h.post(`claims/${detail.claim.id}/items`,{version:detail.claim.version,item:item.id,kind:'receipt',date:item.spent_on,merchant:item.merchant,amount:fixture.cases[1].amount,category:t.cats[1].id,coding:t.fields(1).dimensions,description:n(8307)},t.sam)
  await h.post(`receipt-inbox/${another.receipt.id}/attach`,{expectedSequence:0,claimId:corrected.id,itemId:item.id,version:corrected.version},t.sam)
  detail=await h.get(`claims/${corrected.id}`,t.sam);item=detail.items.at(-1)
  assert.equal(item.allocations[0].category_id,t.cats[1].id);assert.deepEqual(item.coding,t.fields(1).dimensions);assert.equal(item.description,n(8307),'receipt suggestions never overwrite employee coding already entered on the expense')

  const fresh=await t.statement([{id:n(8310),merchant:n(8311),amount:'2.33'}])
  // A new finance rule is introduced before a separate charge so a routed approver can review its frozen advice.
  await t.rule(n(8312),t.fields(0))
  const review=await t.statement([{id:n(8313),merchant:n(8312),amount:'2.34'}]);const before=await h.get(`claims/${review.claims[0]}`,t.sam),suggestion=before.items.at(-1).codingSuggestions.at(-1)
  const submitted=await h.post(`claims/${before.claim.id}/submit`,{version:before.claim.version},t.sam)
  const frozen=(await h.get(`claims/${submitted.id}`,t.manager)).revisions.at(-1).snapshot
  await h.post(`${path}/suggestions/${suggestion.id}/decision`,{claimVersion:submitted.version,action:'accept'},t.finance,403)
  const feedback=await h.post(`${path}/suggestions/${suggestion.id}/decision`,{claimVersion:submitted.version,action:'override',values:t.fields(1)},t.manager)
  assert.equal(feedback.applied,false);assert.equal(feedback.requiresReturn,true)
  assert.deepEqual((await h.get(`claims/${submitted.id}`,t.manager)).revisions.at(-1).snapshot,frozen)
  const records=await h.get(`${path}/rates`,t.finance);assert.ok(records.rules.some(r=>r.id===rule.saved&&r.overridden>0))
}))()
  // Verified receipt understanding uses consented BaseAI line items after native sources, refuses unsafe output and preserves concurrent human coding
  await (async()=>{
  const {readFile}=await import('node:fs/promises'),label=JSON.parse(await readFile('tests/fixtures/receipts/reader/synthetic-coaster-1001.json','utf8'))
  const regions=[{page:1,x:.1,y:.1,width:.5,height:.1}],calls=[]
  const response=value=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]})
  let t,mode='valid',entered,release
  const h=await harness({bindings:{AI_ENABLED:'true',AI_API_KEY:n(9500)},aiEdge:async request=>{
    const body=await request.json();calls.push(body)
    if(body.text.format.name==='receipt_reading')return response(Object.fromEntries(Object.entries(label.values).map(([key,value])=>[key,{value:key==='lineItems'?value.map(i=>({...i,confidence:.99,regions})):value,confidence:.99,regions}])))
    assert.equal(body.text.format.name,'receipt_coding');assert.equal(body.store,false)
    const prompt=JSON.parse(body.input[1].content)
    assert.equal(prompt.receipt.merchant,label.values.merchant);assert.deepEqual(prompt.receipt.lineItems,label.values.lineItems)
    assert.ok(!JSON.stringify(prompt).includes(t.samEmail),'no employee identity enters model context')
    assert.ok(!('last4'in prompt.receipt)&&!('date'in prompt.receipt)&&!('total'in prompt.receipt),'payment metadata is not coding evidence')
    assert.ok(prompt.catalog.categories.every(c=>c.id&&c.name));assert.ok(prompt.catalog.dimensions.every(d=>!('owner_email'in d)))
    if(mode==='paused'){entered();await new Promise(resolve=>release=resolve)}
    if(mode==='unavailable')return Response.json({error:{message:'private upstream detail'}},{status:503})
    const score=mode==='low'?.2:.99
    return response({category:{id:mode==='invalid'?n(9501):t.cats[mode==='transfer'?2:0].id,confidence:score,reason:'The verified purchased items support this category'},dimensions:[{dimension:t.dimensions.class,id:t.values.class[0],confidence:score,reason:'The line items support this active class'},{dimension:t.dimensions.project,id:t.values.project[0],confidence:score,reason:'The line items name this catalog project'}],memo:{text:mode==='transfer'?n(9590):null,confidence:mode==='transfer'?.99:0,reason:'No additional memo is needed'}})
  }})
  try {
    t=await setup(h)
    const settings=await h.get('settings/receipt-reading');await h.post('settings/receipt-reading',{version:settings.version,enabled:true,consent:true,threshold:.95,model:n(9502)})
    let image=1000
    const original=async()=>{
      const uploaded=await t.upload({id:n(9600+image),receipt:`../receipts/reader/synthetic-coaster-${++image}.png`},'')
      const id=uploaded.receipt.id,reading=await h.post(`receipt-inbox/${id}/reading`,{expectedSequence:0,expectedReadingSequence:0,consent:true},t.sam)
      const context=await h.get(`${path}/suggestions?receipt=${id}`,t.sam)
      return {id,reading,notice:uploaded.receipt.matchChoice.notice,body:{expectedSequence:reading.lifecycleSequence,expectedReadingSequence:reading.sequence,contextVersion:context.contextVersion,consent:true}}
    }
    const one=await original(),before=calls.length
    await h.post(`receipt-inbox/${one.id}/reading/coding`,{...one.body,consent:false},t.sam,400)
    await h.post(`receipt-inbox/${one.id}/reading/coding`,one.body,t.finance,404)
    assert.equal(calls.length,before,'no coding request occurs without the original employee and second explicit consent')
    const first=await h.post(`receipt-inbox/${one.id}/reading/coding`,one.body,t.sam)
    assert.deepEqual(simplified(first.values,t),{category:0,class:0,project:0})
    assert.ok(first.codingSuggestions.at(-1).evidence.every(e=>e.source==='receipt-reading'&&e.confidence>=settings.threshold&&e.reason&&e.receipt===one.id))
    await h.post(`receipt-inbox/${one.id}/reading/coding`,one.body,t.sam,409)
    const forged=await h.post(`${path}/preview`,{merchant:n(9503),values:{},receiptReading:{fields:t.fields(2)}},t.sam)
    assert.deepEqual(forged.appliedFields,[],'public preview cannot inject trusted receipt understanding')
    mode='low';const low=await original(),lowResult=await h.post(`receipt-inbox/${low.id}/reading/coding`,low.body,t.sam)
    assert.equal(lowResult.status,'review');assert.equal(lowResult.values.category,undefined);assert.equal(lowResult.codingSuggestions.length,0);assert.ok(lowResult.reviewFields.includes('category'))
    mode='invalid';const invalid=await original(),invalidResult=await h.post(`receipt-inbox/${invalid.id}/reading/coding`,invalid.body,t.sam)
    assert.equal(invalidResult.status,'review');assert.equal(invalidResult.codingSuggestions.length,0);assert.equal(invalidResult.values.category,undefined)
    // Real saved source-five advice carries through the ordinary consented hourly attachment, without a second model call.
    const matching=await h.get('settings/card-matching');await h.post('settings/card-matching',{version:matching.version,enabled:true,windowDays:matching.window_days,tipPercent:0,fxPercent:0})
    await h.post('settings/receipt-reading/matching',{version:one.reading.matchDefault.version,enabled:true,consent:true,notice:one.notice},t.sam)
    await h.post('statements/cards',{issuer:n(300),last4:label.values.last4,employee:t.samEmail})
    const worker=await h.mf.getWorker()
    for(const variant of ['placeholder','finance','human','archived']){
      mode='transfer';const source=await original(),saved=await h.post(`receipt-inbox/${source.id}/reading/coding`,source.body,t.sam),merchant=n(9700+['placeholder','finance','human','archived'].indexOf(variant))
      if(variant==='finance')await t.rule(merchant,t.fields(1))
      const imported=await t.statement([{id:n(9710+image),merchant,date:label.values.date,amount:label.values.total}],label.values.last4)
      let detail=await h.get(`claims/${imported.claims[0]}`,t.sam),expense=detail.items.at(-1)
      if(variant==='human'){
        await h.post(`claims/${detail.claim.id}/items`,{version:detail.claim.version,item:expense.id,kind:'receipt',date:expense.spent_on,merchant:expense.merchant,amount:label.values.total,category:t.cats[1].id,coding:t.fields(1).dimensions},t.sam)
      }
      if(variant==='archived'){const catalog=await h.get('coding');await h.post('coding/values',{version:catalog.version,id:t.values.class[0],active:false})}
      const paid=calls.length;await worker.scheduled({scheduledTime:new Date(),cron:'17 * * * *'});assert.equal(calls.length,paid,'attachment never asks the model again')
      detail=await h.get(`claims/${detail.claim.id}`,t.sam);expense=detail.items.find(item=>item.id===expense.id)
      assert.ok(expense.receipt_id,'the native hourly matcher attached the original')
      if(variant==='placeholder'){
        assert.equal(expense.allocations[0].category_id,t.cats[2].id,'an unchanged importer placeholder receives the actual saved reading category')
        assert.deepEqual(expense.coding,t.fields(0).dimensions)
        assert.equal(saved.values.memo,n(9590));assert.notEqual(expense.description,saved.values.memo,'generated original text stays private until the person adopts it')
        const evidence=expense.codingSuggestions.flatMap(s=>s.evidence).filter(e=>e.source==='receipt-reading')
        assert.ok(evidence.some(e=>e.field==='category'&&e.receipt===source.id&&e.confidence&&e.model&&e.reason))
        assert.ok(evidence.every(e=>e.reason!==saved.codingSuggestions.at(-1).evidence.find(original=>original.field===e.field)?.reason),'the private model explanation is not copied onto the expense')
      }else if(variant==='archived')assert.ok(!expense.codingSuggestions.some(s=>s.evidence.some(e=>e.source==='receipt-reading')),'archived saved reading choices are refused at transfer')
      else{assert.equal(expense.allocations[0].category_id,t.cats[1].id);assert.deepEqual(expense.coding,t.fields(1).dimensions,'higher-priority finance coding and employee choices stay protected')}
    }
    mode='valid';await t.rule(label.values.merchant,t.fields(2));await t.rule(label.values.merchant,t.fields(1),'personal',t.sam)
    const ruled=await original(),ruledResult=await h.post(`receipt-inbox/${ruled.id}/reading/coding`,ruled.body,t.sam)
    assert.deepEqual(simplified(ruledResult.values,t),{category:2,class:2,project:2});assert.ok(ruledResult.codingSuggestions.at(-1).evidence.every(e=>e.source==='merchant-rule'),'finance rule wins over the model and personal rule')
    for(const failure of ['unavailable','invalid']){
      mode=failure;const failed=await original(),failedResult=await h.post(`receipt-inbox/${failed.id}/reading/coding`,failed.body,t.sam)
      assert.equal(failedResult.status,'review','uncertain source-five work stays visible for review')
      assert.deepEqual(simplified(failedResult.values,t),{category:2,class:2,project:2},'a later AI failure never discards earlier finance-rule coding')
      assert.ok(failedResult.codingSuggestions.at(-1).evidence.every(e=>e.source==='merchant-rule'))
      assert.ok(!JSON.stringify(failedResult).includes('private upstream detail'))
    }
    mode='valid'
    const rules=await h.get(`${path}/rules`,t.finance);for(const rule of rules.rules)await h.post(`${path}/rules`,{version:(await h.get(`${path}/rules`,t.finance)).version,id:rule.id,scope:rule.scope,merchant:rule.merchant,coding:rule.fields,active:false},t.finance)
    const own=await h.get(`${path}/rules`,t.sam);for(const rule of own.rules)await h.post(`${path}/rules`,{version:(await h.get(`${path}/rules`,t.sam)).version,id:rule.id,scope:'personal',merchant:rule.merchant,coding:rule.fields,active:false},t.sam)
    const race=await original(),paused=new Promise(resolve=>entered=resolve);mode='paused'
    const pending=h.send(`/api/coaster/receipt-inbox/${race.id}/reading/coding`,race.body,t.sam)
    await paused;await h.post(`${path}/receipts/${race.id}`,{version:race.body.contextVersion,merchant:label.values.merchant,values:t.fields(2)},t.sam);release()
    assert.equal((await pending).status,409,'model output cannot overwrite a human edit made while the provider was running')
    const kept=await h.get(`${path}/suggestions?receipt=${race.id}`,t.sam);assert.deepEqual(simplified(kept.values,t),{category:2,class:2,project:2});assert.equal(kept.suggestions.length,0)
    mode='valid';let catalog=await h.get('coding');await h.post('coding/values',{version:catalog.version,id:t.values.class[0],active:false})
    const retired=await original(),retiredResult=await h.post(`receipt-inbox/${retired.id}/reading/coding`,retired.body,t.sam)
    assert.equal(retiredResult.status,'review');assert.equal(retiredResult.codingSuggestions.length,0,'archived IDs returned by a provider never become advice')
  }finally{release?.();await h.close()}
})()
}
