// First: under RER_DEMO the demo guard must replace fetch before any other module can keep it.
import { withDemo } from './modules/demo/index.mjs'
import { seedDemo } from './demo'
import start from '@tanstack/react-start/server-entry'
import { dispatch } from './base/dispatch'
import { staticAssetResponse } from './base/static-assets'
import { api } from './coaster/api'
import { lobbyResponse } from './base/lobby'
import { setupStateResponse } from './base/setup-state'
import { authResponse, runtimeBindings, type Bindings } from './auth.server'
import { identity } from './identity'
import { deliverReports } from './coaster/report-schedules'
import { runReminders } from './coaster/reminders'

// Start documents keep their own cache policy and add no-transform, so no proxy
// rewrites the HTML React hydrates (Cloudflare's email address obfuscation
// honours it; src/base/hydration/README.md).
function noTransform(response: Response): Response {
  const headers = new Headers(response.headers), policy = headers.get('cache-control')
  headers.set('cache-control', policy ? `${policy}, no-transform` : 'no-transform')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

const worker = {
  async fetch(request, env, execution) {
    const asset = await staticAssetResponse(request, env)
    if (asset) return asset
    const auth = await authResponse(request, env)
    if (auth) return auth
    // The installed variant: the Lobby at / and the public claim state it reads.
    // Local dev serves the saved origin's data at its own port (RER_DEV_ORIGIN).
    const state = await setupStateResponse(request, runtimeBindings(env))
    if (state) return state
    const lobby = await lobbyResponse(request, runtimeBindings(env), identity)
    if (lobby) return lobby
    return dispatch(request, () => api.fetch(request, env, execution), async () => noTransform(await start.fetch(request)))
  },
  // The hourly Cron Trigger chases open items (FOLLOWUP-001) and sends scheduled reports (REPORT-002).
  async scheduled(controller, env) {
    const at = new Date(controller.scheduledTime)
    await runReminders(runtimeBindings(env), at)
    await deliverReports(runtimeBindings(env), at)
  },
} satisfies ExportedHandler<Bindings>

// Demo mode only under RER_DEMO=1 (`rer demo`, a hosted demo); otherwise the worker is unchanged.
export default withDemo(worker, { seed: seedDemo })
