// A fake Auth installation at the Worker's network edge (DATA-001): the pull-link
// endpoints of Base's dependency protocol in front of the test OpenID provider.
import { provider, verifyAssertion } from './idp.mjs'
import { random } from '../src/modules/operator-auth/identity/oidc/crypto.mjs'

export async function authEdge(issuer, origin) {
  const idp = await provider({ issuer, alg: 'ES256', method: 'private_key_jwt', clientId: 'coaster-at-auth', redirectUri: origin + '/auth/oidc/auth/callback', rerInterfaces: ['oidc-provider@1.0.0'] })
  const link = { issuer, version: 1, interface: 'oidc-provider@1', provides: ['oidc-provider@1'], initiate: issuer + '/link', redeem: issuer + '/redeem', deregister: issuer + '/remove' }
  const codes = new Map()
  return {
    issuer, idp,
    async fetch(url, init) {
      if (url === issuer + '/.well-known/rer-provider') return Response.json(link)
      if (url === link.redeem && init.method === 'POST') {
        const input = JSON.parse(init.body), key = codes.get(input.code)
        codes.delete(input.code)
        const claims = key && await verifyAssertion(input.client_assertion, key)
        if (!claims || claims.code !== input.code || claims.aud !== link.redeem || claims.iss !== origin || input.origin !== origin) return Response.json({ error: 'invalid_proof' }, { status: 403 })
        // Sign-in token requests are checked against the same registered public key.
        idp.options.clientKey = key
        return Response.json({ issuer, interface: input.interface, client_id: idp.options.clientId, sector_id: claims.sector_id, origin, callback: input.callback, continuity: 'provider-owner' })
      }
      return idp.fetch(url, init)
    },
    /** What Auth does once its owner approves Coaster: read Coaster's public document and key, then call back with a one-use code. */
    async link(h) {
      const document = (await h.send('/.well-known/rer-dependencies')).value
      const key = (await h.send(new URL(document.dependencies[0].jwks_uri).pathname)).value.keys[0]
      const code = random()
      codes.set(code, key)
      return h.send('/.well-known/rer-link/callback', { issuer, code, interface: 'oidc-provider@1' })
    },
    /** A person signs in to Coaster through Auth; returns Coaster's answer to the callback. */
    async signIn(h, email, name) {
      const start = await h.send('/auth/oidc/auth/start', {})
      const location = start.headers.get('location')
      if (!location) throw new Error(`start: ${start.status} ${start.text}`)
      const iat = Math.floor(Date.now() / 1000)
      const { code, state } = await idp.authorize(location, { email, name, email_verified: true, email_verified_at: iat, sid: random() })
      return h.send(`/auth/oidc/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, undefined, start.cookie)
    },
  }
}
