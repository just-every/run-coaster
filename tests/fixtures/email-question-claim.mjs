import {receipt} from '../harness.mjs';
/** Native public doors build the pending expense used by mail answer journeys. */
export async function pendingEmailQuestionClaim(h,t,title) {
 let claim=await h.post('claims',{title},t.sam);
 const uploaded=await h.post(`claims/${claim.id}/receipts`,{version:claim.version,...await receipt('bistro')},t.sam);claim=uploaded.claim;
 claim=await h.post(`claims/${claim.id}/items`,{version:claim.version,kind:'receipt',date:'2026-05-21',merchant:'Rockpool',amount:'96.00',allocations:[{category:t.c.meals}],receipt:uploaded.receipt},t.sam);
 return h.post(`claims/${claim.id}/submit`,{version:claim.version},t.sam);
}
