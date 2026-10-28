// The browser runs the one emitted production Worker. Only external mail, bank
// and AI transports are fixtures; sign-in uses ordinary invitations and email links.
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { mkdtemp, cp, readFile, mkdir, readdir, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { productionPlan } from '@runeditrun/rer/internal/onboarding/production-options.mjs'
import { bankFixture } from './fixtures/bank.mjs'

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
  const plan=await productionPlan(root,origin,port),bank=bankFixture(),label=JSON.parse(await readFile('tests/fixtures/receipts/reader/synthetic-coaster-1001.json','utf8'))
  plan.workers[0].bindings={...plan.workers[0].bindings,MAIL_PROVIDER:'resend',MAIL_API_KEY:'synthetic-browser-mail',MAIL_FROM:'Coaster <coaster@harbourfinch.example>',AI_ENABLED:'true',AI_API_KEY:'synthetic-archive-reader'}
  plan.workers[0].outboundService=async request=>{
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
  const runtime=new Miniflare({...convertV4MiniflareOptions(plan),resourcePersistencePath:join(root,'.wrangler/state/v3')})
  try{await runtime.ready}catch(error){await runtime.dispose();throw error}
  const server={origin,messages,providers:{bank,label},async close(){servers.delete(origin);await runtime.dispose()}}
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
