import { queuedEntrypoint } from '@runeditrun/rer/queued-entry'
const queued = await queuedEntrypoint(import.meta.url, 'verify:email-link'); if (queued !== null) process.exit(queued)
import assert from 'node:assert/strict'
import { harness } from './harness.mjs'

// Exercise ordinary email-link authentication through the Worker routes, with
// only Resend's network edge faked. Local mail no longer captures an outbox.
const h = await harness()
try {
  const email = 'owner@harbourfinch.example'
  assert.equal((await h.send('/auth/magic-link', { email })).status, 202)
  const cookie = await h.confirmMail(email)
  const session = await h.send('/auth/session', undefined, cookie)
  assert.equal(session.status, 200)
  assert.equal(session.value.operator.email, email)
  console.log('Email-link sign-in passed: provider acceptance, confirmation, session')
} finally { await h.close() }
