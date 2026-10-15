import type { DevPersona } from './modules/operator-auth/dev/index.mjs'

// Local dev personas: real operators at <as>@dev.localhost, created only by
// local dev sign-in and suspended in exports. Only src/server.dev.ts uses them.
// Each still needs the owner to add them in Settings with the matching roles.
export function devPersonas(): DevPersona[] {
 return [
  { as: 'employee', role: 'member', displayName: 'Sam Taylor (employee)' },
  { as: 'manager', role: 'member', displayName: 'Priya Nair (manager)' },
  { as: 'finance', role: 'member', displayName: 'Morgan Lee (finance)' },
 ]
}
