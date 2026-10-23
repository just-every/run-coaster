A claim groups expenses for review. Out-of-pocket expenses are reimbursable; company-card expenses were paid by the company and never add to reimbursement.

## Keep receipts before entering expenses

Open **Receipt inbox** on Claims. Drop dozens of files, choose **Upload receipts**, or use **Photograph a receipt** on a phone. JPEG, PNG, WebP, HEIC and multi-page PDF originals up to 10 MB each stay in your inbox with their hash, size, uploader and source. A refused file leaves successful uploads intact; choose a smaller file to retry.

Reading is unavailable, so each saved original says **Needs attention** and asks you to enter its expense details manually. To attach an inbox original, first add a purchase expense to your draft or returned claim. Expand its attach controls, choose the claim and expense, then attach. Approvers and finance can see it once submitted. You can detach while the expense is editable; earlier submitted evidence stays. Inbox originals keep their 10 MB limit and are stored once. You can also attach an original to a company-card expense by hand. Direct file attachments below retain their 1.5 MB limit.

Finance can review **Cash receipt draft window** in Settings, then confirm its older-receipt count. It is off by default; choose 1–90 elapsed days. Each hourly run prepares up to 25 private draft claims, once per original, with the UTC upload date and **needs details**. No amount is inferred or receipt attached. The inbox links to the draft; enter its details yourself. Turning the window off keeps drafts already prepared.

## Match a private original to a card charge

Expand **Card matching** on one original. Enter its merchant, purchase date, positive total and ISO currency (the business currency is the default). Last four is optional; when entered, it must match. Read the sharing notice, check the acknowledgment and choose **Match to my card charge**. Nothing is preselected, and entering details does not read the receipt. You or a live Submit-only/Full delegate can change the details or withdraw while it is unattached.

Hourly matching considers up to 100 oldest-waiting originals. It attaches only a mutually unique same-employee posted charge on a draft or returned report. The transaction date, or posted date when none is supplied, must be from one day before to seven days after the receipt date by default. Exact same-currency amounts need no merchant corroboration; upward tips up to 20% (rounded down to cents) and ECB reference conversions within 5% need merchant agreement. The owner or finance can version these bounds through `settings/card-matching` in the [API.md](https://github.com/just-every/run-coaster/blob/main/API.md). Merchant agreement lowercases Unicode letters and digits, replaces other characters with spaces, then requires a shared typed token of four or more characters or containment of the compact typed merchant (four or more characters) in the compact statement merchant. Merchant and date proximity never resolve a tie.

A private question lists ambiguous charges; **This one** attaches by you, while **None of these** permanently rejects the listed pairs. A detach permanently excludes that pair and stops automation for the original until you choose matching again. Opted-in originals never become cash drafts; an already reserved cash original can only be attached by hand. Discarded, merged, attached, withdrawn and inactive-member originals stay out of matching. Matching never changes statement facts, submits, approves or notifies. A foreign-currency match shows the entered amount, reference conversion, posted card amount, rate, rate date and source on the expense, its submitted revision and claim PDF. The posted card amount remains authoritative; an ECB reference rate is not the card’s rate. A matched original is stored once; its ordinary provenance and frozen rule/basis become visible with the submitted expense, while typed merchant, choices, questions and private history stay private.

## Company-card expenses from a statement file

When finance imports your card's statement file (an OFX, QFX or CSV download; Coaster calls this a statement file import, not a feed), each purchase appears as a **company-card expense** on your draft report for that month. The company paid it, so it never adds to what you are reimbursed. Its merchant, amount and date come from the statement and cannot be changed or removed; you can change its category and cost center, add a description, attendees or a receipt, and explain it. Submit the report as usual. If you also claim the same purchase out of pocket, submission is refused: correct or remove the duplicate first. Scheduled submission and hold release enforce the same rule. If the card charge arrives after a reimbursement was approved, finance still cannot put it in a reimbursement batch.

## Start a claim

Open **Claims**, choose **New claim**, give it a title such as "Denver client trip" and choose **Start claim**.

## Add expenses

Choose **Add expense** and pick the **Type**:

- **Purchase with receipt**: the date, merchant and amount, and a **Receipt photo or PDF** (JPEG, PNG, WebP, HEIC or PDF, up to 1.5 MB).
- **Mileage**: the route and the distance in miles. Coaster prices it at the business's rate per mile.
- **Per diem**: choose GSA, State Department or IRS high-low, select the published city/county and travel dates, then choose meals, lodging or both. Mark provided meals and choose **Calculate per diem** to inspect daily rates before saving. First and last travel days receive 75% M&IE; provided meals deduct their full published amounts, keeping incidentals. Lodging covers nights before return. Rates are USD, so another business currency needs the enabled ECB conversion or an entered exchange rate. The optional **Company flat daily rate** uses the owner's rate times claimed days. Daily rates and sources stay on the expense, submitted revision, PDF and accounting export. Missing published dates are refused; an allowance does not certify tax treatment.

Choose a **Category**, and a **Cost center** if you use them. One receipt can be split: choose **Split across categories** and give each part its category, cost center and amount. The parts must add up exactly to the expense.

## Explain exceptions

Coaster flags anything outside the policy before you submit:

- a purchase with no receipt above the business's threshold,
- an expense over its category's limit,
- the same receipt as another expense,
- the same date, merchant and amount as another claim or an imported Expensify report.

Write an **Explanation for your approver** on each flagged expense, for example "Dinner with two guests from Pikes Trail Supply, agreed with Dana". The explanation stays with the claim, the batch and the accounting file.

A claim cannot hold the same expense twice. If two expenses have the same date, merchant and amount and no receipt, or the same receipt, attach each one's own receipt, or correct or remove one, before you submit.

## Submit

Choose **Submit for approval**. The claim goes to your approving manager as revision 1 and you can no longer change it.

## When a claim comes back

If your manager returns it, the claim shows **Returned** and their reason. Change or remove the expenses, attach the right receipt, and choose **Resubmit for approval**. It goes back as the next revision. The earlier revision, its receipts and the decision stay under **Earlier revisions and receipts** and in the history.

Next: [Approving claims](/docs/approvals).

If a read receipt and its attached card charge disagree, open the private receipt reading to answer one question. Check the source crop and both values, then explicitly confirm the receipt total, currency and any conflicting fields. You can leave it unanswered without changing the expense. The posted card amount stays unchanged; the confirmed comparison appears with the expense after submission, while the original reading and its source regions remain in your private history. A live delegate can answer for you. Unanswered questions follow the normal reminder schedule.

The owner can review optional AI costs in Settings before enabling receipt reading. USD estimates use the provider-reported tokens and the exact model rates the owner enters. The monthly cap includes reading and coding, settled usage and outstanding reservations. If reading pauses, enter expense details manually. Provider invoices remain authoritative; uncertain requests retain their reservation and a final charge above its reservation can pause later requests.
