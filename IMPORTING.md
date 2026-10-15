# Moving in from Expensify

Coaster's first move-in kit brings past Expensify reports and their expenses in
as read-only history. Imported reports never become claims to approve, batch or
pay. Coaster keeps them to show what was claimed before and to flag an expense
someone claims again (same employee, date, merchant and amount) as a possible
duplicate.

The kit runs on Base import-kit: **Preview** reads the file and writes nothing;
**Import** applies exactly the previewed bytes and mapping (a changed file or
mapping is refused until previewed again) and keeps the original file; **Undo**
reverses the import. Jobs belong to the owner role, so a restored installation's
owner can still undo them.

## Export the file from Expensify

Expensify's built-in CSV exports use fixed columns that its help pages do not
list exactly, so Coaster reads a custom export template built from the field
names in Expensify's documented
[report export template](https://integrations.expensify.com/Integration-Server/doc/export_report_template.html).
In Expensify Classic, create a custom export template (or use the Integration
Server's report exporter) with this header row and one row per expense:

```
reportID,reportName,accountEmail,managerEmail,status,submitted,approved,reimbursed,transactionID,created,merchant,amount,currency,category,categoryGlCode,tag,comment,reimbursable,billable,isDistance,units.count,units.rate,receiptID,receiptFilename,receiptObject.url
```

Each column holds the documented field of the same name (`report.reportID`,
`expense.merchant`, `expense.receiptObject.url` and so on). Write `amount` as a
positive decimal in the report currency (Expensify stores cents; divide by 100),
and dates as `YYYY-MM-DD`, `DD/MM/YYYY` or `MM/DD/YYYY` (choose which in Coaster).

Required columns: `reportID`, `reportName`, `accountEmail`, `status`,
`transactionID`, `created`, `merchant`, `amount`, `currency`. Other listed
columns are optional; any further column is kept in the original file and
reported as not mapped.

`tests/fixtures/expensify-report-template.csv` is a synthetic file in this shape.

## What the preview checks

- every row has a report and a unique transaction, a real date and a positive amount;
- every amount is in the business currency (one currency per business);
- every Expensify report status is mapped to Coaster history (Open, Submitted,
  Approved, Reimbursed, Closed); Coaster suggests the obvious ones;
- each report's fields are the same on all its rows.

Any error blocks the import and is listed by row. Credits and refunds (negative
amounts) are not imported. Receipt images are not fetched: Coaster makes no
calls to Expensify, so the receipt URL and file name are kept as references.

Limits: 2 MB and 2,000 expenses per file; larger histories import in several files.
