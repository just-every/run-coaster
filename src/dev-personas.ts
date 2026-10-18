import { env } from 'cloudflare:workers'
import type { DevPersona } from './modules/operator-auth/dev/index.mjs'

// Local dev personas: real operators at <as>@dev.localhost, created only by
// local dev sign-in and suspended in exports. Only src/server.dev.ts uses them.
// Each still needs the owner to add them in Settings with the matching roles.
// Under `rer demo` none are offered: the sample business's own Jordan Pike,
// Dana Kim and Ruth Kowal sign in as themselves instead (src/demo.ts).
export function devPersonas(): DevPersona[] {
 if ((env as { RER_DEMO?: string }).RER_DEMO === '1') return []
 return [
  { as: 'employee', role: 'member', displayName: 'Jordan Pike (employee)' },
  { as: 'manager', role: 'member', displayName: 'Dana Kim (manager)' },
  { as: 'finance', role: 'member', displayName: 'Ruth Kowal (finance)' },
 ]
}
