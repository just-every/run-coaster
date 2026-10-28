import { fileURLToPath as __rerTestEntryPath } from 'node:url';
const __rerTestEntry = __rerTestEntryPath(import.meta.resolve('@runeditrun/rer/internal/global/rer.mjs'));
const __rerTestEntryArgs = args => ['dev', 'preview'].includes(args[1]) && !args.some(arg => ['--foreground', '--detach', '--stop', '--help'].includes(arg)) ? [...args, '--foreground'] : args;
import {promisify} from 'node:util'
import {spawn,execFile} from 'node:child_process'
import {mkdtemp,cp,readFile,writeFile,mkdir,readdir,rm,symlink} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createServer} from 'node:net'
const source=resolve(new URL('..',import.meta.url).pathname)
const excluded=new Set(['.git','node_modules','.wrangler','.rer','.seed','.cache','.tanstack','dist','.output','exports','test-results'])
export async function fresh({sourceCopy=false}={}){const root=await mkdtemp(join(tmpdir(),'coaster-installation-'));let committed=false;try{await promisify(execFile)('git',['rev-parse','--verify','HEAD'],{cwd:source});committed=true}catch{}if(committed&&!sourceCopy){await promisify(execFile)('git',['clone','--no-hardlinks','--quiet',source,root]);return root;}for(const name of await readdir(source)){if(excluded.has(name)||name.startsWith('.dev.vars')||name.startsWith('.env')||name.endsWith('.tsbuildinfo'))continue;await cp(join(source,name),join(root,name),{recursive:true})}return root}
export async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
const clean=s=>s.replace(/^RER_OPEN .*$/gm,'RER_OPEN [private sign-in URL omitted]').replace(/([?&]token=)[^\s&]+/g,'$1[redacted]')
export async function command(root,args,{expected=0,env={}}={}){const child=spawn(process.execPath,__rerTestEntryArgs([__rerTestEntry,...args]),{cwd:root,env:{...process.env,...env,WRANGLER_SEND_METRICS:'false',RER_SERVER_JOURNEY:'1'},stdio:['ignore','pipe','pipe']});let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',c=>{log+=c});const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});if(code!==expected)throw new Error(`rer ${args[0]} exited ${code}:\n${clean(log).slice(-6000)}`);console.log(`rer ${args.join(' ')}: exit ${code}`);return clean(log)}
export async function start(root,port,mode='dev'){const child=spawn(process.execPath,__rerTestEntryArgs([__rerTestEntry,mode,'--port',String(port)]),{cwd:root,env:{...process.env,WRANGLER_SEND_METRICS:'false',RER_SERVER_JOURNEY:'1'},stdio:['ignore','pipe','pipe']});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',c=>{output+=c});const deadline=Date.now()+20*60*1000;while(!output.includes('RER_READY')&&Date.now()<deadline){if(child.exitCode!==null)throw new Error(`${mode} exited: ${clean(output).slice(-4000)}`);await new Promise(r=>setTimeout(r,250))}if(!output.includes('RER_READY')){if(child.exitCode===null)child.kill('SIGTERM');throw new Error(mode+' admission/readiness timed out')}return {origin:`http://127.0.0.1:${port}`,get siteOrigin(){const site=output.replace(/\x1b\[[0-9;]*m/g,'').match(/RER_SITE (https?:\/\/[^\s]+)/);if(!site)throw Error('The owned runtime did not publish its run-site address');return new URL(site[1]).origin},async scheduled(){const plain=output.replace(/\x1b\[[0-9;]*m/g,'');const runtimes=[...plain.matchAll(/Local:\s+(http:\/\/(?:127\.0\.0\.1|localhost):[0-9]+)\//g)];const runtime=runtimes.find(match=>new URL(match[1]).port!==String(port));if(!runtime)throw Error('The owned runtime did not publish its local scheduler address');return fetch(runtime[1]+'/cdn-cgi/local/scheduled?cron='+encodeURIComponent('17 * * * *'));},async close(){if(child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exited}}}}
export async function report(path,value){await mkdir(path,{recursive:true});await writeFile(join(path,'result.json'),JSON.stringify(value,null,2)+'\n')}

/** Run independent archive refusals against isolated copies of an idle synthetic
 * installation. Each worker keeps its own D1/R2 and CLI operation lock; the
 * caller's real import/export assertions still run for every case. No browser
 * profile or live server state is copied. Local runs remain sequential. */
export async function refusalCases(root, cases, run, after = async () => {}) {
  const workers = Number(process.env.COASTER_REFUSAL_WORKERS ?? 1)
  if (![1, 2, 3].includes(workers)) throw new Error('COASTER_REFUSAL_WORKERS must be 1, 2 or 3')
  if (workers === 1 || cases.length === 0) {
    for (const entry of cases) await run(root, entry)
    await after(root)
    return
  }
  const copies = []
  try {
    for (let i = 0; i < Math.min(workers, cases.length); i++) {
      const copy = await mkdtemp(join(tmpdir(), 'coaster-refusals-'))
      copies.push(copy)
      // Only source and the closed synthetic data store: no .rer/.seed runtime
      // registry, session/profile, command logs, exports or build output.
      for (const name of await readdir(root)) {
        if (excluded.has(name) || name.startsWith('.env') || name.startsWith('.dev.vars') || name.endsWith('.tsbuildinfo')) continue
        await cp(join(root, name), join(copy, name), { recursive: true })
      }
      await cp(join(root, '.wrangler/state'), join(copy, '.wrangler/state'), { recursive: true })
      await symlink(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir')
      await mkdir(join(copy, 'exports'), { recursive: true })
    }
    // Await all workers, including after a refusal assertion fails, before
    // deleting their state. Never abandon a running CLI child.
    const results = await Promise.allSettled(copies.map(async (copy, index) => {
      for (let i = index; i < cases.length; i += copies.length) await run(copy, cases[i])
      await after(copy)
    }))
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Archive refusal worker failed')
  } finally {
    for (const copy of copies) await rm(copy, { recursive: true, force: true })
  }
}
