import { PortabilityError } from '@runeditrun/rer/modules/portability';

/** Readings remain bound to their exact private original and consented settings version after restore. */
export async function validateReceiptReadingArchive(read) {
  const [settings, readings, defaults, originals] = await Promise.all(['c_receipt_reading_settings', 'c_receipt_readings', 'c_receipt_reading_match_defaults', 'c_capture_receipts'].map(read));
  const check = value => { if (!value) throw new PortabilityError('coaster_receipt_reading', 409); };
  if (!settings.length) { check(!readings.length && !defaults.length); return; }
  const versions = new Map(settings.map(row => [row.version, row])), receipts = new Map(originals.map(row => [row.id, row]));
  for (const row of settings) check(Number.isSafeInteger(row.version) && row.version >= 0 && [0, 1].includes(row.enabled) && row.threshold >= 0.9 && row.threshold <= 1 && typeof row.model === 'string');
  check(new Set(settings.map(row => row.version)).size === settings.length && settings.every((_, i) => versions.has(i)));
  const sequence = new Map();
  const names = ['merchant', 'date', 'total', 'subtotal', 'salesTax', 'tip', 'currency', 'last4', 'lineItems'];
  for (const row of [...readings].sort((a, b) => a.receipt_id.localeCompare(b.receipt_id) || a.sequence - b.sequence)) {
    const original = receipts.get(row.receipt_id), prior = sequence.get(row.receipt_id) ?? 0;
    check(original && row.original_sha256 === original.sha256 && Number.isSafeInteger(row.sequence) && row.sequence === prior + 1 && versions.has(row.settings_version));
    check((row.on_behalf_of === null ? row.actor_email === original.owner_email : row.on_behalf_of === original.owner_email && typeof row.actor_email === 'string' && row.actor_email.length > 0) && ['started', 'read', 'failed', 'corrected'].includes(row.kind));
    let fields, usage;
    try { fields = JSON.parse(row.fields_json); usage = JSON.parse(row.usage_json); } catch { check(false); }
    check(fields && typeof fields === 'object' && !Array.isArray(fields) && usage && typeof usage === 'object' && !Array.isArray(usage));
    if (['read', 'corrected'].includes(row.kind)) {
      check(Object.keys(fields).length === names.length && names.every(name => Object.hasOwn(fields, name)));
      for (const field of Object.values(fields)) check(field && typeof field === 'object' && typeof field.review === 'boolean' && ['reader', 'person'].includes(field.source) && Number.isFinite(field.confidence) && field.confidence >= 0 && field.confidence <= 1 && Array.isArray(field.regions) && Array.isArray(field.reasons));
    } else check(!Object.keys(fields).length);
    sequence.set(row.receipt_id, row.sequence);
  }
  for (const row of defaults) check(typeof row.employee_email === 'string' && Number.isSafeInteger(row.version) && row.version > 0 && [0, 1].includes(row.enabled));
}
