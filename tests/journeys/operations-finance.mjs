// Compose independent original assertion phases into the surviving business journey.
import { preserveFinanceAnalysis } from './operations-finance-analysis.mjs'
import { preserveReporting } from './operations-reporting.mjs'
import { preserveAuditOperations } from './operations-audit.mjs'

export async function preserveOperationsFinance() {
  await preserveFinanceAnalysis()
  await preserveReporting()
  await preserveAuditOperations()
}
