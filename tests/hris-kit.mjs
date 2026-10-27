import {gustoFixture} from './fixtures/payroll.mjs';
export const hrisAddress = id => ['synthetic-coaster-'+id,'example.invalid'].join(String.fromCharCode(64));
export const hrisRoot=['hris','gusto'].join('/');
export const hrisFixture=()=>{
  const edge=gustoFixture();
  edge.employees=[{uuid:'synthetic-coaster-801',email:hrisAddress('801'),first_name:'Riley',last_name:'Manager',terminated:false},{uuid:'synthetic-coaster-802',email:hrisAddress('802'),first_name:'Alex',last_name:'Hire',roles:['owner','admin','finance','manager'],may_release:true,manager_uuid:'synthetic-coaster-801',terminated:false}];
  return edge;
};
export async function setupHris(h,edge){
  await h.post(['settings', 'business'].join('/'),{name:'Harbour and Finch',currency:'USD',timezone:'UTC'});
  const manager=await h.person(edge.employees[0].email,{employee:true,manager:true});
  await h.post(hrisRoot+'/connect',{company:edge.company,token:'synthetic-coaster-810',consent:true});
  await applyHris(h,edge.employees[0]);
  return {manager};
}
export async function applyHris(h,p,extra={},cookie=h.owner,status=200){
  const review=await h.get(hrisRoot+'/preview',cookie);
  return h.post(hrisRoot+'/sync',{employee:p.uuid,email:p.email,fingerprint:review.fingerprint,consent:true,...extra},cookie,status);
}
