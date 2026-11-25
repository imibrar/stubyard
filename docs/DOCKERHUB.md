<p align="center"><img src="https://raw.githubusercontent.com/imibrar/stubyard/main/web/public/brand/stubyard-logo.svg" width="280" alt="stubyard"></p>

# stubyard

Fake email, SMS, WhatsApp, payment, storage and login providers for local development and tests, in one Docker container.

Your app keeps using its real SDKs (Twilio, SendGrid, Stripe, the AWS SDK, OAuth libraries…), pointed at stubyard
instead of the real service. Every message lands in a test user's inbox with the OTP extracted, and every request in or
out is logged. You create a project per app, a few test users and provider instances, then point your app at their URLs.

Source and full documentation: https://github.com/imibrar/stubyard

## Quick start

```bash
docker run -d --name stubyard \
  -p 127.0.0.1:4000:4000 -p 127.0.0.1:4443:4443 -p 127.0.0.1:1025:1025 -p 127.0.0.1:2197:2197 \
  -v stubyard-data:/data --add-host=host.docker.internal:host-gateway \
  imibrar/stubyard:latest
```

Then:

1. Open http://localhost:4000 and create a project (e.g. `hyper`), generating a few test users.
2. Open **Connect your app** in the project for copy-paste settings (Laravel, Node, Django, Spring, `.env`).
3. Trigger an email or SMS from your app; it shows up in the test user's inbox with the code extracted.

The same image is published as `ghcr.io/imibrar/stubyard` with the same tags.

## Docker Compose

```yaml
services:
  stubyard:
    image: imibrar/stubyard:latest
    container_name: stubyard
    hostname: stubyard
    restart: unless-stopped
    ports:
      # Bound to 127.0.0.1: only this machine can reach stubyard.
      - "127.0.0.1:4000:4000"   # dashboard, REST API, provider endpoints
      - "127.0.0.1:4443:4443"   # the same over HTTPS (local CA)
      - "127.0.0.1:1025:1025"   # SMTP
      - "127.0.0.1:2197:2197"   # fake APNs (HTTP/2)
    environment:
      STUBYARD_LOG_LEVEL: info
    volumes:
      - stubyard-data:/data     # SQLite DB, stored emails and files, HTTPS CA + certificate
    extra_hosts:
      # Lets stubyard call apps running directly on your machine (http://host.docker.internal:<port>)
      - "host.docker.internal:host-gateway"
    networks: [stubyard]

volumes:
  stubyard-data:

networks:
  # Attach app containers to this network and reach stubyard at http://stubyard:4000 / smtp stubyard:1025.
  stubyard:
    name: stubyard
```

`docker compose down` keeps the data; `docker compose down -v` deletes it, including the HTTPS CA.

For a shared team server (sign-in, Postgres, HTTPS, firewall, backups) see
[DEPLOY-SERVER.md](https://github.com/imibrar/stubyard/blob/main/docs/DEPLOY-SERVER.md).

## What it fakes

| Feature | Speaks |
|---|---|
| Email | SMTP; SendGrid, Mailgun, Amazon SES, Resend, Postmark, Brevo, Mailjet and Mailchimp Transactional (Mandrill) APIs and their event webhooks |
| SMS / WhatsApp | Twilio (Messaging, Verify), Vonage (SMS, Verify), Infobip, Plivo, Sinch, Telnyx, Amazon SNS, Saudi / GCC SMS (Unifonic, Taqnyat, Msegat, 4Jawaly, OurSMS), Meta WhatsApp Cloud API (with message templates), 360dialog, Infobip WhatsApp, Gupshup, Unifonic WhatsApp, Twilio WhatsApp, generic API |
| 2FA / TOTP | RFC 6238 authenticator-app codes for test users |
| Webhooks | Receive with JSON Schema checks; send signed templates (HMAC-SHA256, Stripe, PayTabs, PayPal) |
| API mocks | Any HTTP API at `/mock/<project>/api/<path>`, with rules, templates and scenarios |
| Login providers | OAuth 2 / OIDC: Google, Microsoft, Apple, GitHub, GitLab, Facebook, LinkedIn, Slack, Discord, X, generic OIDC |
| File storage | Amazon S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2, MinIO, Wasabi, Google Cloud Storage, Azure Blob, Cloudinary, Supabase Storage |
| Payments | Stripe Checkout, PayPal, PayTabs, HyperPay, Moyasar, Tap, Tabby, Tamara, Checkout.com, Amazon Payment Services, MyFatoorah, Geidea, JazzCash, Easypaisa |
| Push notifications | FCM HTTP v1, APNs (HTTP/2) |
| LLM APIs | OpenAI, Anthropic: scripted replies, tool calls, faults, record-to-mock |
| Test users that reply | Auto-reply rules and LLM personas for email, SMS and WhatsApp |
| Also | MCP tester, AI chat, scheduling and clock offsets, isolated test runs, storyboards (Chrome extension) |

Any provider can be made to fail on purpose with rules. Callbacks (delivery reports, webhooks, replies) go back to
your app.

## Ports

| Port | What |
|---|---|
| 4000 | Dashboard, REST API, `/mcp`, provider endpoints (`/mock`, `/hook`, `/pay`, `/storage`, `/auth`) over HTTP |
| 4443 | The same over HTTPS, with stubyard's own local CA |
| 1025 | SMTP (any password; the username selects the project) |
| 2197 | APNs HTTP/2 |

To use HTTPS, trust the local CA once: `curl -o stubyard-ca.crt http://localhost:4000/api/ca.crt` (the dashboard's
**HTTPS setup** page has commands per OS and language).

## Volume

`/data` holds everything stubyard keeps: the SQLite database (projects, test users, inboxes, traffic log), stored
emails and files, and the HTTPS CA and certificate. Mount a named volume there so data and the CA survive upgrades.
The container runs as the `node` user, which owns `/data`.

A health check calls `GET /api/system` on port 4000 every 15 seconds.

## Environment variables

The full list is in
[server/src/config.ts](https://github.com/imibrar/stubyard/blob/main/server/src/config.ts). The older `DEVHUB_*`
names still work as fallbacks.

| Variable | Default | Purpose |
|---|---|---|
| `STUBYARD_PUBLIC_URL` | — (then `https://localhost:<host HTTPS port>`) | Base URL the browser uses to reach stubyard (login and payment pages), e.g. behind an SSH tunnel or on a server |
| `STUBYARD_HOST_HTTP_PORT` / `STUBYARD_HOST_HTTPS_PORT` | port in `STUBYARD_PUBLIC_URL`, else `4000` / `4443` | Host ports the container is published on (`-p 5500:4000`), used in the `http(s)://localhost:…` URLs given to apps on the host. 0.17.2 and later |
| `STUBYARD_TLS_NAMES` | — | Extra hostnames / IPs for the HTTPS certificate, comma separated |
| `STUBYARD_ALLOWED_HOSTS` | — | Extra Host / Origin names allowed for `/api` and `/mcp` (`*` disables the check) |
| `STUBYARD_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `STUBYARD_DATA_DIR` | `/data` | SQLite DB, mail store, CA and certificates |
| `STUBYARD_OUTBOUND_ALLOW` | local / private hosts | Hosts stubyard may call; `+a.com` adds, a list replaces, `*` allows all |
| `STUBYARD_OUTBOUND_INSECURE_TLS` | off | `1` accepts self-signed certificates when calling your app |
| `STUBYARD_SMTP_STARTTLS` | `0` | `1` advertises SMTP STARTTLS (clients must trust the stubyard CA) |
| `STUBYARD_SEED` | — | Project export (`.json` file or a directory) imported at start if the project does not exist yet |
| `STUBYARD_LOG_RETENTION_DAYS` / `STUBYARD_MAX_DB_MB` | `7` / `500` | Traffic log retention |
| `STUBYARD_ADMIN_EMAIL` + `STUBYARD_ADMIN_PASSWORD_HASH` | — | Turns on sign-in (Single admin mode). `STUBYARD_ADMIN_PASSWORD` (plain text) works instead of the hash, not both |
| `STUBYARD_DATABASE_URL` | — | Postgres URL: Teams mode (users, project roles, audit log); needs the admin above |
| `STUBYARD_SESSION_TTL_HOURS` | `168` | Sign-in session length |
| `STUBYARD_COOKIE_SECURE` | on when `STUBYARD_PUBLIC_URL` is https | Secure flag on the session cookie |
| `STUBYARD_TRUST_PROXY` | off | Behind a reverse proxy: `true`, a hop count, or the proxies' IPs / CIDRs |
| `STUBYARD_AUDIT_RETENTION_DAYS` | `365` | Audit log retention in Teams mode (`0` = forever) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENROUTER_API_KEY`, `STUBYARD_OLLAMA_URL` | — | Optional AI chat providers |

Generate a password hash with:

```bash
docker run --rm -it imibrar/stubyard:latest node dist/access/hash-password.js
```

## Tags and platforms

- `latest`: the newest release.
- `X.Y.Z` (e.g. `0.17.3`): one release. Pin a version on servers and upgrade on purpose; database migrations run
  automatically at start, so back up `/data` first.
- Platforms: `linux/amd64` and `linux/arm64`.

What changed in each release: [CHANGELOG.md](https://github.com/imibrar/stubyard/blob/main/CHANGELOG.md).

## Connecting apps

- **Other containers on the same Docker network**: use host `stubyard`, e.g. `http://stubyard:4000` and SMTP
  `stubyard:1025`.
- **Apps running on the host**: use `localhost` and the published ports. stubyard calls them back at
  `http://host.docker.internal:<port>` (needs `--add-host=host.docker.internal:host-gateway` on Linux). On Linux, an
  app bound to `127.0.0.1` cannot be reached from the container: start it on `0.0.0.0`. The doctor
  (`GET /api/projects/<project>/doctor`) checks every configured callback URL from inside stubyard.
- **AI agents**: MCP server at `/mcp`, e.g. `claude mcp add --transport http stubyard http://localhost:4000/mcp` (any
  client that speaks streamable HTTP works). Agent guide at `GET http://localhost:4000/api/agent-guide`.
- **Tests and CI**: the wait API blocks until a matching message arrives, e.g.
  `curl -s "http://localhost:4000/api/projects/hyper/messages/wait?user=admin&otp=1&timeout=30"`. See
  [CI.md](https://github.com/imibrar/stubyard/blob/main/docs/CI.md).

## Security

stubyard is for development and testing only. By default its API has no login, so keep the ports bound to
`127.0.0.1` and don't expose it to a network you don't trust. To share one instance with a team, turn on sign-in
(Single admin or Teams mode). Never use real API keys or real card numbers with it.

## Links

- Source: https://github.com/imibrar/stubyard
- User guide: https://github.com/imibrar/stubyard/blob/main/docs/GUIDE.md
- Agent guide (every feature and API): https://github.com/imibrar/stubyard/blob/main/docs/AGENT_GUIDE.md
- Team server setup: https://github.com/imibrar/stubyard/blob/main/docs/DEPLOY-SERVER.md
- CI setup: https://github.com/imibrar/stubyard/blob/main/docs/CI.md
- Changelog: https://github.com/imibrar/stubyard/blob/main/CHANGELOG.md
- Issues: https://github.com/imibrar/stubyard/issues

## License

MIT: https://github.com/imibrar/stubyard/blob/main/LICENSE
