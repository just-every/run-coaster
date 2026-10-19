import { api } from '../src/coaster/api'
import { authResponse, runtimeBindings } from '../src/auth.server'
import { deliverReports } from '../src/coaster/report-schedules'

// The production API and native auth handlers, without Start's document renderer.
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) { return await authResponse(request, env) ?? api.fetch(request, env, ctx) },
  async scheduled(controller: ScheduledController, env: any) { await deliverReports(runtimeBindings(env), new Date(controller.scheduledTime)) },
}
