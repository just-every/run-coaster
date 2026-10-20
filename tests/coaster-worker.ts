import { api } from '../src/coaster/api'
import { authResponse } from '../src/auth.server'
import { runHourly } from '../src/coaster/hourly'
import { databaseAtEdge } from './d1-edge'

// The production API and native auth handlers, without Start's document renderer.
export default {
  async fetch(request: Request, original: any, ctx: ExecutionContext) { const env = { ...original, DB: databaseAtEdge(original) }; return await authResponse(request, env) ?? api.fetch(request, env, ctx) },
  async scheduled(controller: ScheduledController, env: any) { await runHourly(env, new Date(controller.scheduledTime)) },
}
