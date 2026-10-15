Coaster's move-in kit brings your past Expensify reports and their expenses in as read-only history. Imported reports never become claims to approve, batch or pay. Coaster keeps them so you can see what was claimed before, and so an expense someone claims again is flagged as a possible duplicate.

Only the owner moves in, from **Move in**.

## Export from Expensify

Coaster reads an Expensify custom export template built from the field names in Expensify's documented [report export template](https://integrations.expensify.com/Integration-Server/doc/export_report_template.html). In Expensify Classic, create a custom export template with this header row and one row per expense:

```text
reportID,reportName,accountEmail,managerEmail,status,submitted,approved,reimbursed,transactionID,created,merchant,amount,currency,category,categoryGlCode,tag,comment,reimbursable,billable,isDistance,units.count,units.rate,receiptID,receiptFilename,receiptObject.url
```

Write `amount` as a positive decimal in the report currency, and dates as `YYYY-MM-DD`, `DD/MM/YYYY` or `MM/DD/YYYY`. The required columns are `reportID`, `reportName`, `accountEmail`, `status`, `transactionID`, `created`, `merchant`, `amount` and `currency`.

## Preview

Choose the file under **Expensify CSV**, pick how **Dates in the file** are written, and choose **Preview**. The preview writes nothing. It shows the number of reports and expenses and their total, and asks what each Expensify status becomes in Coaster (Open, Submitted, Approved, Reimbursed or Closed). Coaster suggests the obvious ones.

The preview lists anything to fix first, by row: a missing report or transaction, a date that is not real, an amount that is not positive, a currency other than the business's, or a report whose fields differ between its rows.

## Import

Choose **Import** with the number of reports. Coaster applies exactly the file and mapping you previewed; a changed file or mapping is refused until you preview again. It keeps the original file.

Receipt images are not fetched: Coaster makes no calls to Expensify, so the receipt address and file name are kept as references.

## Undo

Under **Imports**, **Undo import** removes everything that import added. You can import the same file again afterwards.

Limits: 2 MB and 2,000 expenses per file. Larger histories import in several files.
