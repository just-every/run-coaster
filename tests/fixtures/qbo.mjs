// Only Intuit's paid/network boundary is synthetic; tests use the real production HTTP API.
import assert from 'node:assert/strict'

export const qboFixtureId = n => `synthetic-coaster-${n}`
const id = qboFixtureId
const record = (n, extra = {}) => ({ Id: id(n), Name: id(n), Active: true, ...extra })

/** Mutable controls: generation 0/1/2 adds then archives a class; failEntity and redirect simulate provider failures. */
export function qboFixture() {
  const fixture = {
    bindings: { QBO_CLIENT_ID: id(800), QBO_CLIENT_SECRET: id(801), QBO_ENVIRONMENT: 'sandbox' },
    realm: id(803), code: id(802), generation: 0, rotation: 0, lastRefresh: '', failEntity: '', redirect: false,
    callback(authorizationUrl) {
      const authorization = new URL(authorizationUrl), callback = new URL(authorization.searchParams.get('redirect_uri'))
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state'), code: fixture.code, realmId: fixture.realm }).toString()
      return callback.pathname + callback.search
    },
    async fetch(request) {
      const url = new URL(request.url)
      if (url.hostname === 'oauth.platform.intuit.com') {
        assert.equal(request.method, 'POST')
        assert.equal(request.headers.get('authorization'), 'Basic ' + Buffer.from(`${fixture.bindings.QBO_CLIENT_ID}:${fixture.bindings.QBO_CLIENT_SECRET}`).toString('base64'))
        const body = new URLSearchParams(await request.text())
        if (body.get('grant_type') === 'authorization_code') assert.equal(body.get('code'), fixture.code)
        else { assert.equal(body.get('grant_type'), 'refresh_token'); assert.equal(body.get('refresh_token'), fixture.lastRefresh, 'the latest rotated refresh token is used') }
        fixture.rotation++
        fixture.lastRefresh = id(810 + fixture.rotation)
        return Response.json({ token_type: 'bearer', access_token: id(830 + fixture.rotation), refresh_token: fixture.lastRefresh, expires_in: 1, x_refresh_token_expires_in: 8_640_000 })
      }
      assert.equal(url.hostname, 'sandbox-quickbooks.api.intuit.com')
      assert.equal(url.pathname, `/v3/company/${fixture.realm}/query`)
      assert.equal(request.method, 'GET'); assert.equal(await request.text(), '')
      assert.equal(request.headers.get('authorization'), `Bearer ${id(830 + fixture.rotation)}`)
      assert.equal(request.headers.get('cookie'), null)
      const query = url.searchParams.get('query')
      assert.match(query, /WHERE Active IN \(true, false\) STARTPOSITION 1 MAXRESULTS 1000$/)
      const entity = /SELECT \* FROM (\w+)/.exec(query)[1]
      if (entity === fixture.failEntity) return Response.json({ Fault: { Error: [{ Detail: id(890) }] } }, { status: 503 })
      if (fixture.redirect) return new Response('', { status: 302, headers: { location: 'https://unrelated.example/' } })
      const rows = {
        Account: [record(850)],
        Class: [record(851, { Active: fixture.generation < 2 }), ...(fixture.generation >= 1 ? [record(852)] : [])],
        Department: [record(853)],
        Customer: [record(854, { DisplayName: id(854) }), record(855, { IsProject: true, Job: true, ParentRef: { value: id(854) } })],
        Vendor: [record(856, { DisplayName: id(856) })],
      }
      return Response.json({ QueryResponse: { [entity]: rows[entity] } })
    },
  }
  return fixture
}
