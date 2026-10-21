// FEED-004 reporting and budgets through statement import, matching and native claim HTTP doors.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness } from './harness.mjs'

const NOTICE = "When this receipt matches one of your card charges, Coaster attaches it automatically. Approvers and finance can see the receipt, its file name and the total, currency and date you entered once that expense is submitted — by you, your delegate or the owner's scheduled submission."

test('FEED-004 REPORT-001 REPORT-002 REPORT-004 posted card spend counts once before submission, groups and drills by card without exposing private receipts, accrues and follows manager scope', async () => {
  const h = await harness()
  try {
    const t = await agency(h), bytes = await readFile('tests/fixtures/receipts/bistro.png')
    const otherManager = await h.person('lee@harbourfinch.example', {employee:true,manager:true})
    await h.post('settings/members', {email:'alex@harbourfinch.example',name:'Alex',employee:true,approver:'lee@harbourfinch.example'})
    const cards = []
    for (const [last4, employee] of [['1111','sam'],['2222','alex']]) cards.push(await h.post('statements/cards',{issuer:'Juniper corporate card',last4,employee:employee+'@harbourfinch.example'}))
    await h.post('budgets',{name:'Office supplies',scope:'category',scopeKey:t.c.office,period:'monthly',amount:'200',owner:'morgan@harbourfinch.example',thresholds:'80,100',policyRule:true},t.morgan)
    const statement = async (last4, amounts) => {
      const body={format:'csv',name:`card-${last4}.csv`,issuer:'Juniper corporate card',category:t.c.office,content:'Date,Merchant,Amount,Id\n'+amounts.map((a,i)=>`2026-10-0${i+2},Office shop ${last4} ${i},${a},${last4}-${i}`).join('\n'),mapping:{dateFormat:'YYYY-MM-DD',sign:'purchases-positive',postedDate:'Date',description:'Merchant',amount:'Amount',transactionId:'Id',wholeFileLast4:last4}}
      const p=await h.post('statements/preview',body,t.morgan)
      return h.post('statements/commit',{...body,fingerprint:p.fingerprint},t.morgan)
    }
    const sam=await statement('1111',['10','20','30']), alex=await statement('2222',['40'])
    for (const [i,total] of ['10','20','30'].entries()) {
      const form=new FormData(); form.append('file',new Blob([Buffer.concat([bytes,Buffer.from(`private-${i}`)])]),`private-original-${i}.png`); form.append('source','upload')
      const request=new Request(h.origin+'/api/coaster/receipt-inbox',{method:'POST',headers:{origin:h.origin,cookie:t.sam},body:form})
      const r=await h.mf.dispatchFetch(request.url,{method:'POST',headers:Object.fromEntries(request.headers),body:await request.arrayBuffer()})
      assert.equal(r.status,200);const receipt=(await r.json()).receipt
      await h.post(`receipt-inbox/${receipt.id}/card-match`,{expectedSequence:0,enabled:true,merchant:`Private entered merchant ${i}`,date:`2026-10-0${i+2}`,total,currency:'AUD',notice:NOTICE},t.sam)
    }
    await (await h.mf.getWorker()).scheduled({scheduledTime:Date.now(),cron:'17 * * * *'})
    const matched=await h.get(`claims/${sam.claims[0]}`,t.sam)
    assert.equal(matched.items.filter(i=>i.receipt_id).length,3)
    const spend=(by='card',cookie=t.morgan,key)=>h.get('spend?'+new URLSearchParams({by,from:'2026-10-01',to:'2026-10-31',...(key?{key}:{})}),cookie)
    for (const by of ['employee','category','merchant','cost-centre','month','card']) assert.equal((await spend(by)).totalMinor,10000)
    let grouped=await spend()
    assert.deepEqual(grouped.groups.map(g=>[g.key,g.pendingMinor,g.approvedMinor,g.expenses]).sort(),[[cards[0].id,6000,0,3],[cards[1].id,4000,0,1]].sort())
    assert.equal((await h.get('budgets?day=2026-10-31',t.morgan))[0].actualMinor,10000,'posting counts before submission')
    const drill=await spend('card',t.morgan,cards[0].id)
    assert.equal(drill.totalMinor,6000);assert.equal(drill.lines.length,3)
    assert.ok(drill.lines.every(l=>l.receipt===null && l.receiptLink===null))
    for(const i of matched.items) for(const token of [i.receipt_id,i.receipt_name,i.receipt_sha256,'Private entered merchant']) assert.ok(!JSON.stringify(drill).includes(token),'draft originals stay private')
    assert.equal((await spend('card',t.priya)).totalMinor,6000)
    assert.equal((await spend('card',otherManager)).totalMinor,4000)
    assert.deepEqual((await spend('card',t.priya,cards[1].id)).lines,[])
    await h.get('spend?by=card&from=2026-10-01&to=2026-10-31',t.sam,403)
    let a=await h.get(`claims/${alex.claims[0]}`,t.alex)
    await h.post(`claims/${a.claim.id}/receipts`,{version:a.claim.version,item:a.items[0].id,name:'office-evidence.png',base64:bytes.toString('base64')},t.alex)
    a=await h.get(`claims/${a.claim.id}`,t.alex)
    const submitted=await h.post(`claims/${a.claim.id}/submit`,{version:a.claim.version},t.alex)
    await h.post(`claims/${a.claim.id}/decision`,{version:submitted.version,revision:submitted.revision,decision:'approved',acknowledge:true},otherManager)
    grouped=await spend()
    assert.equal(grouped.totalMinor,10000,'submission does not double posted spend')
    assert.deepEqual(grouped.groups.find(g=>g.key===cards[1].id).approvedMinor,4000)
    const visible=await spend('card',t.morgan,cards[1].id)
    assert.ok(visible.lines[0].receiptLink)
    const download=await h.mf.dispatchFetch(h.origin+visible.lines[0].receiptLink,{headers:{cookie:t.morgan}})
    assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes)
    const accrual=await h.get('reports/unsubmitted?from=2026-10-01&to=2026-10-31',t.morgan)
    assert.deepEqual(accrual.totals,{claims:1,expenses:3,amountMinor:6000})
    assert.equal((await h.get('budgets?day=2026-10-31',t.morgan))[0].actualMinor,10000)
    const view=(await h.post('spend-views',{name:'October cards',by:'card',from:'2026-10-01',to:'2026-10-31'},t.morgan))[0]
    assert.equal((await h.get(`spend?view=${view.id}`,t.morgan)).totalMinor,10000)
    const undone=await h.post(`statements/${sam.file}/undo`,{},t.morgan)
    assert.equal(undone.removed,0,'matched charges remain posted when their statement is undone')
    assert.equal((await spend()).totalMinor,10000)
  } finally {await h.close()}
})
