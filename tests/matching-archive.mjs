// The existing real-CLI matching refusals, separated from their UI setup so
// the expensive archive checks can be validated without repeating the screens.
import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {command,refusalCases} from './browser-runtime.mjs'
import {records,rows,tampered} from './browser-archive.mjs'

export async function rejectMatchingArchives(restored,archive,empty,{part=0,of=1}={}) {
  const alterBasis=change=>(event,input)=>{
    const data=JSON.parse(event.match_data);change(data);event.match_data=JSON.stringify(data)
    for(const {row} of rows(input).filter(r=>r.table==='c_receipts'))
      if(row.capture_receipt_id===event.receipt_id&&row.claim_id===event.claim_id&&row.card_match_basis)row.card_match_basis=event.match_data
  }
  const automated=r=>r.channel==='schedule'
  // Row order is by random receipt id. Select the consent that actually authorized an automatic attachment;
  // withdrawing a later choice or a manually attached original is a valid archive, not an adversarial match.
  const archivedLines=rows(await records(archive)).filter(r=>r.table==='c_capture_lifecycle').map(r=>r.row)
  const automaticChoices=new Set(archivedLines.filter(automated).map(event=>{
    const choice=archivedLines.filter(r=>r.receipt_id===event.receipt_id&&r.sequence<event.sequence&&['match-details','match-withdrawn'].includes(r.kind)).sort((a,b)=>a.sequence-b.sequence).at(-1)
    assert.equal(choice?.kind,'match-details')
    return `${choice.receipt_id}:${choice.sequence}`
  }))
  const cases=[
    ['match_choice','c_capture_lifecycle',r=>r.kind==='match-details',r=>{const d=JSON.parse(r.match_data);d.totalMinor=0;r.match_data=JSON.stringify(d)}],
    ['match_choice_currency','c_capture_lifecycle',r=>r.kind==='match-details',r=>{const d=JSON.parse(r.match_data);d.currency='ZZZ';r.match_data=JSON.stringify(d)}],
    ['match_choice_last_four','c_capture_lifecycle',r=>r.kind==='match-details',r=>{const d=JSON.parse(r.match_data);d.last4='synthetic-full-card-number';r.match_data=JSON.stringify(d)}],
    ['match_basis','c_capture_lifecycle',r=>r.channel==='schedule',r=>{r.on_behalf_of='foreign@dev.localhost'}],
    ['card_charge','c_card_charges',()=>true,r=>{r.card_id='missing-card'}],
    ['match_rejection','c_card_match_rejections',()=>true,r=>{r.transaction_key='card:forged'}],
    ['match_basis_snapshot','c_revisions',r=>JSON.parse(r.snapshot).items.some(i=>i.card_match_basis),r=>{const snapshot=JSON.parse(r.snapshot);const item=snapshot.items.find(i=>i.card_match_basis);const data=JSON.parse(item.card_match_basis);data.differenceMinor+=1;item.card_match_basis=JSON.stringify(data);r.snapshot=JSON.stringify(snapshot)}],
    ['match_basis_rule','c_capture_lifecycle',automated,alterBasis(d=>{d.ruleVersion=999})],
    ['match_basis_total','c_capture_lifecycle',automated,alterBasis(d=>{d.enteredTotalMinor+=1})],
    ['match_basis_difference','c_capture_lifecycle',automated,alterBasis(d=>{d.differenceMinor+=1})],
    ['match_basis_currency','c_capture_lifecycle',automated,alterBasis(d=>{d.enteredCurrency='USD'})],
    ['match_basis_date','c_capture_lifecycle',automated,alterBasis(d=>{d.enteredDate='2026-10-01'})],
    ['match_basis_private_field','c_capture_lifecycle',automated,alterBasis(d=>{d.merchant='synthetic-private-details'})],
    ['match_basis_withdrawn','c_capture_lifecycle',r=>r.kind==='match-details'&&automaticChoices.has(`${r.receipt_id}:${r.sequence}`),(r)=>{r.kind='match-withdrawn';r.match_data=null}],
    ['match_history_discarded','c_capture_lifecycle',r=>r.kind==='match-details'&&automaticChoices.has(`${r.receipt_id}:${r.sequence}`),(r)=>{r.kind='discarded';r.reason='synthetic-discarded';r.match_data=null}],
    ['match_history_merged','c_capture_lifecycle',r=>r.kind==='match-details'&&automaticChoices.has(`${r.receipt_id}:${r.sequence}`),(r,input)=>{r.kind='merged';r.reason='synthetic-merged';r.match_data=null;r.survivor_id=rows(input).find(i=>i.table==='c_capture_receipts'&&i.row.id!==r.receipt_id).row.id}],
    ['card_charge_employee','c_card_charges',()=>true,r=>{r.employee_email='synthetic-foreign@example.test'}],
    ['card_statement_ledger','c_card_ledger',()=>true,r=>{r.amount_minor+=1}],
    ['coding_parent','c_coding_values',r=>r.parent_value_id,r=>{r.parent_value_id='synthetic-coaster-missing-parent'}],
    ['coding_item','c_items',r=>Object.keys(JSON.parse(r.coding)).length,r=>{r.coding=JSON.stringify({'synthetic-coaster-missing-level':'synthetic-coaster-missing-choice'})}],
    ['coding_category_account','c_categories',r=>r.ledger_account_id,r=>{const account=JSON.parse(r.ledger_account_snapshot);account.sourceId='synthetic-coaster-missing-account';r.ledger_account_snapshot=JSON.stringify(account)}],
    ['receipt_reading_owner','c_receipt_readings',()=>true,r=>{r.actor_email='synthetic-coaster-8000'},0],
    ['program_feed_credentials','c_program_feeds',()=>true,r=>{r.enabled=1},0],
    ['automatic_coding_owner','c_auto_coding_contexts',r=>r.target_kind==='receipt',r=>{r.employee_email='synthetic-coaster-5000'},0],
  ]
  await refusalCases(restored,cases.filter((entry,index)=>entry[4]===undefined?index%of===part:part===entry[4]),async(restored,[code,table,pick,change])=>{
    await writeFile(join(restored,`exports/${code}.rer`),await tampered(archive,table,change,pick),{mode:0o600})
    const result=await command(restored,['import','--input',`exports/${code}.rer`,'--yes'],{expected:4})
    assert.match(result,new RegExp(code.startsWith('receipt_reading_')?'coaster_receipt_reading':code.startsWith('program_feed_')?'coaster_program_feed':code.startsWith('automatic_coding_')?'coaster_automatic_coding':code.startsWith('coding_')?'coaster_coding_catalog':code==='match_basis'?'coaster_capture_lifecycle_provenance':code.startsWith('card_charge')?'coaster_card_charge':code.startsWith('card_statement')?'coaster_card_statement':code.startsWith('match_history')?'coaster_capture_(history|merge)':code.startsWith('match_basis_')?'coaster_capture_match_basis':code.startsWith('match_choice')?'coaster_capture_match_choice':'coaster_capture_'+code))
    await command(restored,['export','--output',`exports/unchanged-${code}.rer`])
    assert.deepEqual(rows(await records(join(restored,`exports/unchanged-${code}.rer`))),empty,'malformed match archive writes nothing')
  })
  return cases.filter((entry,index)=>entry[4]===undefined?index%of===part:part===entry[4]).map(c=>c[0])
}
