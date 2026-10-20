import type { ClaimItem, PolicyException } from './exceptions';
import type { policyConfiguration } from './policy-configuration';

type ActivePolicy = Awaited<ReturnType<typeof policyConfiguration>>;
type Reason = { code: string; message: string; policy?: number };

/** Advisory evidence only: the actual submission evaluator supplies the exceptions.
 * Receipt presence and a fingerprint do not establish what a receipt says. */
export function policyReview(items: ClaimItem[], exceptions: PolicyException[], active: ActivePolicy) {
  return {
    method: 'deterministic-policy-review' as const,
    policyVersion: active.version,
    recommendations: items.map(item => {
      const found = exceptions.filter(exception => exception.item === item.id);
      const reasons: Reason[] = found.length
        ? found.map(({ code, message, policy }) => ({ code, message, ...(policy === undefined ? {} : { policy }) }))
        : [{ code: 'no-policy-exception', message: `No configured-policy exception was raised for this expense under policy v${active.version}. This advice grants no approval; the configured workflow or owner rule still applies.`, policy: active.version }];
      return {
        item: item.id,
        recommendation: found.length ? 'review' as const : 'no-policy-exception' as const,
        reasons,
        evidence: {
          receipt: item.receipt_id ? { id: item.receipt_id, sha256: item.receipt_sha256 ?? null } : null,
          amountMinor: item.amount_minor,
          date: item.spent_on,
          allocations: item.allocations.map(part => ({ category: part.category_id as string, amountMinor: part.amount_minor as number })),
          requestId: (item.request_id as string | null | undefined) ?? null,
          checksUnavailable: ['receipt-content', 'card-match', 'coding-confidence'],
        },
      };
    }),
  };
}
