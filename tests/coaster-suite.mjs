// Business journeys through the public HTTP/transport doors, one installed
// Worker per journey and one cached bundle per process. UI/CLI proof is browser.mjs.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
const files=readdirSync('tests').filter(name=>/^coaster.*\.test\.mjs$/.test(name)&&!(process.env.COASTER_ADMIN_EXTERNAL==='1'&&name==='coaster-admin.test.mjs')).sort().map(name=>`tests/${name}`)
// Keep the local wall complete; CI partitions the same files across bounded jobs.
const shard=process.env.COASTER_FLOW_SHARD
const run=spawnSync(process.execPath,['--test','--test-concurrency=1',...(shard?[`--test-shard=${shard}`]:[]),...files],{stdio:'inherit'})
process.exit(run.status??1)
