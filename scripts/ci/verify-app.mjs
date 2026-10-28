// `rer verify` owns the full local wall. Push Verify separates the journeys
// after this same build/light tier so all consumers use one emitted Worker.
import { spawnSync } from 'node:child_process'
const run=(command,args)=>{
  const result=spawnSync(command,args,{stdio:'inherit',env:process.env})
  if(result.error)throw result.error
  if(result.status!==0)process.exit(result.status??1)
}
run('pnpm',['exec','rer','build'])
run('pnpm',['exec','rer','build','--site'])
for(const name of ['typecheck','test:site'])run('pnpm',['run',name])
if(process.env.COASTER_JOURNEYS_EXTERNAL==='1'){
  // Move the permission journey off the longer HTTP shard; every CI journey
  // still runs once, and the build/light job remains the shortest tier.
  run(process.execPath,['--test','tests/coaster-admin.test.mjs'])
}else{
  run('pnpm',['run','test:coaster'])
  run('pnpm',['run','test:browser'])
}
