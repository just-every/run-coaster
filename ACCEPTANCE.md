# Coaster acceptance

## Purpose and minimum outcome

A finance or operations manager at a 15–75 person Australian agency,
consultancy or trade firm runs expenses in Coaster: employees submit
receipt-backed claims, managers approve or return them, and finance reconciles
the approved claims into a reviewed reimbursement batch and an accounting CSV
for the external books. The first release is accepted when every clause in
`CONTRACT.md` (COA-001 to COA-013) holds on the exact commit:

- totals reconcile: the accounting CSV and the reimbursements CSV each add up to the reviewed batch total (COA-009);
- an exact duplicate expense cannot reimburse twice (COA-005);
- policy exceptions stay visible from submission to the export (COA-004);
- a returned claim is corrected without erasing the old evidence (COA-007);
- access is scoped by employee, manager and finance role in every handler (COA-008);
- export and restore recover receipt bytes and decision history (COA-012).

## How it is proven

- `tests/coaster.test.mjs` (`pnpm test:coaster`): one business-flow test per
  clause COA-001 to COA-011, through the public HTTP API with real native
  sign-in by invitation mail, real workerd and D1 with every migration. No fake
  application database; the only stand-ins are the local development outbox and
  synthetic fixtures.
- `tests/browser.mjs` (`pnpm test:browser`): from a fresh clone of the committed
  head, `rer install`, `setup`, `check`, `describe`, `dev`, the human journey at
  1440 and 390 pixels wide (agent-prepared draft, employee claim with receipts,
  mileage and an over-limit meal, manager return, correction, approval, finance
  batch, accounting download and payment record, owner Expensify move-in and
  settings) with one screenshot per main screen, then `setup` rerun, `build`,
  `preview`, `deploy --dry-run`, `export`, refused corrupt and inconsistent
  archives, `import` into a second empty installation with identical results, and
  `reset` (COA-012, COA-013).
- `rer check` and `rer verify` on the exact commit (COA-013).

All examples are synthetic: the business "Harbour & Finch Studio", its people,
receipts and the Expensify-shaped file in `tests/fixtures/`.

## Not yet proven

- A real owner's Expensify export: the move-in kit is built from Expensify's
  documented report-template fields (IMPORTING.md), not from a real account's file.
- A real set of claims from a pilot business, the current-process cost
  baseline, and a whole month-end cycle observed by a finance manager.
- Hosted deployment, real mail delivery and an accessibility audit.

## Backup and upgrade

A pre-upgrade export restores only with the Coaster release that made it.
Restore it into an empty installation of that release, upgrade that
installation's source in place, run `rer install` and `rer setup`, then export
again. Keep the original release and private export until recovery is verified.
