# Coaster Agent surface (draft)

Draft Agent surface for Coaster, written by ct on 28 October 2026 to the contract standard's section 13. It maps every Core clause of `CONTRACT.md` at main `6426e9696bc64efac2780c607fe6ff6cf0bc4903` (103 Core clauses). It is not part of CONTRACT.md yet: the seed's contract cleanup folds the `### Agent surface` area below into CONTRACT.md as the last area under Target clauses, and the rows under "Status rows" into its Status table. Old clauses whose text fixes what happens to an agent's step: COA-010, CAPTURE-003, CAPTURE-004, FEED-001, FEED-002, FEED-005, CLAIM-008, CODE-002, PAY-002, PAY-003, PAY-004, API-001, ADMIN-001, ADMIN-005, ERASURE-001, AGENT-001, AGENT-002, AGENT-003, AGENT-005, AGENT-006, AGENT-007, AGENT-008, AGENT-009; the cleanup rewords them as the class the step carries.

### Agent surface

**Specialist: Expense controller.** It brings receipts, card charges, claims, reimbursement and ledger evidence into agreement for the business and follows up on the gaps.

Inherits BASE-AGENT-001 to BASE-AGENT-013. The company's policy decides every call.

**How Coaster computes each class.** Coaster uses the native records, resolved recipients, provider response and proposed change, including effects triggered by that change. Caller labels, confirmation flags and imported or receipt text cannot lower a class. A single class is fixed; `a or b` selects per call; `a · b` always carries both; `(+ c)` adds c when its test holds. The Today column names reusable native actions, not MCP implementations; a stated slice leaves the rest unbuilt.

- *standard:* reads and reversible internal drafts, coding, grouping and proposed changes; carries item count. An estimate, recorded provider-cost estimate, forecast or proposed expense is not a payment.
- *external:* a provider request, message or disclosure outside the business, including a receipt sent for reading and financial records sent to a ledger; carries recipient count and counterparty. A native active member is internal; an external bookkeeper remains outside despite having a role. Counterparty is known for a configured provider, trusted company domain or customer/vendor on record, new otherwise, and public for an unauthenticated audience.
- *money:* actual transfers, repayments, card spending authority, stipend entitlements or decisions changing the reimbursement amount the business owes; carries exact amount in minor units, currency and payee or provider, including fees and FX when applicable. Recording an already made payment does not move money again.
- *commitment:* a spend authorization, expense decision, batch release, statement close, financial finding or adopted policy others rely on; carries value and counterparty from the underlying records, with no invented value for a nonfinancial finding.
- *accounts:* registration of an outside provider account or creation of a paid outside resource; carries provider and resource identity. Connecting an existing account does not by itself create an account.
- *gated:* an outside provider reports a consent, hosted bank/card entry, verification or personal-terms step that it keeps for a person; carries provider, step and continuation reference. A local draft or completed provider connection has no such step.
- *access:* changing staff identity, roles, delegates, approval delegation, cardholder access, API/agent/OAuth/webhook grants or connected-provider scopes; carries affected people or principals and direction, widens or narrows, computed from stored authority before and after. No agent can widen its own or its sponsor's authority.
- *security:* handling provider or API credentials, changing SSO, identity mapping, bank destinations, legal holds, retention protections or other protective settings; carries the setting and credential reference, never a secret in an audit fact.
- *destructive:* erasure, financial expiry, removal of a never-submitted expense without recovery, or terminal inbox discard/merge that cannot be reversed in Coaster; carries affected item count. Inbox discard/merge retain original bytes and history but permanently end that original's eligibility. Reversible draft edits and a detach are standard.
- *sensitive:* actual returned, processed or sent health, ID, bank, full-card or payroll-number content, including content inside receipt originals, crops, extracts and reports; carries record count and kind. A name, expense total, sealed token reference or masked last four alone does not qualify. The classifier examines protected content, not an agent's description of it; forbidden full account/card fields remain outside Coaster's structured storage.
- *live:* changing an enabled schedule, policy, rule, card-control program, delivery destination or service configuration that changes running behavior; carries the affected service. Editing an inactive draft configuration has no live effect.

Coaster uses all eleven fleet classes and no others.

| Tool | Does | Core clauses | Risk class | Today |
| --- | --- | --- | --- | --- |
| `coaster.workspace.get` | Read the sponsor's claims, queues and settings projection | COA-001, COA-002 | standard (+ sensitive) | `workspace` |
| `coaster.claims.get` | Read current claim and frozen revisions, decisions and evidence | COA-007, COA-002 | standard (+ sensitive) | `claimDetail` |
| `coaster.claims.create` | Open a draft claim | COA-002, AGENT-001 | standard | `createClaim` |
| `coaster.claims.rename` | Rename an editable claim | COA-002 | standard | `renameClaim` |
| `coaster.expenses.save` | Save purchase, mileage, per diem, splits, itemization, attendees and billable coding | COA-002, COA-003, CLAIM-001, CLAIM-002, CLAIM-003, CLAIM-006, CLAIM-007 | standard (+ sensitive) | `saveItem`; mileage addresses/routing unbuilt |
| `coaster.expenses.remove` | Permanently remove an editable expense | COA-002 | destructive | `removeItem` |
| `coaster.expenses.group` | Add an expense to its automatic month, trip or statement report | AUTO-001 | standard (+ sensitive) | `addExpense` |
| `coaster.claims.submit` | Freeze and route an exact revision, including any triggered financial decision | COA-004, COA-005, COA-006, APPROVE-001, APPROVE-004, AGENT-001 | commitment (+ money) | `submitClaim` |
| `coaster.claims.retract` | Retract an undecided revision | APPROVE-007, COA-007 | standard | `retractClaim` |
| `coaster.claims.decide` | Approve, return, reject or split a held expense on the assigned revision | COA-006, APPROVE-001, APPROVE-003, APPROVE-005, AGENT-005 | commitment (+ money) | `decide`; native web channel only |
| `coaster.claims.unapprove` | Reopen an exact decision and its payable amount | APPROVE-007 | commitment · money | `unapproveClaim`; connected reversals unbuilt |
| `coaster.claims.release_hold` | Decide an exact held revision | APPROVE-005 | commitment (+ money) | `releaseHold` |
| `coaster.claims.reassign` | Assign waiting work within existing roles | APPROVE-002, ADMIN-001 | access | `reassign`, `reassignRequest` |
| `coaster.claims.export` | Render a claim or batch PDF locally | REPORT-005 | standard (+ sensitive) | `claimPdf`, `batchPdf` |
| `coaster.receipts.upload` | Store an original in the private inbox or on an editable claim | CAPTURE-001, COA-002 | standard (+ sensitive) | `receiveReceipt`, `uploadReceipt` |
| `coaster.receipts.list` | List private originals and their states | CAPTURE-004 | standard (+ sensitive) | `listInbox` |
| `coaster.receipts.read` | Return original bytes, source mail or reading evidence | COA-002, CAPTURE-002, CAPTURE-003 | standard (+ sensitive) | `inboxReceiptFile`, `receiptFile`, `receiptEmailSource`, `readingDetail` |
| `coaster.receipts.extract` | Send one original to the configured reader | CAPTURE-003 | external (+ sensitive) | `readReceipt`; Base AI only |
| `coaster.receipts.correct` | Save a private field correction retaining the reading | CAPTURE-003, AGENT-002 | standard (+ sensitive) | `correctReading` |
| `coaster.receipts.question` | Get the single source-linked disagreement | AGENT-002 | standard (+ sensitive) | `receiptQuestion` |
| `coaster.receipts.answer` | Record an answer and its provenance on an editable expense | AGENT-002 | standard (+ sensitive) | `answerReceiptQuestion` |
| `coaster.receipts.attach` | Link an eligible original to an editable expense | CAPTURE-004, FEED-004 | standard (+ sensitive) | `changeAttachment` |
| `coaster.receipts.detach` | Detach an original preserving prior revision evidence | CAPTURE-004, FEED-004 | standard | `changeAttachment` |
| `coaster.receipts.discard` | End eligibility of one inbox original, retaining it in history | CAPTURE-004 | destructive | `discardReceipt` |
| `coaster.receipts.merge` | End duplicate eligibility while keeping both originals | CAPTURE-004 | destructive | `mergeReceipt` |
| `coaster.matches.get` | Read candidates and the current match rule | FEED-004 | standard (+ sensitive) | `cardMatchQuestion`, `matchRule` |
| `coaster.matches.choose` | Bind an exact original and posted card charge | FEED-004 | standard (+ sensitive) | `chooseCardMatch` |
| `coaster.matches.reject` | Exclude an exact proposed pair | FEED-004 | standard | `rejectMatchQuestion` |
| `coaster.matches.configure` | Set receipt matching and cash-draft automation | CAPTURE-004, FEED-004 | standard (+ live) | `saveMatchRule`, `saveCashWindow`, `previewCashWindow` |
| `coaster.mail.configure` | Set the installation's receipt destination and sender trust | CAPTURE-002 | security · access (+ live) | `saveReceiptEmail` |
| `coaster.aliases.request` | Send proof for a proposed receipt sender alias | CAPTURE-002 | standard or external | `requestReceiptAlias` |
| `coaster.aliases.confirm` | Bind a proved sender identity | CAPTURE-002 | access | `confirmReceiptAlias` |
| `coaster.aliases.remove` | Remove an intake identity | CAPTURE-002 | access | `removeReceiptAlias` |
| `coaster.reading.configure` | Set provider processing and private matching choices | CAPTURE-003 | security (+ live) | `saveReadingSettings`, `setReadingMatchDefault` |
| `coaster.mailboxes.search` | Find matching receipt messages using an existing connection | CAPTURE-005 | external (+ sensitive, + gated) | none |
| `coaster.chat.receive` | Take authenticated chat/text receipt or purpose input | CAPTURE-006, AGENT-007 | standard (+ sensitive) | none; native conversation is separate |
| `coaster.merchants.fetch` | Fetch ride/order receipts from a connected merchant | CAPTURE-007 | external (+ sensitive, + gated) | none |
| `coaster.feeds.list` | Read connections, cursor, freshness and coverage | FEED-001, FEED-002, FEED-003 | standard | `plaidConnections`, `programFeeds`; full health unbuilt |
| `coaster.feeds.sync` | Fetch new posted transactions through the native deduplication service | FEED-001, FEED-002, FEED-006 | external (+ sensitive, + gated) | scheduled mapped-CSV SFTP slice in `src/coaster/feeds/`; Plaid transaction sync and issuer formats unbuilt |
| `coaster.feeds.reconnect` | Resume a provider connection after its continuation | FEED-003, AGENT-004 | access · security · external (+ gated) | none |
| `coaster.cards.assign` | Change which person has a card's prospective expense access | FEED-002, ADMIN-001 | access | `assignCard` |
| `coaster.cards.issue` | Create an issuing-partner card with spending controls | CARD-001 | accounts · access · money · external (+ gated, + live) | none |
| `coaster.cards.configure` | Change a card's spending controls | CARD-001 | access · money · external (+ live) | none |
| `coaster.cards.freeze` | Suspend issued-card use | CARD-001, FOLLOWUP-003 | access · external · live | none |
| `coaster.cards.unfreeze` | Restore issued-card use within existing sponsor authority | CARD-001, FOLLOWUP-003 | access · external · live | none |
| `coaster.cards.cancel` | Permanently cancel an issued card | CARD-001 | access · destructive · external · live | none |
| `coaster.cards.mark_personal` | Mark a charge personal and recompute the amount owed | CARD-002, FEED-006 | money · commitment | none |
| `coaster.cards.repay` | Settle personal card spend by debit or reimbursement netting | CARD-002, FEED-006 | money · commitment (+ external, + gated) | none |
| `coaster.statements.list` | Read statement originals and reconciliation differences | FEED-005 | standard (+ sensitive) | `statementState`, `statementFile`, `reconciliations`, `reconciliation` |
| `coaster.statements.open` | Open an internal reconciliation | FEED-005 | standard | `openReconciliation` |
| `coaster.statements.resolve` | Record a difference resolution with supporting evidence | FEED-005 | standard (+ sensitive) | `resolveDifference` |
| `coaster.statements.close` | Sign off balanced statements and write the native clearing ledger | FEED-005 | commitment | `closeReconciliation`; connected tie-out unbuilt |
| `coaster.mileage.quote` | Calculate a proposed address route and commute deduction | CLAIM-001 | external (+ sensitive) | none; manual distance uses `saveItem` |
| `coaster.perdiem.quote` | Price an explicit published locality and dates | CLAIM-002 | standard | `pricePerDiem`, `perDiemLocations` |
| `coaster.fx.quote` | Fetch a public reference rate without employee or expense data | CLAIM-003 | external | `src/coaster/fx.ts`; currently inside native expense save |
| `coaster.requests.create` | Draft a spend or trip request with an estimate | CLAIM-005 | standard | `createRequest` |
| `coaster.requests.decide` | Authorize or refuse a spend request | CLAIM-005, APPROVE-001 | commitment | `decideRequest` |
| `coaster.advances.list` | Read advances and remaining excess | CLAIM-004 | standard | `advancesFor` |
| `coaster.advances.request` | Draft an advance request | CLAIM-004 | standard | `requestAdvance` |
| `coaster.advances.decide` | Authorize or refuse the advance | CLAIM-004 | commitment (+ money) | `decideAdvance` |
| `coaster.advances.link` | Apply a paid advance to an editable claim | CLAIM-004 | standard | `linkAdvance` |
| `coaster.advances.record_payment` | Record an outside advance payment | CLAIM-004 | commitment | `payAdvance`; no transfer |
| `coaster.advances.record_return` | Record excess already returned against an advance | CLAIM-004 | commitment | `recordReturn`; no transfer |
| `coaster.accountable.list` | Read substantiation and excess-return lapses | CLAIM-008 | standard | `accountablePlan` |
| `coaster.accountable.mark` | Record the finance tax-treatment designation | CLAIM-008 | commitment | `markNonAccountable` |
| `coaster.allowances.list` | Read applicable allowances and balances | CLAIM-009 | standard | `allowancesFor` |
| `coaster.allowances.save` | Set a stipend entitlement or reimbursement cap | CLAIM-009 | money · commitment (+ live) | `saveAllowance` |
| `coaster.allowances.stop` | End an allowance entitlement | CLAIM-009 | money · commitment (+ live) | `stopAllowance` |
| `coaster.recurring.save` | Set recurring draft expense creation | CLAIM-009 | standard (+ live) | `saveRecurring` |
| `coaster.recurring.stop` | End recurring draft expense creation | CLAIM-009 | standard (+ live) | `stopRecurring` |
| `coaster.coding.list` | Read active catalogs, rules, suggestions and source agreement | CODE-001, CODE-002 | standard (+ sensitive) | `codingCatalog`, `codingOptions`, `automaticRules`, `suggestionsFor`, `codingRates` |
| `coaster.coding.configure` | Set native dimensions, choices and required coding fields | CODE-001 | standard (+ live) | `saveDimension`, `saveCodingValue`, `saveCodingRequirements` |
| `coaster.coding.rule` | Set a merchant, personal or MCC rule | CODE-002 | standard (+ live) | `saveAutomaticRule` |
| `coaster.coding.suggest` | Compute cited coding without changing an expense | CODE-002, AGENT-001 | standard or external (+ sensitive) | `automaticPreview`, `receiptCoding`, `suggestReadingCoding`; provider path uses Base AI |
| `coaster.coding.apply` | Apply one exact suggestion to an editable expense | CODE-002, AGENT-001 | standard | `decideSuggestion` |
| `coaster.policy.list` | Read effective and historical expense policy | POLICY-001 | standard | `policies` |
| `coaster.policy.publish` | Adopt an exact expense-policy version | POLICY-001, AGENT-003 | commitment (+ live) | `publishPolicy`, `adoptAdvice` |
| `coaster.policy.preview` | Replay a candidate against frozen history | AGENT-003 | standard | `advice`; native card spend included, provider payment replay unbuilt |
| `coaster.workflows.configure` | Set routing, rule decisions and future payment schedules | APPROVE-001, APPROVE-004, AUTO-001, PAY-004 | commitment (+ live) | `saveWorkflow`, `saveApprovalRule`, `saveAutoSubmit`; payment controls use separate security tool |
| `coaster.exceptions.list` | Read exception, signal and audit-sampling queues | COA-004, POLICY-002, POLICY-003 | standard (+ sensitive) | `exceptionQueue` |
| `coaster.exceptions.record` | Record a finding on an exact exception or signal | POLICY-002, POLICY-003, AGENT-006 | commitment | `reviewException`, `reviewReceiptSignal`, `recordFinding` |
| `coaster.investigations.get` | Assemble related submitted evidence and original-image pack | AGENT-006 | standard (+ sensitive) | `investigations`, `investigationFile` |
| `coaster.investigations.record` | Record an investigation outcome with evidence | AGENT-006 | commitment | `investigationOutcome` |
| `coaster.policy.feedback` | Record agreement with cited advice | AGENT-005 | standard | `reviewFeedback` |
| `coaster.comments.add` | Comment or ask a named person a question | APPROVE-006 | standard or external (+ sensitive) | `addComment`; native mail outcome, connected replies partial |
| `coaster.comments.edit` | Revise an eligible comment while retaining prior text | APPROVE-006 | standard | `editComment` |
| `coaster.followup.configure` | Set business-day reminders, escalation and sampling | FOLLOWUP-001, FOLLOWUP-002, FOLLOWUP-003, POLICY-003 | standard (+ live) | `saveReminderSettings`, `saveEscalationChain`, `saveAuditSample` |
| `coaster.followup.send` | Send one due evidence, question or decision chase | FOLLOWUP-001, FOLLOWUP-002, FOLLOWUP-003, AGENT-001, AGENT-008 | standard or external (+ sensitive) | `src/coaster/reminders.ts`, `src/coaster/escalations.ts`; native mail only |
| `coaster.notifications.configure` | Set event channels, digests and delivery preferences | NOTIFY-001 | standard (+ live) | none |
| `coaster.notifications.send` | Deliver one event notification and record provider acceptance | NOTIFY-001 | standard or external (+ sensitive) | native mail call sites only; unified delivery unbuilt |
| `coaster.batches.get` | Read a batch, exact reconciled total and payment evidence | COA-009 | standard (+ sensitive) | `batchDetail` |
| `coaster.batches.create` | Collect eligible expenses into a draft batch | COA-005, COA-009 | standard | `createBatch` |
| `coaster.batches.remove` | Remove an eligible claim from a draft batch | COA-009 | standard | `removeFromBatch` |
| `coaster.batches.certify` | Sign off the exact reconciled batch total | COA-009 | commitment | `approveBatch` |
| `coaster.batches.release` | Authorize the exact payable batch | PAY-004, PAY-001, PAY-005 | money · commitment | `releaseBatch`; native external-payment route only |
| `coaster.payments.send` | Transfer an exact released reimbursement or advance, including foreign payouts | PAY-001, PAY-005, CLAIM-004 | money · external (+ sensitive, + gated) | none |
| `coaster.payments.get` | Read provider payment, failure, return and settlement state | PAY-001, PAY-005 | external (+ sensitive, + gated) | none |
| `coaster.payments.retry` | Send only a verified failed/returned amount under a new exact attempt | PAY-001, PAY-005 | money · external (+ sensitive, + gated) | none |
| `coaster.payments.record` | Record an already made outside payment with reference and date | COA-009 | commitment | `markReimbursed` |
| `coaster.payroll.get` | Read the exact batch's proposed payroll split and saved confirmation | PAY-003 | standard (+ sensitive) | `payrollReview`; Gusto Demo only |
| `coaster.payroll.confirm` | Fetch the original provider run and record a matching confirmation | PAY-003 | commitment · external (+ sensitive, + gated) | `confirmPayroll`; Gusto Demo only |
| `coaster.payroll.send` | Add actual reimbursement and taxable wage amounts to a payroll run | PAY-003, CLAIM-008 | money · commitment · external (+ sensitive, + gated) | `sendPayroll`; Gusto Demo only, does not submit payroll |
| `coaster.bank.get` | Read own or role-visible verification status and masked last four | PAY-002 | standard | `myBank`, `bankPeople` |
| `coaster.bank.start` | Prepare a provider verification continuation | PAY-002 | security · external (+ gated) | `startBank`; Plaid sandbox/Stripe test only |
| `coaster.bank.complete` | Bind a verified provider token and start the saved change hold | PAY-002 | security · external (+ gated) | `completeBank`, `verifyBank`, `refreshBank`; sandbox/test only |
| `coaster.bank.cancel` | End a pending verification without changing settled records | PAY-002 | security | `cancelBank` |
| `coaster.ledgers.sync` | Post triggered records, refresh catalogs or reconcile payment status | ACCT-001, ACCT-002, ACCT-003, ACCT-004, ACCT-007, CODE-001 | external (+ money, + sensitive, + gated) | `refreshQbo` metadata only; `syncDesktop` queues SOAP work; other financial sync unbuilt |
| `coaster.ledgers.map` | Fix coding or mappings against the exact native record | ACCT-006, ACCT-007 | standard (+ live) | `mapDesktop`; connected close/corrections unbuilt |
| `coaster.ledgers.retry` | Retry one failed posting without duplicating a payment | ACCT-006, ACCT-007, AGENT-004 | external (+ money, + sensitive, + gated) | `retryDesktop`; other adapters unbuilt |
| `coaster.ledgers.reverse` | Post a dated correction or reversal preserving a closed period | ACCT-006 | commitment · external (+ money, + sensitive, + gated) | none |
| `coaster.exports.render` | Render accounting, reimbursement or period CSV/XLSX/IIF locally | COA-009, ACCT-005 | standard (+ sensitive) | `batchFile`, `periodFile` |
| `coaster.exports.configure` | Save a named export column template | ACCT-005 | standard | `saveExportTemplate` |
| `coaster.reports.get` | Compute scoped spend, compliance, coverage and budget figures | REPORT-001, REPORT-002, REPORT-004, AGENT-007 | standard (+ sensitive) | `spend`, `report`, `budgetReport`; full feed coverage unbuilt |
| `coaster.reports.save_view` | Save a personal grouping and period | REPORT-001 | standard | `saveSpendView` |
| `coaster.reports.schedule` | Set or stop a report delivery with exact recipients and payload | REPORT-002 | standard or external (+ sensitive, + live) | `scheduleReport`, `stopReportSchedule`; native email only |
| `coaster.budgets.save` | Set a versioned internal budget and threshold alerts | REPORT-004 | standard (+ live) | `saveBudget`; CSV uses import door |
| `coaster.audit.search` | Search visible numbered history | REPORT-003, AUDIT-001 | standard (+ sensitive) | `searchHistory` |
| `coaster.audit.export` | Render an authorized audit pack with exact originals | REPORT-003 | standard (+ sensitive) | `auditPack` |
| `coaster.events.list` | Read typed changes from a replay cursor | AUDIT-001, API-001 | standard (+ sensitive) | public-API history outbox only; MCP replay unbuilt |
| `coaster.business.configure` | Set business, currency, category, tax and mileage defaults | COA-001, LOCALE-001 | standard (+ live) | `saveBusiness`, `saveCategory`, `saveMileageRate` |
| `coaster.entities.create` | Add an entity and its proposed configuration | ADMIN-004 | standard | none |
| `coaster.entities.configure` | Change entity configuration without conflating separate books | ADMIN-004 | standard (+ live) | none |
| `coaster.members.save` | Create or change staff roles, department and successor handoff | COA-001, ADMIN-001 | access (+ live) | `saveMember`, `saveDepartment`; existing role matrix applies |
| `coaster.members.invite` | Send a sign-in invitation for an authorized membership | ADMIN-001 | access (+ external) | `POST /api/coaster/settings/members/invite` |
| `coaster.delegates.grant` | Give a named person delegate or date-bound decision authority | ADMIN-005, APPROVE-002 | access | `grantDelegate`, `saveDelegation` |
| `coaster.delegates.revoke` | End delegated authority immediately | ADMIN-005, APPROVE-002 | access | `revokeDelegate`, `revokeDelegation` |
| `coaster.hris.sync` | Apply verified HRIS roster changes and card offboarding | ADMIN-002 | access · external (+ security, + live, + gated) | none |
| `coaster.identity.configure` | Change SSO requirements, SCIM and provider identity bindings | ADMIN-003 | access · security (+ external, + live, + gated) | Auth dependency only; management unbuilt |
| `coaster.grants.create` | Create an API, agent, OAuth or webhook principal within sponsor authority | COA-010, API-001, AGENT-005 | access · security (+ external, + live) | `createAgentKey`, public-API credential/client/webhook actions; native envelope is a legacy slice |
| `coaster.grants.revoke` | Revoke a credential, client, webhook or agent grant | COA-010, API-001, AGENT-005 | access · security (+ live) | `revokeAgentKey`, public-API revoke actions, `saveEnvelope` |
| `coaster.proposals.get` | Read an existing scoped claim, batch or preparation proposal | COA-010, AGENT-007 | standard (+ sensitive) | `proposal`; native conversation/preparation projections remain native-only today |
| `coaster.proposals.prepare_claim` | Prepare a draft claim proposal from supplied expenses and receipts | COA-010, AGENT-007 | standard (+ sensitive) | `proposeClaim`, `proposeConversationClaim` |
| `coaster.proposals.prepare_batch` | Prepare an exact proposed batch of eligible claims | COA-010 | standard | `proposeBatch` |
| `coaster.proposals.accept` | Apply one exact proposal as its declared draft or checklist result | COA-010, AGENT-001, AGENT-007, AGENT-008, AGENT-009 | standard (+ sensitive) | `acceptProposal`; native-session slice only |
| `coaster.proposals.decline` | Close one proposal without applying it | COA-010, AGENT-007 | standard | `declineProposal` |
| `coaster.providers.register` | Create an outside provider account or paid resource | CARD-001, PAY-001, SEC-001 | accounts · access · security · external (+ money, + gated) | none |
| `coaster.providers.connect` | Bind an existing feed, ledger, mailbox, chat, travel, funding or payroll connection | FEED-001, FEED-002, CODE-001, ACCT-001, ACCT-002, ACCT-003, ACCT-004, ACCT-007, CAPTURE-005, CAPTURE-006, CAPTURE-007, PAY-001, PAY-002, PAY-003, ADMIN-002, INTEG-001, NOTIFY-001, SEC-001 | access · security · external (+ gated, + live) | `startQbo`, `connectDesktop`, `connectProgramFeed`, `createPlaidLink`, `exchangePlaidLink`, `connectPayroll`, `connectBankProvider`; other providers unbuilt |
| `coaster.providers.disconnect` | End local provider authority and request provider revocation | FEED-001, FEED-002, CODE-001, CAPTURE-005, CAPTURE-006, PAY-002, PAY-003, SEC-001 | access · security (+ external, + live, + gated) | `disconnectQbo`, `disconnectDesktop`, `disconnectProgramFeed`, `disconnectPlaid`, `disconnectPayroll`, `disconnectBankProvider`; other providers unbuilt |
| `coaster.security.configure` | Set payment release grants, bank-change protection and credential custody | PAY-004, PAY-002, SEC-001 | access · security (+ live) | `savePaymentControls`, `setBankHold`, `savePlaidSettings`; custody adapters are partial |
| `coaster.retention.get` | Read retention, holds, expiry proposals and erasure receipts | RETAIN-001, ERASURE-001 | standard | `retention`, `erasures` |
| `coaster.retention.configure` | Change retention or place/release a legal hold | RETAIN-001 | security (+ live) | `saveRetention`, `placeHold`, `releaseLegalHold` |
| `coaster.retention.expire` | Apply an exact eligible expiry proposal and preserve reimbursement keys | RETAIN-001 | destructive | `confirmExpiry` |
| `coaster.people.erase` | Erase eligible former-member identity while preserving financial evidence | ERASURE-001 | destructive · access · security | `eraseMember` |
| `coaster.costs.get` | Read USD price estimates, reservations and measured provider usage | COST-001 | standard | `providerCosts` |
| `coaster.costs.configure` | Set estimate inputs for provider metering | COST-001 | standard | `saveProviderCosts`; company spend rules belong to policy |
| `coaster.conversation.answer` | Compute a cited spend/budget answer or editable expense proposal | AGENT-007 | standard (+ sensitive) | `conversation`; native foundation only |
| `coaster.trips.prepare` | Assemble one cited editable trip proposal | AGENT-009 | standard (+ sensitive) | `prepareTrip`; current saved expenses only |
| `coaster.trips.apply` | Group the proposal's exact existing expenses once | AGENT-009 | standard | `acceptProposal`; current native proposal slice only |
| `coaster.expenses.prepare` | Compute a cited receipt, coding and policy checklist | AGENT-001 | standard (+ sensitive) | `prepareExpense` |
| `coaster.close.prepare` | Compute accrual, pending evidence and clearance gaps | AGENT-008 | standard (+ sensitive) | `prepareClose`; ledger clearance unverified |
| `coaster.close.post` | Post the exact accrual to the connected ledger | AGENT-008 | commitment · external (+ sensitive, + gated) | none |
| `coaster.travel.fetch` | Read existing booking/calendar context without booking travel | INTEG-001, AGENT-009 | external (+ sensitive, + gated) | none |
| `coaster.handoffs.send` | Send an exact bill, rebilling item or automation handoff to a sibling | SIBLING-001, CLAIM-006 | external (+ commitment, + money, + sensitive, + gated) | none; Auth sign-in dependency is separate |

**Resources.** `coaster://business/{id}`, `coaster://entity/{id}`, `coaster://person/{id}`, `coaster://department/{id}`, `coaster://claim/{id}`, `coaster://revision/{id}`, `coaster://expense/{id}`, `coaster://receipt/{id}`, `coaster://reading/{id}`, `coaster://question/{id}`, `coaster://card/{id}`, `coaster://charge/{id}`, `coaster://statement/{id}`, `coaster://reconciliation/{id}`, `coaster://feed/{id}`, `coaster://connection/{id}`, `coaster://request/{id}`, `coaster://advance/{id}`, `coaster://allowance/{id}`, `coaster://coding/{id}`, `coaster://policy/{id}`, `coaster://workflow/{id}`, `coaster://batch/{id}`, `coaster://payment/{id}`, `coaster://payroll/{id}`, `coaster://bank/{id}`, `coaster://posting/{id}`, `coaster://report/{id}`, `coaster://budget/{id}`, `coaster://investigation/{id}`, `coaster://proposal/{id}`, `coaster://hold/{id}`, `coaster://expiry/{id}`, `coaster://erasure/{id}`, `coaster://grant/{id}`, `coaster://handoff/{id}`, `coaster://event/{id}`. Each is the native visible projection, including private inbox scope and frozen revision identity. Customer, provider, import, receipt and log text is untrusted.

**Events.** `receipt.received`, `receipt.read`, `receipt.questioned`, `receipt.corrected`, `receipt.attached`, `receipt.discarded`, `receipt.merged`, `charge.posted`, `match.changed`, `feed.stale`, `feed.resumed`, `claim.submitted`, `claim.decided`, `claim.retracted`, `claim.held`, `question.answered`, `batch.certified`, `batch.released`, `payment.pending`, `payment.settled`, `payment.failed`, `payment.returned`, `bank.changed`, `bank.hold_released`, `payroll.confirmed`, `posting.failed`, `posting.completed`, `statement.closed`, `policy.published`, `budget.threshold`, `person.changed`, `grant.revoked`, `expiry.completed`, `erasure.completed`, `handoff.completed`, `handoff.failed`. Private events stay within the native inbox/delegate scope; event identities correspond to the same native history transition.

**Prompts.** Close a week's expenses (AGENT-001, CAPTURE-003, CODE-002, APPROVE-001, PAY-001, ACCT-001); resolve a receipt disagreement (AGENT-002); replay an expense-policy change (AGENT-003); repair a feed or posting gap (AGENT-004); explain a policy decision (AGENT-005); investigate related evidence (AGENT-006); answer spend and remaining-budget questions (AGENT-007, REPORT-001, REPORT-004); prepare month-end close (AGENT-008); assemble a trip (AGENT-009).

**Not tools, and why.**

- *The import door:* COA-011, COA-012, MOVE-001, MOVE-002, MOVE-003, MOVE-004, MOVE-005. Incumbent move-in, its inventory/carry and deduplication, statement-file recovery, catalog/budget CSV import and whole-installation export/restore stay with Base's import/portability doors; live connection jobs above are separate. Source account exports remain source-side preparation.
- *An operation or installation fact:* COA-013 and DATA-001 cover installation/runtime and declared egress, rather than a business action.
- *A person's interactive screen:* MOBILE-001 and A11Y-001 describe the usable, accessible browser interface; its business actions are represented above.
- *Device-only:* MOBILE-002 covers offline capture, GPS, biometric unlock and push presentation in the installed phone client. Address-route calculation and saving a supplied distance are separate server jobs above.
- *Served by the surface itself:* COA-008's role-exact handler boundary is exercised by SURFACE-002 rather than a tool that changes permissions.

**Limits.** Receipt uploads accept at most 10,000,000 bytes per original, independently, with signature validation; legacy claim-receipt intake retains its narrower native bound until extended. Statement-file recovery keeps its 1.5 MB, 1,000-row and 150-new-charge bounds in the import door. Claims hold at most 100 expenses; a per-diem quote spans 1–60 dates; scheduled draft batching takes at most 200 claims and cash-draft preparation at most 25 originals per delivery. Larger sets use cursors and bounded jobs with progress. Business limits and spend caps are the company's policy; estimated USD usage is not a promise that Base enforces spend caps.

**Handoffs.** Listen for verified provider charge, receipt, payment, payroll and catalog events, Willow employment changes, Auth identity revocation, travel itinerary changes and Purse/Gauge outcomes, resolving them through the matching native actions. Emit the event types above with record links for Pantry, Purse, Gauge, Nook, Crank and the business overview; outbound payloads follow the table's classes. A supplier invoice becomes a Purse handoff, not a second reimbursement. Payroll remains in the payroll provider, booking in the travel tool and accounting in the ledger. Failed handoffs retain an owned gap and source reference.

#### SURFACE-001 — The registry equals the Coaster job table

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-006, BASE-AGENT-013

**Requirement.** The expense controller's registry is exactly this table, its resource templates, events, prompts and non-tool reasons. It maps native action variants without implying that today's proposal-only API already supplies the target door.

**Acceptance.**
1. Discovery returns exactly the listed tool names, clauses, possible classes, templates and prompt jobs, with no catch-all executor.
2. Every Core clause is represented by a tool or exactly one non-tool reason; no clause occurs in both sets.
3. Claim save, receipt attach, decision, statement close and batch creation produce the same native records through the browser action and registered action on identical fixtures.
4. Coaster's existing specialist preparations resolve to these same jobs rather than a separate decision path.
5. Under the named all-autonomous and held company policies in SURFACE-013, the Base harness passes on Coaster's fixtures and the registry-generated agent documentation describes the same jobs.

#### SURFACE-002 — Native financial visibility follows every read

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-003, BASE-AGENT-006, BASE-AGENT-010

**Requirement.** Coaster's resource projections preserve its private-original, submitted-revision, department, routed-task and finance boundaries. A report link opens precisely the revision whose figures produced it.

**Acceptance.**
1. Employee, assigned approver, department head, finance and auditor reads match their native claim, card, report and receipt projections; a foreign draft and nonexistent id are indistinguishable.
2. An unsubmitted original and its lifecycle reasons never appear in finance search, accrual details, audit packs or replay events; submission exposes only the native financial projection.
3. On one receipt fixture, returning a masked ordinary expense declares standard only; returning its attached health invoice declares standard and sensitive, with one record and kind health.
4. Reading the same event cursor after role loss omits the newly inaccessible record and its payload.
5. Exact receipt hashes, revision numbers, decision identities and source links agree across resources, PDF, audit pack and reports; source and log text carries the untrusted marker.

#### SURFACE-003 — Receipt work retains the exact original

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-006, BASE-AGENT-012

**Requirement.** Receipt actions preserve Coaster's original bytes, private lifecycle, reading/correction history and posted-charge facts. Terminal inbox dispositions are distinguished from reversible attachment and draft coding.

**Acceptance.**
1. Independent valid uploads survive a mixed batch's oversized refusal with identical hashes and one original per accepted file.
2. On the same ordinary receipt, a local coding suggestion declares standard; sending its bytes to the configured reader declares external, known, one provider recipient. A provider coding request uses that same external classification.
3. Replacing that fixture with an ID-bearing original adds sensitive to extraction, correction, attachment and suggestion output; its ordinary version carries no sensitive class.
4. Discard and merge declare destructive with affected item counts, retain downloadable bytes and end eligibility; detach declares standard and preserves prior revisions.
5. An answer retains the question's conflicting values and source crop; a changed reading or posted charge invalidates the old answer rather than altering settled facts.
6. Exact-date, tip and FX matching runs once on a unique pair; ties return the native question and an undone pair remains excluded.

#### SURFACE-004 — Decisions bind an exact revision and payable amount

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-006, BASE-AGENT-008, BASE-AGENT-012

**Requirement.** Expense and spend decisions use Coaster's frozen routing, own-expense separation, exception explanations and exact-expense reimbursement keys. Financial effect follows the decision's actual change, including any rule decision triggered by submission.

**Acceptance.**
1. A $2,400 spend-request authorization declares commitment with its value and counterparty; a draft estimate declares standard without money.
2. On one submitted $60 claim, returning it without a payable change declares commitment only; accepting its reimbursement declares commitment and money for 6,000 USD cents to its employee. Submission or hold release triggering the same payable change carries both too.
3. A repeated or stale decision changes nothing; a split retains exact earlier evidence and the held and kept totals reconcile.
4. No combined role or delegate path makes the sponsor eligible to decide their own expense, under either named company policy.
5. A batch certification and outside-payment recording declare commitment; release declares money and commitment. Recording a payment never initiates a second transfer.
6. Exact-expense keys continue to prevent a second reimbursement after retention, card matching, correction and replay.

#### SURFACE-005 — Reimbursements and provider handoffs reconcile once

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-006, BASE-AGENT-008, BASE-AGENT-012

**Requirement.** Payment, payroll and sibling jobs preserve exact native payable amounts, provider references, saved bank-change holds and uncertainty recovery. A provider acknowledgment is not bank settlement.

**Acceptance.**
1. A released USD transfer declares money and external with employee, exact cents and fee; a foreign payout also retains original currency, FX and local payout reference.
2. On one personal-spend fixture, netting against an internal reimbursement declares money and commitment without external; paying the same debt by ACH adds external for the configured provider.
3. On one ledger fixture, refreshing its catalog declares external without money; a sync that creates or adjusts an actual payable bill adds money with its exact value. Retry and reversal use the same effect computation.
4. On one supplier-invoice handoff, sending evidence alone declares external; the same handoff accepting a supplier obligation adds commitment and money. Protected bank-number content adds sensitive; the masked alternative does not.
5. One payroll run gets separate exact taxable and reimbursement amounts; an uncertain response is read back, not blindly resent, and the resulting record names the original processed run.
6. A saved bank-change hold prevents new transfers while reconciliation of an already sent transfer continues. Restored connection evidence confers no execution authority.

#### SURFACE-006 — Reports and communication use actual audiences

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-003, BASE-AGENT-006, BASE-AGENT-010

**Requirement.** Reporting, conversation, follow-up and delivery retain Coaster's source figures, business-time dates and native recipient visibility. Routing by email or chat does not make an outside recipient internal.

**Acceptance.**
1. On one report fixture, delivery to an internal finance in-app inbox declares standard; delivery to an external bookkeeper on record declares external, known, one recipient, despite their Coaster role.
2. With that same payload, a new outside address declares external, new; an unauthenticated published audience declares external, public with its audience count representation. Native visibility restrictions still apply.
3. Adding payroll-number content to that report adds sensitive with its record count and kind; removing it leaves the underlying delivery class unchanged without sensitive.
4. The same recipient and payload computation covers aliases, comments/questions, notifications, chases, invitations and grant-associated outbound deliveries, including provider routing.
5. On one report schedule, saving an inactive draft has no live class; activating its delivery adds live for report delivery while retaining its audience class.
6. Spend answers and remaining budgets match exact report lines on both sides of a business-time month boundary; each reminder ceases when its native item is resolved.

#### SURFACE-007 — Operating rules disclose their running effects

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-006, BASE-AGENT-009

**Requirement.** Coaster distinguishes a candidate business configuration from one affecting running expense processing. Publishing does not rewrite historical policy, coding, statement or decision evidence.

**Acceptance.**
1. On one matching-rule fixture, an inactive candidate declares standard without live; applying it to enabled matching adds live with service receipt matching. The same before/after enabled-state computation covers coding, recurring drafts, budgets, entities, reminders, reading, staff handoff and delivery configurations.
2. Publishing an effective policy/workflow declares commitment and live; saving the same future inactive proposal retains commitment without live. A schedule changes no agent-policy decision by itself.
3. Setting or stopping a stipend entitlement declares money and commitment with exact entitlement value and employee population; its active scheduling adds live. A saved recurring draft estimate is standard, not money.
4. Previewing a policy change compares the same frozen population, card charges and payment states without changing a historical decision or transfer.
5. Statement close declares commitment and leaves an immutable balanced native ledger; a correction in a closed connected period posts a dated reversal and replacement, preserving the original.
6. Provider USD estimates and cost reservations remain labeled estimates; changing estimate inputs creates no transfer and declares standard.

#### SURFACE-008 — Staff and delegation use native authority differences

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-005, BASE-AGENT-006, BASE-AGENT-008

**Requirement.** Membership, task reassignment, alias identity and delegation jobs compute authority from the actual native target. Handoffs preserve private-original custody when open work moves to a successor.

**Acceptance.**
1. A staff invitation declares access, direction widens; revocation declares access, narrows. An outside invitation additionally declares external, while the same internal invitation does not.
2. Delegate grants, revokes, task reassignment and alias confirmation/removal declare access with changed principals and direction; narrowing stops their next use.
3. Across members, delegates, task reassignment and alias families, a call widening the agent's or its sponsor's own authority is refused under every company policy, including the named all-autonomous policy.
4. HRIS sync declares access and external; on the same termination fixture, native deactivation alone adds neither security nor live, while revoking the person's sign-in credentials and freezing an enabled card adds security and live, with the exact setting/service facts.
5. HRIS-based attempts to widen the agent or sponsor are refused under every policy; a provider identity field is not authority.
6. Successor handoff detaches the departing employee's private original and moves only the native charge/task facts, recording the agent and represented person.

#### SURFACE-009 — Protective controls and credential grants have explicit scope

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-005, BASE-AGENT-006, BASE-AGENT-009

**Requirement.** Coaster declares authority and protective effects separately for API/agent grants, provider scopes, SSO, payment controls, reading consent, intake identity and retention. Native secrets are references in outputs, not agent-readable credentials.

**Acceptance.**
1. Grant creation/revocation and provider connect/disconnect declare access and security; access facts show the actual principals and direction. A bank-destination change declares security without exposing account numbers.
2. On one grant fixture, creating a local credential adds no external class; configuring its outside webhook adds external, and enabling that webhook adds live. Revoking an inactive grant has no live class; revoking its active delivery adds live.
3. In each of the grants, providers/reconnection, identity/SCIM, payment/security-controls and mail/alias/reading families, widening the agent's or sponsor's own authority is refused under every policy.
4. On one SSO fixture, editing a local inactive definition declares access and security; sending it to its configured provider adds external and enabling enforcement adds live. Provider gating follows SURFACE-010.
5. A legal hold and retention protection declare security; changing an inactive retention proposal has no live class, while enabling the expiry service adds live. A reading-provider protective setting uses the same active-effect distinction.
6. Payment, bank and provider secrets remain sealed; the grant, connection and security tools return references and masked state rather than credential material. Restoring those records creates no usable credential.

#### SURFACE-010 — Provider registration and continuation stay distinct

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-005, BASE-AGENT-006, BASE-AGENT-008

**Requirement.** Coaster distinguishes outside account creation, existing-account connection and provider-kept interactive steps. A continuation records what the provider requires, without turning that hosted screen into a password or verification-code tool.

**Acceptance.**
1. Creating an outside account declares accounts, access, security and external with provider, resource identity and credential scope; connecting an existing account carries access, security and external, without accounts.
2. On one provider-registration fixture, its free account carries no money; selecting an actually charged resource adds money with the exact charge and counterparty. A displayed estimate alone does not.
3. On that same fixture, a completed provider response has no gated class; a response requiring hosted identity verification adds gated with provider, step and continuation. This applies to connection, reconnect, mailbox, feed, merchant, bank, payment, payroll, ledger, travel and sibling calls.
4. Issuing a card declares accounts, access, money and external; issuing an inactive card adds no live class, while activating it adds live for that card program.
5. Card configuration, freeze, unfreeze and cancellation declare their table classes; widening the agent's or sponsor's own card authority is refused under every policy.
6. Registration and bank-verification calls that would widen the agent's or sponsor's own authority are refused under every policy; hosted consent, card entry and personal terms stay at the provider's interactive screen.

#### SURFACE-011 — Erasure and expiry retain financial invariants

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-005, BASE-AGENT-006, BASE-AGENT-012

**Requirement.** Coaster's irreversible identity and financial-expiry jobs keep native hold checks, erasure epochs, exact-expense reservations and financial receipts. An agent call is attributed as the agent for the eligible sponsor rather than as a personal confirmation.

**Acceptance.**
1. Eligible expiry declares destructive with exact claim/receipt counts, retains reimbursement keys and leaves its native expiry receipt.
2. Former-member erasure declares destructive, access and security; it removes identity and credentials while retaining financial totals and hashes under the opaque subject.
3. A new legal hold or changed proposal prevents removal of the affected records exactly as in the native action, under both named company policies.
4. A pre-erasure archive cannot restore the erased identity when the current journal knows the later epoch.
5. Erasure and retention-control attempts widening the agent's or sponsor's own authority are refused under every policy.

#### SURFACE-012 — Specialist preparations compose the financial jobs

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-003, BASE-AGENT-006, BASE-AGENT-012

**Requirement.** Coaster's expense controller composes the same receipt, trip, coding, decision, handoff and close jobs exposed to outside agents. Preparations cite records rather than introducing a separate class of authority.

**Acceptance.**
1. Eight existing trip expenses group once without changing ids, original hashes, per-diem evidence or reimbursement keys; source drafts retain their other expenses.
2. Expense preparation cites current coding sources and policy versions; conflicting advice remains distinguishable from recorded facts.
3. A finance investigation assembles only related submitted evidence, and its outcome declares commitment; opening the pack has no money class and sends no employee message.
4. Repair follows exact cursor/posting gaps and never interprets uncovered dates as zero spend or creates another payment for an uncertain result.
5. A month-end checklist reconciles department accruals, statement balances and provider/ledger references; posting its accrual declares commitment and external without money unless a separate payable-changing job is invoked.
6. The same accrual fixture with an ID-bearing attachment adds sensitive, while its amount-only form does not; an unfinished provider step adds gated as in SURFACE-010.

#### SURFACE-013 — The expense controller completes a seeded week under two policies

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-007, BASE-AGENT-009, BASE-AGENT-013

**Requirement.** A stranger agent runs a seeded Coaster week through MCP. People select two fixture company policies: all-autonomous makes every class autonomous; held makes standard review and every other class approval. These policies belong to this journey.

**Acceptance.**
1. Given only the URL and named sponsor, discovery supplies scoped employee, assigned-approver and finance jobs. Sandbox providers are preconnected with personal steps completed.
2. Under all-autonomous, the agent captures receipts, answers a seeded disagreement, codes thirty charges, assembles a trip, submits and decides claims, reconciles a statement, releases/pays a batch, observes settlement, syncs the ledger and posts the accrual; no person participates.
3. Under all-autonomous, known-provider delivery and a new-counterparty handoff complete with correct classes, facts and attribution; payable, provider and ledger totals reconcile.
4. Under held, standard calls complete into its review feed; every other class produces an approval request without effects until the fixture person approves, then replay applies once.
5. Withholding one held payment approval leaves its transfer unsent and drafts usable; granting it completes the week with the same totals.
6. Both runs audit every sponsor, action, class, fact and policy revision: zero decisions disagree with the selected policy, duplicate reimbursements or cross-role private disclosures.
7. Provider-continuation and authority-widening probes retain SURFACE-008 to SURFACE-011's outcomes under both policies. The all-autonomous week uses provisioned fixtures, never fabricated personal consent.

## Status rows

| Clause | Title | Kind | Status | Evidence | Gap |
| --- | --- | --- | --- | --- | --- |
| `SURFACE-001` | The registry equals the Coaster job table | target | missing | | The registered MCP jobs and Coaster-specific conformance outcomes in this clause are not built yet. |
| `SURFACE-002` | Native financial visibility follows every read | target | missing | | The registered MCP jobs and Coaster-specific conformance outcomes in this clause are not built yet. |
| `SURFACE-003` | Receipt work retains the exact original | target | missing | | The registered MCP jobs and Coaster-specific conformance outcomes in this clause are not built yet. |
| `SURFACE-004` | Decisions bind an exact revision and payable amount | target | missing | | The registered MCP jobs and Coaster-specific conformance outcomes in this clause are not built yet. |
| `SURFACE-005` | Reimbursements and provider handoffs reconcile once | target | missing | | The registered MCP jobs and Coaster-specific conformance outcomes in this clause are not built yet. |
| `SURFACE-006` | Reports and communication use actual audiences | target | missing | | The registered MCP jobs and Coaster-specific conformance outcomes in this clause are not built yet. |
| `SURFACE-007` | Operating rules disclose their running effects | target | missing | | The registered MCP jobs and Coaster-specific conformance outcomes in this clause are not built yet. |
| `SURFACE-008` | Staff and delegation use native authority differences | target | missing | | The registered MCP jobs and Coaster-specific conformance outcomes in this clause are not built yet. |
| `SURFACE-009` | Protective controls and credential grants have explicit scope | target | missing | | The registered MCP jobs and Coaster-specific conformance outcomes in this clause are not built yet. |
| `SURFACE-010` | Provider registration and continuation stay distinct | target | missing | | The registered MCP jobs and Coaster-specific conformance outcomes in this clause are not built yet. |
| `SURFACE-011` | Erasure and expiry retain financial invariants | target | missing | | The registered MCP jobs and Coaster-specific conformance outcomes in this clause are not built yet. |
| `SURFACE-012` | Specialist preparations compose the financial jobs | target | missing | | The registered MCP jobs and Coaster-specific conformance outcomes in this clause are not built yet. |
| `SURFACE-013` | The expense controller completes a seeded week under two policies | target | missing | | The registered MCP jobs and Coaster-specific conformance outcomes in this clause are not built yet. |
