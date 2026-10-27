import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { groups } from './browser-groups.mjs'

const group = process.env.CI_GROUP
if (!Object.hasOwn(groups, group)) throw new Error(`Unknown browser group: ${group}`)
if (!process.env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is required for browser evidence')

for (const suite of groups[group]) {
  for (const args of suite.commands) {
    console.log(`::group::node ${args.join(' ')}`)
    const result = spawnSync(process.execPath, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...suite.env,
        COASTER_EVIDENCE: join(process.env.RUNNER_TEMP, 'coaster-proof', suite.evidence),
      },
    })
    console.log('::endgroup::')
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}
