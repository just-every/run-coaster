Your whole installation can be exported to one file and restored into a new, empty installation: claims, every revision and decision, receipt bytes, batches, history and imported Expensify history.

## Back up

From the Coaster folder:

```sh
rer export --output exports/installation.rer
```

The archive is private: it holds your receipts and people's details. Keep it somewhere safe, and keep several.

The archive does not include sign-in accounts, sessions, the local outbox or private settings such as secrets. Those belong to the installation, not to the business's records.

## Restore

Restore into an empty installation, for example a fresh copy on a new computer:

```sh
git clone https://github.com/just-every/run-coaster.git coaster
cd coaster && rer setup
rer import --input exports/installation.rer --yes
rer dev
```

`rer import` checks the archive before it writes anything. A damaged archive, or one whose claims, batches and receipts do not agree, is refused and nothing changes. It only restores into an installation with no records yet.

After the restore, every claim, receipt, batch and history line is identical, and the owner can still undo an Expensify move-in made before the backup.

## Start over

`rer reset --yes` removes this computer's Coaster data after listing exactly what it removes. Export first if you want to keep it. Your export archives are kept.
