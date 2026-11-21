# stubyard

Fake email, SMS, WhatsApp, payment, storage and login providers for local development and tests, in one Docker container.

Your app keeps using its real SDKs (Twilio, SendGrid, Stripe, the AWS SDK, OAuth libraries…), pointed at stubyard
instead of the real service. Every message lands in a test user's inbox with the OTP extracted, and every request in or
out is logged. *(Formerly named devhub.)*

## How it works

```text
 your app (real SDKs, base URLs pointed at stubyard)
     │  SMTP :1025 · HTTP :4000 / HTTPS :4443 · APNs HTTP/2 :2197
     ▼
 ┌──────────────────────────── stubyard (one container) ─────────────────────────────┐
 │ fake providers: /mock (SMS, WhatsApp, email APIs, your API mocks) · /hook · /auth │
 │                 /storage · /pay · /llm · /push                                    │
 │ projects → test users → inboxes with OTPs and links · rules to force failures     │
 │ traffic log of every request in and out                                           │
 └───────────────┬──────────────────────────┬──────────────────────────┬─────────────┘
                 ▼                          ▼                          ▼
     dashboard :4000 (people)    REST API /api (tests, CI)    MCP /mcp (AI agents)
```

You create a **project** per app and a few **test users**, add **provider instances** (a Twilio, a Stripe, an S3…) and
point your app at their URLs. Whatever the app sends lands in the matching test user's inbox, every request is logged,
and you can make any provider fail on purpose. Callbacks (delivery reports, webhooks, replies) go back to your app at
`http://host.docker.internal:<port>`. The [user guide](docs/GUIDE.md) walks through every feature.

## Why

- Test sign-up, OTP / 2FA, password reset, payment and webhook flows end to end without real provider accounts.
- Nothing leaves your machine: no real emails, texts or charges, and the ports bind to `127.0.0.1`.
- One container with one dashboard for every project you work on.
- Works with AI coding agents: an MCP server and an agent guide let them read codes, set scenarios and debug traffic.

## What it fakes

| Feature | What you get | Speaks |
|---|---|---|
| Email | SMTP inbox per test user, OTP / link extraction, bounces | SMTP; SendGrid, Mailgun and Amazon SES APIs and their event webhooks |
| SMS / WhatsApp | Timelines per user, delivery reports, replies (inbound webhooks) | Twilio (Messaging, Verify), Vonage (SMS, Verify), Meta WhatsApp Cloud API, Twilio WhatsApp, configurable generic API |
| 2FA / TOTP | Authenticator-app codes for test users | RFC 6238 TOTP |
| Webhooks | Receive with JSON Schema checks; send signed templates, sequences, replays | HMAC-SHA256, Stripe, PayTabs, PayPal signatures; Basic auth |
| API mocks | `/mock/<project>/api/<path>` with rules, templates and switchable scenarios | Any HTTP API |
| Login providers | Fake OAuth 2 / OIDC with an account picker per test user | Google, Microsoft, Apple, GitHub, GitLab, Facebook, LinkedIn, Slack, Discord, X, generic OIDC |
| File storage | Buckets, presigned URLs, quotas, fault rules | Amazon S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2, MinIO, Wasabi, Google Cloud Storage, Azure Blob, Cloudinary, Supabase Storage |
| Payments | Hosted payment page with selectable outcomes, signed webhooks | Stripe Checkout, PayPal (Orders v2, subscriptions, disputes), PayTabs, HyperPay, Moyasar, Tap, Tabby, Tamara, Checkout.com, Amazon Payment Services, MyFatoorah, Geidea, JazzCash, Easypaisa |
| Test users that reply | Auto-reply rules and LLM personas answer emails, SMS and WhatsApp messages | Rules; OpenAI, Anthropic, Google, OpenRouter, Ollama, mock providers |
| MCP tester | Connect to your own MCP server, call tools, run checks | MCP (streamable HTTP) |
| AI chat | Chat agents with stubyard tools and your MCP servers, saved prompts, expectations | OpenAI, Anthropic, Google, OpenRouter, Ollama |
| Push notifications | Pushes land in the inbox of the test user who owns the device token | FCM HTTP v1, APNs (HTTP/2) |
| LLM APIs | Scripted replies, tool calls, faults, record-to-mock | OpenAI, Anthropic |
| Scheduling and time | Send later, scheduled jobs, per-feature clock offsets | — |
| Test runs | Isolated users and data per test worker, JSON / HTML run reports | `X-Hub-Run` header or `/run/<key>/…` URL prefix |

## Quick start

**Prebuilt image** (published by the release workflow to GitHub Container Registry; pin a version such as
`:0.13.0` or follow `:latest`):

```bash
docker run -d --name stubyard \
  -p 127.0.0.1:4000:4000 -p 127.0.0.1:4443:4443 -p 127.0.0.1:1025:1025 -p 127.0.0.1:2197:2197 \
  -v stubyard-data:/data --add-host=host.docker.internal:host-gateway \
  ghcr.io/imibrar/stubyard:0.13.0      # or ghcr.io/imibrar/stubyard:latest
```

Ports: 4000 dashboard / API / provider endpoints (HTTP), 4443 the same over HTTPS, 1025 SMTP, 2197 APNs (HTTP/2).

**Docker Compose** (from a clone of this repository; builds the image):

```bash
git clone https://github.com/imibrar/stubyard.git && cd stubyard
docker compose up -d --build
```

**From source** (Node 24, no Docker for the app itself; needs the [Mailpit](https://github.com/axllent/mailpit) binary,
or set `STUBYARD_MAILPIT_URL` to an external Mailpit):

```bash
npm ci && npm run build
cd server && STUBYARD_MAILPIT_BIN=/path/to/mailpit npm start
```

Then:

1. Open http://localhost:4000 and create a project (e.g. `hyper`), generating a few test users.
2. Open **Connect your app** in the project for copy-paste settings (Laravel, Node, Django, Spring, `.env`).
3. Trigger an email or SMS from your app; it shows up in the test user's inbox with the code extracted.

## Point your app at it

The examples use project `hyper`. From another container on stubyard's Docker network, use host `stubyard` instead of
`localhost`; from other containers, `host.docker.internal`.

**Email (SMTP)**: any password works; the username selects the project.

```bash
SMTP_HOST=localhost SMTP_PORT=1025 SMTP_USER=hyper SMTP_PASSWORD=x SMTP_SECURE=false
```

**Twilio SMS**: add a Twilio instance, then point the SDK at it.

```bash
curl -s -X POST http://localhost:4000/api/projects/hyper/providers -H 'content-type: application/json' \
  -d '{"preset":"twilio","slug":"sms-primary"}'
# SDK base URL instead of https://api.twilio.com:
#   http://localhost:4000/mock/hyper/sms-primary
```

**Stripe Checkout**: add a payment instance; the response includes test keys and a ready `.env` block.

```bash
curl -s -X POST http://localhost:4000/api/projects/hyper/payment-instances -H 'content-type: application/json' \
  -d '{"preset":"stripe-checkout","config":{"webhookUrl":"http://host.docker.internal:3000/webhooks/stripe"}}'
# stripe-python: stripe.api_base = "http://localhost:4000/pay/hyper/stripe"
```

**S3** (AWS SDK v3): add a storage instance, then use a path-style endpoint.

```bash
curl -s -X POST http://localhost:4000/api/projects/hyper/storage -H 'content-type: application/json' \
  -d '{"preset":"s3","slug":"s3"}'
```

```js
new S3Client({ endpoint: 'http://localhost:4000/storage/hyper/s3', forcePathStyle: true, region: 'us-east-1',
  credentials: { accessKeyId: 'stubyard', secretAccessKey: 'stubyard-secret' } });
```

**Read the code back**: the wait API blocks until a matching message arrives (HTTP 408 on timeout).

```bash
curl -s "http://localhost:4000/api/projects/hyper/messages/wait?user=admin&otp=1&timeout=30" | jq -r .otp
```

For HTTPS (`https://localhost:4443`), trust stubyard's local CA once: `curl -o stubyard-ca.crt http://localhost:4000/api/ca.crt`
(the dashboard's **HTTPS setup** page has commands per OS and language).

If stubyard runs in Docker and your app runs on a Linux host bound to `127.0.0.1`, callbacks cannot reach it: start the
app on `0.0.0.0` and use `http://host.docker.internal:<port>`, or use
[`deploy/docker-compose.host-network.yml`](deploy/docker-compose.host-network.yml). The doctor
(`GET /api/projects/hyper/doctor`) checks every configured callback URL from inside stubyard.

## Use in tests and CI

[`docs/CI.md`](docs/CI.md) covers GitHub Actions, seeding projects with `STUBYARD_SEED` and the wait API.
The client helpers in [`packages/client`](packages/client) (`@stubyard/client`, not on npm yet: build it with
`npm run build -w @stubyard/client` and depend on the folder) give each test worker an isolated run:

```ts
import { withRun } from '@stubyard/client/runs';

await withRun({ project: 'hyper', users: [{ role: 'customer' }] }, async (run) => {
  await page.setExtraHTTPHeaders(run.headers);              // app → stubyard calls carry X-Hub-Run
  const customer = run.user('customer');
  // … sign up as customer.email in the app …
  const msg = await run.waitForMessage({ user: customer.email!, channel: 'email' });
  console.log(msg.otp);
});
```

## Use with AI agents

- MCP server: `claude mcp add --transport http stubyard http://localhost:4000/mcp` (any MCP client that speaks
  streamable HTTP works).
- Agent guide: `GET http://localhost:4000/api/agent-guide`, source [`docs/AGENT_GUIDE.md`](docs/AGENT_GUIDE.md).
- Paste [`deploy/AGENTS.snippet.md`](deploy/AGENTS.snippet.md) into your app's `AGENTS.md` / `CLAUDE.md`.

## Configuration

Main environment variables (the full list is in [`server/src/config.ts`](server/src/config.ts)). The pre-rename
`DEVHUB_*` names still work as fallbacks.

| Variable | Default | Purpose |
|---|---|---|
| `STUBYARD_HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Listen address |
| `STUBYARD_HTTP_PORT` / `STUBYARD_HTTPS_PORT` / `STUBYARD_SMTP_PORT` | `4000` / `4443` / `1025` | Listener ports |
| `STUBYARD_APNS_PORT` | `2197` | APNs HTTP/2 listener (`0` disables) |
| `STUBYARD_DATA_DIR` | `/data` (image) | SQLite DB, mail store, CA and certificates |
| `STUBYARD_TLS_NAMES` | — | Extra hostnames / IPs for the HTTPS certificate |
| `STUBYARD_PUBLIC_URL` | `https://localhost:4443` | Browser-facing base for login and payment pages (e.g. behind an SSH tunnel) |
| `STUBYARD_OUTBOUND_ALLOW` | local / private hosts | Hosts stubyard may call; `+a.com` adds, a list replaces, `*` allows all |
| `STUBYARD_OUTBOUND_INSECURE_TLS` | off | `1` accepts self-signed certificates when calling your app |
| `STUBYARD_ALLOWED_HOSTS` | — | Extra Host / Origin names allowed for `/api` and `/mcp` (`*` disables the check) |
| `STUBYARD_SEED` | — | Project export (`.json` or a directory) imported at start |
| `STUBYARD_LOG_RETENTION_DAYS` / `STUBYARD_MAX_DB_MB` | `7` / `500` | Traffic log retention |
| `STUBYARD_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENROUTER_API_KEY`, `STUBYARD_OLLAMA_URL` | — | Optional AI chat providers |

## Ports

| Port | What |
|---|---|
| 4000 | Dashboard, REST API, `/mcp`, provider endpoints (`/mock`, `/hook`, `/pay`, `/storage`, `/auth`) over HTTP |
| 4443 | The same over HTTPS (local CA) |
| 1025 | SMTP |
| 2197 | APNs HTTP/2 |

## Security

stubyard is for local development and testing only. Its API has no login, so keep the ports bound to `127.0.0.1`
(the default in the compose files) and don't expose it to a network you don't trust. Never use real API keys or real
card numbers with it; it rejects live Stripe keys and real card numbers, but don't rely on that.

## Documentation

- [`docs/GUIDE.md`](docs/GUIDE.md): user guide, how stubyard works and a short walkthrough per feature (start here)
- [`CHANGELOG.md`](CHANGELOG.md): what changed in each release
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md): working on stubyard itself: requirements, running from source, layout, adding a feature, releases
- [`docs/AGENT_GUIDE.md`](docs/AGENT_GUIDE.md): every feature and API with examples (written for AI agents, useful for people)
- [`docs/CI.md`](docs/CI.md): CI setup
- [`docs/PLAN.md`](docs/PLAN.md): roadmap and progress
- [`docs/CONCEPT.md`](docs/CONCEPT.md): original concept and scope
- [`deploy/`](deploy): compose files, app example, portable bundle (`deploy/make-bundle.sh`)

## Development

Node doesn't need to be installed on the host: `scripts/npm.sh` runs npm in a `node:24` container that includes
the Mailpit binary.

```bash
./scripts/npm.sh install          # install dependencies
./scripts/npm.sh run typecheck
./scripts/npm.sh test             # unit + end-to-end tests (real Mailpit, SMTP, HTTPS, provider SDKs)
./scripts/npm.sh run build
./scripts/dev.sh                  # watch mode: API on :4000, dashboard on http://localhost:5173
```

Layout: `server/` (Fastify, Node's built-in SQLite, SMTP front), `web/` (React + Vite dashboard),
`packages/client/` (test helpers), `docker/` (dev image), `deploy/` (compose files and bundle).

## License

[MIT](LICENSE)
