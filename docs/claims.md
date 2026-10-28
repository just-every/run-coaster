A claim groups expenses for review. Out-of-pocket expenses are reimbursable; company-card expenses were paid by the company and never add to reimbursement.

## Keep receipts before entering expenses

Open **Receipt inbox** on Claims. Drop dozens of files, choose **Upload receipts**, or use **Photograph a receipt** on a phone. JPEG, PNG, WebP, HEIC and multi-page PDF originals up to 10 MB each stay in your inbox with their hash, size, uploader and source. A refused file leaves successful uploads intact; choose a smaller file to retry.

Reading is unavailable, so each saved original says **Needs attention** and asks you to enter its expense details manually. To attach an inbox original, first add a purchase expense to your draft or returned claim. Expand its attach controls, choose the claim and expense, then attach. Approvers and finance can see it once submitted. You can detach while the expense is editable; earlier submitted evidence stays. Inbox originals keep their 10 MB limit and are stored once. You can also attach an original to a company-card expense by hand. Direct file attachments below retain their 1.5 MB limit.

Finance can review **Cash receipt draft window** in Settings, then confirm its older-receipt count. It is off by default; choose 1–90 elapsed days. Each hourly run prepares up to 25 private draft claims, once per original, with the UTC upload date and **needs details**. No amount is inferred or receipt attached. The inbox links to the draft; enter its details yourself. Turning the window off keeps drafts already prepared.

## Match a private original to a card charge

Expand **Card matching** on one original. Enter its merchant, purchase date, positive total and ISO currency (the business currency is the default). Last four is optional; when entered, it must match. Read the sharing notice, check the acknowledgment and choose **Match to my card charge**. Nothing is preselected, and entering details does not read the receipt. You or a live Submit-only/Full delegate can change the details or withdraw while it is unattached.

Hourly matching considers up to 100 oldest-waiting originals. It attaches only a mutually unique same-employee posted charge on a draft or returned report. The transaction date, or posted date when none is supplied, must be from one day before to seven days after the receipt date by default. Exact same-currency amounts need no merchant corroboration; upward tips up to 20% (rounded down to cents) and ECB reference conversions within 5% need merchant agreement. The owner or finance can version these bounds through `settings/card-matching` in the [API.md](https://github.com/just-every/run-coaster/blob/main/API.md). Merchant agreement lowercases Unicode letters and digits, replaces other characters with spaces, then requires a shared typed token of four or more characters or containment of the compact typed merchant (four or more characters) in the compact statement merchant. Merchant and date proximity never resolve a tie.

A private question lists ambiguous charges; **This one** attaches by you, while **None of these** permanently rejects the listed pairs. A detach permanently excludes that pair and stops automation for the original until you choose matching again. Opted-in originals never become cash drafts; an already reserved cash original can only be attached by hand. Discarded, merged, attached, withdrawn and inactive-member originals stay out of matching. Matching never changes statement facts, submits, approves or notifies. A foreign-currency match shows the entered amount, reference conversion, posted card amount, rate, rate date and source on the expense, its submitted revision and claim PDF. The posted card amount remains authoritative; an ECB reference rate is not the card’s rate. A matched original is stored once; its ordinary provenance and frozen rule/basis become visible with the submitted expense, while typed merchant, choices, questions and private history stay private.

## Company-card expenses from a statement file

When finance imports your card's statement file (an OFX, QFX or CSV download; Coaster calls this a statement file import, not a feed), each purchase appears as a **company-card expense** on your draft report for that month. The company paid it, so it never adds to what you are reimbursed. Its merchant, amount and date come from the statement and cannot be changed or removed; you can change its category and cost center, add a description, attendees or a receipt, and explain it. Submit the report as usual. If you also claim the same purchase out of pocket, submission is refused: correct or remove the duplicate first. Scheduled submission and hold release enforce the same rule. If the card charge arrives after a reimbursement was approved, finance still cannot put it in a reimbursement batch.

## Start a claim

Open **Claims**, choose **New claim**, give it a title such as "Denver client trip" and choose **Start claim**.

## Add expenses

Choose **Add expense** and pick the **Type**:

- **Purchase with receipt**: the date, merchant and amount, and a **Receipt photo or PDF** (JPEG, PNG, WebP, HEIC or PDF, up to 1.5 MB).
- **Mileage**: the route and the distance in miles. Coaster prices it at the business's rate per mile.
- **Per diem**: choose GSA, State Department or IRS high-low, select the published city/county and travel dates, then choose meals, lodging or both. Mark provided meals and choose **Calculate per diem** to inspect daily rates before saving. First and last travel days receive 75% M&IE; provided meals deduct their full published amounts, keeping incidentals. Lodging covers nights before return. Rates are USD, so another business currency needs the enabled ECB conversion or an entered exchange rate. The optional **Company flat daily rate** uses the owner's rate times claimed days. Daily rates and sources stay on the expense, submitted revision, PDF and accounting export. Missing published dates are refused; an allowance does not certify tax treatment.

Choose a **Category**, and a **Cost center** if you use them. One receipt can be split: choose **Split across categories** and give each part its category, cost center and amount. The parts must add up exactly to the expense.

## Explain exceptions

Coaster flags anything outside the policy before you submit:

- a purchase with no receipt above the business's threshold,
- an expense over its category's limit,
- the same receipt as another expense,
- the same date, merchant and amount as another claim or an imported Expensify report.

Write an **Explanation for your approver** on each flagged expense, for example "Dinner with two guests from Pikes Trail Supply, agreed with Dana". The explanation stays with the claim, the batch and the accounting file.

A claim cannot hold the same expense twice. If two expenses have the same date, merchant and amount and no receipt, or the same receipt, attach each one's own receipt, or correct or remove one, before you submit.

## Submit

Choose **Submit for approval**. The claim goes to your approving manager as revision 1 and you can no longer change it.

## When a claim comes back

If your manager returns it, the claim shows **Returned** and their reason. Change or remove the expenses, attach the right receipt, and choose **Resubmit for approval**. It goes back as the next revision. The earlier revision, its receipts and the decision stay under **Earlier revisions and receipts** and in the history.

Next: [Approving claims](/docs/approvals).

If a read receipt and its attached card charge disagree, open the private receipt reading to answer one question. Check the source crop and both values, then explicitly confirm the receipt total, currency and any conflicting fields. You can leave it unanswered without changing the expense. The posted card amount stays unchanged; the confirmed comparison appears with the expense after submission, while the original reading and its source regions remain in your private history. A live delegate can answer for you. Unanswered questions follow the normal reminder schedule.

The owner can review optional AI costs in Settings before enabling receipt reading. USD estimates use the provider-reported tokens and the exact model rates the owner enters. The monthly cap includes reading and coding, settled usage and outstanding reservations. If reading pauses, enter expense details manually. Provider invoices remain authoritative; uncertain requests retain their reservation and a final charge above its reservation can pause later requests.

## Contract implementation status

103 clauses: 60 done, 23 partial, 20 missing. See [the contract](https://run-coaster.com/contract) for the full acceptance requirements.

| Clause | Capability | Status |
| --- | --- | --- |
| COA-001 | Business, categories and people set by the owner | done |
| COA-002 | Receipt, mileage and per-diem expenses with receipt provenance | done |
| COA-003 | Exact splits across categories and cost centers | done |
| COA-004 | Policy exceptions explained, acknowledged and carried to the books | done |
| COA-005 | An exact duplicate is never reimbursed twice | done |
| COA-006 | The assigned approver decides the exact submitted revision | done |
| COA-007 | Corrections never erase evidence | done |
| COA-008 | Role-scoped access in every handler | done |
| COA-009 | Reviewed reimbursement batches with reconciled exports | done |
| COA-010 | Personal agents prepare; people decide | done |
| COA-011 | Expensify report history move-in | done |
| COA-012 | Whole-installation export and restore | done |
| COA-013 | Fresh-clone install and runtime | done |
| LOCALE-001 | US-first defaults | done |
| CAPTURE-001 | Photo, file and bulk receipt upload | partial |
| CAPTURE-002 | Email-in receipts | partial |
| CAPTURE-003 | Automatic receipt reading with a correction path | partial |
| CAPTURE-004 | Receipt inbox and automatic attachment | done |
| CAPTURE-005 | Inbox retrieval from Gmail and Outlook | missing |
| CAPTURE-006 | Receipts by Slack, Microsoft Teams and text message | missing |
| CAPTURE-007 | Merchant receipt feeds | missing |
| FEED-001 | Card and bank connections through Plaid | partial |
| FEED-002 | Commercial card program feeds and statement import | partial |
| FEED-003 | Visible feed health and reconnection | missing |
| FEED-004 | Card transaction expenses and receipt matching | done |
| FEED-005 | Card statement reconciliation and liability clearing | done |
| FEED-006 | Individual-liability corporate cards | missing |
| CARD-001 | Company cards through an issuing partner | missing |
| CARD-002 | Personal spend on company cards | missing |
| CLAIM-001 | US mileage | partial |
| CLAIM-002 | GSA per diem by location | done |
| CLAIM-003 | Foreign-currency expenses | done |
| CLAIM-004 | Cash advances | done |
| CLAIM-005 | Spend requests and trip pre-approval | done |
| CLAIM-006 | Billable expenses and client rebilling | partial |
| CLAIM-007 | Itemization, attendees and required fields | done |
| CLAIM-008 | Accountable-plan compliance and non-employee claims | done |
| CLAIM-009 | Recurring expenses and stipends | done |
| CODE-001 | Accounting dimensions from the ledger | partial |
| CODE-002 | Automatic coding | done |
| POLICY-001 | Versioned policy rules | done |
| POLICY-002 | Duplicate and fraud signals | done |
| POLICY-003 | Finance exception queue and audit sampling | done |
| APPROVE-001 | Multi-step conditional approval workflows | done |
| APPROVE-002 | Delegation, out of office and reassignment | done |
| APPROVE-003 | Approve anywhere | partial |
| APPROVE-004 | Rule-based auto-approval | done |
| APPROVE-005 | Hold one expense, approve the rest | done |
| APPROVE-006 | Comments and questions without a decision | done |
| APPROVE-007 | Retract a submitted claim and unapprove before payment | done |
| FOLLOWUP-001 | Reminders that chase people | done |
| FOLLOWUP-002 | Escalation with service levels | done |
| FOLLOWUP-003 | Missing-evidence chasing on card spend | partial |
| NOTIFY-001 | Notification delivery and preferences | missing |
| AUTO-001 | Automatic reports and scheduled submission | done |
| PAY-001 | ACH reimbursement through a payment provider | missing |
| PAY-002 | Employee bank details and change protection | partial |
| PAY-003 | Payroll reimbursement route | partial |
| PAY-004 | Payment controls and schedules | done |
| PAY-005 | Reimbursing employees outside the US | missing |
| ACCT-001 | QuickBooks Online two-way sync | missing |
| ACCT-002 | Xero two-way sync | missing |
| ACCT-003 | Pantry sync | missing |
| ACCT-004 | NetSuite and Sage Intacct | missing |
| ACCT-005 | Exports alongside live sync | done |
| ACCT-006 | Posting integrity and close | missing |
| ACCT-007 | QuickBooks Desktop connection | done |
| REPORT-001 | Spend analytics | done |
| REPORT-002 | Operational and compliance reports | done |
| REPORT-003 | Searchable audit history and auditor access | done |
| REPORT-004 | Budgets with threshold alerts | done |
| REPORT-005 | Claim PDF with receipts | done |
| API-001 | Public API and webhooks | partial |
| ADMIN-001 | People, roles, departments and the permission matrix | done |
| ADMIN-002 | HRIS roster sync | missing |
| ADMIN-003 | Single sign-on and provisioning | partial |
| ADMIN-004 | Multiple entities | missing |
| ADMIN-005 | Delegates who prepare and submit for someone else | done |
| MOBILE-001 | Phone-width web app | done |
| MOBILE-002 | Native iOS and Android apps | missing |
| MOVE-001 | Complete Expensify move-in | partial |
| MOVE-002 | SAP Concur move-in | done |
| MOVE-003 | Emburse move-in | done |
| MOVE-004 | Ramp, Brex and Navan move-in | done |
| MOVE-005 | Cutover without double counting | partial |
| INTEG-001 | Travel booking context | missing |
| SIBLING-001 | Handoffs to neighboring products | partial |
| AUDIT-001 | Append-only history of every action | done |
| ERASURE-001 | Personal-data erasure with financial-record retention | done |
| RETAIN-001 | Record retention and legal hold | done |
| SEC-001 | Financial data and provider credential custody | partial |
| DATA-001 | Declared external data flows | done |
| A11Y-001 | Accessible screens | partial |
| COST-001 | Visible provider costs in USD | done |
| AGENT-001 | The spend agent closes every expense | partial |
| AGENT-002 | Resolve unclear receipts with one question | done |
| AGENT-003 | Preview a policy change before adopting it | done |
| AGENT-004 | Repair feed and accounting handoffs | missing |
| AGENT-005 | Policy review agent with cited reasons | done |
| AGENT-006 | Fraud and anomaly investigation | done |
| AGENT-007 | Conversational expenses and spend questions | partial |
| AGENT-008 | Month-end close preparation | partial |
| AGENT-009 | Trip assembly | partial |
