// Run outside push Verify on the exact committed candidate through heavy-slot.
import { execFileSync } from 'node:child_process'
import { cleanSignalMeasurement } from './receipt-signals-clean.mjs'
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
const result=await cleanSignalMeasurement()
console.log(JSON.stringify({runId:process.env.COASTER_SCALE_RUN_ID??'sx-coaster-c34-policy-002-acceptance',head,...result}))
