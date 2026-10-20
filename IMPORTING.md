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

# Card history from Ramp, Brex and Navan

Card charges from a Ramp, Brex or Navan transaction export come in as
read-only history with their memos, coding and receipts (MOVE-004). Like
Expensify reports they never become claims: Coaster keeps them to show what
was spent (and refunded) on cards before and to flag an out-of-pocket expense that repeats a
card charge (same employee, date, merchant and amount) as a possible duplicate.

On **Move in**, choose the tool, the CSV and the receipt files the CSV names,
and the date format; preview, import and undo work as for Expensify. The CSV
and every receipt are kept byte for byte with the import.

Coaster reads these columns (any other column is kept in the original file and
reported as not mapped). Required: the transaction id, date, employee email,
merchant, amount and currency columns; optional: memo, category, GL code and
receipt file.

| Tool | Transaction id | Date | Employee | Merchant | Amount | Currency | Memo | Category | GL code | Receipt file |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ramp | `Transaction ID` | `Transaction Date` | `User Email` | `Merchant Name` | `Amount` | `Currency` | `Memo` | `Ramp Category` | `Accounting Category` | `Receipt File` |
| Brex | `Transaction ID` | `Posted Date` | `Card Member Email` | `Merchant` | `Amount` | `Currency` | `Memo` | `Category` | `GL Account` | `Receipt File` |
| Navan | `Transaction ID` | `Transaction Date` | `Employee Email` | `Merchant` | `Amount` | `Currency` | `Description` | `Expense Type` | `GL Code` | `Receipt File` |

These are the columns Coaster expects; rename a tool's export headers to them
if your export names a column differently. `tests/fixtures/ramp-transactions.csv`
is a synthetic file in the Ramp shape. Coaster makes no calls to Ramp, Brex or
Navan.

Refunds and credits (negative amounts) come in as history with their negative
amount, so a later card feed can match them too. A row naming a receipt file
you did not add, a repeated transaction id, a bad date or amount, an employee
that is not an email address, blocks the import and is
listed by row. Foreign currencies convert under CLAIM-003 after the owner enables ECB conversion; original amount/currency and rate/source/date remain with each history row. Receipt files
no row names are listed and left out.

Limits: 2 MB and 2,000 charges per CSV, 50 receipt files of up to 1.5 MB each
per import, 8 MB per request.

# Expense history from Emburse

Expense lines from Emburse's Certify, Chrome River and Abacus report exports
come in the same way, as read-only history with their report, approver,
coding and receipts (MOVE-003). On **Move in**, choose the Emburse product,
the CSV of report expense lines and the receipt files it names, and the date
format; preview, import and undo work as for the card tools, and the CSV and
every receipt are kept byte for byte with the import. A later expense claimed
again (same employee, date, merchant and amount) is flagged as a possible
duplicate naming the imported expense.

Required: the expense id, date, employee email, merchant, amount and currency
columns; optional: report id, approver email, description, category, GL code
and receipt file. An approver that is not an email address blocks the import
like the other row errors above.

| Product | Expense id | Report | Date | Employee | Approver | Merchant | Amount | Currency | Description | Category | GL code | Receipt file |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Certify | `Expense ID` | `Report ID` | `Expense Date` | `Employee Email` | `Approver Email` | `Vendor` | `Amount` | `Currency` | `Description` | `Category` | `GL Code` | `Receipt File` |
| Chrome River | `Line Item ID` | `Report ID` | `Transaction Date` | `Employee Email` | `Approver Email` | `Merchant` | `Amount` | `Currency` | `Business Purpose` | `Expense Type` | `GL Account` | `Receipt File` |
| Abacus | `Expense ID` | `Report ID` | `Date` | `User Email` | `Approver Email` | `Merchant` | `Amount` | `Currency` | `Description` | `Category` | `GL Code` | `Receipt File` |

Rename an export's headers to these if it names a column differently.
`tests/fixtures/certify-expenses.csv` and `tests/fixtures/chromeriver-expenses.csv`
are synthetic files in the Certify and Chrome River shapes. Users, categories and ordered approval chains move in through the reviewed
configuration envelope below. Coaster makes no calls to Emburse.

## Emburse people, categories and ordered approval chains

Choose **Emburse configuration JSON** on Move in after translating the product's
people/category/approval exports into this envelope. Expense CSVs and receipts
continue through the history importer above; configuration imports are reviewed
and undone separately. The JSON file's exact bytes are retained as an original.
Each source row has an opaque random UUID `key`, saved with the export for later
imports. A key must never contain a name, email or upstream identifier.
Replace the angle-bracket placeholders below with separately generated random UUIDs;
references to a person reuse that person's row UUID.

```json
{
  "members": [
    {"key":"<employee-row UUID>", "email":"employee@example.com", "name":"Employee", "employee":true},
    {"key":"<manager-row UUID>", "email":"manager@example.com", "name":"Manager", "employee":true, "manager":true}
  ],
  "categories": [
    {"key":"<category-row UUID>", "name":"Supplies", "accountCode":"6500", "taxCode":"NONE"}
  ],
  "chains": [
    {"key":"<chain-row UUID>", "employee":"<employee-row UUID>", "steps":["<manager-row UUID>"]}
  ]
}
```

A preview writes nothing and returns `summary.crosswalk`, from source row UUIDs
to native random UUIDs. The screen keeps that exact crosswalk for commit. API
callers send it back as `mapping.crosswalk`, with the reviewed fingerprint.
To reuse a native person or category, choose it explicitly in the screen or
provide its `member_id`/`id` in that crosswalk. Names and addresses never infer a
match: a collision refuses until explicitly mapped. Previously imported keys
reuse their saved crosswalk; changing it is refused. Existing mapped people and
categories retain their native values, roles and access. Additional row fields
are named as unmapped and kept in the original.

New people have random UUID member identities, remain inactive and receive no
invitation or access. Activate and invite them explicitly in Settings. A chain
has one employee and distinct ordered managers, with no self-approval. Once all
its managers are active, a submitted claim freezes that exact chain: each step
approves the submitted revision in turn, only the last makes it reimbursable,
and automatic approval never skips the chain. Delegation substitutes the current
step. A correction uses the then-current configured chain; reopening approval
restarts its frozen chain. Partial holds are available at the final step only;
held expenses go through submission again.

Undo removes unchanged configuration unless native claims or other live records
need it, preserving activated/edited people, used categories and frozen chains;
the undo report explains retained rows. Erasure withdraws affected originals and
retires the erased person's import records, so undo and reimport cannot restore
their identity. Configuration: at most 500 rows of each kind, 20 managers per
chain, within the 8 MB request limit.

# Moving in from SAP Concur

On **Move in**, use **SAP Concur** to review configuration first, then the
accounting extract and receipt ZIP. Both use the existing owner-only
preview/import/status/resume/undo doors with `source: "concur"`. No Concur
account, credentials or network access are used. The fixtures are synthetic;
operation against an owner's real export has not been demonstrated.

Export without banking fields or full card numbers. Coaster refuses populated
SAE bank/routing fields 16–17, card-account fields 130 and 154, banking fields
291–310, and banking/account-number columns in a header export **before retaining
the input**. The error identifies the export requirement without reproducing
the value. Safe explicitly named token/last-four fields may be retained.

## Configuration translation and review

Translate the Concur user/approver, expense-type and policy exports into the
same reviewed `members`, `categories` and ordered `chains` envelope described
above, adding a `policies` array. Preserve the opaque random UUID row keys with
the export; use explicit crosswalk choices to reuse native people/categories.
New people are inactive, receive no invitation and cannot use Coaster until
the owner activates them. Existing native people retain their roles and access.

Each policy has an opaque UUID `key`, `name` and `rules`, for example:

```json
{
  "key": "<random policy UUID>",
  "name": "US company policy",
  "rules": [
    {"kind": "per-expense-limit", "category": "<category row UUID>", "limit": "70.00", "hard": false}
  ]
}
```

Rules use POLICY-001's public input fields (`kind`, `hard`, and the applicable
`category`, `limit`, `field`, `merchant` or `days`). A category refers to its
configuration row UUID or an explicitly chosen native category. Only supported
company-wide semantics are translated: a department/group scope, unknown rule,
unknown rule property or conflicting deadline is listed as an error and blocks
commit. A source policy name alone is not treated as an implemented rule.

The imported company-wide rules add to existing finance rules and the immutable
owner floor in one new policy version effective today. Original configuration
bytes are retained. Undo appends a compensating version with the previous
finance rules; it never changes an earlier version or submitted revision. If a
native policy version has been published since adoption, undo preserves it and
reports the imported policy as edited. Activated people, frozen chains and
categories referenced by claims or permanent policy history are preserved too.

## Accounting extract and expense-type mapping

Select **Standard Accounting Extract v4** explicitly for pipe-delimited SAE
input. Its `EXTRACT` header supplies the detail record count and signed journal
total, both reconciled before commit. The documented v4 column positions are
used; no layout is guessed. For a CSV report/accounting export select
**Documented headers**, with SAP's field names shown by
`CONCUR_HEADERS` in `src/coaster/imports/concur.ts`. An API caller may supply
`mapping.columns` with those normalized field keys mapped to exact header names
or one-based positions, and `mapping.delimiter` of `|`, comma or tab. Other SAE
versions require an explicit, documented mapping rather than silent detection.

Preview names employee source IDs and expense types. Explicitly map employees
to their addresses and expense types to active native categories, then preview
again. API fields are `mapping.employees: {sourceEmployeeId: email}` and
`mapping.categories: {sourceExpenseType: nativeCategoryId}`. Dates default to
`YYYY-MM-DD`; explicit `YYYYMMDD`, `MM/DD/YYYY` and `DD/MM/YYYY` are supported.
Header exports with a report status use `mapping.statuses` to choose `open`,
`submitted`, `approved`, `reimbursed` or `closed`; SAE history is processor-approved
history and is not asserted paid.

Repeated allocation/journal rows group by Report Entry ID. The approved entry
amount is counted once, all signed allocations are preserved and must sum to
that amount, and report totals sum the distinct entries. Journal IDs must be
unique; contradictory repeated entry/report fields, parent itemization rows,
bad dates, non-cent amounts and missing mappings block import. Credits and
refunds retain their negative values. Foreign currency converts under CLAIM-003 after the owner enables ECB conversion. Concur’s approved report-currency amount and signed allocations are converted; transaction currency/amount, original report amounts and raw journal values remain separately. Preview freezes the resolved rates; a rate change requires another preview.
Every report and entry remains read-only history, never a reimbursable claim;
later matching claims show the imported expense as a possible duplicate.

## Receipt ZIP and index

Supply the decrypted SAP Image Delivery ZIP with its index CSV. The index joins
`Report ID,Employee_ID,Report_Key,Entry_ID(optional)::Image ID`; multiple
`entry::image` pairs are separated by `||`. A pair with no entry stays a report
attachment. An explicit CSV with `Report ID,Entry ID,Image ID,Receipt File` is
also accepted. When an image ID differs from its filename, supply the reviewed
`mapping.imageFiles: {imageId: filename}` crosswalk; ambiguous names block.

Both stored and deflated ZIPs are accepted. Paths, member names, declared sizes
and CRCs are validated; encrypted, multi-volume, unsupported or malformed ZIPs
refuse. Indexed missing files, unindexed files, invalid receipt signatures and
unknown report/entry associations block commit. Receipt formats match native
Coaster capture: JPEG, PNG, WebP, HEIC and PDF. The extract, ZIP, index and indexed
receipt originals are retained byte for byte. Erasure links the extract and
ZIP/index to the employee through structured provenance, including originals
that contain only an upstream employee ID, so status/undo/reimport cannot
resurrect erased identity.

Limits: 2 MB extract, 4,000 journal rows, 8 MB compressed/extracted receipt ZIP,
1.5 MB per extracted receipt, 100 archive members/receipt associations and 8 MB
per HTTP request. Larger exports must be split into complete reports. Fixtures:
`tests/fixtures/concur-sae-v4.txt`, `concur-accounting.csv` and
`concur-receipts.zip` (including entry-level and report-level images).

Source references: SAP's [extract structure](https://help.sap.com/docs/CONCUR_EXPENSE/bb83754b1c5541808d50c09901e11475/188c1bc36f0910148e1d8a01eccf5155.html),
[journal fields](https://help.sap.com/docs/concur-expense/concur-expense-professional-edition-administration-guides/journal-entry-data-a64f2d9ffa1c409b855d03d412785456),
[report fields](https://help.sap.com/docs/CONCUR_EXPENSE/bb83754b1c5541808d50c09901e11475/8bd1d4553ea24fb8abfe37e327c4fde4.html)
and [Image Delivery index](https://help.sap.com/docs/SAP_CONCUR/ceeea7fe419f4997bd53f60c0e1097d5/855f4bc7d0a747499e04b57c1f4993b2.html).

## Foreign-currency history (CLAIM-003)

Enable ECB currency conversion in Settings before importing foreign amounts. Coaster downloads only the fixed public ECB history file; no source expense fields leave the installation. It selects the transaction date or latest publication before it and cross-rates via EUR, rounds half up to cents (credits away from zero), and keeps originals plus rate/date/source. The final Concur allocation takes the remainder so totals reconcile. An unavailable or unsupported rate blocks commit; a changed rate invalidates the preview. ECB reference rates are not card rates. Native expenses also allow an explicit rate entered by hand, without a network request.
