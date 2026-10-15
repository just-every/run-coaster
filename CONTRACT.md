# Coaster first-release contract

Coaster runs expenses and reimbursement for one Australian business of roughly
15–75 people: employees submit receipt-backed claims, their managers approve or
return them, and finance reconciles approved claims into a reviewed
reimbursement batch and an accounting CSV. It runs on the owner's own
Cloudflare account with no provider account, card, bank or payout service.

Each clause says what a person can do and how it is proven. Every clause is
proven by the flow test of the same number in `tests/coaster.test.mjs`
(real workerd, D1 and native sign-in through the public HTTP API) unless it
names another proof. `tests/browser.mjs` drives the same flows through the
screens at 1440 and 390 pixels wide.

| ID | What a person can do | Proof |
|---|---|---|
| COA-001 | The owner names the one business, sets its one currency (fixed once claims exist), timezone, mileage rate per km, optional per-diem rate and receipt threshold; adds categories with account code, tax code and optional per-expense limit; adds people as employee, manager and/or finance with each employee's approving manager. Nobody else can change these. | `COA-001 …` |
| COA-002 | An employee starts a claim and adds purchases with a receipt photo or PDF, mileage (km × the business rate, rounded half up once) and per-diem days (days × the business rate). Each receipt keeps its exact bytes, SHA-256, size, type (from its own signature), uploader and time. Invalid dates, amounts and files are refused and change nothing. | `COA-002 …` |
| COA-003 | An employee splits one expense across categories and cost centres; the parts must add up exactly to the expense, and each part becomes its own accounting line. | `COA-003 …` |
| COA-004 | Coaster flags policy exceptions (no receipt above the threshold, an expense's total in a category over that category's limit however it is split, the same receipt twice, the same date/merchant/amount as another expense on the claim, another claim or an imported report). Submission needs the employee's explanation for each; the manager must acknowledge them to approve; they stay on the decision, the batch and the accounting CSV. | `COA-004 …` |
| COA-005 | An exact duplicate expense can never be reimbursed twice: one database key per expense (its receipt bytes' SHA-256, or without a receipt its employee, date, type, merchant and amount) admits it to one batch only, and a claim holding the same exact expense twice cannot be submitted. | `COA-005 …` |
| COA-006 | Submission freezes the claim as a numbered revision and routes it to the employee's approving manager. Only that manager approves, returns (with a reason) or rejects (with a reason) that exact revision; nobody decides their own claim; a stale view is refused. | `COA-006 …` |
| COA-007 | A returned claim is corrected and resubmitted as the next revision. Earlier revisions, their receipts and decisions stay readable and downloadable; receipts, revisions, decisions and history lines cannot be changed or deleted. | `COA-007 …` |
| COA-008 | Access follows roles in every API handler, not only in screens: employees see their own claims; managers see claims routed to them once submitted; finance and the owner see submitted claims; drafts stay private to their employee. Writes need the current native session from the same origin; deactivated people (in Coaster or in their sign-in account) lose access at once, agent keys included; forged fields in requests decide nothing. | `COA-008 …` |
| COA-009 | Finance gathers approved claims into a draft batch, reviews it by confirming the reconciled total (someone else must review a batch holding their own claim), then downloads an accounting CSV (one line per category split with account/tax codes, receipt SHA-256, exceptions and approver) and a reimbursements CSV (one total per person). Both add up to the batch total. Finance records the payment made outside Coaster with its reference and date. | `COA-009 …` |
| COA-010 | A person makes an agent key. Their agent prepares draft claims from receipts (employees) or batch proposals (finance) through `/api/coaster/agent/*`; it cannot submit, approve, batch, pay or read anything else. Only that person accepts or declines; acceptance is recorded with who and when, and the claim or batch says it was prepared by the agent. | `COA-010 …` |
| COA-011 | The owner moves in Expensify history from a report-template CSV (IMPORTING.md) on Base import-kit: preview writes nothing and lists errors; commit applies only the exact previewed bytes and mapping; the original file is retained; undo reverses the job, and the same file can be imported again after an undo. Imported reports stay read-only history and flag later re-claims as possible duplicates. | `COA-011 …` |
| COA-012 | The owner exports the whole installation with `rer export` and restores it into an empty installation with `rer import`: claims, revisions, decisions, receipt bytes, batches, history and imported history come back identical, and a corrupt archive or one with inconsistent claims is refused without writing. | `tests/browser.mjs` (archive section) |
| COA-013 | Coaster installs and runs from a fresh clone with `rer install`, `setup`, `dev`, `build`, `preview`, `verify`, `reset`, `export`, `import`, `deploy --dry-run`, `describe` and `check`, on TanStack Start, Hono, D1 and Cloudflare Workers. | `tests/browser.mjs`, `rer check`, `rer verify` |

## Decided defaults

These are decided for the first release; changing one is a scope change.

- One business, one currency set by the owner (AUD by default), Australian timezone by default.
- Mileage defaults to A$0.88 per km (the ATO cents-per-kilometre rate for 2025–26), editable by the owner; the rate is copied onto each mileage expense when entered.
- Per diem is off until the owner sets a daily rate.
- A receipt is required for every purchase unless the owner sets a threshold; a missing receipt is an exception that needs an explanation, not a hard block.
- Money is integer minor units; each mileage amount rounds half up once.
- Every policy exception needs the employee's explanation to submit and the manager's acknowledgement to approve. Exceptions never block approval on their own: the manager decides.
- "Exact duplicate" means the same receipt bytes, or for an expense without a receipt the same employee, date, type, merchant and amount. The same date, merchant and amount with different receipts is a visible possible duplicate, not a block.
- Each employee has one approving manager; there is no multi-step approval chain or delegation.
- Finance reviews a batch by confirming its reconciled total; one finance person may create and review a batch unless it holds their own claim.
- Receipts are at most 1.5 MB each, stored in D1 with the claim, and never deleted.
- Agent keys are per person, shown once, stored as SHA-256 hashes and excluded from exports; a restored installation needs new keys.
- Import jobs belong to the owner role, so a restored installation's owner can still undo them.
- An archive carries Coaster's data, not sign-in accounts or sessions: Coaster roles are keyed by email, so after a restore people sign in to the new installation and keep their roles.

## Out of the first release

Card issuing or card feeds, bank feeds, moving money or ABA/payment files,
payroll, travel booking, cash advances, multi-currency claims and exchange
rates, multi-entity or multi-level approval chains, delegation, OCR or model
reading of receipts, email-in receipts, GST calculation or tax advice, accounting
software sync (the CSV is the hand-off), supplier procurement (Purse's job),
mobile offline capture, and real provider calls of any kind.
