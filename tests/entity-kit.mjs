import assert from 'node:assert/strict';
import { agency, receipt } from './harness.mjs';

export const entityRates = `<Envelope><Cube><Cube time="2026-10-02"><Cube currency="USD" rate="1.2"/><Cube currency="CAD" rate="1.6"/></Cube></Cube></Envelope>`;
export const entityClock = Date.parse('2026-10-15T16:00:00Z');
const settings = ['settings','entities'].join('/');
export async function entityScenario(h) {
 const team=await agency(h);
 await h.post(['settings','business'].join('/'),{name:'Harbour Finch US',currency:'USD',timezone:'America/Chicago',fxEnabled:true,receiptThreshold:'75.00'});
 const employee=(await h.get('state',team.sam)).actor.email,manager=(await h.get('state',team.priya)).actor.email,finance=(await h.get('state',team.morgan)).actor.email;
 const ca=await h.post(settings,{name:'Harbour Finch Canada',currency:'CAD',timezone:'America/Toronto',receiptThreshold:'20.00'});
 for(const email of [employee,manager,finance])await h.post(`${settings}/${ca.id}/members`,{email,active:true});
 const category=await h.post(`${settings}/${ca.id}/categories`,{name:'Meals',accountCode:'CA-6300',taxCode:'HST',limit:'60.00'});
 const workflow=await h.post(`${settings}/${ca.id}/workflow`,{version:0,rules:[{label:'Canadian finance review',condition:{kind:'always'},stages:[[{kind:'finance',email:finance}]]}]});
 await h.post(`${settings}/${ca.id}/policy`,{rules:[{kind:'blocked-merchant',merchant:'Restricted shop',hard:true}]});
 const make=async(entityId,title,amount,categoryId,original)=>{
  let claim=await h.post('claims',{title,entityId},team.sam);
  claim=await h.post(`claims/${claim.id}/items`,{version:claim.version,kind:'receipt',date:'2026-10-02',merchant:title,amount,category:categoryId,description:'Client meeting',explanation:'Approved client visit'},team.sam);
  if(original)claim=(await h.post(`claims/${claim.id}/receipts`,{version:claim.version,item:(await h.get(`claims/${claim.id}`,team.sam)).items[0].id,...await receipt(original)},team.sam)).claim;
  return claim;
 };
 const us=await h.get('state'),primary=us.entities.find(e=>e.id==='primary');
 let usClaim=await make('primary','US client visit','100.01',team.c.meals,'bistro');
 let caClaim=await make(ca.id,'Canadian client visit','100.02',category.id,'officeworks');
 const draft=await make(ca.id,'Private Canadian draft','543.21',category.id);
 usClaim=await h.post(`claims/${usClaim.id}/submit`,{version:usClaim.version},team.sam);
 caClaim=await h.post(`claims/${caClaim.id}/submit`,{version:caClaim.version},team.sam);
 const usSubmitted=await h.get(`claims/${usClaim.id}`,team.sam),caSubmitted=await h.get(`claims/${caClaim.id}`,team.sam);
 usClaim=await h.post(`claims/${usClaim.id}/decision`,{version:usClaim.version,revision:usClaim.revision,decision:'approved',acknowledge:true},team.priya);
 caClaim=await h.post(`claims/${caClaim.id}/decision`,{version:caClaim.version,revision:caClaim.revision,decision:'approved',acknowledge:true},team.priya);
 assert.equal(caClaim.status,'submitted');assert.equal(caClaim.approver_email,finance);
 caClaim=await h.post(`claims/${caClaim.id}/decision`,{version:caClaim.version,revision:caClaim.revision,decision:'approved',acknowledge:true},team.morgan);
 const report=await h.post(['spend','consolidated'].join('/'),{from:'2026-10-01',to:'2026-10-31',currency:'USD'},team.morgan);
 const batches=[];
 for(const claim of [usClaim,caClaim])batches.push(await h.post('batches',{claims:[claim.id]},team.morgan));
 return {team,us:primary,ca,category,workflow,employee,manager,finance,claims:[usClaim,caClaim],submitted:[usSubmitted,caSubmitted],draft,report,batches,make};
}
