import { day, money, plural, type D } from './api';

/** One history line in plain words; exact values stay in the event detail. */
export function describe(e: D, names: Record<string, string> = {}) {
  const who = names[e.actor_email] ?? e.actor_email, d = e.detail ?? {}, agent = d.agent && !e.action.startsWith('proposal-') ? ` (through ${d.agent})` : '';
  const words: Record<string, string> = {
    'native-work-proposed': `${who} requested a ${d.preparation} proposal`, 'trip-expenses-grouped': `${who} grouped expenses into a trip draft`,
    'card-charge-marked-personal': `${who} marked a company-card charge personal · ${money(d.outstandingMinor ?? 0, d.currency)} unpaid`,
    'claim-created': `Started by ${who}`, 'claim-renamed': `Renamed by ${who} to “${d.title}”`,
    'expense-added': `${who} added ${d.merchant} · ${money(d.amountMinor ?? 0)}`, 'expense-changed': `${who} changed ${d.merchant}`, 'expense-removed': `${who} removed ${d.merchant}`,
    'receipt-signal-reviewed': `${who} reviewed receipt/spend signal (${d.code}) on revision ${d.revision} · ${d.note}`,
    'receipt-added': `${who} added receipt ${d.name}`, 'claim-submitted': `Submitted by ${who}${d.exceptions ? ` · ${plural(d.exceptions, 'exception')} explained` : ''}`,
    'claim-step-approved': d.workflowVersion ? `Review by ${who}${d.onBehalfOf ? ` on behalf of ${names[d.onBehalfOf] ?? d.onBehalfOf}` : ''} completed in stage ${d.stage + 1} of ${d.stages}; waiting for ${names[d.nextApprover] ?? d.nextApprover}${d.reason ? ` · ${d.reason}` : ''}` : `Step ${d.step} of ${d.steps} approved by ${who}; next: ${names[d.nextApprover] ?? d.nextApprover}${d.reason ? ` · ${d.reason}` : ''}`,
    'claim-resubmitted': `Resubmitted by ${who} as revision ${d.revision}`, 'claim-approved': `Approved by ${who}${d.onBehalfOf ? ` on behalf of ${names[d.onBehalfOf] ?? d.onBehalfOf}` : ''}${d.reason ? ` · ${d.reason}` : ''}${d.exceptionsAcknowledged ? ` · ${plural(d.exceptionsAcknowledged, 'exception')} acknowledged` : ''}`,
    'claim-returned': `Returned by ${who}${d.onBehalfOf ? ` on behalf of ${names[d.onBehalfOf] ?? d.onBehalfOf}` : ''} · ${d.reason}`, 'claim-rejected': `Rejected by ${who}${d.onBehalfOf ? ` on behalf of ${names[d.onBehalfOf] ?? d.onBehalfOf}` : ''} · ${d.reason}`,
    'claim-retracted': `Retracted by ${who} before any decision on revision ${d.revision}${d.reason ? ` · ${d.reason}` : ''}`,
    'claim-unapproved': `Unapproved by ${who} and sent back to the ${d.to === 'approver' ? 'approver' : 'employee'} · ${d.reason}`,
    'comment-added': `${who} commented · “${d.body}”`, 'question-asked': `${who} asked ${names[d.asks] ?? d.asks} · “${d.body}”`,
    'question-answered': `${who} answered · “${d.body}”`, 'comment-edited': `${who} edited a comment · was “${d.previous}”`,
    'claim-split': `${who} held ${plural(d.held, 'expense')} and approved the rest${d.onBehalfOf ? ` on behalf of ${names[d.onBehalfOf] ?? d.onBehalfOf}` : ''} · ${d.reason}`,
    'claim-held': `Held by ${who} from ${d.fromNumber} revision ${d.fromRevision} · ${d.reason}`, 'hold-released': `Hold released and approved by ${who}${d.reason ? ` · ${d.reason}` : ''}`,
    'workflow-review-reassigned': `Moved ${d.role} review from ${names[d.from] ?? d.from} to ${names[d.to] ?? d.to} by ${who} · ${d.reason}`,
    'claim-reassigned': `Moved from ${names[d.from] ?? d.from} to ${names[d.to] ?? d.to} by ${who}${d.reason ? ` · ${d.reason}` : ''}`,
    'claim-batched': d.claim && d.batch ? `${d.claim} added to ${d.batch} by ${who}` : `Added to a reimbursement batch by ${who}`, 'claim-unbatched': `Taken out of a draft batch by ${who}${d.unapproved ? ' when it was unapproved' : ''}`,
    'proposal-accepted': `Prepared by ${d.agent} and accepted by ${who}`,
    'batch-created': `Batch created by ${who}${d.preparedBy ? ` from ${d.preparedBy}’s proposal` : ''} · ${plural(d.claims, 'claim')} · ${money(d.totalMinor ?? 0)}`,
    'batch-approved': `Reviewed and approved by ${who} · ${money(d.totalMinor ?? 0)}`, 'batch-exported': `${d.file === 'accounting' ? 'Accounting' : 'Reimbursement'} file downloaded by ${who} · ${d.rows} rows`,
    'delegate-granted': `${who} gave ${names[d.delegate] ?? d.delegate} ${d.level === 'full' ? 'Full' : 'Submit only'} delegate access for ${names[d.grantor] ?? d.grantor}`,
    'member-invited': `${who} invited ${names[d.email] ?? d.email} to sign in`,
    'import-committed': `${who} imported ${d.source} history · ${d.state}`, 'import-resumed': `${who} resumed the ${d.source} import · ${d.state}`, 'import-undone': `${who} undid the ${d.source} import · ${d.state}`,
    'delegate-revoked': `${who} ended ${names[d.delegate] ?? d.delegate}’s delegate access for ${names[d.grantor] ?? d.grantor}`,
    'batch-reimbursed': `Marked paid by ${who} · reference ${d.reference} on ${day(d.paidOn)}`,
    'payroll-connected': `${who} connected the Gusto sandbox company`,
    'payroll-disconnected': `${who} disconnected Gusto sandbox`,
    'payroll-employee-mapped': `${who} mapped ${names[d.email] ?? d.email} to a Gusto employee`,
    'payroll-prepare-requested': `${who} requested the next Gusto payroll for this batch`,
    'payroll-handoff-reserved': `${who} authorized this batch’s Gusto handoff · ${money(d.totalMinor ?? 0)}`,
    'payroll-handoff-sent': `${who} checked the reimbursement and taxable pay lines in Gusto`,
    'bank-provider-connected': `${who} connected ${d.provider} for employee bank verification`, 'bank-provider-disconnected': `${who} disconnected ${d.provider}`,
    'bank-account-pending': `${who} started adding a bank account by micro-deposits`, 'bank-account-abandoned': `${who} ended the pending bank account · ${d.reason}`,
    'bank-account-added': `${who} added a bank account · ${d.method === 'instant' ? 'verified instantly' : 'verified by micro-deposits'}`,
    'bank-account-changed': `${who} changed their bank account · ${d.method === 'instant' ? 'verified instantly' : 'verified by micro-deposits'}`,
    'bank-hold-started': `Payments to ${who} held for ${plural(d.holdDays ?? 0, 'day')} after the bank change`, 'bank-hold-released': 'Bank change hold released after the cooling-off period',
    'bank-notice-sent': `Bank change notice to ${names[d.to] ?? d.to} · ${d.status}`, 'bank-hold-period-set': `${who} set the bank change cooling-off period to ${plural(d.days ?? 0, 'day')}`,
    'batch-release-first': `First release by ${who} · over ${money(d.dualReleaseOverMinor ?? 0)}, waiting for a second releaser`,
    'batch-released': `Released for payment by ${who}${d.firstReleasedBy ? ` after ${names[d.firstReleasedBy] ?? d.firstReleasedBy}` : ''} · ${money(d.totalMinor ?? 0)} · recent sign-in`,
    'expense-non-accountable': `${who} marked ${d.merchant} on ${d.claim} non-accountable (taxable pay) · ${d.reason}`, 'expense-accountable': `${who} returned ${d.merchant} on ${d.claim} to the accountable plan · ${d.reason}`,
    'release-granted': `${who} gave ${names[d.email] ?? d.email} release access`, 'release-revoked': `${who} ended ${names[d.email] ?? d.email}’s release access`,
    'payment-controls-set': `Payment controls set by ${who} · dual release ${d.dualReleaseOverMinor == null ? 'off' : `above ${money(d.dualReleaseOverMinor)}`} · ${d.payWeekday ? `batches open every ${d.payWeekday}` : 'no reimbursement day'}`,
    'audit-pack-exported': `Audit pack for ${day(d.from)} to ${day(d.to)} downloaded by ${who} · ${plural(d.claims, 'claim')}, ${plural(d.receipts, 'receipt')}`,
  };
  // A delegate's line is theirs, on behalf of the person they acted for (approvals already say so).
  const forWhom = d.actingFor && d.actingFor !== d.onBehalfOf ? ` on behalf of ${names[d.actingFor] ?? d.actingFor}` : '';
  return (words[e.action] ?? `${e.action.replace(/-/g, ' ')} by ${who}`) + forWhom + agent + (d.channel === 'bulk' ? ` · bulk approval · revision ${d.revision}` : '');
}
