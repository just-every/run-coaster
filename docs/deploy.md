When Coaster works the way you want on your computer, put it on your own Cloudflare account so your team can reach it from anywhere. You keep the account, the data and the bill.

## Check first

```sh
rer deploy --dry-run
```

The dry run checks the deployment and builds Coaster locally. It makes no request to Cloudflare.

## What you need

- A Cloudflare account, and an API token for it. Coaster reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from your environment; never put them in a file in the repository.
- A mail provider for real sign-in and invitation emails, with a verified sender address set in `deploy.json`.
- The owner's email address. Coaster keeps its session and setup secrets privately.

## Deploy

```sh
rer deploy
```

`rer deploy` creates Coaster's database and receipt-inbox R2 bucket on your account, applies its migrations, publishes it and checks that it answers. Run it again to publish a newer version; your data stays.

## After deploying

Open your Coaster's address. Its home page is a small lobby with one button: **Finish setup** until the owner confirms setup, then **Sign in**. Then [set up your business](/docs/setup) and invite your team.
