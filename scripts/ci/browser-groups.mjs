// Every former push command and refusal slice appears exactly once. Commands
// within a suite retain their order; independent suites share two worker slots.
// The build is produced once by Verify and downloaded by every shard.
export const groups = {
  'journeys-0': [
    { evidence: 'browser', commands: [['tests/browser.mjs']], env: { COASTER_ARCHIVE_REFUSALS: '0/2' } },
    { evidence: 'flows', commands: [['tests/coaster-suite.mjs']], env: { COASTER_SHARD: '2/2' } },
    { evidence: 'email', commands: [['tests/browser-email.mjs']] },
  ],
  'journeys-1': [
    { evidence: 'browser', commands: [['tests/browser.mjs']], env: { COASTER_ARCHIVE_REFUSALS: '1/2' } },
    { evidence: 'policy-signals-scale', commands: [['tests/policy-signals-scale.mjs']] },
    { evidence: 'bulk-approvals', commands: [['tests/browser-bulk-approvals.mjs']] },
    { evidence: 'card-chases', commands: [['tests/browser-card-chases.mjs']] },
  ],
  'capture-0': [
    { evidence: 'capture', commands: [['tests/capture.mjs']], env: { CAPTURE_REFUSALS: '0/3' } },
    { evidence: 'receipt-reading', commands: [['tests/browser-reading.mjs']] },
    { evidence: 'receipt-agents', commands: [['tests/browser-agents.mjs']] },
    { evidence: 'bank', commands: [['tests/browser-bank.mjs']] },
  ],
  'capture-1': [
    { evidence: 'capture', commands: [['tests/capture.mjs']], env: { CAPTURE_REFUSALS: '1/3' } },
    { evidence: 'cash', commands: [['tests/capture-cash.mjs']] },
    { evidence: 'accessibility', commands: [['tests/accessibility.mjs']] },
    { evidence: 'desktop', commands: [['tests/browser-desktop.mjs']] },
  ],
  'capture-2': [
    { evidence: 'capture', commands: [['tests/capture.mjs']], env: { CAPTURE_REFUSALS: '2/3' } },
    { evidence: 'policy-review', commands: [['tests/browser-policy-review.mjs']] },
    { evidence: 'bank-archive', commands: [['tests/bank-archive.mjs']] },
  ],
  'matching-0': [
    { evidence: 'card-matching', commands: [['tests/card-matching.mjs']], env: { MATCH_REFUSALS: '0/3' } },
    { evidence: 'policy-corpus', commands: [['tests/automatic-coding-quality.mjs', '--policy-agent']] },
    { evidence: 'policy-signals-browser', commands: [['tests/policy-signals-browser.mjs']] },
  ],
  'matching-1': [
    { evidence: 'card-matching', commands: [['tests/card-matching.mjs']], env: { MATCH_REFUSALS: '1/3' } },
    { evidence: 'flows', commands: [['tests/coaster-suite.mjs']], env: { COASTER_SHARD: '1/2' } },
    { evidence: 'email-archive', commands: [['tests/email-archive.mjs']] },
  ],
  'matching-2': [
    { evidence: 'card-matching', commands: [['tests/card-matching.mjs']], env: { MATCH_REFUSALS: '2/3' } },
    { evidence: 'app', commands: [['scripts/ci/run-app-checks.mjs']] },
    { evidence: 'payroll', commands: [['tests/browser-payroll.mjs'], ['tests/payroll-archive.mjs']], env: { COASTER_SHARD: '2/2' } },
  ],
}
