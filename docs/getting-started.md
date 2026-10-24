Coaster runs on your own computer. Open a terminal (on a Mac, Terminal in Applications → Utilities; on Windows, your WSL2 distribution), copy this line into it and press Enter:

```sh
curl -fsSL https://runeditrun.com/install.sh | sh -s -- dev just-every/run-coaster
```

Git is required; rer brings Node and pnpm. Already have Node 22 or later? `npx -y @runeditrun/rer dev just-every/run-coaster` does the same.

The line installs `rer`, the Run Edit Run command, gets Coaster into a `run-coaster` folder, installs everything, makes you the owner of this copy and starts it. A first launch can take a few minutes. When it is ready it prints a line that starts with `RER_OPEN`: open that link on this computer and Coaster opens signed in as you. Treat that link like a password. While Coaster runs on your computer it sends no real email, and nobody else can open it.

If the installer prints a line that puts `rer` on your PATH, run that line too. To start Coaster again later, run the same line from the same folder, or `cd run-coaster && rer dev`. `rer dev --stop` stops it.

Next: [Run Coaster on your computer](/docs/install) covers finishing setup and the local outbox, and [Set up your business](/docs/setup) walks through the first three steps.
