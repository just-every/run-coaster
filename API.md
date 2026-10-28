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
| `POST /api/coaster/approvals/bulk` `{claims: [{id, revision, version, reviewed, acknowledge, override?}]}` | the currently assigned workflow reviewer or live Full delegate, never the claim employee | Approve each of 1–25 distinct reviewed claims through the ordinary decision checks. Each claim commits independently; a 200 response contains `bulkId` and ordered `results` with `id`, `revision`, `approved`, and either `claimStatus` or refusal `status` and `error`. Missing review or exception acknowledgment, stale state, self-approval and unassigned review write nothing to that claim. Successful history records `channel: bulk`, the shared `bulkId` and exact revision. Later workflow stages remain waiting. |
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

## Receipt and spend signals (POLICY-002)

Submitted revisions carry `snapshot.receiptSignals` for every expense, separate from policy exceptions. A receipt carries its id/hash, metadata fields and explicit image inspection status; a receipt-less expense still participates in spend patterns. Each computed observation is `possible, needs review`, with its reason and comparison measurements. Exact receipt hashes, locally normalized visible ink (cropped/re-photographed/recompressed copies and localized changes), JPEG compression-grid observations, editing-software/date metadata, same-day near-limit purchases, repeated round/weekend purchases and published card-match differences feed the finance queue at `GET exceptions`. Comparisons use retained submitted revisions and the current report, never an unmatched private inbox; card evidence is the frozen employee-entered amount/date and statement amount already shared on submission. Image inspection supports JPEG, PNG, WebP and single-image HEIC up to 24 megapixels; unsupported, unreadable and insufficient-ink images are explicitly labelled, never declared authentic. The complete algorithms and measured fixture bound are in CONTRACT.md and ACCEPTANCE.md.

Signals change no submit/approve/batch/release/payment eligibility. Existing COA-004 explanations and COA-005 reimbursement uniqueness still apply independently. `POST claims/:id/receipt-signals/review` takes `{revision,item,code,note}` from native finance (owner included), records one human reason per current-revision signal in append-only claim history and leaves the evidence and payment untouched. `POST exceptions/review` accepts the same signal identity plus `claim` and removes a reviewed signal from the queue using that same history. Existing claim scope, same-origin/session and transaction guards apply. JPEG EXIF and PNG tEXt/eXIf metadata are supported; compressed PNG text, XMP and PDF/WebP/HEIC metadata remain explicitly unchecked.

### MOVE-005 open-report carry

`POST /api/coaster/import/carry` accepts `{report, categories: {transactionID: nativeCategoryId}}` from the report employee's same-origin native session. It creates one draft from a complete imported open/submitted/approved Expensify report's reimbursable purchases. It imports no approval or payment authority and no remote receipt URL is fetched. Missing native evidence and policy explanations are supplied before ordinary submission. Other employees see 404. Paid/closed reports, missing categories, mileage and repeated carry are refused without writes. Source undo leaves the draft/payment and opaque source reservation intact. The owner inventory at `GET /api/coaster/import/cutover` includes `carriedClaim` per linked source record and `carriedReports` per import; `feedReconciled` remains false.

## Receipt inbox (CAPTURE-001, partial)

`GET /api/coaster/receipt-inbox` lists the signed-in employee's unattached originals and private numbered state history; existing ADMIN-005 grants act for that employee. `POST` to the same path accepts multipart form data with exactly one `file` and optional `source` (`upload` or `camera`). Send multiple files as independent requests so one refusal leaves earlier successes intact. Each file is at most 10,000,000 bytes inclusive; actual streamed request bytes are bounded, and signature-derived JPEG, PNG, WebP, HEIC and PDF formats are accepted. A format refusal is 415, oversize 413, and a missing receipt store 503 with a repair message.

The response is `{receipt}` with id/name/mediaType/size/sha256/source/uploadedBy/uploadedAt/state/attentionReason/downloadUrl/history. `GET receipt-inbox/:id` downloads an exact original under the same scope. R2 holds bytes; D1 holds provenance and immutable received/needs-attention history (sequence, actorEmail, onBehalfOf, channel, time). With no reader shipped, all saved receipts honestly need attention for manual entry. A `camera` source records the input control used, never a camera verification. Inbox attachment/matching is CAPTURE-004; existing claim-receipt APIs retain their 1.5 MB limit.

## Private receipt disposition (CAPTURE-004)

`POST receipt-inbox/:id/discard` takes only `{reason, expectedSequence}` from the inbox employee’s current native session or live ADMIN-005 Submit-only/Full delegate. `reason` is trimmed, required, at most 1000 characters. `expectedSequence` is the current lifecycle sequence, initially 0. The response is `{receipt}` with `disposition`, `lifecycleSequence`, private `lifecycle` lines and unchanged reader `history`/download metadata. A discard is terminal; stale, repeated or concurrent second actions return 409, foreign employee receipts 404. Other roles and agent keys gain no access. `GET receipt-inbox` retains discarded rows for the private history section and downloads keep the original bytes.

## Cash receipt draft preparation (CAPTURE-004)

Native finance reads `GET settings/cash-draft-window` (`{days:null|1..90,version}`). `POST settings/cash-draft-window/preview` with `{days}` returns `{days,version,count,asOf}` without private receipt identities. After showing that count, confirm the exact response with `POST settings/cash-draft-window`; stale version/count or a preview older than ten minutes gets 409. Null turns it off. Each hourly delivery considers at most 25 eligible originals and reserves each once, creating an empty private native claim and an upload-dated needs-details preparation record visible as `cashDraft` in the employee's inbox. It infers no amount, copies no original bytes and never submits. The employee completes its expense details and attaches the original through the guarded receipt-inbox attachment door; automatic card attachment uses the matching door below.

## Card receipt matching (CAPTURE-004 / FEED-004)

`GET receipt-inbox` includes each original's `matchChoice: {enabled,details,notice}`. Only its active employee and live Submit-only/Full delegates can read or change it. Agent keys cannot reach these native-session doors; a role alone grants no authority over another person's original.

- `POST receipt-inbox/:id/card-match`: `{expectedSequence,enabled,merchant,date,total,currency?,last4?,notice}`. For `enabled:true`, supply the exact current `notice` after acknowledgment, trimmed merchant (1–200 characters), purchase date, positive hundredths total, ISO 4217 currency (default business currency) and optional four digits. For withdrawal, use `{expectedSequence,enabled:false}`. An attached, terminal or cash-reserved original cannot opt in. Each change appends a private lifecycle line and advances its sequence.
- `GET receipt-inbox/:id/card-match-question`: private `{ambiguous,candidates,notice}`; candidates name the charge, claim, expense/version, statement merchant, dates, amount/currency and last four. `POST receipt-inbox/:id/attach` is the person's guarded **This one** action. `POST receipt-inbox/:id/card-match-reject` takes `{expectedSequence,chargeIds}` containing the exact current list for **None of these**; those pairs remain excluded.
- `GET settings/card-matching` and `POST settings/card-matching`: owner/finance, native session. A save takes `{version,enabled:boolean,windowDays:0..14,tipPercent:0..30,fxPercent:0..10}` with integer bounds, appends the next version and refuses a stale version. Defaults are on, 7 days, 20%, 5%. Off stops future automatic attachment; existing attachments and manual choices remain.

Only hourly delivery attaches automatically, under `automation: card match` on behalf of the employee, on channel `schedule`. It never approves, samples, submits or notifies. Its global history line names only charge, claim and rule version; entered details and lifecycle remain private. The claim's receipt alias carries a frozen `card_match_basis`, copied to submitted revisions; there are zero copied original bytes. Detach excludes the original/card-transaction key pair permanently, including after statement undo/re-import, and appends withdrawal. Audit-pack manifests include each submitted expense's frozen `cardMatchBasis` (null for an expense without an automatic match) and ordinary receipt provenance, including `source`; they omit receipts absent from every submitted revision, private lifecycle lines, typed merchants and questions. The exact rule and amount/date semantics are in CONTRACT.md and the claims guide.

## Public REST credentials and OAuth (API-001, partial)

The separate public boundary is `/api/coaster/public-api`. This implementation
uses a conservative permission policy pending owner policy review: only the
owner's own native session can grant or revoke credentials, OAuth clients and
webhook subscriptions. Credentials bind to that consenting owner's person;
they cannot impersonate another member or use delegation. The owner must have
an active Coaster member record before granting access. Other role grants
are not implemented. A credential's scopes narrow the person's current native
permissions. A member edit, deactivation, operator version/access change,
expiry, credential revocation or OAuth client revocation invalidates it.
Writes recheck that authority inside the native guarded transaction.

Use `Authorization: Bearer <token>` on `/v1/*`. Public tokens use the `cpa_`
audience; native sessions and proposal-only `cst_` agent keys cannot replace
one. Public credentials cannot submit, decide, approve, release, record a
payment, change security/settings, consent to outbound delivery, or mint more
credentials. They prepare only the consenting person's **draft** claims,
expenses and uploads. Returned and submitted records require native action.
There is no automatic submission through this boundary.

Native same-origin owner management routes (all relative to the public boundary):

| Route | Request / result |
|---|---|
| `POST /keys` | `{label, scopes: string[], expiresInDays?: 1..90}`; default 30 days. Returns `{id,label,scopes,expiresAt,token}`. Copy the random token now: only its SHA-256 hash is retained. `member`, if supplied, must be the consenting owner's email. |
| `GET /keys` | Credential metadata, scopes, expiry and revocation; never a token or hash. Includes OAuth access credentials. |
| `POST /keys/:id/revoke` | Immediately stops this key. |
| `POST /oauth/clients` | `{label, redirectUri}`; register one exact HTTPS redirect URI without credentials or fragment. Returns `{client_id,redirect_uri}`. |
| `POST /oauth/clients/:id/revoke` | Stops outstanding codes and all credentials from this client. |
| `POST /oauth/authorize` | Explicit native owner grant: `{client_id,redirect_uri,response_type:"code",scopes,code_challenge,code_challenge_method:"S256",state,consent:true}`. Returns a `redirect_uri` with a five-minute authorization code and the exact `state`; the consenting client follows it. No silent GET grant exists. |
| `POST /oauth/token` | No session required. JSON or form body `{grant_type:"authorization_code",client_id,redirect_uri,code,code_verifier}`. Verifier is 43–128 RFC 7636 characters; challenge is base64url(SHA-256(verifier)). Exact client, redirect and S256 match are required. Atomic single-use exchange returns `{access_token,token_type:"Bearer",expires_in:3600,scope}`. No refresh tokens: obtain another explicit native grant after expiry. |

Every scope must be named explicitly; unknown, wildcard and empty scopes refuse
before a grant is written. Management actions append audit history without
secret values. API writes record `channel:"public-api"` and `apiCredential`.

Public resource routes are relative to `/api/coaster/public-api/v1`:

| Scope | Routes / behavior |
|---|---|
| `claims:read` | `GET /claims`, `GET /claims/:id`: native visible claim summaries. Does not return nested expenses, receipts, decisions, history or people records. Native draft privacy still applies. |
| `claim-reports:read` | `GET /claims/:id/final-report?revision=N`: approved submitted evidence for PURSE INTAKE-006, under current native visibility; explicit separate grant, no receipt bytes. See below. |
| `claims:write` | `POST /claims {title}`; `POST /claims/:id/title {version,title}`. Own drafts only. |
| `expenses:read` | `GET /expenses?claimId=ID`, `GET /expenses/:id`: native visible expenses and allocation coding, with receipt identifiers but no receipt bytes or file metadata. |
| `expenses:write` | `POST /expenses {claimId,version,...native item fields}`; `POST /expenses/:id {version,...native item fields}`; `POST /expenses/:id/remove {version}`. An existing own draft is required; no claim is created as a side effect of invalid expense input. Native item validation, immutable card facts, allocation rules and exact version checks apply. Responses include `{claim}` with its updated version. |
| `receipts:read` | `GET /receipts?claimId=ID` returns native visible file metadata; `GET /receipts/:id` downloads original bytes. The native original-sharing rule applies. |
| `receipts:write` | `POST /claims/:id/receipts {version,name,base64,item?}` uses native format/size checks on an own draft, returning `{claim,receipt}`. Originals stay append-only. |
| `cards:read` | `GET /cards`: native statement-card assignment metadata and last four only, for card-spend readers. Card issuance/provider operations remain in CARD-001. |
| `batches:read` | `GET /batches`: batch summaries for native batch readers. No preparation, review or release through a credential. |
| `payments:read` | `GET /payments`: reimbursed batches with their externally recorded payment date/reference. This is the current native settlement record; no payment rail or bank account access is added. |
| `people:read` | `GET /people`: native people administrators see the roster; others would see their own row. No sign-in or bank secrets. |
| `reports:read` | `GET /reports/aging`, `/cycle-time`, `/receipts`, `/unsubmitted`, `/exceptions` with native `from`, `to`, `format=csv` options; `/reports/spend?by=...&from=...&to=...` uses the existing native spend scope and grouping options. |

Collection results use `{data,nextOffset}`. Optional `offset` starts at zero;
`limit` defaults to 50 and is at most 100. Reads use the current native role and
record visibility. Unsupported resource actions refuse. Normal JSON errors
carry the same 4xx semantics as native handlers; stale writes return 409.

### Frozen approved report for PURSE INTAKE-006

The consumer is **PURSE INTAKE-006 automatic fetch**. The owner explicitly
names `claim-reports:read` when minting a key or granting OAuth consent; no
existing scope implies it. The current owner-only, self-bound, expiring grant
and revocation rules apply unchanged. No new credential principal exists.

`GET /api/coaster/public-api/v1/claims/:id/final-report` requires current native
claim visibility and status `approved`, `batched` or `reimbursed`, with final
approval evidence for the current revision. Draft, returned, rejected and
pending claims refuse with 409 (a natively invisible claim refuses with 403).
Missing scope refuses with 403; expired or revoked credentials with 401.
Optional `revision=N` must equal the current approved revision or returns 409;
it never retrieves an obsolete approval after unapproval or later correction.
A frozen comparison or split that names a claim now outside native visibility
refuses the whole report with 403 rather than rewriting its frozen signals.
Reads return `Cache-Control: no-store` and perform no write or outbound action.

The JSON response contains:

- `claim`: id, number, employee email and **current** status.
- `revision`, `submitted_by`, `submitted_at`, and `snapshot_sha256`: SHA-256 of
  the exact retained snapshot JSON bytes, identifying the immutable revision.
- `snapshot`: the frozen submission's title, currency, total, policy version,
  approval route, exceptions, policy review, receipt signals, individual expense
  approvals and split or reopen evidence when present. `items` contains the
  captured expense facts, splits with category name, account and tax codes,
  amounts and cost centre, explicit coding ids and captured dimension labels,
  and each referenced receipt's id, name, media type, size and SHA-256. These
  are projected from that exact stored revision, never recalculated using
  today's expense, category, policy, receipt reader or detector state.
- `decisions`: every submitted decision through this revision, in recorded
  order, with id, revision, step, decision, reason, approver `actor_email`,
  `on_behalf_of`, `at`, approval `role` and `final_approval`. Role is the recorded
  workflow task's manager or finance authority; ordinary and imported-chain
  reviews use manager authority. Automatic sources are labelled `rule` or
  `policy-agent`, never presented as human approvers. Intermediate chain and
  workflow decisions are not labelled final.
- `batch`: null, or batch id, number, current status, currency, this claim's
  revision and net payable `amount_minor`, creation, review and release actors
  and times. It never includes other batch claims or the batch total.
- `payment`: null, or `{source:"external-recording",reference,paid_on,recorded_by}`
  for a payment recorded outside Coaster. This does not assert provider settlement.

The snapshot projection deliberately excludes coding suggestion context, private
receipt confirmations, inbox ids, readings, questions, lifecycle history,
private notes, storage keys and original bytes. It includes only referenced
submitted receipt metadata; unattached originals remain private. Receipt
signals and policy review retain their frozen advisory meaning, including
unavailable checks; neither is an authenticity or approval grant. Evidence
absent from an older revision stays absent rather than being reconstructed.
The snapshot digest describes the retained source JSON, not the projected JSON.
Later batch or payment recording changes only the response's current sections;
later native correction creates a new revision and leaves earlier submission
facts unchanged. Existing erasure and retention rules still govern availability.
`receipts:read` remains the only public byte door. No submission, approval,
release, payment, handoff or automatic fetch is performed by this endpoint.
API-001 remains PARTIAL pending ct ratification of this conservative read grant
and the standing credential and webhook default, and Base-held hostname egress.

### Consented signed webhooks

At most 100 active subscriptions are supported. Only the native owner may call `POST /webhooks` with
`{destination,events,consent:true}`. Consent explicitly authorizes sending
minimal event metadata to that exact HTTPS address. There is no outbound send
before consent, and earlier history is not replayed to a newly subscribed
destination. The response includes `{id,destination,events,secret}`; the random
HMAC secret is shown once, then stored AES-GCM sealed under `SESSION_SECRET`
with the subscription id bound as associated data. `GET /webhooks` returns
subscription metadata and persisted delivery attempts/statuses, never secrets.
`POST /webhooks/:id/revoke` stops future dispatches; it cannot retract a request
already in flight. Membership/operator access changes also stop dispatch.

Supported events are `claim.created`, `claim.submitted`, `claim.approved`,
`claim.returned`, `claim.rejected`, and `payment.settled`. Approval means the
native final approval, including the native automatic approval rule; settlement
means finance's existing native recording of an externally paid batch after
release. No credential can produce either privileged decision.

Destinations currently require a **global public IPv4 literal**, standard HTTPS
port, and no URL credentials, query or fragment. Private, loopback, link-local,
reserved, multicast, IPv6 and hostname destinations refuse. This intentionally
narrow implementation prevents DNS rebinding without relying on an unproven
DNS-to-connection pin. Domain destinations await a trusted public-egress
boundary and policy review. The exact consented destination is the allowlist;
redirects are never followed. Native request/response bodies, receipts,
amounts, people, event detail and file content never enter the payload.
Delivery status retains only attempt scheduling, status and delivery time.

The exact JSON body is `{id,type,time,record:{id,status}}`. Each delivery sends
`x-coaster-event-id`, `x-coaster-timestamp` (Unix seconds), and
`x-coaster-signature: v1=<lowercase hexadecimal HMAC-SHA256>` over
`timestamp + "." + exactBodyBytes`, using the shown secret as UTF-8 key bytes.
A receiver should reject timestamps outside its tolerance, compare signatures
in constant time, and deduplicate by event id. Retries preserve the event id
and body and use a fresh signature timestamp.

The hourly trigger derives a durable outbox from committed native history,
leases each attempt before sending, and records only HTTP status (zero for
transport failure) and delivery time. Only 2xx succeeds; 3xx is a failed attempt
without forwarding. There are at most six attempts with 1, 2, 4, 8 and 16-hour
retry delays, bounded by hourly scheduling. Delivery is at least once: a crash
after external receipt and before success persistence can repeat an event.
Credentials, OAuth registrations/codes, subscriptions and pending deliveries
are excluded from installation archives; exported native audit history stays.

Evidence: `tests/coaster-api.test.mjs` covers scoped key preparation and scope
refusals and resource reads, the frozen approved report, OAuth consent, exact
redirect, PKCE and code single use, and signed approval and payment notifications with retries and revocation at the outbound
network edge. API-001 remains partial pending authority policy review, domain
egress support, and any wider OAuth consent experience required by that policy.

## Native automatic coding (CODE-002, partial)

These routes require a current native session. The public REST keys and
proposal-only agent keys cannot configure rules or decide suggestions.
Paths below are relative to `/api/coaster/coding/automatic`.

| Method and path | Input or result |
| --- | --- |
| `GET /rules` | `{version,rules,mccMappings,flags}`. Finance's policy row sees company rules; each employee sees their own personal rules. Rule versions retain `fields`, scope and actor. |
| `POST /rules` | `{version,id?,scope:"finance"\|"personal",merchant,active,coding}`. Finance rules use the policy row; personal rules use the person's own submit row. A merchant matches its complete normalized name. |
| `POST /mcc` | `{version,id?,mcc,category,active}`. Finance's policy row maps a four-digit merchant category code to an active category. |
| `POST /preview` | `{merchant,mcc?,values?}` returns suggested `fields`, `appliedFields`, per-field source/reason, invalid-rule flags and catalog/context versions. This is read-only. |
| `GET /suggestions?item=ID` | Current native claim scope; returns the expense's context and append-only suggestions/decisions. `GET claims/:id` also includes `codingSuggestions` on each expense. |
| `GET /suggestions?receipt=ID` | Only the original's employee; returns `{context,contextVersion,values,merchant,suggestions}`. |
| `POST /receipts/:id` | `{version,merchant,values?}` records typed merchant/coding in that private original's context and suggests currently empty fields. It does not read the image. |
| `POST /suggestions/:id/decision` | `{action:"accept"\|"override",values?,claimVersion?\|contextVersion?}`. An override supplies corrected fields. The exact current expense/receipt context is guarded. Draft/returned owners apply coding; assigned approvers record feedback on submitted expenses without rewriting the frozen revision, and use the existing return workflow to request a correction. |
| `GET /rates` | Finance's policy row receives counts by rule and source: accepted, overridden, pending and percentage accepted among decided suggestions. |

Coding fields are `{category?,dimensions?:{dimensionId:choiceId},project?,customer?,memo?}`.
The last three are free-text fields; catalog project and customer choices retain
their stable accounting identities. Active catalog choices and ancestors are
checked at suggestion and write time. Invalid merchant rules are flagged to
finance and do not silently give way to learned coding.

Precedence applies separately to each empty field: finance merchant rule,
personal merchant rule, personal history, department history, company history,
then a mapped MCC. Entered values are protected, including expense values that
exist before an original is attached. Suggestions and human corrections keep
their source and reason; previous predictions alone do not teach the learner.
Two agreeing personal corrections take precedence over older personal history.
Shared learning uses submitted coding choices without original text, memos or
other people's identities in the explanation. Private drafts and inbox coding
only teach their own employee. This conservative learning boundary awaits ct
ratification; the clause remains partial.

New statement-file charges use this service, and CSV statements may map an MCC
column. An uploaded original may supply a typed `merchant` multipart field;
otherwise its employee can enter the merchant in the private inbox. Manual and
scheduled original attachment only fills empty expense coding. An actual matched
charge can supply its own MCC to the original’s empty coding fields; receipt
metadata and fixture labels never invent one. These are native
statement-file and upload doors: no issuer-feed integration or CAPTURE-003
image-reading result is claimed. Those forms retain their own obligations.

## Expensify export set (MOVE-001)

`POST import/preview|commit` accepts `source: "expensify"` and either the
reviewed `configuration` with `mapping.crosswalk`, or report-template `csv`,
`filename`, `mapping: {date, statuses}` and optional `receipts: [{name, base64}]`.
Configuration adds `tags` and `cards` as documented in IMPORTING.md. Preview
returns counts, errors, unmapped warnings, a crosswalk and a fingerprint; commit
echoes them. Native-session owner authority is required, including for undo and
original-byte status reads. Exported Integration Server report CSVs use this
same file door; the native import API has no credential custody or outbound Integration Server call.
The separate explicitly consented host command is documented in IMPORTING.md.

## Policy review and compliant-spend envelopes (AGENT-005)

`POST settings/approval-envelope` accepts `{version, enabled, limit?, consent}`
from the actual native owner; enabling requires explicit consent and a positive
strict per-expense limit. Each save is append-only; disabling revokes future
authority. Agent keys, public credentials, admins and Full delegates are refused.
This conservative authority and evidence/coding boundary awaits ct ratification.

Submitted revisions expose `policyReview` and any `expenseApprovals` with source,
version, actor/on-behalf owner, reason, sample ordinal and percentage. Existing
configured workflow stages still apply. Only a fully covered report with no
explicit workflow completes automatically. Card expenses never reimburse.
`POST claims/:id/policy-review-feedback` accepts `{version, revision, item, agree}`
from a native assigned reviewer, once per reviewer/item/revision, excluding own
claims. `state.reviewerAgreement` is that reviewer’s agreed/total count and percent
over retained explicit feedback; no unanswered or automatic decision is counted.

`GET exceptions` adds `expenseSamples`. `POST audit-samples/finding` also accepts
`item` for an independently sampled expense, with the existing outcome/finding
fields. Finance records one append-only finding and cannot audit its own expense.

## Finance investigation packs (AGENT-006)

Native finance sessions use `GET investigations` for connected POLICY-002 evidence from submitted revisions, `GET investigations/:id/download` for a ZIP containing the record manifest and exact retained originals, and `POST investigations/:id/outcome` with `{outcome: "explained"|"needs-follow-up", note}` to record a human outcome. Private drafts and unmatched originals never enter a pack. These doors send no external request and do not change claims, holds or payments. Pack identity binds its evidence; recording twice refuses, and finance cannot record an outcome on its own expenses.

## Provider costs and receipt questions

Native owners read or version model rates with `GET or POST /api/coaster/settings/provider-costs` (`version`, `model`, `inputPerMillion`, `outputPerMillion`, `reservePerPage`, `monthlyCap`; empty cap is unlimited, zero pauses optional AI). Costs are USD estimates from reported tokens. The monthly check includes settled estimates and outstanding reservations for both reading and coding. Unknown outcomes retain their reservation; metered overruns are fully recorded and stop later requests. Manual claims and coding remain available. Pricing and usage without account details round-trip in the installation archive.

The employee or live delegate reads `GET receipt-inbox/:id/question` and confirms with `POST` carrying `{questionId, expectedSequence, expectedReadingSequence, version, values, consent:true}`. `values` must explicitly confirm total, currency and every conflicting field (tip, subtotal and sales tax can also be confirmed with a total conflict). One current question shows the reading, posted card values and original source regions. Confirmation atomically appends private reading history and records the confirmed comparison on an editable expense. It never changes the card statement amount, submits or pays. Questions stop when answered or no longer editable; FOLLOWUP-001 uses its business-day reminder schedule.

## Native preparation proposals

These doors require the recipient's own native session and refuse agent keys and
acting delegates. They prepare cited proposals in the existing workspace; only
that person accepts or declines through the existing proposal decision doors.

- `POST /api/coaster/preparations/close` with `{from,to}`: owner-only month-end checklist,
  within one calendar month, pending department amounts and cutoff, visible
  missing evidence, pending approval, native reconciliation and unverified ledger
  clearance on recorded payments. Acceptance records review only. Input changes
  invalidate the checklist. No ledger entry, batch or outbound chase is created.
- `POST /api/coaster/preparations/trip` with `{title,from,to,claims:[id]}`: the employee's own
  never-submitted manual drafts, at most 20 sources and 50 expenses. Acceptance
  moves the selected existing items and native receipt references atomically into
  one draft, preserving their ids and evidence and recalculating source totals.
  Automatic reports, card expenses, allowance and advance links and private inbox
  attachments stay in their current workflow. Stale sources refuse acceptance.
- `POST /api/coaster/preparations/expenses/:id`: the employee's editable claim, cited coding
  proposals from the existing CODE-002 engine, current receipt fingerprints and
  policy issues. Acceptance records review and returns that original draft; it
  applies no coding, links no new receipt and never submits. Existing coding
  overrides that still disagree with current advice stop this plan for human correction.

Payloads include `preparation`, source citations and freshness bindings. They are
stored as ordinary COA-010 proposals and follow their archive and erasure rules.
No provider connection or new outbound data flow is introduced.

## Gusto sandbox payroll

The owner's own native session can connect a Gusto Demo company under Settings,
explicitly map each Coaster employee, and authorize a reviewed, released USD
batch for the next unprocessed regular payroll. Each send requires a sign-in
from the last ten minutes and refuses the owner's own claims. Existing batch
review, dual release and reimbursement reservations still apply. Coaster adds
ordinary amounts to reimbursement lines and each person's actual taxable amount
to the Gusto Bonus earning. It preserves existing payroll amounts and does not
submit payroll. The owner completes payroll in Gusto.

- `GET /api/coaster/payroll/gusto` reads the connection and mappings as the owner.
- `POST /api/coaster/payroll/gusto/connect` requires `company`, a private `token`, and explicit `consent: true`.
- `POST /api/coaster/payroll/gusto/employees` maps a Coaster `email` to a Gusto `employee` UUID.
- `POST /api/coaster/payroll/gusto/disconnect` removes the token and mappings.
- `GET /api/coaster/batches/:id/payroll` reviews the employee splits and handoff. Finance and auditors can read it; only the owner reads available provider runs.
- `POST /api/coaster/batches/:id/payroll` requires the reviewed batch `version`, the next `payroll` UUID and explicit `consent: true`.
- `POST /api/coaster/batches/:id/payroll/confirm` reads the original provider run and receipt. It never retransmits amounts.

An accepted update leaves claims batched and unpaid. Only an exact matching
processed payroll and its reimbursement receipt mark them reimbursed. This
records provider run confirmation; it does not assert bank settlement. A lost
response leaves a reserved handoff that must be read back. Gusto omits employee
amounts on an uncalculated run; that response cannot establish a financial match.
An acknowledged update is sent, while a lost acknowledgement stays reserved
until readable amounts reconcile. Neither state marks a claim paid. A rejected or changed
provider run leaves claims unpaid, with no automatic resend or manual-payment
override. Disconnect stops further provider access. Restore preserves financial
handoffs and numbered history, excludes credentials and employee mappings, and
cannot resume a send. Reconnect the original company explicitly to read back a
pending handoff. Unrelated salary amounts are not retained: internal financial
fingerprints allow exact reconciliation.

This first native door is restricted to Gusto Demo. It supports the native batch limit of 200
claims, splitting provider updates into groups of at most 100 employees, and regular payrolls with separate reimbursement arrays;
contractors, cash advances that exceed the remaining non-taxable amount,
off-cycle payrolls, production connection and other providers remain outside
this implemented slice. The conservative owner-only consent and custody policy
awaits ct approval under PAY-003.

## Plaid sandbox connection foundation (FEED-001, partial)

All doors use native sessions and same-origin writes. Company connections honor
live Full delegation in ADMIN-005; personal card custody requires its employee.
Agents and public credentials have no authority. Each physical provider request
requires a sign-in within ten minutes and current native authority. The native owner sets
`POST /api/coaster/plaid/settings` with `version`, `clientId`, `secret`,
`accountMonthly` (USD per connected account month), `monthlyCap` (empty for
unlimited) and explicit `consent:true`. `GET /api/coaster/plaid/settings` returns
only configuration state, the immutable configured price version and month-to-date estimates without account details. No application secret is returned.

`POST /api/coaster/plaid/link` takes `scope:"company"` or `scope:"personal"`
and `consent:true`. Company connections require owner, admin or finance;
a personal card requires its employee's own session. The answer supplies a
sandbox Link token, an expiring request `id` and the configured per-account USD
estimate. Finish Plaid Link, then explicitly confirm its public token using
`POST /api/coaster/plaid/exchange` with `link`, `publicToken` and `consent:true`.
The native session must be the one that started Link. Each request is reserved
before provider exchange and cannot be replayed, even after a lost response.
An uncertain exchange needs human reconciliation with Plaid; it is never resent.

The adapter verifies accounts with Plaid, retaining account identifiers, type
and last four only. Application and access credentials are sealed for this
installation. Accounts with unsupported types are refused. A connection held
in `pending` state after validation or cap refusal can only be disconnected;
it has no transaction authority. Exchange atomically reserves at least one configured account month before any
provider exchange and checks the owner cap, including concurrent requests.
Verified account counts settle the full estimate. Unknown outcomes keep their
reservation; an overrun is fully recorded and pauses subsequent activation.
This caps native estimates and provides no guarantee about provider invoices. Disconnect never erases that cost. These are estimates, not Plaid
invoices, and recurring monthly metering is not yet implemented.

`GET /api/coaster/plaid/connections` lists company records to the connection
roles and personal records only to their employee. Explicit
`POST /api/coaster/plaid/connections/:id/disconnect` first confirms Plaid item
removal, then drops local custody. If the provider refuses, custody remains for
an explicit later action. Erasure deletes personal local connection and Link
custody atomically while retaining financial records and cost estimates without account details; it
makes no claim that the remote provider removed its item. All execution custody
is excluded from installation archives; numbered native history remains.

This foundation implements no transaction sync, expense creation, bank-detail
editing, reimbursement or notification. Transaction lifecycle handling, native
Link screens, account assignment, receipt matching, recurring metering, provider
erasure follow-up and full restored-history proof remain FEED-001 work. The
complete target remains binding. Production Plaid hosts are not accepted.

The bounded native assertions in `tests/plaid-native.mjs` are registered by
`tests/coaster-plaid.test.mjs` in the mandatory push Verify HTTP flow suite.
Run the touched tests with `node --test tests/coaster-plaid.test.mjs`.
The held-key `tests/plaid-sandbox.mjs` journey records its source SHA and verifies
company and personal card connection, admin authority, four refused roles,
costs, the owner cap, continued manual claims and confirmed item removal.
It does not implement or prove transaction sync. FEED-001 remains partial.
The existing provider archive journey carries the mandatory CLI restore proof.

## Employee bank details

Each person adds, verifies and changes their own bank account in their own native
session; a delegate, agent key or public credential is refused. Coaster keeps the
provider's token (sealed in the installation) and the last four digits. The person
enters routing and account numbers with the provider's own browser flow (Plaid Link
for instant verification, Stripe.js for micro-deposits), so Coaster never receives
them. Each account change or provider connection change needs a sign-in from the last ten minutes.

- `GET /api/coaster/bank` reads your own account, any pending account, the connected providers and the cooling-off days.
- `POST /api/coaster/bank/start` takes `provider` (`plaid` or `stripe`) and returns a Plaid `linkToken`, or a Stripe `setupIntent`, `clientSecret` and `publishableKey`.
- `POST /api/coaster/bank/complete` takes the Plaid `publicToken` (and `accountId` when the item holds more than one checking or savings account) or the Stripe `setupIntent`. Instant verification activates the account; micro-deposits leave it pending.
- `POST /api/coaster/bank/verify` takes the pending account `id` and the two deposit `amounts` in cents, or a `descriptorCode`.
- `POST /api/coaster/bank/refresh` and `POST /api/coaster/bank/cancel` take the pending account `id`.
- `GET /api/coaster/bank/people` reads every person's status, last four and hold; the owner and finance only.
- `POST /api/coaster/bank/hold-period` takes whole `days` (1 to 30); the owner and finance only.
- `GET /api/coaster/bank/providers`, `POST /api/coaster/bank/providers/connect` (`provider`, credentials, `consent: true`) and `POST /api/coaster/bank/providers/disconnect` belong to the owner's own session. Only the Plaid sandbox and Stripe test mode are accepted.

Replacing the active account is a change: the old token is discarded, the address on
record is told the last four of both accounts and when the hold ends, and no batch
holding that person's claim can be created, released, recorded as paid or sent to
payroll until the hourly run ends the hold after the cooling-off period. Each step
appends a numbered history line that names the account by an opaque id. Erasure
deletes the person's bank rows. Archives carry the sealed token and last four, never
provider credentials; revoking a provider-side item or payment method is done in the
provider's own console.

Restored bank evidence can be replaced after the owner explicitly reconnects the
verification provider and the employee freshly verifies a replacement. The old
installation secret is not needed to discard historical ciphertext. A committed
replacement sends its safety notice independently of the initiating session;
the original active member and contact must still match. The hourly run releases
expired bank holds before selecting that day’s reimbursement batch.

## Native conversational foundation (AGENT-007, partial)

`POST /api/coaster/conversation` accepts `{message, year?, receipts?, purpose?, manualRate?}` only in the person's own native session. Agent keys and delegates cannot prepare conversational work. It sends no data to a model or chat provider. Unknown requests return a clarification; this route has no submission, approval or payment action.

- `What did Sales spend on Travel in Q3 compared with Q2 2026?` selects exact department and category names. Managers need the complete department in their existing reporting scope; finance retains its native scope. Each quarter returns integer minor-unit totals, expense links and a REPORT-001 link carrying the same department filter. `GET spend` accepts optional `department` within its ordinary read scope. A missing year is clarified.
- `How much of the Travel budget is left this month?` uses the business's local month and REPORT-004's existing budget permissions. `in 2026-06` selects a historical month. Each matching monthly budget returns budget, actual and remaining, or the existing per-member breakdown. No similarly named budget is revealed outside the reader's custody.
- `Denver client trip, Oct 6–8` requires an explicit `year` (or year in the message) and one to twenty receipts. Each receipt is `{date, merchant, amount, category, receipt:{name,base64}}`, with reviewed details within the trip dates. Amounts are entered facts, not a claim of automatic photo reading. The route proposes these originals and the destination's published GSA meal allowance; ordinary explicit FX rules apply through `manualRate` when needed. Furnished meals and purpose need employee review. An omitted purpose returns a question and records the question in the proposal note. Nothing becomes a claim until the existing proposal acceptance door creates a draft; submission is a separate native action.

CT approved the native policy WITH RIDERS on 27 October 2026; AGENT-007 remains partial. Native conversation proposals carry server-owned custody metadata. Shared agent reads refuse their payloads and both shared decision routes require the person's own session. Older proposals bearing the native assistant label retain that restriction; ordinary agent proposals retain their existing authority. Slack verification, account linking, receipt download, replies, Teams, text messages and a conversational input screen remain unbuilt. No chat credentials or sending authority are restored by this foundation.

## Posted card evidence reminders

The hourly scheduled handler chases each native posted card expense missing a receipt,
an expense memo (description), an allocated category field or an active finance-policy
required field. Receipts are chased at every amount, including below the ordinary
receipt threshold. Existing finance reminder steps count US business days from the
statement posting date; business quiet hours and holidays still apply. Late discovery
catches up each due step with a distinct durable mail-adapter identity. Replayed ticks
create no duplicate delivery or reminder history. The native expense edit and receipt
attachment doors resolve evidence; resolved expenses receive no later chase step.
Both reminder branches retain the shared escalation service: after the last reminder
plus the configured gap, the evidence task escalates to its manager, then finance.
Card evidence uses posting age for these steps; the independent unsubmitted-claim
task continues to use discovery age. Each task records its own once-only history.
Mail adapter acceptance does not establish mailbox delivery. This native slice makes
no issuer request and establishes neither card freeze nor issuer unfreeze (CARD-001).

## Employee-confirmed coding

An expense review prepared through `POST /api/coaster/preparations/expenses/:id`
keeps review-only acceptance through `POST /api/coaster/proposals/:id/accept`.
For a never-submitted draft, `payload.codingApplication` also gives a fingerprint
and the exact category and dimension changes, with their current and proposed
labels, protected human fields and coding evidence.

The same employee can explicitly confirm those changes through
`POST /api/coaster/proposals/:id/apply-coding` with
`{"confirm":true,"fingerprint":"<the reviewed fingerprint>"}`. The handler
rechecks current native-session authority, the claim, per-expense coding context,
rules and catalog inside both transaction guards. It refuses changed, disputed,
foreign, delegated, agent-key, submitted, returned and repeated applications
without writes. Human choices and category splits remain protected. Receipt
originals, source charge facts, amounts and reimbursement identity stay intact.
Confirmation records numbered agent-attributed history; it does not submit,
approve, chase, release payment or post to a ledger.
