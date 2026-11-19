<!-- Paste this section into your app's CLAUDE.md / AGENTS.md. Replace "hyper" with this app's devhub project slug. -->

## Local testing with devhub

This app sends email (and later SMS/WhatsApp) to **devhub**, a local testing hub, during development. Nothing is
delivered for real.

- Dashboard and REST API: `http://localhost:4000` (check it's up: `curl -sf http://localhost:4000/api/system`)
- devhub project slug for this app: **`hyper`** (SMTP `localhost:1025`, username `hyper`, any password)
- Full API guide: `<path-to-devhub>/docs/AGENT_GUIDE.md`

Common tasks:

```bash
# Wait for the next code a user receives (email, SMS or WhatsApp) — call right after triggering it
curl -s "http://localhost:4000/api/projects/hyper/messages/wait?user=admin&otp=1&timeout=30" | jq -r .otp

# Latest code a user received (user = id, email, phone, name or role)
curl -s "http://localhost:4000/api/projects/hyper/users/admin/latest?otp=1" | jq -r .otp

# Verification / reset link from the latest email
curl -s "http://localhost:4000/api/projects/hyper/messages?q=admin@hyper.test&limit=1" | jq -r '.[0].links[0]'

# Current authenticator-app (2FA) code
curl -s "http://localhost:4000/api/projects/hyper/authenticators/code?label=Admin%202FA" | jq -r .code

# Test users (email / phone to use in test data)
curl -s http://localhost:4000/api/projects/hyper/users | jq -r '.[] | "\(.role)\t\(.email)\t\(.phone)"'

# Something didn't arrive? Check what devhub received
curl -s "http://localhost:4000/api/logs?project=hyper&limit=10"

# Make the next SMS to customer1 fail / take the primary SMS provider down (then reset)
curl -s -X POST http://localhost:4000/api/projects/hyper/users/customer1/rules -H 'content-type: application/json' -d '{"channel":"sms","action":"fail","count":1}'
curl -s -X POST http://localhost:4000/api/projects/hyper/providers/sms-primary/rules/preset/down-10m
curl -s -X DELETE http://localhost:4000/api/projects/hyper/providers/sms-primary/rules

# Clean inbox before a test run (keeps users and settings)
curl -s -X POST http://localhost:4000/api/projects/hyper/reset
```

MCP: devhub also offers these as tools at `http://localhost:4000/mcp` (`claude mcp add --transport http devhub http://localhost:4000/mcp`).

Rules: use test-user addresses in test data. Read OTPs and 2FA codes from devhub, never from a real phone or mailbox.
Ask before deleting a devhub project or trusting its HTTPS CA system-wide.
