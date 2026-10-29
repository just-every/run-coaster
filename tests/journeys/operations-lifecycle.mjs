// Compose independent original assertion phases into the surviving business journey.
import { preserveClaimOperations } from './operations-claims.mjs'
import { preserveApprovalOperations } from './operations-approvals.mjs'
import { preserveExpenseQuestions } from './operations-questions.mjs'
import { preserveDelegateOperations } from './operations-delegates.mjs'

export async function preserveOperationsLifecycle() {
  await preserveClaimOperations()
  await preserveApprovalOperations()
  await preserveExpenseQuestions()
  await preserveDelegateOperations()
}
