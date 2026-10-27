import assert from 'node:assert/strict';

/** Real native claim approval, a finance tax decision and scheduled taxable allowance. */
export async function payrollBatch(h,{currency='USD',ownClaim=false}={}) {
  await h.post(['settings','business'].join('/'),{name:'Harbour and Finch Studio',currency,timezone:'UTC',receiptThreshold:''});
  const category=(await h.post(['settings','categories'].join('/'),{name:'Office',accountCode:'6500',taxCode:'NONE'})).id;
  const managerEmail='priya@harbourfinch.example',memberEmail=ownClaim?'owner@harbourfinch.example':'sam@harbourfinch.example';
  const manager=await h.person(managerEmail,{manager:true,employee:true});
  const finance=await h.person('morgan@harbourfinch.example',{finance:true,employee:true},managerEmail);
  if(ownClaim)await h.post(['settings', 'members'].join('/'),{email:memberEmail,name:'Rose Owner',employee:true,approver:managerEmail});
  const employee=ownClaim?h.owner:await h.person(memberEmail,{employee:true},managerEmail);
  let claim=await h.post('claims',{title:'Client workshop'},employee);
  for(const [merchant,amount] of [['Office stationery','10.00'],['Unsubstantiated taxi','5.00']])claim=await h.post(`claims/${claim.id}/items`,{version:claim.version,kind:'receipt',date:'2026-04-10',merchant,amount,allocations:[{category}],explanation:'Synthetic acceptance expense'},employee);
  const detail=await h.get(`claims/${claim.id}`,employee),taxable=detail.items.find(i=>i.merchant==='Unsubstantiated taxi');
  claim=await h.post(`claims/${claim.id}/submit`,{version:claim.version},employee);
  claim=await h.post(`claims/${claim.id}/decision`,{version:claim.version,revision:claim.revision,decision:'approved',acknowledge:true},manager);
  await h.post(`claims/${claim.id}/items/${taxable.id}/accountable-plan`,{reason:'Finance classifies this amount as non-accountable'},finance);
  await h.post('allowances',{name:'Phone stipend',type:'stipend',category,period:'monthly',amount:'7.00',tax:'taxable',startsOn:'2026-06-01',member:memberEmail},finance);
  await (await h.mf.getWorker()).scheduled({scheduledTime:new Date('2026-06-02T09:17:00Z'),cron:'17 * * * *'});
  let stipend=(await h.get('state',manager)).claims.find(c=>c.title.startsWith('Phone stipend ·'));
  stipend=await h.post(`claims/${stipend.id}/decision`,{version:stipend.version,revision:stipend.revision,decision:'approved',acknowledge:true},manager);
  let batch=await h.post('batches',{claims:[claim.id,stipend.id]},finance);
  assert.equal(batch.total_minor,2200);
  batch=await h.post(`batches/${batch.id}/approve`,{version:batch.version,expectedTotal:2200},finance);
  return {batch,employee,manager,finance,memberEmail,claims:[claim.id,stipend.id]};
}
export async function connectFixture(h,fixture,memberEmail) {
  const root=['payroll','gusto'].join('/');
  await h.post(root+'/connect',{company:fixture.company,token:'synthetic-coaster-120',consent:true});
  await h.post(root+'/employees',{email:memberEmail,employee:fixture.employee});
}
