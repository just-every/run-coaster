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
