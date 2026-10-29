// Compose independent original assertion phases into the surviving business journey.
import { preserveMigrationHistory } from './operations-migration-history.mjs'
import { preserveImportConfiguration } from './operations-import-configuration.mjs'
import { preserveImportedChains } from './operations-import-chains.mjs'
import { preserveFinancialErasure } from './operations-erasure.mjs'

export async function preserveOperationsCustody() {
  await preserveMigrationHistory()
  await preserveImportConfiguration()
  await preserveImportedChains()
  await preserveFinancialErasure()
}
