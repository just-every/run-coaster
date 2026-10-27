# ADMIN-002 adopted authority assertions

CT wave 19, 27 October 2026, adopted scoped Full delegation. ADMIN-002 remains PARTIAL. Controlled Gusto network-edge fixtures establish native behavior, not live provider completion.

All assertion references below are in `tests/coaster-hris.test.mjs`. The authority test is “HRIS connection matrix refuses unsafe identities, stale review and withdrawn authority with no native or provider writes”; its `fullDelegationAuthority` helper is invoked by that registration. The roster test is “HRIS reviews hires and manager changes, preserves roles and hands off termination before immediate access loss”. The two existing registrations are retained; temporary preparation-only and custody refusals were replaced with adopted delegated execution assertions.

| Adopted sentence | Public-door assertion |
| --- | --- |
| Owner, admin and finance may connect, review and disconnect; their live Full delegates inherit current connection authority. | Authority test, lines 108–137 and 202–244: explicit consent, native connections, all three grantor roles, delegated connection, review and disconnection. |
| Finance connection and review authority cannot authorize roster writes, even when the delegate personally has stronger authority. | Authority test, lines 126–131 and 219–224: 403 before provider requests, unchanged native people, mappings, connection and history. |
| Owner or admin People authority permits native and delegated hire, manager and termination execution. | Roster test, lines 11–67; authority test, lines 225–241: explicit employee-only hire, persisted manager and inactive status, actor and grantor attribution. |
| The acting person uses their own native session; agents and Submit-only grants have no roster authority. | Authority test, lines 161–164 and 274–279: every existing roster verb refused with 403 and no provider or native write for agent credentials; Submit-only requests refused. |
| Execution requires explicit identity confirmation and a review bound to the exact current authority. | Authority test, lines 153 and 227: unconfirmed identity refused and personal review cannot be reused for delegated execution. Original roster test also changes provider data after preview and asserts stale-review refusal. |
| Withdrawal, grantor authority loss and either person's deactivation end delegated authority immediately. | Authority test, lines 165–171 and 250–271: no provider request after withdrawal, loss of People authority retains review only, successful apply immediately before in-flight withdrawal, then 409 before application, and immediate refusal after either deactivation. A deactivated native sign-in returns 401; a departed grantor with a live delegate session returns 403. |
| History records the actual actor and on-behalf grantor. | Authority test, lines 155–158 and 240–241: explicit actual actor, `actingFor`, channel and time. |

`tests/browser-hris.mjs` exercises native connection, hire, manager change, termination, delegated review and application, delegated disconnection and reconnection, and finance-delegate review without write controls. The 1440 and 390 passes check viewport fit and the account control's focus and delayed-hover tooltip. Provider tokens remain password inputs and are never returned by status or review.

The mutation probe substitutes one source change at a time, runs the named public-door test, and restores all source bytes in a `finally` block. A killed mutation must fail an assertion rather than a build or syntax check. Results are retained under the run's reports directory; the mutation table records the exact changes rather than a status-only receipt.

| Mutation | Named assertion that must fail | Result |
| --- | --- | --- |
| Replace People permission with connection permission in roster execution. | Authority test: finance delegate receives 403 with no write. | KILLED |
| Refuse Full delegates at connection. | Authority test: delegated connection receives 200. | KILLED |
| Refuse Full delegates at disconnection. | Authority test: delegated disconnection receives 200. | KILLED |
| Refuse Full delegates at roster execution. | Authority test: People-authorized delegated application receives 200. | KILLED |
| Remove actor and grant identity from review fingerprint. | Authority test: personal review reused by delegate receives 409. | KILLED |
| Attribute on-behalf history to delegate rather than grantor. | Authority test: `actingFor` equals current grantor. | KILLED |
| Remove credential refusal before native HRIS authentication. | Authority test: an agent credential receives 403 on every roster verb. | KILLED |
| Remove explicit identity confirmation. | Authority test: unconfirmed application receives 400. | KILLED |
| Ignore grant withdrawal in transaction authority. | Authority test: otherwise valid application receives 409 after withdrawal during the provider request. | KILLED |
| Give a new hire finance authority from roster import. | Roster test: exact employee-only native role set. | KILLED |
| Clear existing native manager authority during roster import. | Roster test: retained native manager and finance roles after termination. | KILLED |

Remaining obligations include the complete connected Gusto sandbox journey, issuer-confirmed freeze and its pending, failed and uncertain states and retries, department and location synchronization, scheduled synchronization, the other named providers, real Willow handoff, and every unestablished policy sentence retained in CONTRACT.md's Gap. This table does not establish complete mutation coverage of all original acceptance obligations or claim DONE.
