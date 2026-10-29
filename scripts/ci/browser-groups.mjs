// Packed from Verify push 40313453076 step times, in seconds.
// Test bodies total 145.9 minutes: eight sequential jobs cannot fit a 12-minute budget.
// Fifteen shards is the minimum packing at 690 seconds, isolating the three
// existing indivisible commands already above that budget (app, journeys-1, matching-0).
// Fresh-clone build/preview/deploy journeys deliberately keep their own builds.
export const groups = {
  'journeys-0': [
    {"evidence": "browser", "commands": [["tests/browser.mjs"]], "env": {"COASTER_ARCHIVE_REFUSALS": "0/2"}},
    {"evidence": "policy-signals-browser", "commands": [["tests/policy-signals-browser.mjs"]]},
  ],
  'journeys-1': [
    {"evidence": "browser", "commands": [["tests/browser.mjs"]], "env": {"COASTER_ARCHIVE_REFUSALS": "1/2"}},
  ],
  'capture-0': [
    {"evidence": "capture", "commands": [["tests/capture.mjs"]], "env": {"CAPTURE_REFUSALS": "0/3"}},
  ],
  'capture-1-email': [
    {"evidence": "capture", "commands": [["tests/capture.mjs"]], "env": {"CAPTURE_REFUSALS": "1/3"}},
    {"evidence": "email", "commands": [["tests/browser-email.mjs"], ["tests/email-archive.mjs"]]},
  ],
  'capture-2': [
    {"evidence": "capture", "commands": [["tests/capture.mjs"]], "env": {"CAPTURE_REFUSALS": "2/3"}},
  ],
  // Split the former 0/3 refusal slice into 0/9, 3/9 and 6/9 for CLI headroom.
  // Only 0/9 owns the part-0 reading, feed and automatic-coding journeys.
  'matching-0': [
    {"evidence": "card-matching", "commands": [["tests/card-matching.mjs"]], "env": {"MATCH_REFUSALS": "0/9"}},
  ],
  'matching-1': [
    {"evidence": "card-matching", "commands": [["tests/card-matching.mjs"]], "env": {"MATCH_REFUSALS": "1/3"}},
  ],
  'matching-2': [
    {"evidence": "card-matching", "commands": [["tests/card-matching.mjs"]], "env": {"MATCH_REFUSALS": "2/3"}},
  ],
  'matching-3': [
    {"evidence": "card-matching", "commands": [["tests/card-matching.mjs"]], "env": {"MATCH_REFUSALS": "3/9"}},
  ],
  'matching-4': [
    {"evidence": "card-matching", "commands": [["tests/card-matching.mjs"]], "env": {"MATCH_REFUSALS": "6/9"}},
  ],
  'cash-accessibility': [
    { evidence: 'account-corrections', commands: [['tests/browser-accounting-corrections.mjs'], ['tests/accounting-corrections-archive.mjs']] },
    {"evidence": "cash", "commands": [["tests/capture-cash.mjs"]]},
    {"evidence": "accessibility", "commands": [["tests/accessibility.mjs"]]},
  ],
  'policy-signals-scale': [
    {"evidence": "policy-signals-scale", "commands": [["tests/policy-signals-scale.mjs"]]},
  ],
  'policy-review': [
    { evidence: 'bulk-approvals', commands: [['tests/browser-bulk-approvals.mjs']] },
    { evidence: 'card-chases', commands: [['tests/browser-card-chases.mjs']] },
    { evidence: 'bank-archive', commands: [['tests/bank-archive.mjs']] },
    {"evidence": "policy-review", "commands": [["tests/browser-policy-review.mjs"]]},
  ],
  'payroll-corpus': [
    { evidence: 'bank', commands: [['tests/browser-bank.mjs']] },
    {"evidence": "payroll", "commands": [["tests/browser-payroll.mjs"], ["tests/payroll-archive.mjs"]], "env": {"COASTER_SHARD": "2/2"}},
    {"evidence": "policy-corpus", "commands": [["tests/automatic-coding-quality.mjs", "--policy-agent"]]},
  ],
}
