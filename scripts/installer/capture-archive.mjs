import { PortabilityError } from '@runeditrun/rer/modules/portability';

const check = (ok, code) => { if (!ok) throw new PortabilityError('coaster_capture_' + code, 409); };
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const mediaTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);
const states = new Set(['received', 'reading', 'read', 'needs-attention']);

/** Base verifies each object's actual bytes against its manifest hash before
 * calling this hook. Bind those verified objects to D1's immutable evidence;
 * matching only the object key would allow a re-sealed, inconsistent archive. */
export async function validateCaptureArchive(read, manifest) {
  const [receipts, events, erasing] = await Promise.all([read('c_capture_receipts'), read('c_capture_receipt_events'), read('c_capture_erasing')]);
  check(erasing.length === 0, 'erasure_guard');
  const objects = manifest?.objects.filter(object => object.bucket === 'COASTER_RECEIPTS') ?? [];
  check(objects.length === receipts.length, 'objects');
  const byKey = new Map(objects.map(object => [object.key, object]));
  const byId = new Map(receipts.map(receipt => [receipt.id, receipt]));
  const lifecycle = await read('c_capture_lifecycle'), discarded = new Set();
  for (const event of lifecycle) {
    const receipt = byId.get(event.receipt_id);
    check(receipt && !discarded.has(event.receipt_id), 'lifecycle_receipt');
    check(event.sequence === 1 && event.kind === 'discarded'
      && typeof event.reason === 'string' && event.reason === event.reason.trim()
      && event.reason.length > 0 && event.reason.length <= 1000
      && timestamp(event.at) && event.at >= receipt.uploaded_at, 'lifecycle');
    check(event.channel === 'app' && typeof event.actor_email === 'string' && event.actor_email.length > 0
      && event.on_behalf_of === (event.actor_email === receipt.owner_email ? null : receipt.owner_email), 'lifecycle_provenance');
    discarded.add(event.receipt_id);
  }
  check(byKey.size === objects.length && byId.size === receipts.length, 'objects');
  const history = new Map();
  for (const event of events) {
    check(byId.has(event.receipt_id), 'event_receipt');
    check(Number.isSafeInteger(event.sequence) && event.sequence > 0 && states.has(event.state)
      && typeof event.reason === 'string' && timestamp(event.at), 'history');
    check(event.channel === 'app' && typeof event.actor_email === 'string' && event.actor_email.length > 0
      && (event.on_behalf_of === null || (typeof event.on_behalf_of === 'string' && event.on_behalf_of.length > 0)), 'provenance');
    check(event.state !== 'needs-attention' || event.reason.trim().length > 0, 'history');
    if (!history.has(event.receipt_id)) history.set(event.receipt_id, []);
    history.get(event.receipt_id).push(event);
  }
  for (const receipt of receipts) {
    check(typeof receipt.id === 'string' && receipt.id.length > 0
      && typeof receipt.sha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.sha256), 'provenance');
    check(typeof receipt.owner_email === 'string' && receipt.owner_email.length > 0
      && typeof receipt.uploaded_by === 'string' && receipt.uploaded_by.length > 0 && timestamp(receipt.uploaded_at)
      && ['upload', 'camera'].includes(receipt.source), 'provenance');
    check(typeof receipt.name === 'string' && receipt.name.trim().length > 0 && receipt.name.length <= 200
      && !/[\u0000-\u001f\u007f]/.test(receipt.name) && mediaTypes.has(receipt.media_type)
      && Number.isSafeInteger(receipt.size) && receipt.size > 0 && receipt.size <= 10_000_000, 'provenance');
    check(receipt.object_key === `receipt-inbox/${receipt.id}/${receipt.sha256}`, 'object_key');
    const object = byKey.get(receipt.object_key);
    check(object && object.size === receipt.size && object.sha256 === receipt.sha256, 'bytes');
    check(object.httpMetadata?.contentType === receipt.media_type
      && Object.keys(object.httpMetadata).length === 1 && Object.keys(object.customMetadata ?? {}).length === 0, 'metadata');
    const own = (history.get(receipt.id) ?? []).sort((a, b) => a.sequence - b.sequence);
    check(own.length > 0 && own[0].state === 'received' && own[0].reason === ''
      && own[0].at === receipt.uploaded_at, 'history');
    check(own[0].actor_email === receipt.uploaded_by
      && own[0].on_behalf_of === (receipt.uploaded_by === receipt.owner_email ? null : receipt.owner_email), 'provenance');
    check(own.every((event, index) => event.sequence === index + 1
      && (index === 0 || event.at >= own[index - 1].at)), 'history');
  }
}
