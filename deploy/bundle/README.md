# devhub — portable bundle

Everything needed to run devhub on any machine with Docker. No source code or build step needed.

| File | Purpose |
|---|---|
| `devhub-image.tar.gz` | The prebuilt devhub image (linux/amd64) |
| `docker-compose.yml` | Runs the image: dashboard `:4000`, HTTPS `:4443`, SMTP `:1025`, data in the `devhub-data` volume |
| `start.ps1` / `start.sh` | Load the image (first time) and start devhub (Windows / macOS + Linux) |
| `AGENT_GUIDE.md` | Features and full API guide for AI agents (and humans) |
| `AGENTS.snippet.md` | Short block to paste into your app's `CLAUDE.md` / `AGENTS.md` |
| `docker-compose.app-example.yml` | How to connect your app's containers to devhub |

## Requirements

- Docker Desktop (Windows / macOS) or Docker Engine + Compose v2 (Linux), running.
- Free ports 4000, 4443 and 1025 (change them via `DEVHUB_HTTP_PORT` / `DEVHUB_HTTPS_PORT` / `DEVHUB_SMTP_PORT`).
- The image is `linux/amd64`. On Apple Silicon Macs it runs under Docker Desktop's emulation, which is slower but works.

## Start

**Windows (PowerShell):**

```powershell
cd devhub-bundle
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

**macOS / Linux:**

```bash
cd devhub-bundle
./start.sh
```

Or manually:

```bash
docker load -i devhub-image.tar.gz      # first time only
docker compose up -d
```

Open **http://localhost:4000**.

## Everyday commands (run inside this folder)

```bash
docker compose ps                 # status (should say "healthy")
docker compose logs -f devhub     # logs
docker compose down               # stop (data is kept)
docker compose up -d              # start again
docker compose down -v            # stop AND delete all data (projects, emails, logs, HTTPS CA)
```

## Updating to a newer bundle

Replace the folder contents with the new bundle, then run `start.ps1 -Reload` (Windows) or `./start.sh --reload`.
Your data in the `devhub-data` volume is kept.

## What's new in 0.3

- Webhooks: receive with schema checks, send signed webhooks (HMAC / Stripe), sequences, replay.
- Email APIs: SendGrid, Mailgun, Amazon SES, Generic, with bounce / complaint / delivered events.
- API mocks with live scenarios, export/import of project settings, automatic log clean-up, System page.

## What's new in 0.2

- New dashboard: pinned users per role (press 1–9), a per-user workspace (credentials, latest code and link, 2FA,
  all channels), Ctrl/⌘+K command palette, dark/light theme, desktop notifications for new codes.
- SMS and WhatsApp simulators: Twilio, Vonage, Meta WhatsApp Cloud API, Twilio WhatsApp, Generic. Includes delivery
  reports and replies from test users.
- Scenario rules per user or per provider (fail next N, provider down, 429, timeout, delay, email bounces…).
- Wait API (`/messages/wait`) and an MCP server at `http://localhost:4000/mcp` for AI agents.

Updating from 0.1 keeps all data (projects, users, emails); the database upgrades itself on start.

## First steps

1. Open http://localhost:4000 → **New project** (e.g. "Hyper", generate 1 admin + 9 customers).
2. Open the project's **Connect your app** tab and copy the SMTP settings into your app
   (host `localhost`, port `1025`, username = project slug, any password).
3. Send an email from your app. It appears in the matching test user's inbox, with the OTP pinned.
4. **Authenticator** tab: paste a 2FA secret key from your app to get live codes.
5. **HTTPS setup** (left menu): download the CA certificate if your SDKs need `https://`.

In `AGENT_GUIDE.md`, §2 shows the start command used in the source repository. With this bundle, use the commands
above instead. Everything else in the guide applies unchanged.
