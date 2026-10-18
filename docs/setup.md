Before the first claim, the owner names the business, adds the expense categories and adds the people. Everything here lives in **Settings**, and only the owner can change it.

## The business

In **Settings**, under **Business**:

| Field | What it does |
|---|---|
| Business name | The name people see. |
| Currency | One currency for every claim; `USD` unless you choose another. It is fixed once claims exist. |
| Time zone | One of the US zones, for example Central (`America/Chicago`). |
| Per diem per day | Leave it empty if you do not pay per diems. |
| Receipts required above | A purchase above this amount needs a receipt: $75 to start, the IRS documentary-evidence line. Leave it empty to require a receipt for every purchase. |
| Sales tax account and code | A receipt's sales tax, entered as part of its amount, posts on its own accounting line to this account and tax code. |

Choose **Save business**.

## Mileage rates

Mileage is priced at miles times the rate in force on the trip's date, to a tenth of a cent, and that rate is copied onto the expense. A new US business starts with the IRS standard business rates for each year (72.5¢ a mile from 1 January 2026). Under **Mileage rates**, add next year's rate with the day it takes effect when the IRS announces it, or change or remove one; expenses already entered keep their rate. A business in another currency adds its own rates.

## Expense categories

Add the categories your accountant expects. Each has a **Category name**, an **Account code**, a **Tax code** (for example `TAX` or `NON`) and an optional **Limit per expense**. The account and tax codes travel with every accounting line, so the bookkeeper can import the file without retyping.

A limit is checked against the whole amount of an expense in that category, however it is split. An expense over its limit needs the employee's explanation before they can submit it.

Tick **Always needs a receipt** for a category whose purchases need one at any amount. A category named for lodging (Lodging, Hotel) always does, as the IRS requires.

To stop using a category, choose **Change** and untick **In use**. Past claims keep it.

## People

Add each person with their **Name**, **Email** and **Roles**:

- **Employee** makes claims.
- **Manager** approves the claims of the people who report to them.
- **Finance** makes reimbursement batches, exports them and records payments.

Every employee needs an **Approving manager**. Then choose **Invite**: Coaster emails them a sign-in link. A person you untick **Active** for loses access at once, and so does any agent key they made.

## Then

People sign in and start claims. [Claims and receipts](/docs/claims) is the page to share with your team.
