When Coaster works the way you want on your computer, put it on your own Cloudflare account so your team can reach it from anywhere. You keep the account, the data and the bill.

## Check first

```sh
rer deploy --dry-run
```

The dry run checks the deployment and builds Coaster locally. It makes no request to Cloudflare.

## What you need

- A Cloudflare account, and an API token for it. Coaster reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from your environment; never put them in a file in the repository.
- A mail provider for real sign-in and invitation emails. Choose Resend, SendGrid or Cloudflare Email Sending and verify your sender address with that provider.
- Set `MAIL_PROVIDER` and `MAIL_FROM` in `deploy.json` under `vars`, then commit that public configuration before deploying. Both are declared deployment inputs in `packaging.json`. For Cloudflare Email Sending, also set `MAIL_ACCOUNT_ID`.
- Required private inputs: `SESSION_SECRET`, `SETUP_TOKEN` and `INSTALLATION_KEY`. The direct mail provider also needs `MAIL_API_KEY`; keep these in private setup inputs or the target secret store. Never commit them. Managed hosting supplies the RER mail relay URL and its private credential.
- The owner's email address. Coaster keeps its session and setup secrets privately.

## Deploy

```sh
rer deploy
```

`rer deploy` creates Coaster's database and receipt-inbox R2 bucket on your account, applies its migrations, publishes it and checks that it answers. Run it again to publish a newer version; your data stays.

## After deploying

Open your Coaster's address. Its home page is a small lobby with one button: **Finish setup** until the owner confirms setup, then **Sign in**. Then [set up your business](/docs/setup) and invite your team.
