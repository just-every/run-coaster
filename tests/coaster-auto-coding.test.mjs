import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness } from './harness.mjs'

import { n, path, fixture, setup, manual, simplified } from './automatic-coding-quality.mjs'

async function withSetup(run){const h=await harness();try{await run(h,await setup(h))}finally{await h.close()}}
test('CODE-002 labeled 120-charge and 120-receipt corpus measures finance-rule exact coding and twelve-month repeat learning through native public doors',()=>withSetup(async(h,t)=>{
  const claims={}
  for(const key of ['sam','alex','bea'])claims[key]=await h.post('claims',{title:n(7000+['sam','alex','bea'].indexOf(key))},t[key])
  for(const row of fixture.history)claims[row.employee]=await manual(h,t,row,claims[row.employee])
  for(const key of ['sam','alex','bea'])await h.post(`claims/${claims[key].id}/submit`,{version:claims[key].version},t[key])
  const historyMonths=new Set(fixture.history.map(r=>r.date.slice(0,7)));assert.equal(historyMonths.size,12)
  await t.rule(n(1001),t.fields(1))
  await t.rule(n(1002),t.fields(2),'personal',t.sam)
  for(const [mcc,cat]of [['5812',2],['5943',0]])await h.post(`${path}/mcc`,{version:(await h.get(`${path}/rules`,t.finance)).version,mcc,category:t.cats[cat].id,active:true},t.finance)
  let catalog=await h.get('coding');catalog=await h.post('coding/values',{version:catalog.version,id:t.values.account,active:false});await h.post('coding/values',{version:catalog.version,id:t.values.class[3],active:false})
  const imported=await t.statement(fixture.cases)
  const charges=[];for(const claim of imported.claims)charges.push(...(await h.get(`claims/${claim}`,t.sam)).items)
  assert.equal(charges.length,120)
  const scores={charges:120,receipts:120,financeRule:{matched:0,total:0},eligibleRepeatCategory:{matched:0,total:0},fullRepeatCategory:{matched:0,total:0},category:{matched:0,total:0},class:{matched:0,total:0},project:{matched:0,total:0},abstentions:0,sources:{}}
  const originals=[]
  for(const row of fixture.cases){
    const item=charges.find(i=>i.merchant===row.merchant&&i.amount_minor===Math.round(Number(row.amount)*100));assert.ok(item)
    const sources=item.codingSuggestions.flatMap(s=>s.evidence)
    const proposed=item.codingSuggestions.reduce((a,s)=>({category:s.fields.category??a.category,dimensions:{...a.dimensions,...s.fields.dimensions}}),{dimensions:{}})
    const actual=simplified(proposed,t),label={category:row.category,class:row.class,project:row.project}
    assert.deepEqual(actual,label,`${row.id} charge ${row.kind}`)
    const receipt=await t.upload(row);originals.push({row,id:receipt.receipt.id,notice:receipt.receipt.matchChoice.notice});const suggestions=receipt.codingSuggestions??[]
    const receiptFields=suggestions.reduce((a,s)=>({category:s.fields.category??a.category,dimensions:{...a.dimensions,...s.fields.dimensions}}),{dimensions:{}})
    const receiptActual=simplified(receiptFields,t)
    for(const field of ['category','class','project'])if(receiptActual[field]!==null)assert.equal(receiptActual[field],label[field],`${row.id} receipt ${field} suggestion must match its business label`)
    // Receipts have no charge MCC and no invented reader. Missing source data is an abstention, included in category recall.
    for(const measured of [actual,simplified(receiptFields,t)]){
      for(const field of ['category','class','project'])if(row[field]!==null){scores[field].total++;if(measured[field]===row[field])scores[field].matched++}
      if(row.repeat&&row.category!==null){scores.eligibleRepeatCategory.total++;if(measured.category===row.category)scores.eligibleRepeatCategory.matched++}
      if(row.repeat){scores.fullRepeatCategory.total++;if(row.category!==null&&measured.category===row.category)scores.fullRepeatCategory.matched++}
      if(row.kind==='finance'){scores.financeRule.total++;if(JSON.stringify(measured)===JSON.stringify(label))scores.financeRule.matched++}
      if(measured.category===null)scores.abstentions++
    }
    for(const source of new Set(sources.map(e=>e.source)))scores.sources[source]=(scores.sources[source]??0)+1
    assert.ok(!Object.values(proposed.dimensions).includes(t.values.class[3]))
    assert.notEqual(proposed.category,t.cats[3].id)
  }
  for(const field of ['financeRule','eligibleRepeatCategory','fullRepeatCategory','category','class','project'])scores[field].percent=100*scores[field].matched/scores[field].total
  assert.equal(scores.financeRule.percent,100);assert.ok(scores.eligibleRepeatCategory.percent>=90)
  console.log('CODE002_INGESTION_MEASUREMENT '+JSON.stringify(scores))
  // The employee opts each original into real charge matching. The actual linked charge can supply its MCC.
  for(const {row,id,notice}of originals)await h.post(`receipt-inbox/${id}/card-match`,{expectedSequence:0,enabled:true,merchant:row.merchant,date:row.date,total:row.amount,currency:'USD',notice},t.sam)
  const worker=await h.mf.getWorker();for(let i=0;i<2;i++)await worker.scheduled({scheduledTime:Date.now()+i*3600000,cron:'17 * * * *'})
  // Tip-tolerant matching correctly asks when multiple charges are candidates. The employee confirms the exact-total purchase through the normal attachment door.
  const inbox=await h.get('receipt-inbox',t.sam),versions=new Map();
  for(const {row,id}of originals){
    const original=inbox.receipts.find(r=>r.id===id);if(original.attachment)continue;
    const question=await h.get(`receipt-inbox/${id}/card-match-question`,t.sam),exact=question.candidates.filter(c=>c.amountMinor===Math.round(Number(row.amount)*100));assert.equal(exact.length,1)
    const chosen=exact[0];if(!versions.has(chosen.claimId))versions.set(chosen.claimId,(await h.get(`claims/${chosen.claimId}`,t.sam)).claim.version)
    const attached=await h.post(`receipt-inbox/${id}/attach`,{expectedSequence:original.lifecycleSequence,claimId:chosen.claimId,itemId:chosen.itemId,version:versions.get(chosen.claimId)},t.sam);versions.set(chosen.claimId,attached.claim.version)
  }
  const linked={fullRepeatCategory:{matched:scores.fullRepeatCategory.matched,total:scores.fullRepeatCategory.total},eligibleRepeatCategory:{matched:scores.eligibleRepeatCategory.matched,total:scores.eligibleRepeatCategory.total},category:{matched:scores.category.matched,total:scores.category.total},class:scores.class,project:scores.project,financeRule:scores.financeRule,abstentions:24}
  for(const {row,id}of originals){
    const read=await h.get(`${path}/suggestions?receipt=${id}`,t.sam),fields=read.suggestions.reduce((a,s)=>({category:s.fields.category??a.category,dimensions:{...a.dimensions,...s.fields.dimensions}}),{dimensions:{}}),actual=simplified(fields,t)
    assert.deepEqual(actual,{category:row.category,class:row.class,project:row.project},`${row.id} actual linked charge supplies its MCC without OCR`)
    if(['ambiguous','new-mcc','retired-class'].includes(row.kind)){linked.category.matched++;if(row.repeat){linked.fullRepeatCategory.matched++;linked.eligibleRepeatCategory.matched++}assert.ok(read.suggestions.some(s=>s.evidence.some(e=>e.source==='merchant-category'&&e.reason.includes(row.mcc))))}
  }
  for(const k of ['fullRepeatCategory','eligibleRepeatCategory','category'])linked[k].percent=100*linked[k].matched/linked[k].total
  assert.ok(linked.fullRepeatCategory.percent>=90,'all repeat charges and originals count, including required archived-account abstentions')
  console.log('CODE002_LINKED_MEASUREMENT '+JSON.stringify(linked))

  // Two personal corrections affect only this employee’s next charge.
  {

  const merchant=n(8200),initial=t.fields(0),corrected=t.fields(2)
  let history=await h.post('claims',{title:n(8201)},t.alex)
  for(let i=0;i<2;i++)history=await manual(h,t,{employee:'alex',merchant,date:`2026-0${i+1}-15`,amount:'1.00',category:0,class:0,project:0},history)
  await h.post(`claims/${history.id}/submit`,{version:history.version},t.alex)
  for(let i=0;i<2;i++){
    const imported=await t.statement([{id:n(8202+i),merchant,amount:`3.0${i}`}]);const detail=await h.get(`claims/${imported.claims[0]}`,t.sam),item=detail.items.at(-1)
    assert.deepEqual(simplified(item.codingSuggestions.at(-1).fields,t),{category:0,class:0,project:0})
    await h.post(`${path}/suggestions/${item.codingSuggestions.at(-1).id}/decision`,{claimVersion:detail.claim.version,action:'override',values:corrected},t.sam)
  }
  const third=await t.statement([{id:n(8204),merchant,amount:'3.02'}]),detail=await h.get(`claims/${third.claims[0]}`,t.sam),item=detail.items.at(-1)
  assert.deepEqual(simplified(item.codingSuggestions.at(-1).fields,t),{category:2,class:2,project:2})
  assert.ok(item.codingSuggestions.at(-1).evidence.every(e=>e.source==='learned-person'))
  const other=await t.statement([{id:n(8205),merchant,amount:'3.03'}],'2222'),another=await h.get(`claims/${other.claims[0]}`,t.alex)
  assert.deepEqual(simplified(another.items.at(-1).codingSuggestions.at(-1).fields,t),{category:0,class:0,project:0})
  }
}))
