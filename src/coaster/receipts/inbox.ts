import { authority, commit, need, sha256Hex } from '../session';
import { now, requireThat, uid, type Actor } from '../types';
import { originalBytes, receiptBucket, storeReceipt, type StoredReceipt } from './storage';
import { receiptUpload } from './upload';

type InboxReceipt = StoredReceipt & {
  id: string; owner_email: string; name: string; media_type: string;
  source: 'upload' | 'camera'; uploaded_by: string; uploaded_at: string;
  state: 'received' | 'reading' | 'read' | 'needs-attention'; reason: string;
};
type InboxEvent = { receipt_id: string; sequence: number; state: InboxReceipt['state']; reason: string; at: string; actor_email: string; on_behalf_of: string | null; channel: 'app' };
type Lifecycle = Omit<InboxEvent, 'state'> & { kind: 'discarded' };
const ATTENTION = 'Automatic receipt reading is not available. Enter the expense details manually using this original.';
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
  disposition: lifecycle.length ? 'discarded' : 'active', lifecycleSequence: lifecycle.at(-1)?.sequence ?? 0,
  lifecycle: lifecycle.map(e => ({ sequence: e.sequence, kind: e.kind, reason: e.reason, at: e.at, actorEmail: e.actor_email, onBehalfOf: e.on_behalf_of, channel: e.channel })),
  downloadUrl: `/api/coaster/receipt-inbox/${r.id}`,
});

/** Unattached originals follow employee privacy and existing ADMIN-005 grants. */
export async function listInbox(db: D1Database, actor: Actor) {
  ownInbox(actor);
  const [receipts, history, lifecycle] = await db.batch([
    db.prepare(`${SELECT} WHERE r.owner_email=? ORDER BY r.uploaded_at DESC,r.id DESC`).bind(actor.email),
    db.prepare('SELECT e.* FROM c_capture_receipt_events e JOIN c_capture_receipts r ON r.id=e.receipt_id WHERE r.owner_email=? ORDER BY e.receipt_id,e.sequence').bind(actor.email),
    db.prepare('SELECT e.* FROM c_capture_lifecycle e JOIN c_capture_receipts r ON r.id=e.receipt_id WHERE r.owner_email=? ORDER BY e.receipt_id,e.sequence').bind(actor.email),
  ]);
  const events = history.results as InboxEvent[];
  return { receipts: (receipts.results as InboxReceipt[]).map(r => summary(r, events.filter(e => e.receipt_id === r.id), (lifecycle.results as Lifecycle[]).filter(e => e.receipt_id === r.id))) };
}

export async function receiveReceipt(db: D1Database, originalBucket: R2Bucket | undefined, actor: Actor, request: Request) {
  ownInbox(actor);
  const bucket = receiptBucket(originalBucket), upload = await receiptUpload(request);
  const id = uid(), at = now(), hash = await sha256Hex(upload.bytes), key = `receipt-inbox/${id}/${hash}`, uploader = actor.delegate?.email ?? actor.email;
  const history: InboxEvent[] = [
    { receipt_id: id, sequence: 1, state: 'received', reason: '', at, actor_email: uploader, on_behalf_of: actor.delegate ? actor.email : null, channel: 'app' },
    { receipt_id: id, sequence: 2, state: 'needs-attention', reason: ATTENTION, at, actor_email: uploader, on_behalf_of: actor.delegate ? actor.email : null, channel: 'app' },
  ];
  await storeReceipt(bucket, key, upload.bytes, upload.mediaType, hash);
  try {
    await commit(db, authority(actor, 'employee'), [
      db.prepare('INSERT INTO c_capture_receipts(id,owner_email,name,media_type,size,sha256,object_key,source,uploaded_by,uploaded_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .bind(id, actor.email, upload.name, upload.mediaType, upload.bytes.length, hash, key, upload.source, uploader, at),
      ...history.map(e => db.prepare('INSERT INTO c_capture_receipt_events(receipt_id,sequence,state,reason,at,actor_email,on_behalf_of,channel) VALUES(?,?,?,?,?,?,?,?)')
        .bind(id,e.sequence,e.state,e.reason,e.at,e.actor_email,e.on_behalf_of,e.channel)),
    ]);
  } catch (error) {
    await bucket.delete(key);
    throw error;
  }
  return { receipt: summary({ id, owner_email: actor.email, name: upload.name, media_type: upload.mediaType,
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
