import type { Bindings } from '../auth.server';
import { canSee, loadClaim } from './claims';
import { commentWrites } from './comments';
import { can } from './permissions';
import { all, commit, rolesFrom, sha256Hex, type Sql } from './session';
import { Fault, now, text, uid, type Actor, type Data } from './types';
import type { MailReceiptMessage } from './receipts/mail-content';

const marker = /\[Coaster answer ([a-f0-9]{64})\]/gi;
const flags = ['is_employee', 'is_manager', 'is_finance', 'is_auditor', 'is_admin', 'is_card_admin', 'is_bookkeeper'];
const owner = "EXISTS(SELECT 1 FROM oa_operators o WHERE lower(o.email)=m.email AND o.role='owner' AND o.status='active')";
const activeAccount = "NOT EXISTS(SELECT 1 FROM oa_operators o WHERE lower(o.email)=m.email AND o.status<>'active')";
// Resolve all native identities before permission filtering: an alias that also
// names another member must never be silently attributed to either of them.
const identities = 'SELECT m.* FROM c_members m WHERE (m.email=? OR EXISTS(SELECT 1 FROM c_receipt_mail_aliases a WHERE a.email=? AND a.owner_email=m.email AND a.confirmed_at IS NOT NULL))';

export const isCommentReply = (message: MailReceiptMessage) => /\[Coaster answer\b/i.test(message.subject ?? '');

/** A private, question-specific credential, sent only to its named person's mailbox. */
export async function questionReplyMail(db: D1Database, env: Bindings, question: string, address: string) {
  // The managed relay does not support Reply-To; its ordinary app notification
  // remains valid without claiming an email answer door on that provider.
  if (!env.MAIL_PROVIDER || env.MAIL_PROVIDER === 'rer') return null;
  const destination = await db.prepare('SELECT address FROM c_receipt_mail_settings WHERE id=1').first<{ address: string }>();
  const member = await db.prepare('SELECT member_id FROM c_members WHERE email=? AND active=1').bind(address).first<{ member_id: string }>();
  if (!destination || !member) return null;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  return {
    destination: destination.address, subject: `[Coaster answer ${token}]`,
    statement: db.prepare('INSERT INTO c_comment_email_tokens(question_id,token_hash,member_id,destination,created_at) VALUES(?,?,?,?,?)').bind(question, await sha256Hex(token), member.member_id, destination.address, now()),
  };
}

type ReplyInput = { messageHash: string; sender: string; recipient: string; message: MailReceiptMessage };
type ReplyResult = { matched: false } | { matched: true; status: 'accepted' | 'held'; reason: string; claimId?: string; commentId?: string };
const held = (reason: string): ReplyResult => ({ matched: true, status: 'held', reason });

/** Native email event only. Accepted answers retain only their erasable native
 * comment and an opaque replay digest. Refusals return to owner-held custody. */
export async function recognizeCommentReply(db: D1Database, _env: Bindings, input: ReplyInput): Promise<ReplyResult> {
  if (!isCommentReply(input.message)) return { matched: false };
  const sender = input.sender.toLowerCase(), recipient = input.recipient.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(input.messageHash)) return held('Reply source digest is invalid');
  const saved = await db.prepare('SELECT a.comment_id,c.claim_id FROM c_comment_email_answers a JOIN c_comments c ON c.id=a.comment_id WHERE a.message_sha256=?').bind(input.messageHash).first<{ comment_id: string; claim_id: string }>();
  if (saved) return { matched: true, status: 'accepted', reason: '', claimId: saved.claim_id, commentId: saved.comment_id };
  const matches = [...(input.message.subject ?? '').matchAll(marker)];
  if (matches.length !== 1) return held('Reply must identify exactly one question');
  const token = matches[0][1], hash = await sha256Hex(token);
  const settings = await db.prepare('SELECT address,version FROM c_receipt_mail_settings WHERE id=1').first<{ address: string; version: number }>();
  if (!settings || settings.address !== recipient) return held('Question reply address is no longer enabled');
  const question = await db.prepare('SELECT q.*,t.member_id,t.destination FROM c_comment_email_tokens t JOIN c_comments q ON q.id=t.question_id WHERE t.token_hash=?').bind(hash).first<Data>();
  if (!question || question.parent_id || !question.asks_email || question.destination !== recipient) return held('Question reply credential is unknown or no longer valid');
  const members = (await db.prepare(identities).bind(sender, sender).all<Data>()).results;
  if (members.length !== 1 || members[0].email !== question.asks_email || members[0].member_id !== question.member_id || members[0].active !== 1) return held('Reply sender is not the active named person');
  const member = members[0];
  const native = await db.prepare(`SELECT ${owner} AS is_owner FROM c_members m WHERE m.member_id=? AND m.active=1 AND ${activeAccount}`).bind(member.member_id).first<{ is_owner: number }>();
  if (!native) return held('Reply sender native account is inactive');
  const actor: Actor = { kind: 'person', email: member.email, name: member.name, roles: rolesFrom(member, native.is_owner === 1) };
  let claim;
  try { claim = await loadClaim(db, question.claim_id); }
  catch (error) { if (error instanceof Fault && error.status === 404) return held('Question claim is no longer available'); throw error; }
  if (!canSee(actor, claim)) return held('Reply sender can no longer open this claim');
  if (await db.prepare('SELECT 1 FROM c_comments WHERE parent_id=? AND (author_email=? OR on_behalf_of=?)').bind(question.id, actor.email, actor.email).first()) return held('Question has already been answered');
  // Preserve the new plain-text answer, excluding ordinary quoted notification
  // text. HTML-only and oversized messages remain held for explicit app answers.
  const lines = (input.message.text ?? '').split(/\r?\n/), answer: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line) || /^On .{0,500}wrote:\s*$/i.test(line) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(line)) break;
    answer.push(line);
  }
  let body: string;
  try { body = text(answer.join('\n').split(token).join('[reply credential removed]'), 'Email answer', 2000); }
  catch (error) { if (error instanceof Fault) return held('Reply needs a plain-text answer of at most 2000 characters'); throw error; }
  const live: Sql = {
    sql: `EXISTS(SELECT 1 FROM c_members m WHERE m.member_id=? AND m.email=? AND m.active=1 AND ${flags.map(f => `m.${f}=?`).join(' AND ')} AND (${owner})=? AND ${activeAccount}) AND (SELECT COUNT(*) FROM (${identities}))=1 AND EXISTS(${identities} AND m.member_id=?) AND EXISTS(SELECT 1 FROM c_receipt_mail_settings WHERE id=1 AND address=? AND version=?) AND EXISTS(SELECT 1 FROM c_comment_email_tokens WHERE question_id=? AND token_hash=? AND member_id=? AND destination=?) AND EXISTS(SELECT 1 FROM c_claims c WHERE c.id=? AND (c.employee_email=? OR (c.status<>'draft' AND (? OR (? AND (c.approver_email=? OR c.on_behalf_of=?)) OR EXISTS(SELECT 1 FROM c_workflow_tasks w WHERE w.kind='claim' AND w.record_id=c.id AND w.revision=c.revision AND (w.email=? OR w.on_behalf_of=?))))))`,
    params: [member.member_id, actor.email, ...flags.map(f => member[f]), native.is_owner, sender, sender, sender, sender, member.member_id, recipient, settings.version, question.id, hash, member.member_id, recipient, claim.id, actor.email, can(actor, 'readAll') ? 1 : 0, actor.roles.manager ? 1 : 0, actor.email, actor.email, actor.email, actor.email],
  };
  const commentId = uid();
  try {
    await commit(db, all(live, {
      sql: 'EXISTS(SELECT 1 FROM c_claims WHERE id=? AND version=? AND revision=?) AND EXISTS(SELECT 1 FROM c_comments WHERE id=? AND claim_id=? AND asks_email=? AND parent_id IS NULL) AND NOT EXISTS(SELECT 1 FROM c_comments WHERE parent_id=? AND (author_email=? OR on_behalf_of=?)) AND NOT EXISTS(SELECT 1 FROM c_comment_email_answers WHERE message_sha256=?)',
      params: [claim.id, claim.version, claim.revision, question.id, claim.id, actor.email, question.id, actor.email, actor.email, input.messageHash],
    }), [
      ...commentWrites(db, actor, claim.id, { id: commentId, item: question.item_id, parent: question.id, asks: null, parentAsks: actor.email, body, at: now() }),
      db.prepare('INSERT INTO c_comment_email_answers(message_sha256,comment_id) VALUES(?,?)').bind(input.messageHash, commentId),
    ]);
  } catch (error) {
    // A concurrent redelivery can win the same atomic source reservation.
    const replay = await db.prepare('SELECT a.comment_id,c.claim_id FROM c_comment_email_answers a JOIN c_comments c ON c.id=a.comment_id WHERE a.message_sha256=?').bind(input.messageHash).first<{ comment_id: string; claim_id: string }>();
    if (replay) return { matched: true, status: 'accepted', reason: '', claimId: replay.claim_id, commentId: replay.comment_id };
    if (error instanceof Fault && error.status === 409) return held('Question or native permission changed before the answer was recorded');
    throw error;
  }
  return { matched: true, status: 'accepted', reason: '', claimId: claim.id, commentId };
}
