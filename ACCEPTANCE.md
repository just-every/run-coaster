# Coaster acceptance

## Purpose and minimum outcome

A finance or operations manager at a 15–150 person US company runs all of its
expenses in Coaster instead of Expensify, SAP Concur Expense or Emburse:
receipts are snapped, forwarded or pulled in and read automatically, card and
bank feeds are matched to them, policy is enforced, approvals chase the people
who owe them, employees are reimbursed by ACH through a payment provider, and
every expense, receipt, reimbursement and clearing entry syncs with QuickBooks
Online, Xero or Pantry. The target is accepted when every clause in
`CONTRACT.md` holds on the exact commit through the journey listed for it below.

The claim-to-reimbursement spine already accepted for the first release stays
a floor that no later change may weaken:

- totals reconcile: the accounting CSV and the reimbursements CSV each add up to the reviewed batch total (COA-009);
- an exact duplicate expense cannot reimburse twice (COA-005);
- policy exceptions stay visible from submission to the export (COA-004);
- a returned claim is corrected without erasing the old evidence (COA-007);
- access is scoped by employee, approver and finance role in every handler (COA-008);
- export and restore recover receipt bytes and decision history (COA-012).

**103 clauses: 25 done, 20 partial, 58 missing.** Statuses describe the `main` commit that carries this file and match CONTRACT.md's Status table; new target clauses are build
requirements, not current interface or homepage promises.

## How it is proven

- `tests/coaster.test.mjs` (`pnpm test:coaster`): one business-flow test per
  clause COA-001 to COA-011, through the public HTTP API with real native
  sign-in by invitation mail, real workerd and D1 with every migration. No fake
  application database; the only stand-ins are the local development outbox and
  synthetic fixtures.
- `tests/browser.mjs` (`pnpm test:browser`): from a fresh clone of the committed
  head, `rer install`, `setup`, `check`, `describe`, `dev`, the human journey at
  1440 and 390 pixels wide (agent-prepared draft, employee claim with receipts,
  mileage and an over-limit meal, manager return, correction, approval, finance
  batch, accounting download and payment record, owner Expensify move-in and
  settings) with one screenshot per main screen, then `setup` rerun, `build`,
  `preview`, `deploy --dry-run`, `export`, refused corrupt and inconsistent
  archives, `import` into a second empty installation with identical results, and
  `reset` (COA-012, COA-013, MOBILE-001).
- `rer check` and `rer verify` on the exact commit (COA-013).
- New clauses are proven through the same public doors (screens, HTTP API,
  agent API, CLI, inbound provider webhooks) against the real Worker and D1,
  with fakes only at the paid or network edge: provider sandboxes or recorded
  fixtures for Plaid, card program files, Dwolla, the issuing partner,
  QuickBooks Online, Xero, NetSuite, Sage Intacct, Gusto, Slack, Microsoft
  Teams, Twilio, Postmark, Google, Microsoft and the receipt reader. A clause is
  not done until its journey runs in CI or, for live provider journeys, its
  sandbox evidence is recorded with the commit.

All examples are synthetic: a US business, its people, receipts, card data and
the incumbent-shaped files in `tests/fixtures/`.

## Clause journeys

- **COA-001 — Business, categories and people set by the owner. Status: done.** `COA-001` flow test: the owner configures the business, categories and people through the HTTP API; a manager, finance member and employee are each refused the same writes and nothing changes. Existing evidence: `src/coaster/settings.ts`; `tests/coaster.test.mjs` (COA-001).

- **COA-002 — Receipt, mileage and per-diem expenses with receipt provenance. Status: done.** `COA-002` flow test: upload a JPEG and a PDF, add mileage and per diem, read back exact bytes and hashes, and see malformed dates, amounts and disguised files refused with no write. Existing evidence: `src/coaster/claims.ts`; `src/coaster/items.ts`; `tests/coaster.test.mjs` (COA-002).

- **COA-003 — Exact splits across categories and cost centers. Status: done.** `COA-003` flow test: split one expense three ways, see a non-adding split refused, and read three coded accounting lines in the batch export. Existing evidence: `src/coaster/items.ts`; `tests/coaster.test.mjs` (COA-003).

- **COA-004 — Policy exceptions explained, acknowledged and carried to the books. Status: done.** `COA-004` flow test: submit an over-limit, receipt-less and duplicate claim, see submission refused without explanations, approval refused without acknowledgment, and the exceptions in the batch and CSV. Existing evidence: `src/coaster/exceptions.ts`; `src/coaster/decisions.ts`; `tests/coaster.test.mjs` (COA-004).

- **COA-005 — An exact duplicate is never reimbursed twice. Status: done.** `COA-005` flow test: approve two claims carrying the same receipt and see the second refused from any batch; a claim holding the same expense twice cannot be submitted. Existing evidence: `src/coaster/exceptions.ts`; `src/coaster/batches.ts`; `tests/coaster.test.mjs` (COA-005).

- **COA-006 — The assigned approver decides the exact submitted revision. Status: done.** `COA-006` flow test: another manager, the employee and a stale revision are refused; the assigned manager's decision is recorded against the exact revision. Existing evidence: `src/coaster/decisions.ts`; `tests/coaster.test.mjs` (COA-006).

- **COA-007 — Corrections never erase evidence. Status: done.** `COA-007` flow test: return, correct with a replacement receipt and resubmit; both revisions, both receipts and every decision remain readable and no route edits or deletes them. Existing evidence: `src/coaster/claims.ts`; `src/coaster/events.ts`; `tests/coaster.test.mjs` (COA-007).

- **COA-008 — Role-scoped access in every handler. Status: done.** `COA-008` flow test: each role reads and writes across every claim, batch and receipt route; cross-origin, deactivated and forged requests are refused with no write. Existing evidence: `src/coaster/session.ts`; `src/coaster/api.ts`; `tests/coaster.test.mjs` (COA-008).

- **COA-009 — Reviewed reimbursement batches with reconciled exports. Status: done.** `COA-009` flow test: batch, review, download both CSVs, check both sum to the batch total, record the payment and see each employee's claim marked reimbursed. Existing evidence: `src/coaster/batches.ts`; `tests/coaster.test.mjs` (COA-009).

- **COA-010 — Personal agents prepare; people decide. Status: done.** `COA-010` flow test: an agent key proposes a claim and a batch, is refused submission, approval and foreign reads, and only its person accepts; the provenance appears on the result. Existing evidence: `src/coaster/agents.ts`; `tests/coaster.test.mjs` (COA-010).

- **COA-011 — Expensify report history move-in. Status: done.** `COA-011` flow test: preview with errors, commit, see a re-claim flagged, undo and re-import the same file. Existing evidence: `src/coaster/imports/expensify.ts`; `src/coaster/imports/jobs.ts`; `tests/coaster.test.mjs` (COA-011).

- **COA-012 — Whole-installation export and restore. Status: done.** `tests/browser.mjs` archive section and `tests/browser-archive.mjs`: export, refuse tampered and inconsistent archives, import into a second empty installation and compare. Existing evidence: `tests/browser.mjs` (archive section); `tests/browser-archive.mjs`.

- **COA-013 — Fresh-clone install and runtime. Status: done.** `tests/browser.mjs`, `rer check` and `rer verify` on the exact commit. Existing evidence: `tests/browser.mjs`; `rer check`; `rer verify`.

- **LOCALE-001 — US-first defaults. Status: done.** Set up a fresh installation and see USD, miles, a US zone and the $75/lodging rule; enter mileage dated either side of a January rate change and see each priced at its year's rate; capture a receipt's sales tax and see it on its own accounting line. Existing evidence: `src/coaster/settings.ts`; `src/coaster/mileage.ts`; `src/coaster/items.ts`; `src/coaster/batches.ts`; `src/ui/settings.tsx`; `tests/coaster.test.mjs` (LOCALE-001).

- **CAPTURE-001 — Photo, file and bulk receipt upload. Status: partial.** At 390 px photograph a receipt; at 1440 px drop 30 mixed files including an 8 MB three-page hotel folio PDF and a HEIC; see each appear in the inbox with state, exact bytes and hash, and a 12 MB file refused with a reason. Existing evidence: `src/ui/item-form.tsx`; `src/coaster/claims.ts`; `tests/browser.mjs`; `tests/coaster.test.mjs` (COA-002). Open scope: Camera/file capture of JPEG, PNG, WebP, HEIC and PDF ships one receipt per expense up to 1.5 MB in D1; no bulk upload, receipt inbox, processing states or R2 storage for 10 MB files.

- **CAPTURE-002 — Email-in receipts. Status: missing.** Forward an airline HTML receipt, a PDF invoice and a photo from a member's address and see three inbox receipts with the source message retained; send one from an unknown address and see it held; confirm an alias and see the next one land. Open scope: No inbound receipts address or mail intake.

- **CAPTURE-003 — Automatic receipt reading with a correction path. Status: missing.** Run the reading suite over the labeled corpus through the public upload door: (1) every field the reader marks confident equals its label exactly (zero confident-wrong fields); (2) every field that differs from its label is marked for review, never prefilled as confident; (3) each prefilled expense's amount equals the labeled total before the employee touches it whenever the total was marked confident, including the tipped restaurant receipt (total includes the tip), the hotel folio (folio balance, not the first night) and the faded thermal receipt; (4) the per-field read-without-correction rate for merchant, date and total is reported and recorded with the commit, and merchant, date and total are read correctly without review on at least 90% of the corpus. Then correct the faded total and see both values in history; force the reader to fail and see the needs-attention state with a retry. Open scope: No receipt reading and no labeled receipt corpus; every field is typed by hand.

- **CAPTURE-004 — Receipt inbox and automatic attachment. Status: missing.** Upload a receipt before its card charge arrives and see it attach when the feed posts; upload a cash receipt and see a draft expense after the window; discard one and find it in history. Open scope: Receipts exist only attached to an expense; no inbox or automatic attachment.

- **CAPTURE-005 — Inbox retrieval from Gmail and Outlook. Status: missing.** Against provider test tenants, connect a mailbox, post an unmatched card charge, see the matching receipt message found and attached with its source; disconnect and see the grant revoked and no further reads. Open scope: No Gmail or Outlook connection.

- **CAPTURE-006 — Receipts by Slack, Microsoft Teams and text message. Status: missing.** Through Slack and Teams test workspaces and a Twilio test number, send a receipt each way and see it in the inbox with a threaded reply of the read fields; reply with the business purpose and see it on the expense; an unlinked Slack user is refused. As an approver ask "Which client was this for?" on one expense of a pending claim (APPROVE-006); answer from a Slack reply as the employee and see the answer recorded in Coaster, the question closed and the answer visible to the approver as they approve. Open scope: No Slack, Teams or SMS intake.

- **CAPTURE-007 — Merchant receipt feeds. Status: missing.** With provider sandbox data, connect each merchant, post a ride, a trip and an order and see receipts arrive, match their card charges and carry the merchant's expense code. Open scope: No merchant receipt feeds.

- **FEED-001 — Card and bank connections through Plaid. Status: missing.** In Plaid sandbox connect a company card and a personal card, run sync through added, modified (pending→posted) and removed transactions and see one expense per posted charge assigned to its cardholder; replay the same cursor and see no duplicates. Open scope: No Plaid connection or transaction records.

- **FEED-002 — Commercial card program feeds and statement import. Status: missing.** Against a test SFTP server standing in for the issuer at the network edge, complete the enrollment checklist and see the delivery values; place PGP-encrypted GL1025, VCF and CDF3 fixture files at the drop and, with nobody uploading, see the scheduled job pick each up and cardholders see their transactions once; switch the feed to pull mode and see a file fetched from the issuer host; re-deliver the same GL1025 file and see nothing imported twice; skip the next day's file and see the stale-feed alert (FEED-003) to finance and the spend report show that date as uncovered; import a QFX statement for the same period and see overlaps flagged as duplicates in preview, and an undo reverse the job. Open scope: No card program feed, SFTP drop, enrollment checklist or statement import.

- **FEED-003 — Visible feed health and reconnection. Status: missing.** Trigger a Plaid login-required error in sandbox; see the connection marked broken with its last sync and a reconnect action, the owner notified, and the spend report show the uncovered dates; reconnect through update mode and see the backlog arrive. With a clock-controlled installation, let a daily GL1025 file miss its expected time plus grace; see the missed date on the feed, the alert to finance and the uncovered date in the report; deliver the late file and see the date covered and the alert closed. Open scope: No feeds, so no feed health.

- **FEED-004 — Card transaction expenses and receipt matching. Status: missing.** Post 20 sandbox charges and 20 receipts including a tipped meal, a foreign charge and two same-amount charges on one day; see 18 auto-matches, two match questions, an undo, and a duplicate out-of-pocket claim for a matched card charge blocked from reimbursement. Open scope: No card transactions or matching.

- **FEED-005 — Card statement reconciliation and liability clearing. Status: missing.** Reconcile a fixture statement with one missing charge and one refund; see the difference listed, resolve it, close the period and see the ledger card account match the statement balance. Open scope: No card statements or liability clearing.

- **FEED-006 — Individual-liability corporate cards. Status: missing.** Mark a fixture card program individual-liability; post six charges, two marked personal; approve the claim and see the four business charges in the reimbursement batch to the employee, the two personal charges excluded, and the QuickBooks sandbox posting as a bill to the employee rather than a purchase on a card account. Open scope: No card feeds, so no individual-liability handling.

- **CARD-001 — Company cards through an issuing partner. Status: missing.** In the issuing partner's test mode, issue a virtual card with a $500 monthly limit and a blocked category; authorize an allowed purchase, see a blocked-category and an over-limit decline with reasons, freeze the card and see the next authorization declined. Open scope: No issuing partner integration.

- **CARD-002 — Personal spend on company cards. Status: missing.** Mark a sandbox charge personal, repay by netting against a reimbursement and by ACH debit; see both settle and clear the balance; leave one overdue and see the reminder and, for an issued card, the freeze. Open scope: No personal-spend repayment.

- **CLAIM-001 — US mileage. Status: partial.** Enter a three-stop round trip from addresses and see the calculated miles and route; apply a commute deduction; record a GPS trip on the mobile build; see each priced at its date's rate and the distance source retained. Existing evidence: `src/coaster/items.ts`; `tests/coaster.test.mjs` (COA-002). Open scope: Mileage is miles × the IRS rate in force on its date (LOCALE-001) with exact rounding; no miles default, address routing, multi-stop, commute deduction, odometer or GPS trips.

- **CLAIM-002 — GSA per diem by location. Status: partial.** Claim a four-day trip to Chicago with a provided lunch; see M&IE at the location's rate, 75% on travel days and the lunch deducted; claim a trip spanning 1 October and see each day at its fiscal year's rate. Existing evidence: `src/coaster/items.ts`; `tests/coaster.test.mjs` (COA-002). Open scope: Per diem is days × one flat business rate; no GSA location tables, 75% travel days, meal deductions or fiscal-year rates.

- **CLAIM-003 — Foreign-currency expenses. Status: missing.** Claim a €48.00 Paris taxi and see the USD amount with rate and date; match a EUR receipt to its card charge and see the card's amount win with both kept. Open scope: One currency per installation; no conversion.

- **CLAIM-004 — Cash advances. Status: missing.** Approve and pay a $1,000 advance, claim $830 of expenses and see $170 owed back; claim $1,200 and see $200 reimbursed; let a return lapse and see it reach the overdue list. Open scope: No cash advances.

- **CLAIM-005 — Spend requests and trip pre-approval. Status: done.** Request a $2,400 conference trip, approve it, then file expenses linked to it and see estimate versus actual on the claim; file an unlinked expense over the threshold and see approval refused, including a partial approval that keeps it, until an approved request is linked; approve another with the approver's override reason and see that reason in the claim's history and the batch's accounting export. Existing evidence: `src/coaster/requests.ts`; `src/coaster/exceptions.ts`; `src/coaster/views.ts`; `src/ui/requests.tsx`; `tests/coaster.test.mjs` (CLAIM-005).

- **CLAIM-006 — Billable expenses and client rebilling. Status: missing.** Mark two expenses billable to a customer; see them as billable in the QuickBooks sandbox with attachments and as billable items in a Gauge test installation. Open scope: No billable flag or client rebilling.

- **CLAIM-007 — Itemization, attendees and required fields. Status: done.** Itemize a three-night folio and see room and in-room dining in their categories; add four attendees to a $320 dinner against a $75 per-person limit and see the exception; see a $101.95 dinner for three shown as $33.98 a person, under $75; leave a required field blank and see submission refused with the field named. Existing evidence: `src/coaster/items.ts`; `src/coaster/exceptions.ts`; `src/coaster/claims.ts`; `src/ui/item-form.tsx`; `tests/coaster.test.mjs` (CLAIM-007).

- **CLAIM-008 — Accountable-plan compliance and non-employee claims. Status: missing.** File an expense 75 days after the spend and see the lapse flagged; mark it non-accountable and see it in the payroll handoff as taxable; reimburse a contractor and see the 1099 review flag in the export. Open scope: No accountable-plan deadlines, payroll routing or 1099 flag.

- **CLAIM-009 — Recurring expenses and stipends. Status: missing.** With a clock-controlled installation, set a monthly $75 phone stipend for a department and a yearly $500 home-office cap; advance three months and see three stipend expenses created and reimbursed; claim $320 then $250 against the cap and see the second capped at $180 with the excess flagged; deactivate a member and see their stipend stop. Open scope: No recurring expenses or stipends.

- **CODE-001 — Accounting dimensions from the ledger. Status: partial.** Connect a QuickBooks sandbox and see its accounts, classes, locations and customers as choices; add a class in QuickBooks and see it appear after the next scheduled refresh with nobody pressing sync; archive a class and see it no longer offered; import a department → project tag list where Sales offers only Sales projects, and see a Marketing project refused on a Sales expense; require a project on Travel and see a Travel expense refused without one. Existing evidence: `src/coaster/settings.ts`; `src/coaster/items.ts`; `tests/coaster.test.mjs` (COA-001, COA-003). Open scope: Categories carry account and tax codes and splits carry a cost center; no ledger-synced classes, locations, departments, projects or customers, no scheduled refresh, no dependent multi-level tags and no per-category required dimensions.

- **CODE-002 — Automatic coding. Status: missing.** Run the coding suite over the fixture set through the public feed and upload doors: (1) every charge a merchant rule covers gets exactly the rule's coding (100%), including where learned history points elsewhere; (2) for repeat merchants (coded at least twice in the history by the person or the company), the suggested category equals the label on at least 90%, and the match rate across all suggestions for category, class and project is reported and recorded with the commit; (3) override one person's coding for a merchant twice and see their third charge from it carry the corrected coding, while another person's charge from the same merchant is unchanged; (4) no suggestion uses an archived account or class, and no suggestion changes a field the employee filled before the charge arrived; (5) open a suggestion and see its source and reason, override it, and see the override and the rule's acceptance rate. Open scope: No merchant rules, learned or merchant-category coding suggestions, and no labeled coding fixture set.

- **POLICY-001 — Versioned policy rules. Status: partial.** Publish a policy with a daily meal limit, a blocked merchant and a hard 90-day deadline; see each fire with its rule version; publish a new version and see older claims keep the old version and new claims use the new one. Existing evidence: `src/coaster/exceptions.ts`; `src/coaster/settings.ts`; `tests/coaster.test.mjs` (COA-004). Open scope: Receipt threshold and per-expense category limits raise soft exceptions; no versioned rules, daily/trip/attendee limits, blocked merchants, deadlines or hard rules.

- **POLICY-002 — Duplicate and fraud signals. Status: partial.** Submit the same receipt from two employees, a re-photographed copy, an edited total and two $480 charges against a $500 limit; see each signal with evidence, resolve one as legitimate and see the reason recorded. Run the clean fixture set and see signals on no more than 2% of its expenses, each with its evidence, and the rate recorded. Existing evidence: `src/coaster/exceptions.ts`; `tests/coaster.test.mjs` (COA-004, COA-005). Open scope: Same-receipt detection across all claims and same-employee possible duplicates ship; no near-duplicate images, edited-receipt detection, split-charge or pattern signals, and no clean-set false-positive measurement.

- **POLICY-003 — Finance exception queue and audit sampling. Status: done.** Generate exceptions across five claims and card charges; see them in one queue ordered by risk; configure a 10% audit sample and see a sampled claim with a recorded finding. Existing evidence: `src/coaster/audit-queue.ts`; `migrations/core/0026_exception_queue.sql`; `src/ui/exception-queue.tsx`; `tests/coaster.test.mjs` (POLICY-003): five claims' exceptions in one queue; card charges join when FEED-004 ships (CONTRACT.md POLICY-003).

- **APPROVE-001 — Multi-step conditional approval workflows. Status: partial.** Configure "over $1,000 adds the department head; any exception adds finance review"; submit claims of $200, $1,400 and $300-with-exception and see three different paths; the department head cannot approve their own claim at any step. Existing evidence: `src/coaster/settings.ts`; `src/coaster/decisions.ts`; `tests/coaster.test.mjs` (COA-006). Open scope: One owner-assigned approving manager per employee; no conditions, multiple or parallel steps or finance review step.

- **APPROVE-002 — Delegation, out of office and reassignment. Status: done.** Set a delegation for next week and see a claim route to the delegate with "on behalf of" recorded; deactivate an approver and see their queue move with a history line. Existing evidence: `src/coaster/delegation.ts`; `src/coaster/decisions.ts`; `src/coaster/claims.ts`; `src/ui/approvals.tsx`; `tests/coaster.test.mjs` (APPROVE-002).

- **APPROVE-003 — Approve anywhere. Status: partial.** Approve one claim at 390 px, one from an email link (a reused or expired link is refused), one from Slack and one from Teams test workspaces, and bulk-approve three; each records its channel and refuses a stale revision. Existing evidence: `src/ui/approvals.tsx`; `tests/browser.mjs`. Open scope: Approval works in the phone-width web app; no email-link, Slack, Teams, native or bulk approval.

- **APPROVE-004 — Rule-based auto-approval. Status: missing.** Enable the rule; see a compliant $40 matched charge approved by rule and a $40 charge with an exception routed to a person. Open scope: No auto-approval.

- **APPROVE-005 — Hold one expense, approve the rest. Status: done.** Submit a five-expense claim; as the approver hold the dinner with "Add the attendee list" and approve the other four; see the four reach a batch and be paid (PAY-001) while the dinner sits in a new claim with the employee, with the reason and a link to the original; advance the clock and see FOLLOWUP-001 remind the employee; add the attendees and resubmit the held claim alone and see it approved and paid separately. The employee cannot hold or approve their own claim, a hold sent against an older revision is refused, and history on both claims shows the split with who and when. Existing evidence: `src/coaster/holds.ts`; `src/coaster/decisions.ts`; `migrations/core/0024_holds.sql`; `src/ui/claim-panel.tsx`; `tests/coaster.test.mjs` (APPROVE-005): both parts are paid through the finance-recorded payment (COA-009) until PAY-001. The ACH payment of both parts is written into PAY-001's clause and acceptance, and the held-claim reminder into FOLLOWUP-001's clause and acceptance, so each ships with it.

- **APPROVE-006 — Comments and questions without a decision. Status: done.** As an approver ask "Which client was this for?" on one expense of a pending claim; see the claim stay pending with the question marked open, the employee notified, the employee answer from a Slack reply, and the approver approve with the answer visible; try to edit the question after the reply and be refused. Existing evidence: `src/coaster/comments.ts`; `migrations/core/0023_comments.sql`; `src/ui/comments.tsx`; `tests/coaster.test.mjs` (APPROVE-006): the employee is emailed and answers in Coaster; answering from a Slack reply is written into CAPTURE-006's clause and acceptance, so it ships with the Slack app.

- **APPROVE-007 — Retract a submitted claim and unapprove before payment. Status: done.** Submit a claim and retract it before any decision; add a receipt, resubmit, and see revision 2 with the retraction recorded on revision 1 and the approver's pending reminder stopped; another employee's attempt to retract it is refused; retract a claim after its first step has approved and be refused. Approve a card-charge claim and see its purchase posted to the QuickBooks sandbox; unapprove it with a reason and see the claim back with the approver, the purchase voided in QuickBooks, and both events in history; try to unapprove a claim in a reviewed batch and be refused. Existing evidence: `src/coaster/reversals.ts`; `src/ui/claim-panel.tsx`; `tests/coaster.test.mjs` (APPROVE-007). The QuickBooks void is written into ACCT-001's clause and acceptance (7) (ACCT-002 and ACCT-003 carry the same for Xero and Pantry), and the pending-reminder stop into FOLLOWUP-001's clause and acceptance, so each ships with its clause.

- **FOLLOWUP-001 — Reminders that chase people. Status: missing.** With a clock-controlled installation, leave a receipt missing, a draft unsubmitted, a held expense unanswered and a claim unapproved; advance the clock and see reminders on the scheduled business days, none on a holiday or in quiet hours; resolve each and see its reminders stop. Hold one expense of a claim (APPROVE-005) and see the employee reminded about the held claim until they resubmit it; ask the employee a question (APPROVE-006) and see them reminded until they reply; submit a claim, let the approver's reminder go out, retract the claim (APPROVE-007) and see no further reminder to the approver. Open scope: No reminders; nothing chases a person.

- **FOLLOWUP-002 — Escalation with service levels. Status: missing.** Let an approval pass its three-day service level and see escalation to the approver's manager and then finance, each recorded; approve it and see escalation stop. Open scope: No escalation or service levels.

- **FOLLOWUP-003 — Missing-evidence chasing on card spend. Status: missing.** Post a charge with no receipt, advance seven days and see three reminders and the card frozen; attach the receipt and see the card unfreeze and the chase close. Open scope: No card spend to chase.

- **NOTIFY-001 — Notification delivery and preferences. Status: missing.** Set one person to Slack-immediate and another to an email daily digest; generate events and see the Slack messages and one digest; make the Slack webhook fail and see the attempt recorded and the email fallback sent. Open scope: Mail is used only for sign-in invitations; no event notifications, preferences or chat delivery.

- **AUTO-001 — Automatic reports and scheduled submission. Status: missing.** Set weekly submission; add five compliant expenses and one missing a receipt; at the scheduled time see a report of five submitted and the sixth held with a reminder. Open scope: Claims are built and submitted by hand.

- **PAY-001 — ACH reimbursement through a payment provider. Status: missing.** In the Dwolla sandbox, verify a funding account and two employees, release a batch, see both transfers settle and the claims marked paid; simulate an R03 return and see the failure, the plain-words reason, the employee notified and the amount back in their balance; retry after correction and see it settle once. Hold one expense of a five-expense claim (APPROVE-005), release a batch holding the other four and see them settle by ACH, then approve the resubmitted held claim and see it paid by ACH in a later batch. Open scope: Payment happens outside Coaster and finance records it (COA-009).

- **PAY-002 — Employee bank details and change protection. Status: missing.** Add an account by instant verification and another by micro-deposits; read the database and archive and find only tokens and last four; change the account and see the notice to the old address, the payment hold and its release after the period. Open scope: No employee bank details.

- **PAY-003 — Payroll reimbursement route. Status: missing.** With the Gusto developer sandbox, send a batch to payroll and see reimbursement lines on the next run and the claims marked paid when the run is confirmed; a non-accountable amount appears as taxable. Open scope: No payroll handoff.

- **PAY-004 — Payment controls and schedules. Status: partial.** Set dual release over $5,000 and a Friday schedule; see a $7,200 batch wait for a second releaser, a releaser with their own claim refused, and after release batch, provider and ledger totals agree. Existing evidence: `src/coaster/batches.ts`; `tests/coaster.test.mjs` (COA-009). Open scope: Batch review confirms the reconciled total and refuses a reviewer with their own claim; no schedule, dual release, step-up or provider/ledger reconciliation.

- **PAY-005 — Reimbursing employees outside the US. Status: missing.** In the provider's sandbox, add a Canadian entity employee's CAD account and a UK employee's GBP account; release a batch holding them and a US employee; see the US transfer go by ACH (PAY-001) and the CAD and GBP payouts by the international provider with rate, fee and reference recorded; fail one payout and see the claim reopened for payment with the reason. Open scope: No payment provider, so no international payouts.

- **ACCT-001 — QuickBooks Online two-way sync. Status: missing.** On a clock-controlled installation against a QuickBooks sandbox company, with nobody pressing sync: (1) final-approve a card-charge claim and see the purchase on the card account, with its receipt attached, after the next posting run; (2) with the reimbursable trigger at final approval, final-approve a claim and see its bill posted; switch the trigger to at payment, approve another and see no bill until its ACH batch is released, then see the bill and bill payment posted together with totals equal to the batch; (3) post for an employee with no QuickBooks vendor and see the vendor created once and reused on their next claim, and with auto-create off see the posting queued with the create-vendor fix; (4) mark one Coaster bill paid inside QuickBooks and, after the next run, see that claim marked reimbursed with the QuickBooks payment reference, gone from the draft batch, and refused from a later batch and from an ACH release; (5) add an account and a class in QuickBooks and see both offered as choices after the next scheduled daily refresh; (6) re-run sync and see no duplicates; delete one bill in QuickBooks and see the discrepancy flagged; return an ACH transfer (PAY-001) and see its bill payment reversed. (7) Final-approve a card-charge claim and see its purchase posted; unapprove it with a reason (APPROVE-007) and see the claim back with the approver, the purchase voided in QuickBooks after the next posting run, and both the unapproval and the void in history. Open scope: No QuickBooks Online connection, posting triggers, scheduled refresh, vendor creation or payment status sync.

- **ACCT-002 — Xero two-way sync. Status: missing.** Against a Xero demo company on a clock-controlled installation, with nobody pressing sync, repeat ACCT-001's journey: a final-approved card claim appears as a spend-money transaction after the next run; a reimbursable claim on the at-payment trigger posts its bill and payment when its ACH batch is released, with totals equal to the batch; an employee with no contact gets one created once; a bill paid in Xero marks its claim reimbursed with the Xero reference and is refused from a later batch and ACH release; a tracking option added in Xero appears after the next daily refresh; re-sync makes no duplicates; a posted card claim unapproved with a reason (APPROVE-007) has its spend-money transaction voided after the next run. Open scope: No Xero connection, posting triggers, scheduled refresh or payment status sync.

- **ACCT-003 — Pantry sync. Status: missing.** With a Pantry test installation and a clock-controlled Coaster, with nobody pressing sync: final-approve a card claim and see the expense in Pantry after the next run; release an ACH batch on the at-payment trigger and see bills, payments and attachments posted with totals equal to the batch, and Pantry's bank-feed line for the ACH debit reconcile against Coaster's clearing entry; mark one bill paid in Pantry and see the claim marked reimbursed with Pantry's reference and refused from a later batch and ACH release; add an account in Pantry and see it in Coaster after the next refresh; unapprove a posted card claim with a reason (APPROVE-007) and see its Pantry expense reversed after the next run. Open scope: No Pantry connection, posting triggers, scheduled refresh or payment status sync.

- **ACCT-004 — NetSuite and Sage Intacct. Status: missing.** Against vendor sandboxes with nobody pressing sync, final-approve claims in two entities and see records in each subsidiary with dimensions and attachments after the next run; mark one vendor bill paid in NetSuite and one in Sage Intacct and see both claims marked reimbursed with the ledger's reference and refused from a later batch. Open scope: No NetSuite or Sage Intacct connection.

- **ACCT-005 — Exports alongside live sync. Status: done.** Export a batch with the default and a custom template and as IIF; import the IIF into a fixture validator and see totals match the batch. Existing evidence: `src/coaster/exports.ts`; `src/coaster/xlsx.ts`; `migrations/core/0025_export_templates.sql`; `src/ui/exports.tsx`; `tests/coaster.test.mjs` (ACCT-005).

- **ACCT-006 — Posting integrity and close. Status: missing.** Archive an account in the sandbox and see the failing records queued with the message; map a new account and retry only those; close March and correct a March expense in April, then see a reversal and new entry dated April. Open scope: No sync, so no error queue, period locks or reversals.

- **ACCT-007 — QuickBooks Desktop connection. Status: missing.** Against a QuickBooks Desktop test company (or a Web Connector qbXML fixture at the network edge), run the connector and see accounts and classes pulled; sync a batch and see the bill and card-charge requests with totals equal to the batch; re-run and see no duplicate; make one request fail and see it queued with the QuickBooks message and retried alone. Open scope: No QuickBooks Desktop connector.

- **REPORT-001 — Spend analytics. Status: partial.** Load six months of fixture spend; group by department and drill to a receipt; a manager sees only their reports' spend; set a department budget (REPORT-004) and see budget, actual and remaining for it in the grouped view; save a view and reopen it. Existing evidence: `src/coaster/views.ts`. Open scope: Employee claim totals and coded batch lines ship; no grouped analytics, drill-down, budgets or saved views.

- **REPORT-002 — Operational and compliance reports. Status: missing.** Run each report on fixture data and check its totals against the underlying records; schedule the accrual report for the last business day and see it delivered. Open scope: No operational or scheduled reports.

- **REPORT-003 — Searchable audit history and auditor access. Status: done.** Search history for one claim across capture, approval, payment and sync; sign in as an auditor and see writes refused; export a quarter's audit pack and verify receipt hashes against stored bytes. Existing evidence: `src/coaster/audit.ts`; `src/coaster/zip.ts`; `src/coaster/session.ts`; `src/ui/audit.tsx`; `tests/coaster.test.mjs` (REPORT-003).

- **REPORT-004 — Budgets with threshold alerts. Status: missing.** Set a $5,000 monthly Travel budget for Sales owned by the Sales head with 80% and 100% alerts, and a $200 monthly per-member meals budget; post $4,100 of Sales travel and see exactly one 80% alert to the Sales head and finance and the report show $5,000 budget, $4,100 actual (82%) split into approved and pending; post past $5,000 and see the 100% alert and the over-budget soft exception on the next claim; exceed one member's meals budget and see only that member flagged; advance to next month and see actuals reset with no repeat alert. Open scope: No budgets or threshold alerts.

- **REPORT-005 — Claim PDF with receipts. Status: missing.** Download a paid three-expense claim with a JPEG, a HEIC and a two-page PDF receipt; see the summary totals equal the claim, the approval chain and payment reference, every receipt page present in order with its hash matching the stored bytes; download the customer-filtered PDF and see only that customer's billable expenses; a user who cannot see the claim is refused. Open scope: Receipts download one at a time (COA-007); no claim PDF.

- **API-001 — Public API and webhooks. Status: partial.** Create a scoped key, list and create expenses, be refused outside the scope, subscribe a webhook and verify its signature on a claim approval and a payment settlement. Existing evidence: `src/coaster/agents.ts`; `src/coaster/api.ts`; `tests/coaster.test.mjs` (COA-010). Open scope: A scoped agent API prepares drafts and proposals; no general API keys, OAuth, full resource coverage or webhooks.

- **ADMIN-001 — People, roles, departments and the permission matrix. Status: partial.** Add one person holding only each role and a three-level hierarchy; a matrix test drives every action in the matrix through its public route as each single-role person and sees each permitted cell succeed and every other cell refused with 403 and no write (for example the bookkeeper exports and syncs but is refused releasing a payment, changing policy and reading bank details; the card admin freezes a card but is refused approving a claim or releasing a batch); a person with finance and approver roles gets both rows but cannot approve their own claim; deactivate a manager with open approvals and see them moved to the successor and the manager's access end at once. Existing evidence: `src/coaster/settings.ts`; `src/coaster/session.ts`; `tests/coaster.test.mjs` (COA-001, COA-008). Open scope: Owner, employee, manager and finance roles with immediate deactivation ship and are enforced per handler; the auditor role ships (REPORT-003); no admin, card admin or bookkeeper roles, no matrix test over the full permission matrix, no departments, hierarchy or successor handoff.

- **ADMIN-002 — HRIS roster sync. Status: missing.** Connect a Gusto sandbox; add a hire, change a manager and terminate someone in Gusto; see each reflected in Coaster after sync and the terminated person's card frozen. Open scope: No HRIS connection.

- **ADMIN-003 — Single sign-on and provisioning. Status: partial.** Configure Okta and Entra test tenants, sign in through each, provision and deprovision a user by SCIM and see access granted and removed; require SSO and see a password sign-in refused for a member. Existing evidence: `src/auth.server.ts`. Open scope: The Base identity-provider dependency is declared; no tested SAML/OIDC sign-in, SCIM provisioning or SSO-required journey.

- **ADMIN-004 — Multiple entities. Status: missing.** Set up a US entity in USD and a Canadian entity in CAD with separate QuickBooks sandboxes; file expenses in each, sync to the right company and see a consolidated USD report. Open scope: One business per installation.

- **ADMIN-005 — Delegates who prepare and submit for someone else. Status: done.** An executive grants an assistant Submit only access; the assistant uploads three receipts, builds a claim and submits it in the executive's name, and history shows "submitted by the assistant on behalf of the executive"; the assistant is refused approving any claim, reading the executive's bank details and changing the executive's settings; the executive revokes the grant and the assistant's next request is refused with no write. A Full delegate approves a claim routed to the executive with "on behalf of" recorded, and is refused approving the executive's own claim and the delegate's own claim. Existing evidence: `src/coaster/delegates.ts`; `src/coaster/session.ts`; `src/coaster/events.ts`; `src/ui/delegates.tsx`; `tests/coaster.test.mjs` (ADMIN-005).

- **MOBILE-001 — Phone-width web app. Status: done.** `tests/browser.mjs` runs the employee, manager and finance journey at 390 px with screenshots of every main screen. Existing evidence: `src/ui/item-form.tsx`; `src/ui/approvals.tsx`; `tests/browser.mjs`.

- **MOBILE-002 — Native iOS and Android apps. Status: missing.** On iOS and Android test devices, capture three receipts in airplane mode and see them upload on reconnect; record a GPS trip; approve from a push notification; sign out and see biometric unlock required. Open scope: No native apps.

- **MOVE-001 — Complete Expensify move-in. Status: partial.** With a synthetic Expensify export set (policy JSON, report CSVs, receipt images), preview and see people, rules and reports mapped and unmapped fields named; commit, see receipts attached to their expenses, then undo. Existing evidence: `src/coaster/imports/expensify.ts`; `tests/coaster.test.mjs` (COA-011). Open scope: Report-template CSV history moves in; people, rules, tags, receipt images and card assignments do not.

- **MOVE-002 — SAP Concur move-in. Status: missing.** With a synthetic Concur standard accounting extract and receipt archive, preview, map expense types to categories, commit and see report history with receipts; undo. Open scope: No SAP Concur importer.

- **MOVE-003 — Emburse move-in. Status: missing.** With synthetic Certify and Chrome River exports, preview, commit and undo, and see history and receipts carried. Open scope: No Emburse importer.

- **MOVE-004 — Ramp, Brex and Navan move-in. Status: missing.** Import a synthetic Ramp transaction export with receipts and see history; connect a feed overlapping the same month and see no duplicates. Open scope: No Ramp, Brex or Navan importer.

- **MOVE-005 — Cutover without double counting. Status: partial.** Import a month of Expensify history, connect a feed covering the same month and carry three open reports; see imported charges deduplicated, open reports reimbursable once, and a cutover report that accounts for every source record. Existing evidence: `src/coaster/exceptions.ts`; `tests/coaster.test.mjs` (COA-011). Open scope: Re-claims of imported Expensify expenses are flagged as possible duplicates; no feed deduplication, open-item carry-over or cutover report.

- **INTEG-001 — Travel booking context. Status: missing.** Forward a TravelPerk confirmation and import a Navan trip through its API sandbox; see trips with dates and locations, matching card charges grouped under them and per diem prefilled. Open scope: No travel tool connection.

- **SIBLING-001 — Handoffs to neighboring products. Status: partial.** With test installations of each sibling, run each handoff once; hand a supplier invoice to Purse and see it leave the claim with a link; break one sibling's connection and see the failure owned in Coaster. Existing evidence: `src/auth.server.ts`; `src/modules/dependencies/auth.mjs` (Auth OIDC sign-in dependency). Open scope: No Pantry, Purse, Willow, Gauge, Nook or Crank handoffs, or tested cross-product outcome and failure journeys.

- **AUDIT-001 — Append-only history of every action. Status: partial.** Perform one action of each kind through its public door, read the history and see each line in order; try to alter or delete a line through every route and see refusal; export, restore and see identical history. Existing evidence: `src/coaster/events.ts`; `tests/coaster.test.mjs` (COA-007); `tests/browser.mjs` (archive section). Open scope: Append-only numbered history covers settings, claims, decisions, batches, agent keys and imports and survives restore; provider, payment and sync actions do not exist yet.

- **ERASURE-001 — Personal-data erasure with financial-record retention. Status: missing.** Erase a departed employee with paid claims; see their personal fields gone, amounts and receipt hashes kept under an opaque subject, the receipt listing both; restore an archive made before the erasure and see the erasure re-applied. Open scope: No Coaster entity erasure route; Base erasure tables cover import-kit records only.

- **RETAIN-001 — Record retention and legal hold. Status: partial.** Set a short retention on a test installation and see expiry proposed, confirmed and receipted; place a legal hold and see expiry and ERASURE-001 refused until it is released. Existing evidence: `src/coaster/claims.ts`; `tests/coaster.test.mjs` (COA-007). Open scope: Receipts and history are never deleted; no retention period, confirmed expiry or legal hold.

- **SEC-001 — Financial data and provider credential custody. Status: missing.** Connect each provider, export the installation and scan the archive and database for card and account numbers and tokens (none in clear); attempt a payment release with a stale session and see step-up required. Open scope: No provider credentials or financial account data exist yet; agent keys are stored hashed (`src/coaster/agents.ts`).

- **DATA-001 — Declared external data flows. Status: partial.** With no providers connected, run the claim-to-batch journey and observe no outbound traffic beyond Cloudflare and the configured mail adapter; connect each provider and see only its declared data leave. Existing evidence: `seed.json`; `tests/harness.mjs`; `tests/coaster.test.mjs` (DATA-001). Open scope: Cloudflare hosting, the optional mail adapter (Resend, SendGrid or Cloudflare Email) and the optional Auth identity provider are declared with the data each sends, and the egress test proves the claim-to-batch journey with no optional provider connected sends data only through the mail adapter; no Coaster test yet links an identity provider and shows only its declared data leaving.

- **A11Y-001 — Accessible screens. Status: partial.** Run axe on every main screen at 1440 and 390 px with no violations, complete the claim and approval journeys by keyboard only, and check reading and payment state announcements with VoiceOver. Existing evidence: `tests/browser.mjs`. Open scope: Screens are driven at 1440 and 390 px; no axe run, keyboard-only journey or screen-reader check.

- **COST-001 — Visible provider costs in USD. Status: missing.** Enable receipt reading with a $20 monthly cap and read the CAPTURE-003 labeled corpus; see the per-page and month-to-date cost recorded against the corpus run; read receipts until the cap and see reading pause with manual entry still working. Open scope: No provider costs or caps.

- **AGENT-001 — The spend agent closes every expense. Status: missing.** Post 30 sandbox charges with mixed receipts; see the agent collect receipts and context by chat, route approvals and prepare a payment run that a person releases; see every step in history with the agent named, a disputed coding stop the item, and an attempt to release payment refused. Over the CODE-002 coding fixture set, the coding the agent applies meets CODE-002's bars: 100% on merchant-rule charges and at least 90% category matches on repeat merchants. Open scope: Agents only prepare drafts and batch proposals (COA-010).

- **AGENT-002 — Resolve unclear receipts with one question. Status: missing.** Submit a receipt whose total differs from its card charge by a handwritten tip; see one question with the crop and both values; confirm and see the corrected expense with the original reading retained; ignore the question and see no value changed. Over the CAPTURE-003 labeled corpus matched to fixture card charges, every receipt where the reading and the charge disagree gets exactly one question and none gets a value the label contradicts. Open scope: No receipt reading to reconcile.

- **AGENT-003 — Preview a policy change before adopting it. Status: missing.** On fixture history where a $50 meal limit is routinely exceeded and approved, see the agent surface that recurring exception and propose raising the limit to $75; see affected claims, exception count before and after and approver hours saved; adopt it and see a new version effective from today with history unchanged. Open scope: No policy simulation.

- **AGENT-004 — Repair feed and accounting handoffs. Status: missing.** Drop a day from a sandbox feed and delete a synced bill in QuickBooks; see the agent identify both with evidence, open the reconnect and resync tasks, and after reconnection reprocess only the gap with no duplicates. Open scope: No feeds or sync to repair.

- **AGENT-005 — Policy review agent with cited reasons. Status: missing.** Grant a $100 compliant envelope; submit a claim with a compliant $60 lunch and an over-limit $180 dinner; see the lunch approved by the agent with cited reasons and the dinner routed with a recommendation; revoke the envelope and see the next compliant lunch routed to a person. Over the CODE-002 coding fixture set, every expense the agent approves within its envelope carries coding equal to its label or its merchant rule, and every expense whose coding came from a low-confidence suggestion is routed to the approver with that coding marked for review. Open scope: No policy review agent.

- **AGENT-006 — Fraud and anomaly investigation. Status: missing.** Seed a pattern of split charges and an edited receipt across two employees; see one evidence pack with the related records; confirm no message was sent to the employees and no payment was held until finance acts. Open scope: No fraud investigation.

- **AGENT-007 — Conversational expenses and spend questions. Status: missing.** In Slack send four receipt photos with "Denver client trip, Oct 6–8" and see a draft claim with receipts, per diem and a question for the missing purpose; as a manager ask a Q3 versus Q2 question and see figures that match REPORT-001 with links; ask about another department and see the scope refusal. Open scope: No conversational entry or spend questions.

- **AGENT-008 — Month-end close preparation. Status: missing.** On a fixture month with unsubmitted charges and one uncleared payment, see the checklist with the accrual amount by department, the chases sent and the uncleared payment named; post the accrual and see it in the QuickBooks sandbox. Open scope: No close preparation.

- **AGENT-009 — Trip assembly. Status: missing.** With a Navan itinerary, a calendar event and eight charges, see one proposed trip claim with the right expenses, per diem days at the city's GSA rate and an airport mileage leg; the employee edits and submits it. Open scope: No trip assembly.

## Not yet proven

- A real owner's Expensify, SAP Concur or Emburse export: move-in kits are
  built from documented export fields, not from real accounts' files.
- Live provider connections: no Plaid, card program, payment provider,
  issuing partner, ledger, HRIS, chat or mailbox connection has run against a
  production account.
- A real set of claims from a pilot business, the current-process cost
  baseline, and a whole month-end cycle observed by a finance manager.
- Hosted deployment, real mail delivery and an accessibility audit.

## Backup and upgrade

A pre-upgrade export restores only with the Coaster release that made it.
Restore it into an empty installation of that release, upgrade that
installation's source in place, run `rer install` and `rer setup`, then export
again. Keep the original release and private export until recovery is verified.
Provider connections and agent keys are not in the archive: reconnect providers
and issue new keys after a restore.
