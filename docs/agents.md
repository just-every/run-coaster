Your own agent can prepare work for you: an employee's agent drafts claims from receipts, and a finance person's agent proposes batches of approved claims. Nothing moves until you accept it.

## Make a key

In **Settings**, under **Agent keys**, enter an **Agent name** such as "Receipt inbox agent" and choose **Make agent key**. Coaster shows the key once: copy it into your agent's configuration. **Revoke** stops a key at once.

A key acts only for you and only while you can sign in. It cannot submit, approve, batch, pay, change settings or read anyone else's claims.

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
