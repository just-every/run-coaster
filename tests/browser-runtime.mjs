// The browser runs the one emitted production Worker. Only external mail, bank
// and AI transports are fixtures; sign-in uses ordinary invitations and email links.
import { promisify } from 'node:util'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, cp, readFile, mkdir, readdir, stat, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { Miniflare, compileModuleRules, convertV4MiniflareOptions, testRegExps } from 'miniflare'
import { readSettings } from '@runeditrun/rer/adapter-settings'
import rerPackage from '@runeditrun/rer/package.json' with { type: 'json' }
import { productionModules } from '@runeditrun/rer/production-modules'
import { bankFixture } from './fixtures/bank.mjs'

const source=resolve(new URL('..',import.meta.url).pathname)
// The source checkout supplies the pinned command even before a fresh clone installs it.
const cli=fileURLToPath(new URL(rerPackage.bin.rer,import.meta.resolve('@runeditrun/rer/package.json')))
const excluded=new Set(['.git','node_modules','.wrangler','.rer','.seed','.cache','.tanstack','exports','test-results'])
const servers=new Map()
export async function fresh({clone=false}={}){
  const root=await mkdtemp(join(tmpdir(),'coaster-installation-'))
  if(clone){
    await promisify(execFile)('git',['clone','--no-hardlinks','--quiet',source,root])
    await cp(join(source,'dist'),join(root,'dist'),{recursive:true})
    return root
  }
  for(const name of await readdir(source)){
    if(excluded.has(name)||name.startsWith('.dev.vars')||name.startsWith('.env')||name.endsWith('.tsbuildinfo'))continue
    await cp(join(source,name),join(root,name),{recursive:true})
  }
  // Share immutable installed packages, while each installation's Vite
  // optimizer and temporary configuration files stay in its own directory.
  await mkdir(join(root,'node_modules'))
  for(const name of await readdir(join(source,'node_modules'))){
    if(['.vite','.vite-temp','.cache'].includes(name))continue
    const target=join(source,'node_modules',name)
    await symlink(target,join(root,'node_modules',name),(await stat(target)).isDirectory()?'dir':'file')
  }
  return root
}
export async function freePort(){const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const {port}=socket.address();await new Promise(r=>socket.close(r));return port}
const clean=s=>s.replace(/^RER_OPEN .*$/gm,'RER_OPEN [private sign-in URL omitted]').replace(/([?&]token=)[^\s&]+/g,'$1[redacted]')
export async function command(root,args,{expected=0,env={}}={}){
  let result
  try{result=await promisify(execFile)(process.execPath,[cli,...args],{cwd:root,env:{...process.env,...env,WRANGLER_SEND_METRICS:'false',RER_SERVER_JOURNEY:'1'},maxBuffer:16*1024*1024})}
  catch(error){if(error.code!==expected)throw new Error(`rer ${args[0]} exited ${error.code}: ${clean(error.stdout+error.stderr).slice(-6000)}`);result=error}
  if(expected!==0&&!(result instanceof Error))throw new Error(`rer ${args[0]} unexpectedly succeeded`)
  console.log(`rer ${args[0]}: exit ${expected}`)
  return clean(result.stdout+result.stderr)
}

async function builtWorker(root, origin) {
  const { unstable_readConfig, unstable_getMiniflareWorkerOptions } = await import('wrangler')
  const config = unstable_readConfig({ config: join(root, 'dist/server/wrangler.json') })
  const { workerOptions: { modulesRules, ...options }, main, externalWorkers } = unstable_getMiniflareWorkerOptions(config)
  const { values } = await readSettings(root, { file: '.dev.vars' })
  const modules = await productionModules(main, modulesRules, { compileModuleRules, testRegExps })
  const worker = {
    ...options,
    name: config.name,
    ...modules,
    bindings: {
      ...options.bindings,
      ...values,
      [process.env.RER_ORIGIN_KEY ?? 'AUTH_ORIGIN']: origin,
      RER_DEV_ORIGIN: origin,
      ...(process.env.RER_DEV_KEY ? { RER_DEV_KEY: process.env.RER_DEV_KEY } : {}),
    },
  }
  return { worker, externalWorkers }
}

async function previewSite(root) {
  const { preview } = await import('vite')
  return preview({
    root,
    configFile: false,
    envFile: false,
    // Serve extensionless document routes from their emitted .html files.
    appType: 'mpa',
    build: { outDir: 'dist/site' },
    preview: { host: '127.0.0.1', port: 0 },
  })
}

export async function start(root,port,{readingEdge,site=false,clock}={}){
  const origin=`http://127.0.0.1:${port}`,messages=[]
  const {worker,externalWorkers}=await builtWorker(root,origin),bank=bankFixture(),label=JSON.parse(await readFile('tests/fixtures/receipts/reader/synthetic-coaster-1001.json','utf8'))
  if(clock!==undefined) {
    const entry=worker.modules[0];
    entry.contents=`const NativeDate=globalThis.Date; globalThis.Date=class extends NativeDate { constructor(...args) { if(args.length)super(...args); else super(${clock}); } static now() { return ${clock}; } };\n`+await readFile(entry.path,'utf8');
  }
  worker.bindings={...worker.bindings,MAIL_PROVIDER:'resend',MAIL_API_KEY:'synthetic-browser-mail',MAIL_FROM:'Coaster <coaster@harbourfinch.example>',AI_ENABLED:'true',AI_API_KEY:'synthetic-archive-reader'}
  worker.outboundService=async request=>{
    if(readingEdge && (request.url.startsWith(readingEdge.url + '/') || new URL(request.url).hostname==='api.openai.com')){
      const path=new URL(request.url).pathname.replace(/^\/v1/,'')
      // The forwarded body is serialized again; let Node calculate its Content-Length.
      const headers=new Headers(request.headers);headers.delete('content-length')
      return fetch(readingEdge.url+path,{method:request.method,headers:Object.fromEntries(headers),body:await request.arrayBuffer()})
    }
    if(new URL(request.url).hostname==='sandbox.plaid.com')return bank.fetch(request)
    if(new URL(request.url).hostname==='api.openai.com'){
      if(new URL(request.url).pathname!=='/v1/responses'||request.method!=='POST'||(await request.json()).store!==false)throw new Error('Receipt reading must use the declared no-store provider door')
      const regions=[{page:1,x:.1,y:.1,width:.5,height:.1}],fields=Object.fromEntries(Object.entries(label.values).map(([name,value])=>[name,{value:name==='lineItems'?value.map(item=>({...item,description:`${item.description} × ${item.quantity}`,confidence:.99,regions})):value,confidence:.99,regions}]))
      return Response.json({status:'completed',model:'synthetic-archive-reader',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(fields)}]}],usage:{input_tokens:100,output_tokens:100,total_tokens:200}})
    }
    assertMail(request)
    messages.push(await request.json())
    return Response.json({id:crypto.randomUUID()})
  }
  const options=convertV4MiniflareOptions({
    host:'127.0.0.1',port,workers:[worker,...externalWorkers],
    unsafeTriggerHandlers:process.env.RER_RUNTIME_TRIGGERS==='1',unsafeLocalExplorer:false,
  })
  const runtime=new Miniflare({...options,resourcePersistencePath:join(root,'.wrangler/state/v3')})
  let runSite,siteOrigin
  try {
    await runtime.ready
    if(site){
      runSite=await previewSite(root)
      siteOrigin=`http://127.0.0.1:${runSite.httpServer.address().port}`
    }
  } catch(error){await runtime.dispose();throw error}
  const server={origin,messages,sessions:new Map(),siteOrigin,providers:{bank,label},async scheduled(time=Date.now()){
    const target=await runtime.getWorker(worker.name)
    await target.scheduled({scheduledTime:new Date(time),cron:'17 * * * *'})
    return Response.json({ok:true})
  },async close(){
    servers.delete(origin)
    try {await runSite?.close()} finally {await runtime.dispose()}
  }}
  servers.set(origin,server)
  return server
}
/** Exercise the installed CLI's own dev/preview readiness and shutdown doors. */
export async function startCli(root,port,mode='dev'){
  const child=spawn(process.execPath,[cli,mode,'--port',String(port),'--foreground'],{cwd:root,env:{...process.env,WRANGLER_SEND_METRICS:'false',RER_SERVER_JOURNEY:'1'},stdio:['ignore','pipe','pipe']})
  let output=''
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk})
  const close=async()=>{if(child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited}}
  try{
    const deadline=Date.now()+20*60*1000
    while(!output.includes('RER_READY')&&Date.now()<deadline){
      if(child.exitCode!==null)throw new Error(`${mode} exited: ${clean(output).slice(-4000)}`)
      await new Promise(resolve=>setTimeout(resolve,250))
    }
    if(!output.includes('RER_READY'))throw new Error(`${mode} readiness timed out`)
    return {origin:`http://127.0.0.1:${port}`,get siteOrigin(){
      const site=output.replace(/\x1b\[[0-9;]*m/g,'').match(/RER_SITE (https?:\/\/[^\s]+)/)
      if(!site)throw new Error('The native CLI did not publish its run site')
      return new URL(site[1]).origin
    },close}
  }catch(error){await close();throw error}
}
function assertMail(request){if(request.url!=='https://api.resend.com/emails'||request.method!=='POST')throw new Error('Unexpected browser-journey egress')}
export async function signIn(context,origin,email,{invitation=false}={}){
  const server=servers.get(origin),saved=server.sessions.get(email)
  if(saved){
    await context.addCookies(saved)
    const current=await (await context.request.get(origin+'/auth/session')).json()
    if(current.operator?.email!==email)throw new Error('The reused native session has the wrong identity')
    return
  }
  const before=server.messages.length
  if(!invitation){
    const response=await context.request.post(origin+'/auth/magic-link',{headers:{origin},data:{email}})
    if(response.status()!==202)throw new Error('Native email-link request refused')
  }
  const messages=invitation?server.messages:server.messages.slice(before)
  const message=messages.findLast(m=>m.to.includes(email)&&/\/auth\/confirm\?token=/.test(m.text))
  if(!message)throw new Error('Native sign-in mail missing for synthetic member')
  const link=message.text.match(/http:\/\/[^\s]+\/auth\/confirm\?token=[^\s]+/)[0]
  const confirmed=await context.request.post(origin+'/auth/confirm',{headers:{origin},data:{token:new URL(link).searchParams.get('token')},maxRedirects:0})
  if(confirmed.status()!==303)throw new Error('Native email-link confirmation refused')
  const session=await (await context.request.get(origin+'/auth/session')).json()
  if(session.operator?.email!==email)throw new Error('Native session has the wrong identity')
  server.sessions.set(email,await context.cookies(origin))
}
export async function report(path,value){await mkdir(path,{recursive:true});await (await import('node:fs/promises')).writeFile(join(path,'result.json'),JSON.stringify(value,null,2)+'\n')}
