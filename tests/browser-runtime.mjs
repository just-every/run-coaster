// The browser runs the one emitted production Worker. Only the external mail
// transport is replaced; sign-in uses its ordinary invitation and email links.
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { mkdtemp, cp, readFile, mkdir, readdir, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { productionPlan } from '@runeditrun/rer/internal/onboarding/production-options.mjs'

const source=resolve(new URL('..',import.meta.url).pathname)
const excluded=new Set(['.git','node_modules','.wrangler','.rer','.seed','.cache','.tanstack','exports','test-results'])
const servers=new Map()
export async function fresh(){
  const root=await mkdtemp(join(tmpdir(),'coaster-installation-'))
  for(const name of await readdir(source)){
    if(excluded.has(name)||name.startsWith('.dev.vars')||name.startsWith('.env')||name.endsWith('.tsbuildinfo'))continue
    await cp(join(source,name),join(root,name),{recursive:true})
  }
  await symlink(join(source,'node_modules'),join(root,'node_modules'),'dir')
  return root
}
export async function freePort(){const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const {port}=socket.address();await new Promise(r=>socket.close(r));return port}
const clean=s=>s.replace(/^RER_OPEN .*$/gm,'RER_OPEN [private sign-in URL omitted]').replace(/([?&]token=)[^\s&]+/g,'$1[redacted]')
export async function command(root,args,{expected=0,env={}}={}){
  const cli=import.meta.resolve('@runeditrun/rer/internal/global/rer.mjs')
  let result
  try{result=await promisify(execFile)(process.execPath,[new URL(cli).pathname,...args],{cwd:root,env:{...process.env,...env,WRANGLER_SEND_METRICS:'false',RER_SERVER_JOURNEY:'1'},maxBuffer:16*1024*1024})}
  catch(error){if(error.code!==expected)throw new Error(`rer ${args[0]} exited ${error.code}: ${clean(error.stdout+error.stderr).slice(-6000)}`);result=error}
  if(expected!==0&&!(result instanceof Error))throw new Error(`rer ${args[0]} unexpectedly succeeded`)
  console.log(`rer ${args[0]}: exit ${expected}`)
  return clean(result.stdout+result.stderr)
}
export async function start(root,port){
  const origin=`http://127.0.0.1:${port}`,messages=[]
  const plan=await productionPlan(root,origin,port)
  plan.workers[0].bindings={...plan.workers[0].bindings,MAIL_PROVIDER:'resend',MAIL_API_KEY:'synthetic-browser-mail',MAIL_FROM:'Coaster <coaster@harbourfinch.example>'}
  plan.workers[0].outboundService=async request=>{
    assertMail(request)
    messages.push(await request.json())
    return Response.json({id:crypto.randomUUID()})
  }
  const runtime=new Miniflare({...convertV4MiniflareOptions(plan),resourcePersistencePath:join(root,'.wrangler/state/v3')})
  try{await runtime.ready}catch(error){await runtime.dispose();throw error}
  const server={origin,messages,async close(){servers.delete(origin);await runtime.dispose()}}
  servers.set(origin,server)
  return server
}
function assertMail(request){if(request.url!=='https://api.resend.com/emails'||request.method!=='POST')throw new Error('Unexpected browser-journey egress')}
export async function signIn(context,origin,email){
  const response=await context.request.post(origin+'/auth/magic-link',{headers:{origin},data:{email}})
  if(response.status()!==202)throw new Error('Native email-link request refused')
  const message=servers.get(origin).messages.findLast(m=>m.to.includes(email))
  if(!message)throw new Error('Native sign-in mail missing for synthetic member')
  const link=message.text.match(/http:\/\/[^\s]+\/auth\/confirm\?token=[^\s]+/)[0]
  const confirmed=await context.request.post(origin+'/auth/confirm',{headers:{origin},data:{token:new URL(link).searchParams.get('token')},maxRedirects:0})
  if(confirmed.status()!==303)throw new Error('Native email-link confirmation refused')
  const session=await (await context.request.get(origin+'/auth/session')).json()
  if(session.operator?.email!==email)throw new Error('Native session has the wrong identity')
}
export async function report(path,value){await mkdir(path,{recursive:true});await (await import('node:fs/promises')).writeFile(join(path,'result.json'),JSON.stringify(value,null,2)+'\n')}
