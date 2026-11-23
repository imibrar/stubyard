# Sample data

A ready-made data set that fills every dashboard page, for trying stubyard or judging a dashboard design. Everything
is fake: `*.example.test` addresses, `+1555…` numbers, made-up keys.

| File | Project | What it shows |
|---|---|---|
| `seed/01-brightpath.json` | Brightpath (consumer app, the main one) | 14 users (pinned, long names, email-only, phone-only, opted out, blocked, flaky), SMTP ×2, SendGrid, Twilio, Vonage, WhatsApp Cloud API, FCM and APNs with devices, Google and Apple login, user and provider rules, TOTP keys, API mocks, webhook endpoints, templates and a sequence, LLM mocks, an AI persona, auto-replies, chat agents, login recipes, a data set, storyboards |
| `seed/02-ledgerline.json` | Ledgerline (B2B SaaS) | 8 users with roles, Mailgun, SES, generic SMS, S3 with buckets, Microsoft / GitHub / OIDC login with a login rule, signed webhooks |
| `seed/03-souk.json` | Souk Market (shop) | 6 users, Stripe, PayPal, PayTabs and Tabby, payment rules, Twilio SMS and WhatsApp |
| `seed/04-sandbox.json` | Sandbox | one user and one email: the near-empty states |

The seed holds configuration only. `populate.mjs` then sends traffic through stubyard's real endpoints (SMTP, the
provider APIs, FCM / APNs, payment gateways, OAuth, S3, webhooks, the mock LLM APIs): codes and magic links, duplicates
(the same message 3–4 times), refused and failed deliveries, inbound replies, an AI persona conversation, pushes,
payments (paid, declined, cancelled, refunded, partly refunded, left open), and some messages marked read.

## Run it

```bash
./scripts/npm.sh ci                        # once
STUBYARD_DEV_SEED=1 ./scripts/dev.sh       # imports samples/seed at start (STUBYARD_SEED=/app/samples/seed)
node samples/populate.mjs                  # in a second terminal, once the API answers
```

Then open http://localhost:5173. The seed only creates projects whose slug does not exist yet, so keeping
`STUBYARD_DEV_SEED=1` on is safe. `populate.mjs` stops when Brightpath already has messages; `--again` adds another
round. Options: `--api http://127.0.0.1:4000` and `--smtp 127.0.0.1:1025` (for moved ports, see the top of
`scripts/dev.sh`). The defaults use `127.0.0.1` because Node may resolve `localhost` to `::1`, where the dev
container does not listen.

Without the dev scripts (any stubyard): import the files with `POST /api/projects/import` or the dashboard's import,
or mount the folder and set `STUBYARD_SEED` to it.

On Windows Git Bash, run the scripts with `MSYS_NO_PATHCONV=1` so Docker gets the `/app` paths unchanged.

## Reset

Stop stubyard, delete `./data`, start again. `./data` is git-ignored and holds every project, message and log.
