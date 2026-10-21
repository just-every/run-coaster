# Coaster API

All routes are under `/api/coaster/` on the installation's own origin and
answer JSON (`{"error": "…"}` with a 4xx status when refused). Money is integer
minor units in responses; requests take amounts as decimal text such as
`"64.50"`.

## People (native session)

A person's requests carry their native session cookie. Writes must come from
the same origin. Every handler checks the session and the person's current
Coaster role itself. A delegate (ADMIN-005) sends `x-coaster-acting-for: <email>`
(or `?actingFor=` on a link) to act in that person's name: Submit only reaches
their own expenses, Full their whole role row; delegate access, agent keys and
approval delegation stay the person's own. Each history line is the delegate's,
with `actingFor`.

| Route | Who | Does |
|---|---|---|
| `GET state` | anyone in Coaster | Their workspace: business, categories, the claims they may see, their proposals and agent keys; batches for finance and auditors. An auditor sees every submitted claim and changes nothing. |
| `GET receipt-inbox` | employee or their live Submit-only/Full delegate | Private originals, reader/lifecycle history, cash drafts and current expense attachment. |
| `POST receipt-inbox/:id/attach` `{expectedSequence, claimId, itemId, version}` | its employee or their live Submit-only/Full delegate | Attach an active unattached original to an unreceipted purchase on their own draft or returned claim; the shown notice explains receipt sharing on submission. |
| `POST receipt-inbox/:id/detach` `{expectedSequence, claimId, itemId, version}` | same | Detach from the editable expense; keep the original and earlier submitted evidence. Both routes append private lifecycle history and advance the claim version. |
| `POST claims` `{title}` | employee | Start a draft claim. |
| `GET claims/:id` | who may see it | Items, receipts, exceptions, every revision, decision and history line. |
| `POST claims/:id/items` `{version, item?, kind, date, merchant, amount \| distance \| days, description, explanation, billable?: boolean, customer?: string, project?: string, receipt?, allocations: [{category, costCentre, amount?, description?}], attendees?: [{kind: employee\|guest, name, email?}], fields?: {name: value}}` | its employee | Add or replace an expense (draft or returned); an itemized part names itself (room, tax), attendees count against a category's per-person limit, and every category's required fields must be filled before submission. |
| `POST claims/:id/items/remove` `{version, item}` | its employee | Remove an expense. |
| `POST claims/:id/receipts` `{version, name, base64, item?}` | its employee | Upload receipt bytes (JPEG, PNG, WebP, HEIC or PDF, at most 1.5 MB). |
| `POST claims/:id/submit` `{version}` | its employee | Submit the next revision to the approving manager. |
| `POST claims/:id/decision` `{revision, version, decision: approved\|returned\|rejected, reason, acknowledge}` | the assigned manager | Decide the exact revision. |
| `GET receipts/:id` | who may see its claim | The receipt bytes. |
| `POST requests` `{title, estimate, purpose}` | employee | Ask before spending; routes to their approving manager (or that manager's delegate). |
| `POST requests/:id/decision` `{version, decision: approved\|rejected, reason}` | the routed approver | Decide the exact request; expenses link to an approved one with `request` and claims show estimate against actual. |
| `GET advances` | anyone | Cash advances you may see (your own, routed to you, or all for finance, auditors and the owner) with what each claim draws, what it reimburses beyond the advance, what is owed back, the due date (120 calendar days after the paid date) and the overdue ones apart. |
| `POST advances` `{purpose, amount}` | employee | Ask for a cash advance; routes to their approving manager (or that manager's delegate). |
| `POST advances/:id/decision` `{version, decision: approved\|rejected, reason}` | the routed approver | Decide the exact advance; nobody decides their own. |
| `POST advances/:id/paid` `{version, reference, paidOn}` | finance, not the advance's employee | Record an approved advance paid outside Coaster. |
| `POST advances/:id/return` `{version, amount, returnedOn, reference}` | finance, not the advance's employee | Record excess returned, never more than is still owed. |
| `POST claims/:id/advance` `{version, advance}` | the claim's employee | Link one of their paid advances to a draft or returned claim (empty `advance` unlinks); its batch pays the claim total less the advance and posts a negative "Cash advance applied" line. |
| `POST batches` `{claims: [id]}` | finance | Draft batch of approved claims. |
| `GET batches/:id` | finance, auditor | Claims, people, accounting lines, history. |
| `POST batches/:id/remove` `{version, claim}` | finance | Take a claim out of a draft batch. |
| `POST batches/:id/approve` `{version, expectedTotal}` | finance (not for their own claims) | Review and lock the batch. |
| `GET batches/:id/accounting.csv`, `GET batches/:id/reimbursements.csv` | finance, auditor | The export files. |
| `POST batches/:id/paid` `{version, reference, paidOn}` | finance | Record the payment made outside Coaster. |
| `POST settings/business`, `settings/categories`, `settings/members`, `settings/members/invite` | owner | Policy, categories, people and invitations. |
| `POST agent-keys` `{label}` → `{token}`; `POST agent-keys/:id/revoke` | the person | Make (shown once) or revoke their agent's key. |
| `POST delegates` `{delegate, level: submit\|full, grantor?}`; `POST delegates/:id/revoke` | the person (the owner for anyone; the delegate may end their own) | Give or end delegate access; the granting person is emailed each grant. |
| `POST proposals/:id/accept`, `POST proposals/:id/decline` `{reason}` | the person it was prepared for | Turn a proposal into their own draft claim or draft batch, or decline it. |
| `GET history?q=&from=&to=` | owner, finance, auditor | Search every history line (who, what, when, app or agent): `CL-0001` gives a claim with its batch's review, export and payment lines, `RB-0001` a batch, anything else matches people and words; dates are business-time days. |
| `GET audit-pack?from=&to=` | owner, finance, auditor | A ZIP for the period: `manifest.json` (every claim submitted in it with revisions, exceptions, explanations, decisions and payment references), `history.csv` and each receipt's exact bytes under its SHA-256. |
| `GET import`; `POST import/preview\|commit\|status\|resume\|undo` | owner | The Expensify move-in kit (IMPORTING.md). |

## Agents (agent key)

An agent sends `Authorization: Bearer cst_…` and reaches only these routes. It
acts for the person who made the key and can only prepare work for them.

| Route | Does |
|---|---|
| `GET agent/context` | Who it works for, the business policy, active categories, its proposals; approved claims if that person is in finance. |
| `POST agent/claims` `{title, note, items: [{…same item fields…, receipt?: {name, base64}}]}` | Prepare a draft claim (employees). |
| `POST agent/batches` `{claims: [id], note}` | Propose a batch of approved claims (finance). |
| `GET agent/proposals/:id` | Read one of its proposals and whether the person accepted it. |

The person accepts or declines in Coaster; the resulting claim or batch records
that the agent prepared it and who accepted it. An agent key cannot submit,
approve, batch, pay, change settings or read other people's claims, and a
revoked key stops working at once.

## Versioned expense policy (POLICY-001)

`GET /api/coaster/policy` returns `{versions}` to owner, finance and auditor. `POST` accepts `{effectiveFrom?, rules}` from owner/finance; at most 50 rules, effective today or later in the business time zone. Each rule has `kind` and `hard` (default false). Category rules use an active `category` id. `daily-limit`, `trip-limit`, `monthly-limit`, `per-expense-limit`, `attendee-limit` take a decimal `limit`; `receipt-threshold` takes only `limit`; `blocked-category` and `approval-required` take `category`; `required-field` also takes `field`; `blocked-merchant` takes `merchant`; `weekend` and `holiday` take no other fields; `deadline` takes integer `days` (1–3650, one deadline). Finance rules add to the immutable owner configuration captured with each version. Owner business/category saves create their own immediately effective version. `state.policyFields` supplies active finance-required field names to expense forms; item `fields` accepts their values. Submitted revisions record `policyVersion`; exceptions raised by configurable policy carry `policy` and additional finance rules carry `hard`. Trip/month/date/approval semantics are stated in CONTRACT.md.

## Policy replay assistant (AGENT-003)

`POST /api/coaster/policy/advice` accepts `{minutesPerException:number}` (positive, at most 1440) from a native signed-in finance person or owner. It returns `{policyVersion,window,suggestions}`: each suggestion names the category, current/proposed integer-cent limits, acknowledged approval count, category-limit exception counts before/after, affected claims/expenses, `estimatedHoursSaved`, the entered minutes, `estimate:true`, and `proposalToken`. It sends nothing externally. `POST /api/coaster/policy/advice/adopt` accepts `{category,proposalToken,minutesPerException}` from the owner, recomputes the exact proposal, refuses stale inputs, and returns `{policyVersion,effectiveFrom,adopted}` after appending today's version. The token is an integrity binding, not an access grant; agent keys cannot use these doors. Advice also returns `ruleSuggestions` for recurring acknowledged soft finance rules. Supply `proposedRules` (the same rule inputs as `POST policy`) to preview a complete candidate set, including tightening; the returned `preview` contains rules, affected claims/expenses and exceptions, approval observations/effort estimates, reimbursement eligibility/affected recorded amounts, population semantics and a proposal token. The owner adopts with `{proposedRules,proposalToken,minutesPerException}`. Candidate rules always retain the current owner floor, all historical records stay unchanged, and only a new effective-today version is appended. FEED-004 and PAY-001 carry future card and settlement replay.

## Emburse configuration (MOVE-003)

The existing import preview/commit doors accept `{source: "certify"|"chromeriver"|"abacus", configuration: string|object, mapping: {crosswalk?: {sourceKey: nativeId}}}`. `configuration` is the members/categories/chains JSON in IMPORTING.md; send the original JSON string to retain exact file bytes. Preview returns `summary.crosswalk`; commit echoes it in `mapping.crosswalk` with the fingerprint. Member `member_id` is a random opaque UUID exposed to the owner in state, and each member sees their own. Native mapped people/categories are preserved, new people are inactive, and ordered chains require owner activation before use. Status includes the dependency-aware undo report.

## Claim and batch PDFs (REPORT-005)

`GET claims/:id/pdf` uses the claim’s usual read permission; `GET batches/:id/pdf` uses the batch’s usual read permission. Both return an attachment PDF with summaries, coded expense lines, approvals, payment references, comments and rendered receipt pages stamped with the expense id and original SHA-256. The originals are attached byte for byte. Optional `?customer=NAME` and/or `?project=NAME` includes only expenses whose native `billable` flag is true and whose supplied customer/project filters both match exactly. No match refuses with 404; an unreadable/encrypted receipt or a HEIC image above the 24-megapixel rendering safety limit refuses with 422, with the original still downloadable. Item save/agent preparation accepts `billable: boolean`, `customer: string` and `project: string` (customer/project are optional native text coding, each at most 200 characters); billable requires a nonblank customer. Coding stays in submitted revisions, and PDFs use that frozen coding. Accounting CSV/XLSX exports and their templates carry `billable`, `customer` and `project` on every split and sales-tax line. This prepares a file; it sends nothing externally. CLAIM-006 remains partial: QuickBooks/Xero billable sync, ledger customer/project choices and Gauge handoff require their provider connections.

## SAP Concur move-in (MOVE-002)

The existing owner-only import doors accept `source:"concur"`. Configuration is exact JSON bytes in `configuration`, with the MOVE-003 envelope plus supported `policies` and `mapping.crosswalk`. History takes `csv`, `filename`, `mapping:{layout:"sae-v4"|"headers",employees:{sourceId:email},categories:{expenseType:nativeCategoryId},columns?,delimiter?,date?,statuses?,imageFiles?}` and `receipts:{archive:{name,base64}}` (or `files` plus `index:{name,csv}`). IMPORTING.md defines the source columns and SAP image index. Preview returns counts, diagnostics and the exact fingerprint; commit applies only that review. Undo compensates policy adoption with a new version, preserving later edits. Banking/PAN columns and erased source identities refuse before retention. No Concur connection or credentials are used.

## Foreign-currency expenses (CLAIM-003)

`settings/business` accepts owner-only `fxEnabled: boolean` (off by default, preserved when omitted). Receipt-item input accepts `currency` (installation currency when omitted), `amount`, optional sales tax and split amounts in that original currency. Optional `manualRate` is explicit decimal business units per original unit, positive with up to 12 decimal places; without it ECB must be enabled and available. The returned item and frozen revisions expose `original_minor`, `original_currency`, `fx_rate`, `fx_date`, `fx_source`, `original_sales_tax_minor`; each split retains `original_minor`. Amounts are hundredths of units. FX exports add `original_amount`, `original_currency`, `exchange_rate`, `rate_date`, `rate_source`. Original source/report/transaction amounts remain separate on Concur history. See CONTRACT.md for exact rounding and publication-date semantics.


## Per diem (CLAIM-002)

`GET per-diem/locations?method=gsa|state|high-low` returns explicit published locality ids and labels. `POST per-diem/quote` accepts `{date, perDiem:{method,locationId,endDate,component:"mie"|"lodging"|"both",providedMeals?:[{date,meals:["breakfast"|"lunch"|"dinner"]}]}}` from a signed-in employee and writes nothing. Supply that same `perDiem` object on the normal item-save, automatic-expense or agent-draft door with `kind:"per_diem"`; client totals and rates are ignored. The server returns the copied `per_diem` daily breakdown on the expense and frozen revision. USD government rates use the existing explicit `manualRate` or enabled ECB path for another business currency. Without `perDiem`, the existing owner-set company allowance remains `days × perDiem` in business currency. Government date coverage, overnight lodging and meal semantics are in CONTRACT.md. The accounting template field `per_diem` contains the exact JSON daily evidence; it is also readable in the claim PDF.

## Expensify cutover inventory (MOVE-005, partial)

`GET import/cutover` is owner-only and returns `{imports,feedReconciled:false,openItemsCarried:false}`. Each retained Expensify import has one row per source report/expense, its source location and disposition (`history-only`, `open-history`, `left-behind`, `erased`), reconciled record counts, open report count and expense-only amount. Counts are per job; undo/reimport remain separate operations. Open source reports are read-only history, never native approvals or payable claims. No feed or payment is changed.

## Policy review advice (AGENT-005, partial)

Submitted claim revisions include `snapshot.policyReview`: deterministic per-expense recommendations (`review` or `no-policy-exception`) with actual evaluator reasons and policy version, exact receipt id/hash, amount, date, allocations and linked request. `checksUnavailable` explicitly names receipt-content, card-match and coding-confidence checks. The normal claim read scope applies. Advice is immutable, never an approval grant, and never changes configured workflows, owner approval rules or personal agent-key authority. Revisions created by partial approval retain only kept-expense advice; hold release records advice under its effective policy.

## Receipt metadata signals (POLICY-002, partial)

Submitted revisions carry `snapshot.receiptSignals`, separate from policy exceptions. Each expense with a receipt has the receipt id/hash, supported metadata fields, an honest inspection status and computed `editing-software`/`image-date-mismatch` signals labelled `possible, needs review` with exact reasons. These signals change no submit/approve/batch/release/payment eligibility. JPEG EXIF and PNG tEXt/eXIf are supported; compressed PNG text, XMP and PDF/WebP/HEIC metadata are not checked. `POST claims/:id/receipt-signals/review` takes `{revision,item,code,note}` from native finance (owner included), records one human reason per current-revision signal in append-only claim history and leaves the evidence and payment untouched. It uses the existing claim read scope, same-origin/session and transaction guards.

### MOVE-005 open-report carry

`POST /api/coaster/import/carry` accepts `{report, categories: {transactionID: nativeCategoryId}}` from the report employee's same-origin native session. It creates one draft from a complete imported open/submitted/approved Expensify report's reimbursable purchases. It imports no approval or payment authority and no remote receipt URL is fetched. Missing native evidence and policy explanations are supplied before ordinary submission. Other employees see 404. Paid/closed reports, missing categories, mileage and repeated carry are refused without writes. Source undo leaves the draft/payment and opaque source reservation intact. The owner inventory at `GET /api/coaster/import/cutover` includes `carriedClaim` per linked source record and `carriedReports` per import; `feedReconciled` remains false.

## Receipt inbox (CAPTURE-001, partial)

`GET /api/coaster/receipt-inbox` lists the signed-in employee's unattached originals and private numbered state history; existing ADMIN-005 grants act for that employee. `POST` to the same path accepts multipart form data with exactly one `file` and optional `source` (`upload` or `camera`). Send multiple files as independent requests so one refusal leaves earlier successes intact. Each file is at most 10,000,000 bytes inclusive; actual streamed request bytes are bounded, and signature-derived JPEG, PNG, WebP, HEIC and PDF formats are accepted. A format refusal is 415, oversize 413, and a missing receipt store 503 with a repair message.

The response is `{receipt}` with id/name/mediaType/size/sha256/source/uploadedBy/uploadedAt/state/attentionReason/downloadUrl/history. `GET receipt-inbox/:id` downloads an exact original under the same scope. R2 holds bytes; D1 holds provenance and immutable received/needs-attention history (sequence, actorEmail, onBehalfOf, channel, time). With no reader shipped, all saved receipts honestly need attention for manual entry. A `camera` source records the input control used, never a camera verification. Inbox attachment/matching is CAPTURE-004; existing claim-receipt APIs retain their 1.5 MB limit.

## Private receipt disposition (CAPTURE-004)

`POST receipt-inbox/:id/discard` takes only `{reason, expectedSequence}` from the inbox employee’s current native session or live ADMIN-005 Submit-only/Full delegate. `reason` is trimmed, required, at most 1000 characters. `expectedSequence` is the current lifecycle sequence, initially 0. The response is `{receipt}` with `disposition`, `lifecycleSequence`, private `lifecycle` lines and unchanged reader `history`/download metadata. A discard is terminal; stale, repeated or concurrent second actions return 409, foreign employee receipts 404. Other roles and agent keys gain no access. `GET receipt-inbox` retains discarded rows for the private history section and downloads keep the original bytes.

## Cash receipt draft preparation (CAPTURE-004, partial)

Native finance reads `GET settings/cash-draft-window` (`{days:null|1..90,version}`). `POST settings/cash-draft-window/preview` with `{days}` returns `{days,version,count,asOf}` without private receipt identities. After showing that count, confirm the exact response with `POST settings/cash-draft-window`; stale version/count or a preview older than ten minutes gets 409. Null turns it off. Each hourly delivery considers at most 25 eligible originals and reserves each once, creating an empty private native claim and an upload-dated needs-details preparation record visible as `cashDraft` in the employee's inbox. It infers no amount, copies no original bytes and never submits. Automatic attachment and moving originals onto editable expenses remain unimplemented.

## Card receipt matching (CAPTURE-004 / FEED-004)

`GET receipt-inbox` includes each original's `matchChoice: {enabled,details,notice}`. Only its active employee and live Submit-only/Full delegates can read or change it. Agent keys cannot reach these native-session doors; a role alone grants no authority over another person's original.

- `POST receipt-inbox/:id/card-match`: `{expectedSequence,enabled,merchant,date,total,currency?,last4?,notice}`. For `enabled:true`, supply the exact current `notice` after acknowledgment, trimmed merchant (1–200 characters), purchase date, positive hundredths total, ISO 4217 currency (default business currency) and optional four digits. For withdrawal, use `{expectedSequence,enabled:false}`. An attached, terminal or cash-reserved original cannot opt in. Each change appends a private lifecycle line and advances its sequence.
- `GET receipt-inbox/:id/card-match-question`: private `{ambiguous,candidates,notice}`; candidates name the charge, claim, expense/version, statement merchant, dates, amount/currency and last four. `POST receipt-inbox/:id/attach` is the person's guarded **This one** action. `POST receipt-inbox/:id/card-match-reject` takes `{expectedSequence,chargeIds}` containing the exact current list for **None of these**; those pairs remain excluded.
- `GET settings/card-matching` and `POST settings/card-matching`: owner/finance, native session. A save takes `{version,enabled:boolean,windowDays:0..14,tipPercent:0..30,fxPercent:0..10}` with integer bounds, appends the next version and refuses a stale version. Defaults are on, 7 days, 20%, 5%. Off stops future automatic attachment; existing attachments and manual choices remain.

Only hourly delivery attaches automatically, under `automation: card match` on behalf of the employee, on channel `schedule`. It never approves, samples, submits or notifies. Its global history line names only charge, claim and rule version; entered details and lifecycle remain private. The claim's receipt alias carries a frozen `card_match_basis`, copied to submitted revisions; there are zero copied original bytes. Detach excludes the original/card-transaction key pair permanently, including after statement undo/re-import, and appends withdrawal. The exact rule and amount/date semantics are in CONTRACT.md and the claims guide.
