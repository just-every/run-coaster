// Business journeys through the public HTTP/transport doors, one installed
// Worker per journey and one cached bundle per process. UI/CLI proof is browser.mjs.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
const files=readdirSync('tests').filter(name=>/^coaster.*\.test\.mjs$/.test(name)&&!(process.env.COASTER_ADMIN_EXTERNAL==='1'&&name==='coaster-admin.test.mjs')).sort().map(name=>`tests/${name}`)
// Keep the large receipt-signal corpus and the claim/finance journeys in
// separate required CI jobs. A local run without a shard still runs every file.
const shard=process.env.COASTER_FLOW_SHARD
if(shard&&!['core','signals','rest'].includes(shard))throw Error('Unknown Coaster flow shard')
const core='tests/coaster.test.mjs',signals='tests/coaster-receipt-signals.test.mjs'
const selected=!shard?files:files.filter(file=>shard==='core'?file===core:shard==='signals'?file===signals:file!==core&&file!==signals)
if(!selected.length)throw Error('Coaster flow shard has no test files')
const run=spawnSync(process.execPath,['--test','--test-concurrency=1',...selected],{stdio:'inherit'})
process.exit(run.status??1)
