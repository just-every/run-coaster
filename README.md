# Coaster

Coaster runs employee expenses and reimbursement for one business: employees
submit receipt-backed claims, managers approve or return them, and finance
reconciles approved claims into a reviewed reimbursement batch and an
accounting CSV. MIT licensed; it runs on the owner's own Cloudflare account.
Source code: [just-every/run-coaster](https://github.com/just-every/run-coaster).

## Run it locally

Run two lines to install the `rer` command, clone Coaster and start it:

```sh
curl -fsSL https://runeditrun.com/install.sh | sh
rer dev just-every/run-coaster
```

The first line installs `rer` for you alone, with its own Node if you have none. It changes no shell settings: if it prints an `export PATH=…` line, run that line before the second. Already have Node 22 or later? `npx -y @runeditrun/rer dev just-every/run-coaster` does both lines in one.

To start it again later, run `cd run-coaster && rer dev`.
This edition is runnable after composition. From the composed edition's
checkout root, `rer dev` alone launches it for review: it installs pinned
dependencies, sets up a local owner on a free port, starts the real app and
prints `RER_READY` and a sign-in link. To install for a real owner, run the
verbs yourself:

```sh
rer install
rer setup --owner-email you@example.com
rer dev
```

`rer demo` opens a throwaway copy signed in as the owner, with Harbour & Finch
Studio's sample claims, and deletes it when it stops; [DEMO.md](DEMO.md) covers
the sample data and the hosted demo at https://demo.run-coaster.com/.

Commands that run project work select the exact Node version declared by the
project. They use an exact matching installed runtime or a checksum-verified
copy cached at `~/.rer/node/node-vVERSION-PLATFORM-ARCH/`; when needed on
supported platforms, the runner retrieves the official Node release and checks
its SHA-256 against `SHASUMS256.txt`. It does not change global Node installations.
Set `RER_NODE_AUTO=0` to disable automatic selection. If selection is disabled
or acquisition fails, the command reports a repair invocation in this form:
`npm exec --yes --package=node@VERSION -- node SCRIPT VERB --cwd PROJECT`.
Help, check, describe, doctor and stop do not select or acquire Node.

After `RER_READY`, `dev` prints `RER_SIGNED_IN EMAIL` and `RER_OPEN URL`.
Open that URL on this computer: the app opens signed in as the owner and
finishes first-run setup at `/setup`. Treat the line as a credential.
`dev --as PERSONA` starts as a persona or signed out; `dev --login` prints
the outbox instead: follow its newest ordinary sign-in link. Until first-run
completion is stored durably, app routes send the signed-in owner to `/setup`;
signed-out visitors sign in and return there. Once complete, `/setup` opens the
app or settings. The local outbox sends no external email.

The saved local port is used; a first setup saves the first free port from 8787. Explicit ports are decimal
integers from 1 through 65535 and must be free; a busy requested port fails
instead of silently moving. Only `127.0.0.1`, `localhost` and `::1` are allowed.
Dev applies the selected host and port to both the listener and runtime bindings;
readiness is bounded and failure stops the owned processes.

Missing non-interactive setup answers exit 3 and name the manifest fields.
Read `rer-setup.json` and pass a private, mode-0600 JSON object keyed by those
names using `rer setup --answers PATH --non-interactive`,
for example `{"OWNER_EMAIL":"owner@example.com"}`. Secret values stay in
private inputs and never go in command arguments. A setup rerun with the saved
owner and origin preserves existing owner/data and exact private settings.
Conflicting saved identity or origin reports an actionable recovery path.
Review reset's exact removal inventory before confirmation; export domain data
first if it should be restored, and import only into an empty destination.

Queue waits report immediately with a reason and numeric one-based position,
then refresh about every 15 seconds while waiting. Package mode has no queue status command; a waiting command reports its live position.

Use the setup prompt instead of `--owner-email` when entering the real owner
mailbox. Open the `RER_OPEN` URL printed by `dev` on this computer; the app opens
signed in as the owner. With `dev --login`, open the outbox it prints, choose
the newest ordinary sign-in message and follow its link. No external email is
sent. `dev` serves
live editing with HMR and stays in the foreground on its first invocation; a
compatible repeated invocation reuses the server and exits. Stop `dev` with
`rer dev --stop` or Ctrl-C, and stop `preview` with
`rer preview --stop` before build or verification.

```sh
rer verify
rer reset --yes
rer export --output exports/installation.rer
rer import --input exports/installation.rer --yes
rer deploy
rer describe
```

`verify` ends by loading each public page of the production build in Chromium to
prove its sections hydrate as separate units (`src/base/hydration/README.md`); run
`pnpm exec playwright install chromium` once on a new machine.

Reset is destructive local cleanup. Import requires an empty destination and
explicit confirmation. Use `rer describe` to inspect the
checkout's actual commands and flags. The maintained pins are Node 22.20.0 and
pnpm 10.12.4. Read `RUN-LOCALLY.md` for data custody, deploy requirements and
remote-transfer support.

## What Coaster does

- Claims with receipt photos or PDFs, mileage and per diem, split across categories and cost centres.
- Policy exceptions (missing receipt, over a category limit, possible duplicates) that need an explanation and stay visible to the export.
- One approving manager per employee, deciding the exact submitted revision; returned claims keep every earlier revision and receipt.
- Reimbursement batches where an exact duplicate expense can be paid only once, reviewed against a reconciled total, exported as an accounting CSV and a per-person reimbursements CSV.
- Agent keys: a person's agent prepares draft claims or batch proposals; only the person accepts them.
- An Expensify move-in kit on Base import-kit, with preview, exact commit and undo.

Read `CONTRACT.md` for the first-release clauses, `ACCEPTANCE.md` for how they are
proven, `API.md` for the HTTP and agent API and `IMPORTING.md` for the move-in kit.

## Foundation notes

This is a technical foundation, not a finished product. It includes Hono,
TanStack Start, Vite, React, Cloudflare, D1 and real owner/operator
authentication, with no precreated owner, product domain or background jobs.
The edition owns its complete product experience and may change its source,
schema, UI, framework, infrastructure and integration method.

Private HTTP routes and Start functions must authorize native sessions inside
every server function, including direct transport calls. Route guards alone are
insufficient. Keep server-only modules and secrets out of client bundles.
Unknown documents and missing assets return real 404s. Keep Queue/Cron handlers
and named Worker exports in `src/server.ts`; the dispatcher only selects HTTP
ownership.

An installed instance's `/` is the Lobby, served by `src/server.ts` from
`src/base/lobby.ts` with `GET /setup/state`: Sign in, or Finish setup until the
owner confirms first-run setup. `src/identity.ts` holds its edition identity.
The run site (`run-coaster.com`, `deploy-site.json`) is the public homepage,
its Run page and the docs: `rer build --site` renders `src/site/pages.tsx` (the
homepage in `src/site/landing`, the Run page from `src/site/run.ts`, and
`/docs` from `docs/site.json` and `docs/*.md`) into `dist/site`, and `rer dev`
serves it as `RER_SITE`. `.github/workflows/run-site.yml` deploys it only once
the repository's `RUN_SITE_DEPLOY` variable is turned on (see
`HOMEPAGE-VARIANTS.md`). The owner guides live in `docs/`.

The edition owns `rer-setup.json`, application branding and its installer
adapter. Keep one setup manifest and declare actual answers, defaults, managed
secrets, migrations, build targets, health checks and owner behavior there and
in the adapter. Setup must preserve existing local owner/data and exact private
settings on reruns. Never create a second owner or rotate secrets implicitly.

Local durable data lives in `.wrangler/state`; private settings default to
`.dev.vars` with mode 0600. Local export/import covers declared supported
resources and excludes owner/auth, outbox, private settings and transient
runtime state. Every first-party seed verifies local export/import/export
equivalence across its supported resources. Preserve applied migration history
and require forward migrations for schema changes. Remote transfer is supported
only when the adapter covers all required resources.

`deploy --dry-run` builds and validates locally without provider requests. Real
deployment uses the owner-account procedure and requires its private account
credentials, declared migrations and a real verified mail configuration. Local
verification does not establish hosted acceptance, remote health or mail
delivery. See `OPERATIONS.md`, `ONBOARDING.md`, `SEED-COMMAND-CONTRACT.md` and
`RUN-LOCALLY.md` for the implemented requirements.
