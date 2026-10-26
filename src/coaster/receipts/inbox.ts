import { prepareTarget, targetSuggestions } from '../coding/automatic/storage';
import { all, authority, commit, need, sha256Hex } from '../session';
import { now, requireThat, uid, type Actor } from '../types';
import { originalBytes, receiptBucket, storeReceipt, type StoredReceipt } from './storage';
import { MATCH_NOTICE } from './match-notice';
import { receiptUpload } from './upload';

type InboxReceipt = StoredReceipt & {
  id: string; owner_email: string; name: string; media_type: string;
  source: 'upload' | 'camera'; uploaded_by: string; uploaded_at: string;
  state: 'received' | 'reading' | 'read' | 'needs-attention'; reason: string;
};
type InboxEvent = { receipt_id: string; sequence: number; state: InboxReceipt['state']; reason: string; at: string; actor_email: string; on_behalf_of: string | null; channel: 'app' };
type Lifecycle = Omit<InboxEvent, 'state'> & { kind: 'discarded' | 'merged' | 'attached' | 'detached' | 'match-details' | 'match-withdrawn' | 'match-rejected'; survivor_id: string | null; claim_id: string | null; item_id: string | null; match_data: string | null };
const ATTENTION = 'This original has not been read. Enter the expense details manually, or explicitly choose receipt reading when your business enables it.';
const SELECT = `SELECT r.*,e.state,e.reason FROM c_capture_receipts r JOIN c_capture_receipt_events e ON e.receipt_id=r.id
  AND e.sequence=(SELECT MAX(latest.sequence) FROM c_capture_receipt_events latest WHERE latest.receipt_id=r.id)`;

function ownInbox(actor: Actor) {
  need(actor, 'employee');
  requireThat(actor.kind === 'person', 'A native session is required to open a receipt inbox', 403);
}

const summary = (r: InboxReceipt, history: InboxEvent[], lifecycle: Lifecycle[] = []) => ({
  id: r.id, name: r.name, mediaType: r.media_type, size: r.size, sha256: r.sha256,
  source: r.source, uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at,
  state: r.state, attentionReason: r.reason,
  history: history.map(e => ({ sequence: e.sequence, state: e.state, reason: e.reason, at: e.at, actorEmail: e.actor_email, onBehalfOf: e.on_behalf_of, channel: e.channel })),
  disposition: lifecycle.find(e => e.kind === 'discarded' || e.kind === 'merged')?.kind ?? 'active', lifecycleSequence: lifecycle.at(-1)?.sequence ?? 0,
  lifecycle: lifecycle.map(e => ({ sequence: e.sequence, kind: e.kind, reason: e.reason, ...(e.survivor_id ? { survivorId: e.survivor_id } : {}), ...(e.claim_id ? { claimId: e.claim_id, itemId: e.item_id } : {}), at: e.at, actorEmail: e.actor_email, onBehalfOf: e.on_behalf_of, channel: e.channel })),
  matchChoice: (() => { const choice = lifecycle.filter(e => ['match-details','match-withdrawn'].includes(e.kind)).at(-1); return { enabled: choice?.kind==='match-details', details: choice?.kind==='match-details' ? JSON.parse(choice.match_data!) : null, notice: MATCH_NOTICE }; })(),
  downloadUrl: `/api/coaster/receipt-inbox/${r.id}`,
});

/** Unattached originals follow employee privacy and existing ADMIN-005 grants. */
export async function listInbox(db: D1Database, actor: Actor) {
  ownInbox(actor);
  const [receipts, history, lifecycle, drafts, attachments, rules, mailSources] = await db.batch([
    db.prepare(`${SELECT} WHERE r.owner_email=? ORDER BY r.uploaded_at DESC,r.id DESC`).bind(actor.email),
    db.prepare('SELECT e.* FROM c_capture_receipt_events e JOIN c_capture_receipts r ON r.id=e.receipt_id WHERE r.owner_email=? ORDER BY e.receipt_id,e.sequence').bind(actor.email),
    db.prepare('SELECT e.* FROM c_capture_lifecycle e JOIN c_capture_receipts r ON r.id=e.receipt_id WHERE r.owner_email=? ORDER BY e.receipt_id,e.sequence').bind(actor.email),
    db.prepare('SELECT d.*,c.status AS claim_status,CASE WHEN c.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM c_items i WHERE i.claim_id=c.id) THEN 1 ELSE 0 END AS needs_details FROM c_capture_cash_drafts d JOIN c_capture_receipts r ON r.id=d.receipt_id LEFT JOIN c_claims c ON c.id=d.claim_id WHERE r.owner_email=?').bind(actor.email),
    db.prepare(`SELECT a.capture_receipt_id AS receiptId,i.id AS itemId,c.id AS claimId,c.version,c.status,c.title AS claimTitle,i.merchant FROM c_items i JOIN c_receipts a ON a.id=i.receipt_id JOIN c_claims c ON c.id=i.claim_id WHERE a.capture_receipt_id IS NOT NULL AND c.employee_email=?`).bind(actor.email),
    db.prepare('SELECT enabled FROM c_card_match_rules ORDER BY version DESC LIMIT 1'),
    db.prepare('SELECT s.receipt_id,m.sender,m.subject,m.received_at FROM c_receipt_mail_sources s JOIN c_receipt_mail_messages m ON m.id=s.message_id JOIN c_capture_receipts r ON r.id=s.receipt_id WHERE r.owner_email=?').bind(actor.email),
  ]);
  const events = history.results as InboxEvent[];
  return { receipts: (receipts.results as InboxReceipt[]).map(r => summary(r, events.filter(e => e.receipt_id === r.id), (lifecycle.results as Lifecycle[]).filter(e => e.receipt_id === r.id))).map(receipt => ({ ...receipt, emailSource: (()=>{const m=(mailSources.results as {receipt_id:string;sender:string;subject:string;received_at:string}[]).find(m=>m.receipt_id===receipt.id);return m?{from:m.sender,subject:m.subject,receivedAt:m.received_at,sourceUrl:`/api/coaster/receipt-inbox/${receipt.id}/source`}:null;})(), matchChoice: {...receipt.matchChoice,automationEnabled:(rules.results[0] as {enabled:number}).enabled===1}, attachment: (attachments.results as {receiptId: string; status: string}[]).filter(a=>a.receiptId===receipt.id).map(a=>({...a,editable:['draft','returned'].includes(a.status)}))[0] ?? null, cashDraft: (drafts.results as { receipt_id: string; claim_id: string; expense_date: string; created_at: string }[]).find(d => d.receipt_id === receipt.id) ?? null })) };
}

export async function receiveReceipt(db: D1Database, originalBucket: R2Bucket | undefined, actor: Actor, request: Request) {
  ownInbox(actor);
  const bucket = receiptBucket(originalBucket), upload = await receiptUpload(request);
  const id = uid(), at = now(), hash = await sha256Hex(upload.bytes), key = `receipt-inbox/${id}/${hash}`, uploader = actor.delegate?.email ?? actor.email;
  const history: InboxEvent[] = [
    { receipt_id: id, sequence: 1, state: 'received', reason: '', at, actor_email: uploader, on_behalf_of: actor.delegate ? actor.email : null, channel: 'app' },
    { receipt_id: id, sequence: 2, state: 'needs-attention', reason: ATTENTION, at, actor_email: uploader, on_behalf_of: actor.delegate ? actor.email : null, channel: 'app' },
  ];
  const coding=upload.merchant?await prepareTarget(db,{kind:'receipt',id,employee:actor.email,merchant:upload.merchant},{},{},[],true):null;
  await storeReceipt(bucket, key, upload.bytes, upload.mediaType, hash);
  try {
    await commit(db, all(authority(actor, 'employee'),...(coding?[coding.guard]:[])), [
      db.prepare('INSERT INTO c_capture_receipts(id,owner_email,name,media_type,size,sha256,object_key,source,uploaded_by,uploaded_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .bind(id, actor.email, upload.name, upload.mediaType, upload.bytes.length, hash, key, upload.source, uploader, at),
      ...(coding?.writes??[]),
      ...history.map(e => db.prepare('INSERT INTO c_capture_receipt_events(receipt_id,sequence,state,reason,at,actor_email,on_behalf_of,channel) VALUES(?,?,?,?,?,?,?,?)')
        .bind(id,e.sequence,e.state,e.reason,e.at,e.actor_email,e.on_behalf_of,e.channel)),
    ]);
  } catch (error) {
    await bucket.delete(key);
    throw error;
  }
  return { ...(coding?{codingSuggestions:await targetSuggestions(db,'receipt',id),codingContext:{version:coding.version,merchant:upload.merchant,values:coding.values}}:{}),receipt: summary({ id, owner_email: actor.email, name: upload.name, media_type: upload.mediaType,
    size: upload.bytes.length, sha256: hash, object_key: key, source: upload.source as 'upload' | 'camera',
    uploaded_by: uploader, uploaded_at: at, state: 'needs-attention', reason: ATTENTION }, history) };
}

export async function inboxReceiptFile(db: D1Database, originalBucket: R2Bucket | undefined, actor: Actor, id: string, inline = false) {
  ownInbox(actor);
  const receipt = await db.prepare(`${SELECT} WHERE r.id=? AND r.owner_email=?`).bind(id,actor.email).first<InboxReceipt>();
  requireThat(receipt, 'Receipt not found', 404);
  const bytes = await originalBytes(receiptBucket(originalBucket), receipt);
  const image = receipt.media_type.startsWith('image/') && receipt.media_type !== 'image/heic';
  return new Response(bytes, { headers: {
    'content-type': receipt.media_type, 'content-length': String(receipt.size),
    'content-disposition': `${inline && image ? 'inline' : 'attachment'}; filename="${receipt.name.replace(/[^a-zA-Z0-9._-]/g,'_')}"`,
    'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store',
  } });
}
