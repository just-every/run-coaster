import { all, authority, commit, rolesFrom } from './session';
import { event } from './events';
import { canSee, claimNumber, loadClaim, visible, type Claim } from './claims';
import { operatorMail } from '../mail.server.mjs';
import type { Bindings } from '../auth.server';
import { email, now, requireThat, text, uid, type Actor, type Data } from './types';
import { questionReplyMail } from './comment-email';

const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const author = (actor: Actor) => actor.delegate?.email ?? actor.email;

/** App and authenticated native email answers write the same comment and history line. */
export function commentWrites(db: D1Database, actor: Actor, claim: string, c: { id: string; item: string | null; parent: string | null; asks: string | null; parentAsks: string | null; body: string; at: string }) {
  const action = c.asks ? 'question-asked' : c.parentAsks === actor.email ? 'question-answered' : 'comment-added';
  return [
    db.prepare('INSERT INTO c_comments(id,claim_id,item_id,parent_id,author_email,on_behalf_of,asks_email,body,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(c.id, claim, c.item, c.parent, author(actor), actor.delegate ? actor.email : null, c.asks, c.body, c.at),
    event(db, actor, action, { claim }, { comment: c.id, item: c.item, parent: c.parent, asks: c.asks, body: c.body }),
  ];
}

/** Whether this address could open the claim itself: the same rule as canSee, read from the member record. */
async function seesClaim(db: D1Database, address: string, claim: Claim) {
  const m = await db.prepare("SELECT m.name,m.is_employee,m.is_manager,m.is_finance,m.is_auditor,m.is_admin,m.is_card_admin,m.is_bookkeeper,EXISTS(SELECT 1 FROM oa_operators o WHERE lower(o.email)=m.email AND o.role='owner' AND o.status='active') AS is_owner FROM c_members m WHERE m.email=? AND m.active=1").bind(address).first<Data>();
  if (!m) return null;
  const owner = m.is_owner === 1;
  const roles = rolesFrom(m, owner);
  return canSee({ kind: 'person', email: address, name: m.name, roles }, claim) ? m.name as string : null;
}

/** Open questions per claim: asked of a named person who has not replied yet. */
export async function openQuestions(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db.prepare('SELECT q.claim_id, COUNT(*) AS n FROM c_comments q WHERE q.asks_email IS NOT NULL AND NOT EXISTS(SELECT 1 FROM c_comments r WHERE r.parent_id=q.id AND (r.author_email=q.asks_email OR r.on_behalf_of=q.asks_email)) GROUP BY q.claim_id').all<{ claim_id: string; n: number }>();
  return Object.fromEntries(results.map(r => [r.claim_id, r.n]));
}

/** A claim's comments in order, each question marked answered by the named person's first reply. */
export async function claimComments(db: D1Database, claimId: string) {
  const { results } = await db.prepare('SELECT * FROM c_comments WHERE claim_id=? ORDER BY created_at, id').bind(claimId).all<Data>();
  return results.map(c => {
    const answer = c.asks_email ? results.find(r => r.parent_id === c.id && (r.author_email === c.asks_email || r.on_behalf_of === c.asks_email)) : undefined;
    return { ...c, open: !!c.asks_email && !answer, answered_at: answer?.created_at ?? null, replies: results.filter(r => r.parent_id === c.id).length };
  });
}

/** Anyone who can see a claim comments on it or one of its expenses, replies, or asks a named person a question; the
 * claim's status and version never change, so a pending decision stays pending. The named person is emailed. */
export async function addComment(db: D1Database, env: Bindings, actor: Actor, id: string, b: Data) {
  requireThat(actor.kind === 'person', 'Only a person comments on a claim', 403);
  const claim = await loadClaim(db, id);
  visible(actor, claim);
  const body = text(b.body, 'Comment', 2000);
  let item: string | null = null, parent: Data | null = null, asks: string | null = null, asksName: string | null = null;
  if (b.parent) {
    parent = await db.prepare('SELECT id,item_id,parent_id,asks_email FROM c_comments WHERE id=? AND claim_id=?').bind(b.parent, claim.id).first<Data>();
    requireThat(parent && !parent.parent_id, 'Reply to a comment on this claim', 404);
    item = parent.item_id;
  } else if (b.item) {
    requireThat(await db.prepare('SELECT 1 FROM c_items WHERE id=? AND claim_id=?').bind(b.item, claim.id).first(), 'Expense not found on this claim', 404);
    item = b.item;
  }
  if (b.asks) {
    requireThat(!parent, 'Ask a question as its own comment, not as a reply');
    asks = email(b.asks, 'Person to ask');
    requireThat(asks !== actor.email && asks !== author(actor), 'Ask someone other than yourself');
    asksName = await seesClaim(db, asks, claim);
    requireThat(asksName, 'Ask someone who can see this claim');
  }
  const commentId = uid(), at = now();
  const reply = asks ? await questionReplyMail(db, env, commentId, asks) : null;
  await commit(db, authority(actor), [
    ...commentWrites(db, actor, claim.id, { id: commentId, item, parent: parent?.id ?? null, asks, parentAsks: parent?.asks_email ?? null, body, at }),
    ...(reply ? [reply.statement] : []),
  ]);
  let notified: string | null = null;
  if (asks) {
    const mail = operatorMail(env), link = `${env.AUTH_ORIGIN}/app#/claims/${claim.id}`;
    const words = `${actor.name} asked you about ${claimNumber(claim.number)} “${claim.title}”: “${body}” ${reply ? 'Reply above the quoted message to answer, keeping the subject unchanged. Or answer in Coaster: ' : 'Answer it in Coaster: '}${link}`;
    const sent = mail ? await mail.send({ deliveryId: commentId, from: env.MAIL_FROM ?? '', to: [asks], subject: `${actor.name} has a question about ${claimNumber(claim.number)}${reply ? ` ${reply.subject}` : ''}`, text: words, html: `<p>${escape(words.replace(link, ''))}<a href="${link}">${link}</a></p>`, ...(reply ? { replyTo: reply.destination } : {}), headers: {} }) : null;
    notified = sent?.status ?? 'mail not set up';
  }
  return { comment: commentId, notified, comments: await claimComments(db, claim.id) };
}

/** The author may correct a comment until anyone replies; the earlier wording stays in the history line. */
export async function editComment(db: D1Database, actor: Actor, id: string, b: Data) {
  requireThat(actor.kind === 'person', 'Only a person edits a comment', 403);
  requireThat(typeof id === 'string' && id.length <= 64, 'Comment not found', 404);
  const comment = await db.prepare('SELECT * FROM c_comments WHERE id=?').bind(id).first<Data>();
  requireThat(comment, 'Comment not found', 404);
  visible(actor, await loadClaim(db, comment.claim_id));
  requireThat(comment.author_email === author(actor), 'Only the person who wrote a comment can edit it', 403);
  requireThat(!(await db.prepare('SELECT 1 FROM c_comments WHERE parent_id=?').bind(id).first()), 'Someone has replied; the comment can no longer be edited', 409);
  const body = text(b.body, 'Comment', 2000);
  await commit(db, all(authority(actor), { sql: 'NOT EXISTS(SELECT 1 FROM c_comments WHERE parent_id=?)', params: [id] }), [
    db.prepare('UPDATE c_comments SET body=?,edited_at=? WHERE id=?').bind(body, now(), id),
    event(db, actor, 'comment-edited', { claim: comment.claim_id }, { comment: id, previous: comment.body, body }),
  ]);
  return { comments: await claimComments(db, comment.claim_id) };
}
