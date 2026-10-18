import { day, money, plural, type D } from './api';

/** One history line in plain words; exact values stay in the event detail. */
export function describe(e: D, names: Record<string, string> = {}) {
  const who = names[e.actor_email] ?? e.actor_email, d = e.detail ?? {}, agent = d.agent && !e.action.startsWith('proposal-') ? ` (through ${d.agent})` : '';
  const words: Record<string, string> = {
    'claim-created': `Started by ${who}`, 'claim-renamed': `Renamed by ${who} to “${d.title}”`,
    'expense-added': `${who} added ${d.merchant} · ${money(d.amountMinor ?? 0)}`, 'expense-changed': `${who} changed ${d.merchant}`, 'expense-removed': `${who} removed ${d.merchant}`,
    'receipt-added': `${who} added receipt ${d.name}`, 'claim-submitted': `Submitted by ${who}${d.exceptions ? ` · ${plural(d.exceptions, 'exception')} explained` : ''}`,
    'claim-resubmitted': `Resubmitted by ${who} as revision ${d.revision}`, 'claim-approved': `Approved by ${who}${d.onBehalfOf ? ` on behalf of ${names[d.onBehalfOf] ?? d.onBehalfOf}` : ''}${d.reason ? ` · ${d.reason}` : ''}${d.exceptionsAcknowledged ? ` · ${plural(d.exceptionsAcknowledged, 'exception')} acknowledged` : ''}`,
    'claim-returned': `Returned by ${who}${d.onBehalfOf ? ` on behalf of ${names[d.onBehalfOf] ?? d.onBehalfOf}` : ''} · ${d.reason}`, 'claim-rejected': `Rejected by ${who}${d.onBehalfOf ? ` on behalf of ${names[d.onBehalfOf] ?? d.onBehalfOf}` : ''} · ${d.reason}`,
    'claim-reassigned': `Moved from ${names[d.from] ?? d.from} to ${names[d.to] ?? d.to} by ${who}${d.reason ? ` · ${d.reason}` : ''}`,
    'claim-batched': d.claim && d.batch ? `${d.claim} added to ${d.batch} by ${who}` : `Added to a reimbursement batch by ${who}`, 'claim-unbatched': `Taken out of a draft batch by ${who}`,
    'proposal-accepted': `Prepared by ${d.agent} and accepted by ${who}`,
    'batch-created': `Batch created by ${who}${d.preparedBy ? ` from ${d.preparedBy}’s proposal` : ''} · ${plural(d.claims, 'claim')} · ${money(d.totalMinor ?? 0)}`,
    'batch-approved': `Reviewed and approved by ${who} · ${money(d.totalMinor ?? 0)}`, 'batch-exported': `${d.file === 'accounting' ? 'Accounting' : 'Reimbursement'} file downloaded by ${who} · ${d.rows} rows`,
    'batch-reimbursed': `Marked paid by ${who} · reference ${d.reference} on ${day(d.paidOn)}`,
  };
  return (words[e.action] ?? `${e.action.replace(/-/g, ' ')} by ${who}`) + agent;
}
