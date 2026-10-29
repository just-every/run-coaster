// Optional complete composition; individual suite exports allow balanced registration.
import { preservePerDiem } from './specialized-per-diem.mjs'
import { preserveForeignImports } from './specialized-fx-imports.mjs'
import { preservePolicy } from './specialized-policy.mjs'
import { preserveWorkflow } from './specialized-workflow.mjs'
import { preserveWorkflowLifecycle } from './specialized-workflow-lifecycle.mjs'
import { preserveFinanceDelegation } from './specialized-finance-delegation.mjs'
import { preserveAdministration } from './specialized-admin.mjs'
import { preservePolicyAdvice } from './specialized-policy-advice.mjs'
import { preserveSuccessorHandoff } from './specialized-handoff.mjs'

export async function preserveSpecialized() {
  await preservePerDiem()
  await preserveForeignImports()
  await preservePolicy()
  await preserveWorkflow()
  await preserveWorkflowLifecycle()
  await preserveFinanceDelegation()
  await preserveAdministration()
  await preservePolicyAdvice()
  await preserveSuccessorHandoff()
}
