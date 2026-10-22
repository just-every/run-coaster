# QuickBooks accounting dimensions

This connection reads the connected company's accounting choices. It does not
post expenses, bills, payments or receipts. ACCT-001's posting and payment-status
work remains separate. CODE-001 still needs a receipt from its required real
QuickBooks sandbox journey; the network-edge integration test is not that receipt.

Configure the private `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET` bindings through
installation setup. `QBO_ENVIRONMENT` is `sandbox` by default; `production` must
be selected explicitly with the matching Intuit application credentials. Never
put credentials, authorization codes or tokens in a command argument or archive.

Register the exact callback shown by `GET /api/coaster/accounting/qbo` in the
Intuit application's redirect list. It is the installation's current origin plus
`/api/coaster/accounting/qbo/callback`; local and hosted origins need their own
registration. An owner, admin or finance person explicitly consents in their own
native session, follows Intuit's authorization page and chooses the company.
The callback needs that same session. An expired, reused or another session's
state is refused before exchanging its code.

Intuit provides the `com.intuit.quickbooks.accounting` scope, which grants broader
accounting access than this adapter uses. Coaster sends token exchanges and
metadata queries only. The client secret stays in private bindings. Access and
refresh tokens are AES-GCM sealed using a separate HKDF key derived from
`SESSION_SECRET`, bound to the installation origin and the company/environment.
Status, audit history and domain archives contain no credentials. Changing the
origin or session secret requires reconnecting.

Finance or the owner chooses the refresh hour in the business time zone. The
hourly scheduler performs one successful complete refresh per business day at
or after that hour; an unsuccessful run records an error and can run again next
hour. The owner, finance and bookkeeper may also refresh manually. A per-company
lease prevents overlapping token rotation and catalog commits. The newest
refresh token is saved before metadata requests, including when a later request
fails. Every page checks that consent and request authority still hold.

Queries fetch `Account`, `Class`, `Department`, `Customer` and `Vendor`, including
inactive rows and all pages. QBO's Department resource supplies its location
dimension and its department choices. Customer records marked `IsProject` or
`Job` also supply projects under their parent customer. Complete successful
snapshots atomically replace the offered choices; inactive or absent choices
are retired. A failed or redirected response preserves the previous catalog.
Native project ownership survives refresh. Old submitted coding remains frozen.

Disconnect requires an owner, admin or finance person's explicit confirmation.
It removes this installation's encrypted tokens and pending OAuth states,
retires its ledger choices, and prevents later pages or scheduled runs from
sending requests. An HTTP request already in flight may finish, but cannot
commit its catalog. Disconnecting locally does not revoke the application's
authorization inside Intuit; that authorization can also be removed in Intuit.

Public routes:

| Method | Route suffix after `/api/coaster/accounting/qbo` | Input/result |
| --- | --- | --- |
| GET | empty | Public connection status, callback and refresh status |
| POST | `/connect` | `{consent:true}` returns `authorizationUrl` |
| GET | `/callback` | Intuit's `state`, `code`, `realmId`; redirects to Settings |
| POST | `/schedule` | `{version,hour}`; owner or finance |
| POST | `/refresh` | Refresh the complete catalog |
| POST | `/disconnect` | `{version,consent:true}` |

Protocol references: Intuit's [OAuth setup](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0),
[query guide](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries)
and [inactive-list query examples](https://help.developer.intuit.com/s/article/SQL-Queries),
[Customer resource](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/customer),
and [Department references](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/billpayment).

Evidence: `tests/coaster-qbo.test.mjs` drives the real HTTP API, native sessions,
D1 catalog and scheduled Worker. Intuit alone is replaced at the network edge
by `tests/fixtures/qbo.mjs`, using synthetic data. It proves consent binding and
reuse refusal, current role permissions, token rotation, daily discovery and
retirement, project-owner preservation, complete-snapshot failure behavior,
credential redaction and disconnect stopping further scheduled requests.
