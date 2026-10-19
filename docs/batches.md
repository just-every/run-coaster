Finance gathers approved claims into one batch, checks that it adds up, downloads the files for the bookkeeper and the bank, pays from the bank, and records the payment.

## Make a batch

1. Open **Batches**. Approved claims wait under **Approved and ready**.
2. Tick the claims to pay together and choose **Create batch**. The button shows the total.
3. Check the reconciled line: the accounting lines and the reimbursements each add up to the batch total.

A draft batch can still change: **Take out** removes a claim and returns it to the approved list.

## Review it

Someone other than the claimant reviews the batch: tick **I checked the reimbursements, accounting lines and exceptions add up to** the total and choose **Approve batch**. If the batch changed after you checked its total, Coaster asks you to review it again. Someone in finance whose own claim is in the batch cannot review it.

An exact expense is reimbursed once. If the same receipt, or the same expense with no receipt, is in another batch already, Coaster refuses to batch it again and says which claim and batch hold it.

## Download and pay

| File | One line per |
|---|---|
| Accounting CSV | category split, with account and tax codes, cost center, receipt fingerprint, exceptions, explanation and approver |
| Reimbursements CSV | person, with their total |

Both add up to the batch total. Give the accounting file to your bookkeeper and pay the reimbursements file from your bank.

## Release the batch

A reviewed batch is released before anyone pays it. The owner, or a finance member the owner gave **May release payments** under Settings → People, chooses **Release payment**. Releasing needs a sign-in within the last 10 minutes (sign in again if it has been longer), and nobody releases a batch holding their own claim. When the owner sets **Dual release above** under Settings → Payment controls, a batch over that amount needs a second release by a different person. With a **Reimbursement day** set, Coaster opens a draft batch of every approved claim at 9:00 on that day for finance to review; it never releases one.

## Record the payment

Coaster does not move money. After releasing and paying, enter the **Payment reference** and **Paid on** date and choose **Record payment**. The batch shows **Paid** with its reference and date, and every claim in it shows **Reimbursed**.

## Accountable plan

Under **Accountable plan** on Batches, finance sees every expense filed more than 60 days after the spend. Choose **Mark non-accountable** with a reason to treat one as taxable pay: it is still reimbursed, and the reimbursements file shows it in the person's **taxable_amount** (with stipends set as taxable pay) while the accounting file marks its line **taxable**. The mark can change until the batch is reviewed. People the owner marks as **Contractor** under Settings → People are flagged **form_1099_review** in both files. Coaster supplies these flags; taxability and 1099 decisions stay with your accountant.
