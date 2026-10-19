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
    'claim-retracted': `Retracted by ${who} before any decision on revision ${d.revision}${d.reason ? ` · ${d.reason}` : ''}`,
    'claim-unapproved': `Unapproved by ${who} and sent back to the ${d.to === 'approver' ? 'approver' : 'employee'} · ${d.reason}`,
    'comment-added': `${who} commented · “${d.body}”`, 'question-asked': `${who} asked ${names[d.asks] ?? d.asks} · “${d.body}”`,
    'question-answered': `${who} answered · “${d.body}”`, 'comment-edited': `${who} edited a comment · was “${d.previous}”`,
    'claim-split': `${who} held ${plural(d.held, 'expense')} and approved the rest${d.onBehalfOf ? ` on behalf of ${names[d.onBehalfOf] ?? d.onBehalfOf}` : ''} · ${d.reason}`,
    'claim-held': `Held by ${who} from ${d.fromNumber} revision ${d.fromRevision} · ${d.reason}`, 'hold-released': `Hold released and approved by ${who}${d.reason ? ` · ${d.reason}` : ''}`,
    'claim-reassigned': `Moved from ${names[d.from] ?? d.from} to ${names[d.to] ?? d.to} by ${who}${d.reason ? ` · ${d.reason}` : ''}`,
    'claim-batched': d.claim && d.batch ? `${d.claim} added to ${d.batch} by ${who}` : `Added to a reimbursement batch by ${who}`, 'claim-unbatched': `Taken out of a draft batch by ${who}${d.unapproved ? ' when it was unapproved' : ''}`,
    'proposal-accepted': `Prepared by ${d.agent} and accepted by ${who}`,
    'batch-created': `Batch created by ${who}${d.preparedBy ? ` from ${d.preparedBy}’s proposal` : ''} · ${plural(d.claims, 'claim')} · ${money(d.totalMinor ?? 0)}`,
    'batch-approved': `Reviewed and approved by ${who} · ${money(d.totalMinor ?? 0)}`, 'batch-exported': `${d.file === 'accounting' ? 'Accounting' : 'Reimbursement'} file downloaded by ${who} · ${d.rows} rows`,
    'delegate-granted': `${who} gave ${names[d.delegate] ?? d.delegate} ${d.level === 'full' ? 'Full' : 'Submit only'} delegate access for ${names[d.grantor] ?? d.grantor}`,
    'delegate-revoked': `${who} ended ${names[d.delegate] ?? d.delegate}’s delegate access for ${names[d.grantor] ?? d.grantor}`,
    'batch-reimbursed': `Marked paid by ${who} · reference ${d.reference} on ${day(d.paidOn)}`,
    'audit-pack-exported': `Audit pack for ${day(d.from)} to ${day(d.to)} downloaded by ${who} · ${plural(d.claims, 'claim')}, ${plural(d.receipts, 'receipt')}`,
  };
  // A delegate's line is theirs, on behalf of the person they acted for (approvals already say so).
  const forWhom = d.actingFor && d.actingFor !== d.onBehalfOf ? ` on behalf of ${names[d.actingFor] ?? d.actingFor}` : '';
  return (words[e.action] ?? `${e.action.replace(/-/g, ' ')} by ${who}`) + forWhom + agent;
}
