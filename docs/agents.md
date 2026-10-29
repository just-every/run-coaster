Your own agent can prepare work for you: an employee's agent drafts claims from receipts, and a finance person's agent proposes batches of approved claims. Nothing moves until you accept it.

## Make a key

In **Settings**, under **Agent keys**, enter an **Agent name** such as "Receipt inbox agent" and choose **Make agent key**. Coaster shows the key once: copy it into your agent's configuration. **Revoke** stops a key at once.

A key acts only for you and only while you can sign in. It cannot submit, approve, batch, pay, change settings or read anyone else's claims.

## Company agents through MCP

Coaster serves one shared agent door at `/mcp`, discovery and canonical metadata,
`/api/rer/agent-policy`, and native person policy, approval, review and audit pages
at `/agents`. The specialist is **Expense controller**. The declared capability
families are tools, policy, pause, audit and idempotency. Resources, prompts,
events and subscriptions are undeclared and return typed refusals.

| Tool | Scope | Classes | Clauses |
| --- | --- | --- | --- |
| `coaster.workspace.get` | `proposals:read` | standard | COA-010, BASE-AGENT-002, BASE-AGENT-006 |
| `coaster.proposals.get` | `proposals:read` | standard, sensitive | COA-010, BASE-AGENT-002, BASE-AGENT-006 |
| `coaster.claims.propose` | `proposals:write` | standard, sensitive; external for automatic FX | COA-010, CLAIM-003, BASE-AGENT-002, BASE-AGENT-006 |
| `coaster.batches.propose` | `proposals:write` | standard | COA-010, BASE-AGENT-002, BASE-AGENT-006 |

These tools call the same native preparation services as the existing personal
agent API. Company policy can require review or named approval before preparation;
it does not replace the separate native human acceptance, submission, approval,
batch review and payment controls. Proposal payloads are private, untrusted
expense content and are conservatively classified sensitive. The context returns
only the existing personal-agent projection. Hidden and missing proposals have
the same refusal. No resource links, receipt-byte reader or financial-decision
tool is advertised. Screen, device, connector, import and installation doors
retain their separate purposes. The existing narrow personal-key REST API below
retains its native preparation contract; it is not a Business policy transport.

Business tokens bind their subject to the existing native operator id through
signed Business settings, never an email match. The current email must still
match, and inactive operators and excluded Coaster members are refused. Business
owner maps to owner, Business team admin to editor and member to no policy role;
a native promotion grants no Business edit role. Business team binding links
existing accounts only and creates no Coaster role or shadow account. Each tool
re-reads the active Coaster member and transactionally fences native roles, the
door policy snapshot, sponsor and agent. Personal keys remain narrow when used
at MCP, and revoking a key removes its scopes immediately.

The runtime is copied from Base `2135c394939f4a737adabdc8003b0e667b31ac5a`
and the pinned CLI is released `@runeditrun/rer@0.2.91`. The normal `rer verify`
runs `agent-surface.json` against the production Worker and all real migrations.
Its initializer drives the declared setup-token `/auth/bootstrap`, ordinary
native invitations, claim submission and a different person's approval. The
negative fixtures suspend a real operator and remove a bound member's native
admission. Native initialization uses the built-in mail network edge. Automatic foreign-currency
receipt proposals fetch the public ECB history URL without expense or person data;
that path is classified external from native currency facts and uses the declared
`tests/agent-door/network.mjs` edge. Explicit manual rates use no provider. Spend is `none`; no provider cost is registered. There is
no queued continuation in these preparation tools and no native Undo for a
retained proposal. Reviews never erase proposal history.

The draft ct surface at `bb0a3a35d2da9d4f9d4f274e0d8022a58c13f41d`
is a larger target, not a grant of current agent authority. Coaster's COA-010
boundary still requires people to decide. Its many screen-native financial,
access, security, provider and administrative jobs have not been added to MCP.
No SURFACE ids are introduced from that unlanded draft. BASE-AGENT-001 through
BASE-AGENT-013 retain partial judgments and their specific gaps in CONTRACT.md.

## What your agent can do

Your agent sends the key as `Authorization: Bearer` to these routes on your Coaster's address:

| Route | Does |
|---|---|
| `GET /api/coaster/agent/context` | Who it works for, the business policy and categories, and its proposals. |
| `POST /api/coaster/agent/claims` | Prepares a draft claim with its expenses and receipts. |
| `POST /api/coaster/agent/batches` | Proposes a batch of approved claims (finance only). |
| `GET /api/coaster/agent/proposals/:id` | Reads one of its proposals and whether you accepted it. |

Amounts are decimal text such as `"64.50"`. A proposed claim takes the same expense fields as the screen: the type, date, merchant, amount or distance or days, category split, explanation, and a receipt as a file name and its bytes in base64.

## Accept or decline

Prepared work appears at the top of **Claims** (or **Batches**) under **Prepared for you**. **Accept as draft** turns it into your own draft claim or draft batch, which you check, change and submit as usual. **Decline** removes it. The claim or batch records that the agent prepared it and that you accepted it.

## Native preparation in Coaster

Under **Claims**, open **Prepare a trip or expense review**. A trip proposal groups
expenses dated within the selected range from your selected never-submitted manual
drafts. Review the expense, receipt fingerprint, coding and source claim citations,
then choose **Accept as draft**. Acceptance moves the same expense records into one
new draft; it does not copy an expense into a second payable claim. Source drafts
remain, with their other expenses and recalculated totals. Existing mileage and
published per diem evidence stay attached. Automatic reports, card expenses,
allowances, advance-linked claims and private inbox attachments keep their current
workflow. New travel bookings, calendar context, GSA days and airport routes are
not inferred.

**Prepare expense review** creates a cited checklist for one of your editable
claims, including current coding, finance-rule and learned coding proposals,
receipt links and policy issues. Existing coding overrides that still disagree with current advice stop acceptance
for human resolution. **Accept review plan** records review and opens the original
claim. Change coding and evidence, and submit separately through the ordinary
claim screen; accepting this plan changes no expense.

The owner opens **Prepare month-end checklist** under **Batches**. Choose dates
within one month. The proposal shows pending expense amounts by department,
unsubmitted amounts, missing evidence on claims the owner may read, submitted
claims awaiting approval, native statement reconciliation status, recorded
payments whose ledger clearance is unverified, and the period cutoff. Private
draft titles and other employees’ inbox originals stay private; only the owner's
own unattached-original count is included. **Accept checklist** records owner
review. It creates no batch, posts no accrual and sends no chase. A changed input
requires a fresh proposal.

These preparations require the person's own native session. Agent keys and
delegates cannot create or decide them; a key cannot read their payloads.
QuickBooks posting and clearance, travel-tool and calendar context, connected
chat collection, provider settlement and ledger synchronization remain open.
