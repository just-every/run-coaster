When Coaster works the way you want on your computer, put it on your own Cloudflare account so your team can reach it from anywhere. You keep the account, the data and the bill.

## Check first

```sh
MAIL_PROVIDER=none rer deploy --dry-run
```

The dry run checks the deployment and builds Coaster locally. It makes no request to Cloudflare.

## What you need

- A Cloudflare account, and an API token for it. Coaster reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from your environment; never put them in a file in the repository.
- The owner's email address and the private setup values `SESSION_SECRET`, `SETUP_TOKEN` and `INSTALLATION_KEY`. Keep these in private setup inputs or the target secret store.
- For email sign-in, invitations and notifications, set `MAIL_PROVIDER` to `resend`, `sendgrid` or `cloudflare` and supply your verified `MAIL_FROM` and private `MAIL_API_KEY`. Cloudflare Email Sending also needs `MAIL_ACCOUNT_ID`. RER managed mail uses its assigned relay URL and credential.

## Deploy

```sh
MAIL_PROVIDER=none rer deploy
```

For a deployment with email, set the provider inputs above and run `rer deploy`.

`rer deploy` creates Coaster's database and receipt-inbox R2 bucket on your account, applies its migrations, publishes it and checks that it answers. Run it again to publish a newer version; your data stays.

## After deploying

With mail off, run `rer signin` from the checkout with the Cloudflare credentials used for deployment. Open the private, one-time owner link and [set up your business](/docs/setup). Email sign-in, invitations, reminders and receipt-alias verification need outbound mail.
