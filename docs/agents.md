Your own agent can prepare work for you: an employee's agent drafts claims from receipts, and a finance person's agent proposes batches of approved claims. Nothing moves until you accept it.

## Make a key

In **Settings**, under **Agent keys**, enter an **Agent name** such as "Receipt inbox agent" and choose **Make agent key**. Coaster shows the key once: copy it into your agent's configuration. **Revoke** stops a key at once.

A key acts only for you and only while you can sign in. It cannot submit, approve, batch, pay, change settings or read anyone else's claims.

Coaster does not yet expose these jobs through MCP or accept a signed company
agent policy. Use the personal-key routes below for the supported preparation
work; native sign-in is required to accept proposals and make financial decisions.

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
