import { inspectReceiptMetadata } from './receipt-metadata';
import { inspectReceiptImage, compareReceiptImages } from './receipt-image';
import { claimReceiptBytes } from './receipts/claim-storage';
import { categories } from './items';
import { requireBusiness } from './settings';
import { policyConfiguration } from './policy-configuration';
import { cardDisagreement, observation, spendSignals, type AdvisorySignal } from './spend-signals';
import type { Data } from './types';

/** Advisory observations stay separate from eligibility and immutable on submission.
 * Comparison evidence comes from submitted revisions, never another employee's private inbox. */
export async function receiptSignals(db: D1Database, claimId: string, bucket?: R2Bucket) {
  const claim = (await db.prepare('SELECT employee_email,currency FROM c_claims WHERE id=?').bind(claimId).first<Data>())!;
  const items = (await db.prepare('SELECT i.*,r.card_match_basis FROM c_items i LEFT JOIN c_receipts r ON r.id=i.receipt_id WHERE i.claim_id=? ORDER BY i.position').bind(claimId).all<Data>()).results;
  const allocations = (await db.prepare('SELECT a.* FROM c_allocations a JOIN c_items i ON i.id=a.item_id WHERE i.claim_id=?').bind(claimId).all<Data>()).results;
  const history = (await db.prepare("SELECT c.id,c.number,c.employee_email,r.snapshot FROM c_claims c JOIN c_revisions r ON r.claim_id=c.id AND r.revision=c.revision WHERE c.id<>? AND c.status IN ('submitted','approved','batched','reimbursed')").bind(claimId).all<Data>()).results;
  const prior = history.flatMap(c => {
    const snapshot = JSON.parse(c.snapshot);
    return snapshot.items.map((i: Data) => ({ ...i, employee: c.employee_email, claim: c.id, number: c.number, receiptId: i.receipt?.id ?? i.receipt_id, receiptSha: i.receipt?.sha256, image: snapshot.receiptSignals?.find((r: Data) => r.item === i.id)?.image }));
  });
  const current: Data[] = items.map(i => ({ ...i, employee: claim.employee_email, claim: claimId, currency: claim.currency, attendees: JSON.parse(i.attendees), allocations: allocations.filter(a => a.item_id === i.id) }));
  const active = await policyConfiguration(db, await requireBusiness(db), await categories(db));
  const results: Data[] = [], imageCache = new Map<string, Data>();
  const inspect = async (receipt: Data, bytes?: Uint8Array) => {
    if (!imageCache.has(receipt.id)) imageCache.set(receipt.id, await inspectReceiptImage(bytes ?? await claimReceiptBytes(db, receipt, bucket), receipt.media_type));
    return imageCache.get(receipt.id)!;
  };
  for (const item of current) {
    const receipt = item.receipt_id ? await db.prepare('SELECT * FROM c_receipts WHERE id=?').bind(item.receipt_id).first<Data>() : null;
    const bytes = receipt ? await claimReceiptBytes(db, receipt, bucket) : null;
    const metadata = bytes ? inspectReceiptMetadata(bytes, receipt!.media_type, item.spent_on) : { status: 'no receipt', fields: {}, signals: [] };
    const image = bytes ? await inspect(receipt!, bytes) : { status: 'no receipt' };
    const signals: AdvisorySignal[] = [...metadata.signals, ...('observations' in image ? image.observations : []), ...spendSignals(item, [...prior, ...current], active.categories, claim.currency, active.rules), ...cardDisagreement(item)];
    const candidates = [...prior, ...current.filter(i => i.id !== item.id).map(i => ({ ...i, receiptId: i.receipt_id, receiptSha: results.find(r => r.item === i.id)?.sha256, image: results.find(r => r.item === i.id)?.image }))];
    if (receipt) for (const candidate of candidates) {
      if (candidate.id === item.id || !candidate.receiptId) continue;
      let sha = candidate.receiptSha, otherImage = candidate.image;
      // Revisions from before image inspection are examined from their retained original on first comparison.
      if (!otherImage || !sha) {
        const original = await db.prepare('SELECT * FROM c_receipts WHERE id=?').bind(candidate.receiptId).first<Data>();
        if (!original) continue;
        sha = original.sha256;
        otherImage ??= await inspect(original);
        candidate.receiptSha = sha; candidate.image = otherImage;
      }
      const reference = candidate.number ? `claim CL-${String(candidate.number).padStart(4, '0')}` : 'another expense in this claim';
      if (sha === receipt.sha256) {
        if (!signals.some(s => s.code === 'same-receipt')) signals.push(observation('same-receipt', `Identical receipt SHA-256 ${sha} on ${reference}. Review the shared original and its allocation.`, { sha256: sha, item: candidate.id, claim: candidate.claim }));
      } else if (image.fingerprint && otherImage.fingerprint) {
        const compared = compareReceiptImages(image.fingerprint, otherImage.fingerprint);
        for (const signal of compared.signals) if (!signals.some(s => s.code === signal.code)) signals.push({ ...signal, reason: `${signal.reason} Compared with ${reference}, receipt SHA-256 ${sha}.`, evidence: { ...compared.evidence, receiptSha256: sha, item: candidate.id, claim: candidate.claim } });
      }
    }
    results.push({ item: item.id, receipt: receipt?.id ?? null, sha256: receipt?.sha256 ?? null, ...metadata, image, signals });
  }
  return results;
}
