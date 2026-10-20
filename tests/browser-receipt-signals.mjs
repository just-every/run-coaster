// POLICY-002: a person sees the signal's exact evidence and finance records a review.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { api } from './browser-journey.mjs'

export async function inspectReceiptSignals(person,origin,claimId,width,evidence,shots,phase='submitted',resolve=false){
 const {page,context}=person,before=await api(context,origin,`claims/${claimId}`),frozen=before.revisions.at(-1).snapshot.receiptSignals
 const section=page.getByRole('region',{name:'Receipt metadata signals',exact:true})
 await section.getByText('possible, needs review',{exact:true}).waitFor()
 for(const summary of await section.getByText('Metadata evidence',{exact:true}).all())if(!await summary.evaluate(el=>el.parentElement.open))await summary.click()
 const text=await section.innerText()
 for(const receipt of frozen){
  assert.ok(text.includes(receipt.sha256))
  for(const signal of receipt.signals)assert.ok(text.includes(signal.reason),'POLICY-002 computed signal reason is visible')
 }
 assert.ok(text.includes('no metadata to check'),'POLICY-002 stripped metadata is not a flag')
 if(resolve){
  await section.getByLabel('Review note for editing-software',{exact:true}).fill('Legitimate supplier preparation; finance checked the original.')
  await section.getByRole('button',{name:'Record editing-software review',exact:true}).click()
  await section.getByText(/Reviewed by.*Legitimate supplier preparation/).waitFor()
  const after=await api(context,origin,`claims/${claimId}`)
  assert.equal(after.claim.status,before.claim.status);assert.deepEqual(after.revisions.at(-1).snapshot.receiptSignals,frozen)
 }
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`POLICY-002 no overflow at ${width}`)
 const path=join(evidence,`receipt-signals-${phase}-${width}.jpg`);await section.screenshot({path,type:'jpeg',quality:85});shots.push({screen:`receipt-signals-${phase}`,viewport:width,path})
}
