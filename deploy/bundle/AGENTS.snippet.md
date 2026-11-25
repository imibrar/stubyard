<!-- Paste this section into your app's CLAUDE.md / AGENTS.md. Replace "hyper" with this app's stubyard project slug. -->

## Local testing with stubyard

This app sends email, SMS and WhatsApp (and calls provider APIs) to **stubyard**, a local testing hub, during development. Nothing is
delivered for real.

- Dashboard and REST API: `http://localhost:4000` (check it's up: `curl -sf http://localhost:4000/api/system`)
- stubyard project slug for this app: **`hyper`** (SMTP `localhost:1025`, username `hyper`, any password)
- Full API guide: `curl -s http://localhost:4000/api/agent-guide` (Markdown, served by stubyard)

Common tasks:

```bash
# Wait for the next code a user receives (email, SMS or WhatsApp): take a cursor BEFORE triggering the action,
# then wait after it (never returns the previous code after "resend")
CUR=$(curl -s "http://localhost:4000/api/projects/hyper/messages/cursor?user=admin" | jq -r .cursor)
curl -s "http://localhost:4000/api/projects/hyper/messages/wait?user=admin&otp=1&after=$CUR&timeout=30" | jq -r .otp

# Latest code a user received (user = id, email, phone, name or role)
curl -s "http://localhost:4000/api/projects/hyper/users/admin/latest?otp=1" | jq -r .otp

# Verification / reset link from the latest email
curl -s "http://localhost:4000/api/projects/hyper/messages?q=admin@hyper.test&limit=1" | jq -r '.[0].links[0]'

# Current authenticator-app (2FA) code
curl -s "http://localhost:4000/api/projects/hyper/authenticators/code?label=Admin%202FA" | jq -r .code

# Test users (email / phone to use in test data)
curl -s http://localhost:4000/api/projects/hyper/users | jq -r '.[] | "\(.role)\t\(.email)\t\(.phone)"'

# Something didn't arrive? Check what stubyard received
curl -s "http://localhost:4000/api/logs?project=hyper&limit=10"

# Make the next SMS to customer1 fail / take the primary SMS provider down (then reset)
curl -s -X POST http://localhost:4000/api/projects/hyper/users/customer1/rules -H 'content-type: application/json' -d '{"channel":"sms","action":"fail","count":1}'
curl -s -X POST http://localhost:4000/api/projects/hyper/providers/sms-primary/rules/preset/down-10m
curl -s -X DELETE http://localhost:4000/api/projects/hyper/providers/sms-primary/rules

# Callbacks / webhooks from stubyard don't reach the app? Check every configured URL from inside stubyard
curl -s http://localhost:4000/api/projects/hyper/doctor

# Clean inbox before a test run (keeps users and settings)
curl -s -X POST http://localhost:4000/api/projects/hyper/reset
```

MCP: stubyard also offers these as tools at `http://localhost:4000/mcp` (`claude mcp add --transport http stubyard http://localhost:4000/mcp`).

Run a storyboard yourself after a change (you drive your own browser; stubyard gives steps, users, data and codes):

```text
1. list_storyboards {project: "hyper"}  → pick the slug
2. start_walkthrough {project: "hyper", storyboard: "<slug>", inputs?, runner: {name: "<your browser tool>"}}
   → key, actors (with passwords), step (the first step, resolved)
3. Do the step in the browser (step.todo: url, username/password + twoFactor.code, entries to fill, value to read)
4. report_step {project: "hyper", walkthrough: "<key>", step: "<step id>", status: "done"|"failed"|"skipped",
   note?, value?, screenshot?}  → next (the next step, resolved)
5. Email steps: resolve_step {project: "hyper", walkthrough: "<key>", wait_seconds: 30} → code and link
6. When next is null: finish_walkthrough {project: "hyper", walkthrough: "<key>"} (verdict from the step results)
7. A failed step: report failed with a note and a screenshot; stop early with finish_walkthrough {allowIncomplete: true}
8. Your verdict is not a sign-off: a person signs the run off in the dashboard (Storyboards → Walkthroughs, Agent filter)
```

To keep a storyboard as a CI test: `export_storyboard_playwright {project: "hyper", storyboard: "<slug>"}` (or `GET /api/projects/hyper/storyboards/<slug>/export?format=playwright`) gives a Playwright spec that runs it as an agent run; review its `// TODO` lines.

Rules: use test-user addresses in test data. Read OTPs and 2FA codes from stubyard, never from a real phone or mailbox.
Ask before deleting a stubyard project or trusting its HTTPS CA system-wide.
