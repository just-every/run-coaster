# Coaster demo

After the ordinary `rer setup`, run `rer demo` (`rer dev --demo`) and open its
private `RER_OPEN` link. It opens signed in as the saved owner on its own data
in `.rer/demo/<start>/`, which is deleted when it stops: `rer demo --stop`,
Ctrl-C, or its end. Restarting starts afresh. The checkout's `.wrangler/state`
and private settings are not touched. The title and the nav read **Coaster Demo**.

## Sample data

`src/demo.ts` (`seedDemo`, data in `src/demo-data.ts`) writes Harbour & Finch
Studio, the business Coaster's own tests use, as it looks a few weeks in: AUD
with mileage at 0.88/km and a 75.00 per diem, six categories with account and
tax codes (Meals limited to 120.00, Software to 500.00), the owner and seven
people with their approving managers (one inactive), and fourteen claims at
every stage:

- three reimbursed in a paid batch (RB-0001) and two in a draft batch (RB-0002)
  waiting for the owner's review;
- two approved and ready to batch, one with an explained missing receipt;
- two waiting for the owner's approval, one over the Meals limit with the
  employee's explanation, and two waiting for Priya, one of them the owner's;
- one returned for a missing receipt, one rejected, and the owner's own draft;
- an agent key and its proposal: three ride receipts prepared as a claim for
  the owner to accept or decline.

Each receipt is a one-page PDF with the merchant, date, lines and total. Every
submission, decision and batch carries its frozen revision, exceptions and
history lines, and the batches reconcile to the cent. Dates count back from the
moment the demo starts. Base's `modules/demo` runs the hook once, after the
owner exists; a workspace that already has a business keeps its own records.

## What a demo reaches

| Path | Where it goes | In a demo |
|---|---|---|
| Sign-in links, member invitations and step-up confirmations (`src/mail.server.mjs`) | People's inboxes, through the mail provider | Mocked success: Base accepts suppressed development delivery under its demo guard; nothing is sent or stored |
| Linking an identity provider (`IDENTITY_PROVIDER`, `/auth/dependencies/*`) | The provider's discovery and token endpoints | Not configured in a demo |

Coaster has no public reads or checks: it never fetches a page, feed or URL a
person gives it, and it never moves money (a batch is paid outside Coaster and
recorded by hand). Base's guard returns success for any other external write.

## Hosted demo

`rer deploy --demo` puts it on the web at `https://demo.run-coaster.com/`
(`deploy-demo.json`): one Cloudflare Container per visitor running Coaster's
container image with `RER_DEMO=1`. The visitor passes Turnstile and lands signed
in as the owner through Base's signed owner claim (`/auth/owner-claim` in
`src/auth.server.ts`, served only when the claim's public keys are set). A demo
ends after 60 minutes or 15 idle minutes, and its container and state are
deleted.

`.github/workflows/run-demo.yml` (Base's `export/run-demo.yml`, on the
RunEditRun account) deploys from the `run-demo` environment when run by hand,
and on pushes to `main` only when the repository variable `RUN_DEMO_DEPLOY` is
`true`. Run by hand with `test_only` it deploys the separate test host
`demo.test.run-coaster.com` with Turnstile's always-passing test keys; `remove`
removes the selected demo.

`src/modules/demo` is Base's `modules/demo` from the pinned rer release's tag.
