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
  const prior: Data[] = history.flatMap(c => {
    const snapshot = JSON.parse(c.snapshot);
    return snapshot.items.map((i: Data) => ({ ...i, employee: c.employee_email, claim: c.id, number: c.number, receiptId: i.receipt?.id ?? i.receipt_id, receiptSha: i.receipt?.sha256, image: snapshot.receiptSignals?.find((r: Data) => r.item === i.id)?.image }));
  });
  const current: Data[] = items.map(i => ({ ...i, employee: claim.employee_email, claim: claimId, currency: claim.currency, attendees: JSON.parse(i.attendees), allocations: allocations.filter(a => a.item_id === i.id) }));
  const active = await policyConfiguration(db, await requireBusiness(db), await categories(db));
  const results: Data[] = [];
  // Read each current original once. Retain only compact derived evidence between
  // comparisons, not every receipt's full bytes or a quadratic number of D1 reads.
  for (const item of current) {
    const receipt = item.receipt_id ? await db.prepare('SELECT * FROM c_receipts WHERE id=?').bind(item.receipt_id).first<Data>() : null;
    const bytes = receipt ? await claimReceiptBytes(db, receipt, bucket) : null;
    const metadata = bytes ? inspectReceiptMetadata(bytes, receipt!.media_type, item.spent_on) : { status: 'no receipt', fields: {}, signals: [] };
    const image = bytes ? await inspectReceiptImage(bytes, receipt!.media_type) : { status: 'no receipt', observations: [] };
    const signals: AdvisorySignal[] = [...metadata.signals, ...image.observations, ...spendSignals(item, [...prior, ...current], active.categories, claim.currency, active.rules), ...cardDisagreement(item)];
    results.push({ item: item.id, receipt: receipt?.id ?? null, sha256: receipt?.sha256 ?? null, ...metadata, image, signals });
  }
  const candidates: Data[] = [...prior, ...results.map(r => ({ id: r.item, claim: claimId, receiptId: r.receipt, receiptSha: r.sha256, image: r.image }))];
  for (const result of results.filter(r => r.receipt)) for (const candidate of candidates) {
    if (candidate.id === result.item || !candidate.receiptId) continue;
    // Revisions from before image inspection are examined from their retained original on first comparison.
    if (!candidate.image || !candidate.receiptSha) {
      const original = await db.prepare('SELECT * FROM c_receipts WHERE id=?').bind(candidate.receiptId).first<Data>();
      if (!original) continue;
      candidate.receiptSha = original.sha256;
      candidate.image ??= await inspectReceiptImage(await claimReceiptBytes(db, original, bucket), original.media_type);
    }
    const reference = candidate.number ? `claim CL-${String(candidate.number).padStart(4, '0')}` : 'another expense in this claim';
    if (candidate.receiptSha === result.sha256) {
      if (!result.signals.some((s: AdvisorySignal) => s.code === 'same-receipt')) result.signals.push(observation('same-receipt', `Identical receipt SHA-256 ${result.sha256} on ${reference}. Review the shared original and its allocation.`, { sha256: result.sha256, item: candidate.id, claim: candidate.claim }));
    } else if (result.image.fingerprint && candidate.image.fingerprint) {
      const compared = compareReceiptImages(result.image.fingerprint, candidate.image.fingerprint);
      for (const signal of compared.signals) if (!result.signals.some((s: AdvisorySignal) => s.code === signal.code)) result.signals.push({ ...signal, reason: `${signal.reason} Compared with ${reference}, receipt SHA-256 ${candidate.receiptSha}.`, evidence: { ...compared.evidence, receiptSha256: candidate.receiptSha, item: candidate.id, claim: candidate.claim } });
    }
  }
  return results;
}
