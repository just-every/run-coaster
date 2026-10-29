// Original operations assertions, composed as named phases without test registrations.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agency, harness, receipt } from '../harness.mjs'
import { sha, sum, claim, submit, approve, central, deactivateAccount, unzip, everywhere, withAgency } from './operations-support.mjs'

// APPROVE-006 an approver asks a named person about one expense without deciding; the answer closes the question and frozen comments stay in history
async function answerNamedExpenseQuestions(h, t) {
  const SAM = 'sam@harbourfinch.example', PRIYA = 'priya@harbourfinch.example'
  const { receiptAddress, deliverMail, aliasCode } = await import('../fixtures/receipt-email.mjs')
  await h.post('settings/receipt-email', { address: receiptAddress, consent: true })
  const reply = (mail, from, body, subject = `Re: ${mail.subject}`) => Buffer.from(`From: ${from}\r\nTo: ${receiptAddress}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`)
  const audrey = await h.person('audrey@harbourfinch.example', { auditor: true })
  const d = await claim(h, t.sam, 'Client dinner', [{ kind: 'receipt', date: '2026-05-21', merchant: 'Rockpool', amount: '96.00', allocations: [{ category: t.c.meals }], receiptFixture: 'bistro' }, { kind: 'receipt', date: '2026-05-21', merchant: 'Uber', amount: '18.40', allocations: [{ category: t.c.travel }], receiptFixture: 'uber' }])
  const c = await submit(h, t.sam, d), dinner = d.items[0].id
  await h.post(`claims/${c.id}/comments`, { body: 'Which client was this for?', asks: SAM }, t.alex, 403)
  await h.post(`claims/${c.id}/comments`, { body: 'Which client?', item: dinner, asks: 'alex@harbourfinch.example' }, t.priya, 400)
  const asked = await h.post(`claims/${c.id}/comments`, { body: 'Which client was thsi for?', item: dinner, asks: SAM }, t.priya)
  assert.equal(asked.notified, 'accepted')
  const mail = h.messages.findLast(m => m.to.includes(SAM))
  assert.equal(mail.reply_to, receiptAddress, 'reply reaches the installation native email event address')
  assert.match(mail.subject, /question about CL-/); assert.match(mail.text, /Which client was thsi for\?/); assert.match(mail.text, new RegExp(`#/claims/${c.id}`))
  let seen = await h.get(`claims/${c.id}`, t.priya)
  assert.deepEqual([seen.claim.status, seen.claim.version], ['submitted', c.version], 'the claim stays pending, its version unchanged')
  assert.equal((await h.get('state', t.priya)).claims.find(x => x.id === c.id).open_questions, 1, 'the open question shows on the approver\'s queue')
  await h.post(`comments/${asked.comment}/edit`, { body: 'Which client was this for?' }, t.sam, 403)
  await h.post(`comments/${asked.comment}/edit`, { body: 'Which client was this for?' }, t.priya)

  // Finance and an auditor can comment too; only the named person's reply answers the question.
  await h.post(`claims/${c.id}/comments`, { body: 'Coded to client entertainment once known', parent: asked.comment }, t.jordan)
  assert.equal((await h.get('state', t.priya)).claims.find(x => x.id === c.id).open_questions, 1)
  await h.post(`claims/${c.id}/comments`, { body: 'Sampled for the quarterly review' }, audrey)
  const heldBefore = (await h.get('settings/receipt-email')).held.length
  const alias = 'sam.answers@example.net'
  await h.post('settings/receipt-email/aliases', { email: alias }, t.sam)
  for (const from of ['unknown@example.net', 'jordan@harbourfinch.example', alias]) {
    await deliverMail(h, reply(mail, SAM, `A forged From header is not the native sender: ${from}`), from)
  }
  assert.equal((await h.get(`claims/${c.id}`, t.priya)).comments.filter(x => x.parent_id === asked.comment).length, 1, 'unknown, another member and an unconfirmed alias cannot answer')
  assert.equal((await h.get('settings/receipt-email')).held.length, heldBefore + 3)
  const original = reply(mail, SAM, 'Harbour Bank, the pitch team\r\n\r\nOn Monday Priya wrote:\r\n> Which client was this for?')
  await deliverMail(h, original, SAM)
  await deliverMail(h, original, SAM)
  seen = await h.get(`claims/${c.id}`, t.priya)
  const question = seen.comments.find(x => x.id === asked.comment)
  assert.deepEqual([question.open, question.item_id, question.body, question.edited_at !== null, question.replies], [false, dinner, 'Which client was this for?', true, 2])
  assert.equal((await h.get('state', t.priya)).claims.find(x => x.id === c.id).open_questions, 0)
  const answer = seen.comments.find(x => x.parent_id === asked.comment && x.author_email === SAM)
  assert.equal(answer.body, 'Harbour Bank, the pitch team')
  assert.deepEqual(seen.items, d.items, 'mail answers leave every expense field unchanged')
  assert.deepEqual([seen.claim.status, seen.claim.version], ['submitted', c.version])
  assert.equal((await h.get('receipt-inbox', t.sam)).receipts.length, 0, 'question replies are never receipt files')
  assert.equal((await h.get('settings/receipt-email')).held.length, heldBefore + 3, 'accepted answer source is private provenance rather than owner-held mail')
  assert.equal(await h.db.prepare('SELECT id FROM c_receipt_mail_messages WHERE sha256=?').bind(sha(original)).first(), null, 'accepted mail answer retains no original containing erasable comment text')
  const bucket = await h.mf.getR2Bucket('COASTER_RECEIPTS')
  assert.ok(!(await bucket.list()).objects.some(o => o.key.endsWith(sha(original))), 'accepted reply bytes do not remain in private object storage')
  await h.post(`comments/${asked.comment}/edit`, { body: 'Who was at the dinner?' }, t.priya, 409)
  await assert.rejects(h.db.prepare('UPDATE c_comments SET body=? WHERE id=?').bind('Rewritten', asked.comment).run(), /permanent/)
  await assert.rejects(h.db.prepare('DELETE FROM c_comments WHERE id=?').bind(asked.comment).run(), /permanent/)

  const approved = await approve(h, t.priya, seen.claim)
  assert.equal(approved.status, 'approved')
  const history = (await h.get(`claims/${c.id}`, t.sam)).events.filter(e => ['question-asked', 'comment-edited', 'comment-added', 'question-answered'].includes(e.action))
  assert.deepEqual(history.map(e => [e.action, e.actor_email]), [['question-asked', PRIYA], ['comment-edited', PRIYA], ['comment-added', 'jordan@harbourfinch.example'], ['comment-added', 'audrey@harbourfinch.example'], ['question-answered', SAM]])
  assert.equal(history[1].detail.previous, 'Which client was thsi for?', 'the earlier wording stays in history')
  assert.ok(!JSON.stringify(history).includes(mail.subject.match(/\[Coaster answer ([a-f0-9]+)\]/)[1]), 'reply credential never enters claim history')

  // App answers still work; confirmed aliases use the same named person's authority.
  const appQuestion = await h.post(`claims/${c.id}/comments`, { body: 'Who attended?', asks: SAM }, t.priya)
  await h.post(`claims/${c.id}/comments`, { body: 'The pitch team', parent: appQuestion.comment }, t.sam)
  await h.post('settings/receipt-email/aliases/confirm', { email: alias, code: aliasCode(h, alias) }, t.sam)
  const aliasQuestion = await h.post(`claims/${c.id}/comments`, { body: 'Which office?', asks: SAM }, t.priya)
  const aliasMail = h.messages.findLast(m => m.to.includes(SAM))
  await deliverMail(h, Buffer.from(reply(aliasMail, alias, '<p>Brisbane</p><script>do not execute</script>').toString().replace('Content-Type: text/plain;', 'Content-Type: text/html;')), alias)
  const aliasSeen=(await h.get(`claims/${c.id}`, t.priya)).comments
  assert.equal(aliasSeen.find(x => x.id === aliasQuestion.comment).open, false)
  assert.equal(aliasSeen.find(x => x.parent_id === aliasQuestion.comment).body, 'Brisbane')
  const revokedQuestion = await h.post(`claims/${c.id}/comments`, { body: 'Which project?', asks: SAM }, t.priya)
  const revokedMail = h.messages.findLast(m => m.to.includes(SAM))
  await h.post('settings/receipt-email/aliases/remove', { email: alias }, t.sam)
  await deliverMail(h, reply(revokedMail, alias, 'Revoked alias answer'), alias)
  await deactivateAccount(h, SAM)
  await deliverMail(h, reply(revokedMail, SAM, 'Inactive account answer'), SAM)
  assert.equal((await h.get(`claims/${c.id}`, t.priya)).comments.find(x => x.id === revokedQuestion.comment).open, true)

  const AUDREY = 'audrey@harbourfinch.example'
  const auditQuestion = await h.post(`claims/${c.id}/comments`, { body: 'Which audit period?', asks: AUDREY }, t.priya)
  const auditMail = h.messages.findLast(m => m.to.includes(AUDREY))
  const auditOriginal = reply(auditMail, AUDREY, 'October audit sample')
  await deliverMail(h, auditOriginal, AUDREY)
  const auditAnswer = (await h.get(`claims/${c.id}`, t.priya)).comments.find(x => x.parent_id === auditQuestion.comment)
  assert.equal(auditAnswer.author_email, AUDREY)
  const erasedQuestion = await h.post(`claims/${c.id}/comments`, { body: 'Which audit sample?', asks: AUDREY }, t.priya)
  const erasedMail = h.messages.findLast(m => m.to.includes(AUDREY))
  await h.post('settings/members', { email: AUDREY, name: 'Audrey', employee: true })
  await deliverMail(h, reply(erasedMail, AUDREY, 'Role no longer permits claim access'), AUDREY)
  assert.equal((await h.get(`claims/${c.id}`, t.priya)).comments.find(x => x.id === erasedQuestion.comment).open, true)
  await h.post('settings/members', { email: AUDREY, name: 'Audrey', auditor: true, active: false })
  await h.post('settings/members/erase', { email: AUDREY })
  assert.ok(!(await h.get(`claims/${c.id}`, t.priya)).comments.some(x => x.id === auditAnswer.id), 'erasure removes the email-authored native comment')
  assert.equal(await h.db.prepare('SELECT comment_id FROM c_comment_email_answers WHERE message_sha256=?').bind(sha(auditOriginal)).first(), null, 'erasure removes the answer replay link')
  assert.equal(await h.db.prepare('SELECT id FROM c_receipt_mail_messages WHERE sha256=?').bind(sha(auditOriginal)).first(), null)
  await h.person(AUDREY, { auditor: true })
  await deliverMail(h, reply(erasedMail, AUDREY, 'Recreated account cannot inherit erased credentials'), AUDREY)
  assert.ok(!(await h.get(`claims/${c.id}`, t.priya)).comments.some(x => x.body === 'Recreated account cannot inherit erased credentials'))
}

export async function preserveExpenseQuestions() {
  await withAgency(answerNamedExpenseQuestions)
}
