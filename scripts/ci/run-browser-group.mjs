import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { groups } from './browser-groups.mjs'

const group = process.env.CI_GROUP
if (!Object.hasOwn(groups, group)) throw new Error(`Unknown browser group: ${group}`)
if (!process.env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is required for browser evidence')

let next = 0
const failures = []
async function worker() {
  while (next < groups[group].length) {
    const suite = groups[group][next++]
    for (const args of suite.commands) {
      const started = performance.now()
      console.log(`START ${suite.evidence}: node ${args.join(' ')}`)
      const child = spawn(process.execPath, args, {
        stdio: 'inherit',
        env: { ...process.env, ...suite.env, COASTER_EVIDENCE: join(process.env.RUNNER_TEMP, 'coaster-proof', suite.evidence) },
      })
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
      console.log(`END ${suite.evidence}: exit=${code} seconds=${Math.round((performance.now() - started) / 1000)}`)
      if (code !== 0) { failures.push(`${suite.evidence}: node ${args.join(' ')} exited ${code}`); break }
    }
  }
}
// Two independent suites, never simultaneous commands within one suite. Wait
// for both workers even on failure so each journey closes its owned processes.
const results = await Promise.allSettled([worker(), worker()])
for (const result of results) if (result.status === 'rejected') failures.push(result.reason.stack)
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
