// AGENT-005: read the actual submitted evidence in the approver's claim panel.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { api } from './browser-journey.mjs'

export async function inspectPolicyReview(person, origin, claimId, width, evidence, shots, phase='submitted') {
 const {page,context}=person,detail=await api(context,origin,`claims/${claimId}`)
 const frozen=detail.revisions.at(-1).snapshot.policyReview
 const section=page.getByRole('region',{name:'Policy review',exact:true})
 await section.getByRole('heading',{name:`Policy review · revision ${detail.claim.revision}`,exact:true}).waitFor()
 assert.equal(frozen.recommendations.length,detail.revisions.at(-1).snapshot.items.length)
 assert.match(await section.innerText(),/This advice grants no approval/)
 for(const r of frozen.recommendations){
  for(const reason of r.reasons)assert.ok((await section.innerText()).includes(reason.message),'AGENT-005 actual evaluator reason is visible')
 }
 for(const disclosure of await section.getByText('Review evidence',{exact:true}).all())if(!await disclosure.evaluate(el=>el.parentElement.open))await disclosure.click()
 for(const r of frozen.recommendations)if(r.evidence.receipt)assert.ok((await section.innerText()).includes(r.evidence.receipt.sha256),'AGENT-005 exact receipt citation is visible')
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`AGENT-005 no overflow at ${width}`)
 const path=join(evidence,`policy-review-${phase}-${width}.jpg`);await section.screenshot({path,type:'jpeg',quality:85});shots.push({screen:`policy-review-${phase}`,viewport:width,path})
 return frozen
}
