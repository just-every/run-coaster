import { api } from '../src/coaster/api'
import { authResponse } from '../src/auth.server'

// The production API and native auth handlers, without Start's document renderer.
export default { async fetch(request: Request, env: any, ctx: ExecutionContext) { return await authResponse(request, env) ?? api.fetch(request, env, ctx) } }
