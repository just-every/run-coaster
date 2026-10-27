// The HTTP flow suite (tests/coaster*.test.mjs), one file at a time. Push Verify splits it across the app job and the
// coaster_flows job with COASTER_SHARD=1/2 and 2/2 (node --test-shard); without it every file runs, as `rer verify` does.
// This discovery also registers tests/coaster-bulk-approvals.test.mjs.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

const files = readdirSync('tests').filter(name => /^coaster.*\.test\.mjs$/.test(name)).sort().map(name => `tests/${name}`)
const shard = process.env.COASTER_SHARD ? [`--test-shard=${process.env.COASTER_SHARD}`] : []
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...shard, ...files], { stdio: 'inherit' })
process.exit(run.status ?? 1)
