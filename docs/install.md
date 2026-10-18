Coaster runs on your own computer with the `rer` command, on macOS, Linux or Windows with WSL2, with Git. The installer brings Node when it is missing, and rer installs the pnpm and Node versions Coaster pins by itself.

## Get Coaster and start it

Two lines, the same as on the [Run page](https://run-coaster.com/run):

```sh
curl -fsSL https://runeditrun.com/install.sh | sh
rer dev just-every/run-coaster
```

The first line installs `rer`, the Run Edit Run command, for you alone, with its own Node if you have no Node 22 or later. It changes no shell settings: if its last line puts `rer` on your PATH, run that line before the second. The second gets Coaster into a `run-coaster` folder, installs everything it needs, makes you the owner of this copy and starts it.

Already have Node 22 or later? `npx -y @runeditrun/rer dev just-every/run-coaster` does both steps in one line. To set Coaster up without starting it, use `setup` in place of `dev`.

To start it again later, run `cd run-coaster && rer dev`. A first launch can take a few minutes. When it is ready it prints a line that starts with `RER_OPEN`: open that link on this computer and Coaster opens signed in as you. Treat that link like a password.

## Finish setup

The first time you open Coaster you land on **Finish setup**. It shows the owner's name and email; tick **I confirm this owner account is ready to use.** and choose **Finish setup**. Coaster then opens on **Set up Coaster**, three steps that each open the setting that completes them. [Set up your business](/docs/setup) walks through them.

## Stop and start again

- `rer dev --stop` stops Coaster. Your claims, receipts and settings stay on this computer.
- `rer dev` starts it again on the same address.
- `rer dev --login` prints the local outbox instead of a sign-in link; open the newest sign-in message there.

While Coaster runs on your computer it sends no real email: invitations and sign-in links go to the local outbox that `rer dev --login` prints.

## Next

When it is working the way you want, [put it on your own Cloudflare account](/docs/deploy) so your team can reach it.
