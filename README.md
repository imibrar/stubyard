# devhub — Developer Testing Hub

A local, single-container tool for testing **email, SMS, WhatsApp, 2FA codes, webhooks and external APIs** across multiple projects.
Point your app's SMTP settings and provider base URLs at devhub. Nothing is delivered for real. Every message lands in a
test user's inbox, and every request in or out is logged.

- Concept and scope: [`developer_testing_hub_concept.md`](developer_testing_hub_concept.md)
- Development plan and progress: [`docs/PLAN.md`](docs/PLAN.md)
- **For AI agents:** [`docs/AGENT_GUIDE.md`](docs/AGENT_GUIDE.md) covers features, every API with examples, and recipes.
  A running devhub serves it at `http://localhost:4000/api/agent-guide`, with the addresses you reached it on.
  Paste [`deploy/AGENTS.snippet.md`](deploy/AGENTS.snippet.md) into your app's `CLAUDE.md` / `AGENTS.md`.
- CI (GitHub Actions, seed file, wait API): [`docs/CI.md`](docs/CI.md)
- Docker: [`Dockerfile`](Dockerfile) · [`deploy/docker-compose.yml`](deploy/docker-compose.yml) (standalone) ·
  [`deploy/docker-compose.app-example.yml`](deploy/docker-compose.app-example.yml) (connect your app's containers) ·
  [`deploy/docker-compose.host-network.yml`](deploy/docker-compose.host-network.yml) (Linux, host networking)
- Portable bundle (prebuilt image + compose + guide, no source): [`deploy/bundle`](deploy/bundle); refresh its docs with
  `deploy/make-bundle.sh` (`--image` / `--tar` also save the image and pack the tarball)

## Quick start

```bash
docker compose up -d --build
```

| What | Where |
|---|---|
| Dashboard | http://localhost:4000 |
| HTTPS (local CA) | https://localhost:4443 |
| SMTP | `localhost:1025` |

1. Open the dashboard and **create a project** (e.g. *Hyper*). You can generate test users at the same time (e.g. 1 admin + 9 customers).
2. Open **Connect your app** in the project for copy-paste settings (Laravel, Node, Django, Spring, generic `.env`).
3. Send an email from your app. It appears in the matching test user's inbox, with the OTP and links extracted.

Without Docker Compose:

```bash
docker build -t devhub .
docker run -d --name devhub -p 127.0.0.1:4000:4000 -p 127.0.0.1:4443:4443 -p 127.0.0.1:1025:1025 \
  -v devhub-data:/data --add-host=host.docker.internal:host-gateway devhub
```

The ports are published on `127.0.0.1` only: devhub's API has no login, so other machines shouldn't reach it. Drop the
`127.0.0.1:` prefix only on a trusted network. Inside the container devhub listens on `0.0.0.0` (the image sets
`DEVHUB_HOST=0.0.0.0`); run outside Docker (`npm start`), it listens on `127.0.0.1` unless you set `DEVHUB_HOST`.

### Linux: devhub calling your app

devhub calls your app back (delivery reports, inbound SMS/WhatsApp, email events, webhooks). From inside the container,
`localhost` is devhub itself. Use one of these:

| Your app runs… | Callback URL | Notes |
|---|---|---|
| in a container on the `devhub` network | `http://app:3000/...` (service name) | see `deploy/docker-compose.app-example.yml` |
| on the host, listening on `0.0.0.0` | `http://host.docker.internal:3000/...` | needs `--add-host=host.docker.internal:host-gateway` (the compose file has it); a firewall (ufw) may have to allow the Docker bridge |
| on the host, listening on `127.0.0.1` only | `http://localhost:3000/...` | only with host networking: `docker compose -f deploy/docker-compose.host-network.yml up -d` (Linux) |

On Docker Desktop (macOS / Windows), `host.docker.internal` also reaches apps that listen on 127.0.0.1.
**Connect your app → Check the connection** (or `GET /api/projects/<p>/doctor`) tests every configured URL from inside
devhub and explains failures, e.g. `ECONNREFUSED to host.docker.internal:3000: is your app listening on 0.0.0.0?`.

## Email

| Setting | Value |
|---|---|
| Host | `localhost` (or `devhub` / `host.docker.internal` from containers) |
| Port | `1025` |
| Username | project slug, e.g. `hyper`, or `hyper.<instance>` for a specific email provider instance |
| Password | anything |
| Encryption | none |

If your app can't authenticate, devhub picks the project from the recipient (the project that has a test user with
that address), or uses the only project if there is just one.

## SMS and WhatsApp

Add a provider instance (Twilio, Vonage, Meta WhatsApp Cloud API, Twilio WhatsApp or a configurable Generic API) and
point the SDK's base URL at `https://localhost:4443/mock/<project>/<instance>`. Messages land in the test user's
timeline; delivery reports (`sent` → `delivered` / `failed`) go to your status-callback URL in the provider's format,
and test users can reply (inbound webhooks). See **Connect your app** in the dashboard for SDK snippets.

## Scenario rules

Make things fail on purpose, per test user or per provider instance, changeable at any time: fail / reject / rate
limit / timeout / drop / delay / blocked / random failures / provider down / slow, plus email bounces (hard, soft,
deferred, delayed DSN) and spam complaints. Durations: always, next N, for X minutes, after N normal messages.
One-off: `X-Hub-Scenario: fail:30003:Unreachable` request header.

## Webhooks, email APIs and API mocks

- **Webhooks**: receive at `/hook/<project>/<path>` with JSON Schema checks (or infer a schema from a sample), and
  send signed webhooks (HMAC, Stripe-style, Basic) to your app from templates, as a test user, in sequences; replay
  anything from the traffic log.
- **Email APIs**: SendGrid, Mailgun, Amazon SES and a Generic preset at `/mock/<project>/<instance>/…`, with
  delivered / bounce / complaint event webhooks driven by the same scenario rules.
- **API mocks**: `/mock/<project>/api/<path>` with rules, templated responses and live-switchable scenarios.
- **Housekeeping**: logs kept 7 days / 500 MB, per-project auto-reset, reset all rules, export/import project config
  as JSON, factory reset (System page).

## For AI agents

- `GET /api/projects/<p>/messages/wait?user=admin&otp=1` blocks until a code arrives.
- MCP server at `http://localhost:4000/mcp`: `claude mcp add --transport http devhub http://localhost:4000/mcp`.
  Tools for codes, messages, scenario rules, webhooks, API mocks, providers, project setup and `doctor`.
- Full guide: `GET /api/agent-guide` (Markdown, host and ports rewritten to the ones you used, so it also works
  through an SSH tunnel), source [`docs/AGENT_GUIDE.md`](docs/AGENT_GUIDE.md). The dashboard links to it (sidebar → Agent guide).

## HTTPS

devhub creates a local certificate authority on first start (stored in the `/data` volume). Download it from
**HTTPS setup** in the dashboard, or from `http://localhost:4000/api/ca.crt`, and trust it once. The page has commands
for Linux, macOS, Windows, Node, PHP, Python, Java and Docker. To add hostnames to the certificate, set
`DEVHUB_TLS_NAMES=myhost.local,10.0.0.5`.

## Traffic log

Every request to `/mock/…` and `/hook/…`, every request to an unknown URL (returned as a 404), and every SMTP
transaction (including rejected logins and recipients) is recorded **as soon as it arrives**, then updated with the
response. Each HTTP response carries an `X-Hub-Request-Id` header that you can look up in the dashboard. Dashboard
and API calls (`/api/…`) are not logged.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DEVHUB_HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Listen address |
| `DEVHUB_HTTP_PORT` / `DEVHUB_HTTPS_PORT` / `DEVHUB_SMTP_PORT` | `4000` / `4443` / `1025` | Listener ports |
| `DEVHUB_DATA_DIR` | `/data` (image) | SQLite DB, Mailpit store, certificates |
| `DEVHUB_TLS_NAMES` | — | Extra hostnames/IPs for the HTTPS certificate |
| `DEVHUB_MAX_LOG_BODY_BYTES` | `1048576` | Max body stored per log entry (larger bodies are truncated and flagged) |
| `DEVHUB_MAX_EMAIL_BYTES` | `26214400` | Max accepted email size |
| `DEVHUB_SMTP_STARTTLS` | off | Set to `1` to advertise STARTTLS (clients then need to trust the CA) |
| `DEVHUB_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `DEVHUB_CALLBACK_DELAY_MS` | `1500` | Time until the final delivery report (`sent` goes out at a third of it) |
| `DEVHUB_TIMEOUT_HOLD_MS` | `120000` | How long a `timeout` rule holds a request before closing it |
| `DEVHUB_LOG_RETENTION_DAYS` | `7` | Traffic logs older than this are deleted |
| `DEVHUB_MAX_DB_MB` | `500` | Above this the oldest logs are deleted and the database is compacted |
| `DEVHUB_MAINTENANCE_INTERVAL_MS` | `600000` | How often the clean-up runs |
| `DEVHUB_OUTBOUND_ALLOW` | local / private hosts | Hosts devhub may call (callbacks, events, webhooks). Default: `localhost`, `host.docker.internal`, `*.local`, `*.test`, `*.internal`, private IP ranges, docker service names. `+a.com,*.corp` adds, a list without `+` replaces, `*` allows everything. Blocked calls are logged as `blocked_by_allowlist` |
| `DEVHUB_OUTBOUND_INSECURE_TLS` | off | `1` = accept self-signed certificates when calling your app over HTTPS, or a host list (`myapp.test,*.local`) |
| `DEVHUB_SEED` | — | A project export (`.json`) or a directory of them, imported at start when the slug doesn't exist yet (see [`docs/CI.md`](docs/CI.md)) |
| `DEVHUB_ALLOWED_HOSTS` | — | Extra hostnames allowed in the Host / Origin of `/api` and `/mcp` calls (`*` disables the check) |
| `DEVHUB_AGENT_GUIDE` | `docs/AGENT_GUIDE.md` | Markdown file served at `/api/agent-guide` |

## Development

Node doesn't need to be installed on the host. The scripts run everything in a `node:24` container that includes the
Mailpit binary.

```bash
./scripts/npm.sh install     # install dependencies
./scripts/npm.sh test        # unit + end-to-end tests (real Mailpit, SMTP, HTTPS, SSE, real provider SDKs)
./scripts/npm.sh run test:sdk -w server   # only the SDK conformance suite (DEVHUB_SDK_TESTS=0 skips it)
./scripts/dev.sh             # watch mode: API on :4000, dashboard on http://localhost:5173
```

Layout: `server/` (Fastify + Node's built-in SQLite + SMTP front), `web/` (React + Vite), `docker/` (dev image).
