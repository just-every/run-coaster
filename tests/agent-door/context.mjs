import assert from 'node:assert/strict'

export const contextFacts = [
  { class: 'standard', facts: { measure: 1 } },
  { class: 'sensitive', facts: { measure: 1, kind: 'private-expense' } },
]
export const contextParams = (args = {}) => ({ name: 'coaster.workspace.get', arguments: args })
export function contextDecision(answer, disposition) {
  const result = answer.result
  assert.equal(answer.status, 200)
  const decision = result?._meta?.['com.runeditrun/decision']
  assert.ok(decision, JSON.stringify(answer))
  assert.deepEqual(decision.classes.map(({ class: cls, facts }) => ({ class: cls, facts })), contextFacts)
  if (disposition) assert.equal(decision.disposition, disposition)
  return decision
}
export function contextRefusal(answer, code) {
  if (code === 'approval_required' && answer.result?.resultType === 'input_required') {
    assert.ok(answer.result._meta['com.runeditrun/approval'])
  } else assert.equal(answer.result?._meta?.['com.runeditrun/error']?.code, code, JSON.stringify(answer))
  assert.equal(answer.result.structuredContent, undefined, 'private context is withheld')
  return answer.result
}
export const unansweredSensitive = () => ({ schema: 'rer-agent-policy/1', catalogue: 'rer-agent-classes/1', rules: [{ id: 'standard', class: 'standard', do: 'autonomous' }, { id: 'external', class: 'external', do: 'autonomous' }], spend: { none: true } })
export const blockedSensitive = () => ({ schema: 'rer-agent-policy/1', catalogue: 'rer-agent-classes/1', rules: [{ id: 'all', class: '*', do: 'autonomous' }, { id: 'sensitive', class: 'sensitive', do: 'blocked' }], spend: { none: true } })
