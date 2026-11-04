import { receiveEmail } from '../src/coaster/receipts/mail-intake'
import { agentDoorResponse } from '../src/coaster/agent-door'
import { api } from '../src/coaster/api'
import { authResponse } from '../src/auth.server'
import { runHourly } from '../src/coaster/hourly'
import { databaseAtEdge } from './d1-edge'

// The production API and native auth handlers, without Start's document renderer.
let logSequence = 0
export default {
  async fetch(request: Request, original: any, ctx: ExecutionContext) { const env = { ...original, DB: databaseAtEdge(original) };
    if (new URL(request.url).pathname === '/__test/log-observer' && request.method === 'POST') {
      const sequence = ++logSequence
      for (const level of ['debug', 'info', 'log', 'warn', 'error'] as const) console[level](`synthetic-coaster-log-${sequence}-${level}`)
      return Response.json({ sequence })
    }
    if(new URL(request.url).pathname==='/__test/email'&&request.method==='POST') {
      const b=await request.json() as {from:string;to:string;base64:string},raw=Uint8Array.from(atob(b.base64),c=>c.charCodeAt(0));let rejected='';
      await receiveEmail({from:b.from,to:b.to,rawSize:raw.length,raw:new Blob([raw]).stream(),headers:new Headers(),setReject:reason=>{rejected=reason;}} as ForwardableEmailMessage,env);
      return Response.json({rejected});
    }
    return await agentDoorResponse(request, env) ?? await authResponse(request, env) ?? api.fetch(request, env, ctx) },
  async scheduled(controller: ScheduledController, env: any) { await runHourly(env, new Date(controller.scheduledTime)) },
}
