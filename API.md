# Coaster API

All routes are under `/api/coaster/` on the installation's own origin and
answer JSON (`{"error": "…"}` with a 4xx status when refused). Money is integer
minor units in responses; requests take amounts as decimal text such as
`"64.50"`.

## People (native session)

A person's requests carry their native session cookie. Writes must come from
the same origin. Every handler checks the session and the person's current
Coaster role itself.

| Route | Who | Does |
|---|---|---|
| `GET state` | anyone in Coaster | Their workspace: business, categories, the claims they may see, their proposals and agent keys; batches for finance and auditors. An auditor sees every submitted claim and changes nothing. |
| `POST claims` `{title}` | employee | Start a draft claim. |
| `GET claims/:id` | who may see it | Items, receipts, exceptions, every revision, decision and history line. |
| `POST claims/:id/items` `{version, item?, kind, date, merchant, amount \| distance \| days, description, explanation, receipt?, allocations: [{category, costCentre, amount?}]}` | its employee | Add or replace an expense (draft or returned). |
| `POST claims/:id/items/remove` `{version, item}` | its employee | Remove an expense. |
| `POST claims/:id/receipts` `{version, name, base64, item?}` | its employee | Upload receipt bytes (JPEG, PNG, WebP, HEIC or PDF, at most 1.5 MB). |
| `POST claims/:id/submit` `{version}` | its employee | Submit the next revision to the approving manager. |
| `POST claims/:id/decision` `{revision, version, decision: approved\|returned\|rejected, reason, acknowledge}` | the assigned manager | Decide the exact revision. |
| `GET receipts/:id` | who may see its claim | The receipt bytes. |
| `POST batches` `{claims: [id]}` | finance | Draft batch of approved claims. |
| `GET batches/:id` | finance, auditor | Claims, people, accounting lines, history. |
| `POST batches/:id/remove` `{version, claim}` | finance | Take a claim out of a draft batch. |
| `POST batches/:id/approve` `{version, expectedTotal}` | finance (not for their own claims) | Review and lock the batch. |
| `GET batches/:id/accounting.csv`, `GET batches/:id/reimbursements.csv` | finance, auditor | The export files. |
| `POST batches/:id/paid` `{version, reference, paidOn}` | finance | Record the payment made outside Coaster. |
| `POST settings/business`, `settings/categories`, `settings/members`, `settings/members/invite` | owner | Policy, categories, people and invitations. |
| `POST agent-keys` `{label}` → `{token}`; `POST agent-keys/:id/revoke` | the person | Make (shown once) or revoke their agent's key. |
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
