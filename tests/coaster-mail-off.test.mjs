import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { harness } from './harness.mjs'

test('The hosted owner can sign in once with a rer signin link while outbound mail is off', async () => {
  const h = await harness({ hosted: true, bindings: { MAIL_PROVIDER: 'none' } })
  try {
    assert.equal((await h.send('/health')).value.status, 'ok')
    const signin = await h.send('/signin')
    assert.equal(signin.status, 200)
    assert.doesNotMatch(signin.text, /action="\/auth\/magic-link"/)
    const emailed = await h.send('/auth/magic-link', { email: 'owner@harbourfinch.example' })
    assert.equal(emailed.status, 503)
    assert.equal(emailed.value.error, 'mail_unavailable')

    // The Cloudflare D1 write made by rer signin, using the owner's live account.
    const token = randomBytes(32).toString('base64url')
    const digest = createHash('sha256').update('owner-signin\0' + token).digest('hex')
    const now = Date.now()
    await h.db.prepare(`INSERT INTO oa_owner_signins(id,token_hash,operator_id,operator_version,created_at,expires_at)
      SELECT ?,?,id,version,?,? FROM oa_operators WHERE role='owner' AND status='active'`)
      .bind(crypto.randomUUID(), digest, now, now + 900_000).run()
    const opened = await h.send('/auth/owner-signin', { token })
    assert.equal(opened.status, 303)
    const session = await h.send('/auth/session', undefined, opened.cookie)
    assert.equal(session.value.operator.email, 'owner@harbourfinch.example')
    assert.equal((await h.send('/auth/owner-signin', { token })).status, 400)

    const alias = await h.send('/api/coaster/settings/receipt-email/aliases',
      { email: 'receipts@harbourfinch.example' }, opened.cookie)
    assert.equal(alias.status, 409)
    assert.match(alias.value.error, /mail_off/)
    assert.deepEqual(h.outbound, [])
  } finally {
    await h.close()
  }
})
