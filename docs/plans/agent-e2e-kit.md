# Is stubyard ready for fully agent-driven end-to-end testing?

Checked 2026-11-24 against stubyard **0.16.0** (branch `dev`, commit cf7d112). I built it as a throwaway image and ran it on ports 48300–48320. Afterwards I removed the containers, the network, the image and the two anonymous data volumes. The live hub (port 4000) and the `classprovia` project were not touched. class-provia was read only.

"Hyper" is not a stubyard project. It is the generator that produced Class PROvia (`class-provia/docs/HYPER-GAPS.md`); `hyper` appears in stubyard's docs only as an example slug.

## Short answer

**Yes, it can be done today, but only with code the agent writes itself.** Acting as an app's agent, with no human and
no Chrome extension, I did this:

1. Set the hub up through **MCP**: `create_project`, `set_app_origins`, `upsert_login_recipe`, `upsert_data_set`, `validate_storyboard` and `upsert_storyboard`. A Stripe gateway was added through **REST**, because MCP has no tool for it.
2. Ran a 12-step storyboard in **headless Chromium** (Playwright 1.55 in a container) against a small demo app:
   sign-up → confirmation email read from the stubyard inbox → link opened → TOTP key captured from the page and
   registered in stubyard → first code entered → login with password and a stubyard TOTP code → Stripe Checkout →
   hosted stubyard payment page (Pay) → back to the app → the app shows "Payment confirmed" after the **signed
   webhooks** (`payment_intent.succeeded` and `checkout.session.completed`, signatures checked by the app).
3. Recorded every step through the walkthrough REST API using **@stubyard/client/walkthroughs** (`startWalkthrough`,
   `resolveStep`, `updateStep` with notes and data, `addScreenshot`, `finishWalkthrough`). The run shows in the
   dashboard as *finished · pass · 12/12*, with one screenshot per step and a sign-off "by agent (playwright runner)".
   `get_walkthrough_result` (MCP), `summary.html` and the storyboard's `lastWalkthrough` all show it.
   The whole browser run took about 4 seconds.
4. Uploaded the Playwright **video** (WebM) to a walkthrough started with `record: "video"`, through
   `POST …/recording/chunks` (`kind: "video"`). It was stored as a complete video segment.
5. With sign-in on (Single admin), a **token** worked for REST and MCP, and the app-facing `/pay` and SMTP endpoints
   needed no token. A token cannot create tokens (403), so a person must create the first one.

**What made it work was hand-written glue:** about 120 lines of Playwright code that turns each step kind (open,
fill, email, capture, login with 2FA, check, instruction) into browser actions. Stubyard provides none of this.
Two steps needed knowledge specific to this app: "enrol 2FA" and "pay on the hosted page", because `instruction` steps
are free text. The first run **failed** because of a mistake that is easy to make with the email-step window (gap 3).
After adding `since`, it passed.

Proof files (git-ignored, next to this report): `(local scratch, not committed) `
`demo-app.js` (the app: sign-up, confirm, TOTP, Stripe, webhook), `mcp-lib.mjs`, `agent-setup.mjs` (MCP + REST setup;
the confirm-email step there lacks `since`, which the run added afterwards), `playwright-runner.mjs` (the executor),
`video-upload-probe.mjs`, `dashboard-agent-run.png`.

## 1. Verdict per capability

| Capability | Verdict | Notes from the practical run |
|---|---|---|
| API-level tests (REST, wait API, users, rules, mocks) | **Ready** | Mature. `messages/wait` with a cursor, test runs (§N), doctor, logs. An agent can drive all of it from curl or MCP (148 tools). |
| Email / SMS / WhatsApp / OTP | **Ready** | The confirmation mail arrived over SMTP with `links[]` extracted, and the wait API returned it. Pitfall: the window of a storyboard email step (gap 3). |
| TOTP (authenticator) | **Mostly** | Codes are fine (`codePath` in a resolved login step, `remaining` handling). Enrolment is the gap: there is **no MCP tool** to add a key (REST only) and **no step kind** for "capture the otpauth/secret → register → type the code". The agent wrote that by hand. Class PROvia staff use email 2FA locally for this reason. |
| OAuth / login providers | **Ready** (API) / Mostly (storyboards) | `@stubyard/client/auth` (`loginAs` cookie, `getTokens`) is made for Playwright. Storyboard login recipes only know a form login with an optional 2FA field, with no "Sign in with Google" button flow. |
| Payments + webhooks | **Ready** | Stripe Checkout hosted page with stable `data-testid`s (`stubyard-pay`…), signed webhooks that the app verified, `wait_for_payment`, rules, forced outcomes. Gateway setup is REST only (no MCP tool). Class PROvia's gaps 1–4 (`since`, vars in selectors, Moyasar decline return, mada) are fixed in 0.16.0. |
| Browser automation | **Mostly** (possible, not provided) | Works with the agent's own Playwright. Stubyard has no runner and no Playwright package for storyboards. The extension's fill, scan, capture and assert engine is pure DOM code but is only shipped inside the extension. |
| Storyboard runs by an agent | **Mostly** | The REST walkthrough API covers everything needed (start, resolve, step status/note/data/value, screenshots, finish, abandon). But `executor` is always `"human"` (`agentRun` is "reserved"), MCP has **no** start/report/finish tools (read only), and the dashboard says "Started and run from the browser extension". Agent runs look like human runs. |
| Evidence (screenshots, recordings) and reporting | **Mostly** | Screenshots: yes (600 KB each, 40 per run). Video: the upload works but is documented only as the extension's protocol, not as an agent use. No place for a Playwright trace or HAR. `summary.html` and JSON summary are good. Captured secret vars (the TOTP key) show in clear in the dashboard Vars. |
| CI use | **Mostly** | `STUBYARD_SEED`, the doctor, the wait API and the example GitHub workflow are good. Missing: JUnit/JSON output per storyboard, a "run all storyboards" command, and docs/CI.md still says "no published image yet". |
| Sign-in / teams tokens for agents | **Ready** (by design, one human step) | Bearer tokens work for REST and MCP; teams scoping and roles apply. A person must create the token in the dashboard, so the first setup cannot be fully unattended (except in Open mode, the local default). |

**Overall: mostly ready.** Every primitive an agent needs exists and works end to end, as the run above shows. What is
missing is the layer that turns a storyboard into an automated browser run without app-specific code, and makes agent
runs first-class objects in stubyard.

## 2. Gaps, ranked by impact

| # | Gap | One-line fix | Size |
|---|---|---|---|
| 1 | **No storyboard runner for Playwright.** Each agent must re-implement every step kind: fill rules (Radix select, checkbox groups, dates), capture, assert, email link choice, login with 2FA and `remaining` handling. | Ship `@stubyard/playwright`: `runStoryboard(page, {project, storyboard, vars})` that resolves each step, runs it, and reports status, notes, screenshots and video. Reuse `packages/extension/src/content/{fill,radix,scan,capture,match,dom}.ts` as a script injected into the page (they use no `chrome.*`). | L |
| 2 | **Agent runs are not first-class.** `executor` is fixed to `human`; MCP can only read results; the UI says "run from the browser extension". | Accept `executor: "agent"` (plus `runner` name/version) on `POST /walkthroughs`; add MCP `start_walkthrough`, `resolve_step`, `report_step` (status, note, data, screenshot data URL), `finish_walkthrough`; show an "agent" badge and filter in the dashboard. | M |
| 3 | **The default email-step window misses mail.** An email step looks from the start of the *previous* step. Put a `check` after the action that sends the mail, and the mail arrives before that window opens. My first run failed this way (the wait returned "No matching message within 60s" while the mail was in the inbox 70 ms earlier). This affects human runs too. | Default the window to the start of the last non-check step (or the last step that had an action), and/or add a validation warning `email_after_check` that suggests `since`. | S |
| 4 | **`instruction` steps are not machine-executable** ("Click Pay", "pay with 4242 on the hosted page"). | Add an optional `do` to instruction steps: `[{click: sel} \| {press: key} \| {waitForUrl: pattern} \| {fillCard: "success"}]`. Humans still read `intent`; runners run `do`. Add a built-in `pay` step kind for stubyard's hosted pages (outcome + test card). | M |
| 5 | **TOTP enrolment is manual.** There is no MCP tool to add an authenticator ("Created by a human in the dashboard or via REST") and no step kind for enrolment. | MCP `add_authenticator {project, label, secret\|otpauth, user}`; step kind `totp-enrol {secretSelector \| qrSelector, codeSelector, label}` that decodes the QR on the server, registers the key to the actor and fills the first code. | S (tool) + M (step and QR) |
| 6 | **`@stubyard/client` is not installable.** It is `private: true` with no `dist` in git; I had to copy and compile it. An app repo's agent cannot `npm i` it. | Publish it (npm or GitHub Packages), or serve a tarball at `GET /api/client.tgz` matching the hub version. | S |
| 7 | **Setup tools missing from MCP:** payment gateways, webhook endpoints, authenticators, project settings beyond origins. An MCP-only agent hits a wall at "add a Stripe gateway". | MCP `create_payment_instance` (returns `connect.env`), `create_webhook_endpoint`, `add_authenticator`. | S |
| 8 | **Evidence is limited to screenshots.** Video upload works (`kind: "video"` chunk; the segment key must not contain `.`) but is not documented for agents; a Playwright `trace.zip` or HAR cannot be attached. | Document "upload a Playwright video" plus a client helper `attachVideo(id, file)`; add per-run artifacts (`trace.zip`, HAR, console log) with size caps. | S / M |
| 9 | **Walkthroughs are not tied to test runs (§N).** Parallel agent runs share project and payment rules; scenario rules cannot be scoped to one walkthrough. | `run` on `POST /walkthroughs` (or start a run per walkthrough automatically) so rules, mocks and messages are scoped. | M |
| 10 | **CI reporting.** No "run every storyboard tagged X" entry point, no JUnit output, CI.md is out of date about the image. | `stubyard-run` CLI or a Docker image (Playwright + runner) that runs tagged storyboards and writes JUnit + `summary.html`; update docs/CI.md (ghcr image). | M |
| 11 | **Captured secrets show in clear.** The `totpSecret` var appears in the dashboard Vars and the summary. | `capture.secret: true` (or detect base32/otpauth) → masked like passwords. | S |
| 12 | **First token needs a person** (by design). Fine locally; a nuisance in CI with sign-in on. | Optional `STUBYARD_BOOTSTRAP_TOKEN` (hashed, scoped, env only) for CI containers. | S |
| 13 | **Docs for agents are split:** AGENT_GUIDE §AF says "An agent does not run walkthroughs in this version", while REST allows it. `deploy/AGENTS.snippet.md` does not mention storyboards. | Add an "Agent e2e" section and a short recipe to the snippet, once gaps 1–2 land. | S |

Networking note from the run: an app and a browser in containers need `STUBYARD_ALLOWED_HOSTS=stubyard`,
`STUBYARD_OUTBOUND_ALLOW=+app` and `STUBYARD_PUBLIC_URL=http://stubyard:4000`, so that hosted pages and webhooks
use addresses that work. A docker-compose example with app, stubyard and a Playwright runner would save each team that
hour.

## 3. Recommended "agent e2e kit"

Goal: an app's agent goes **feature → test cases → automated browser run → results in stubyard** with no human.

1. **Plan (exists):** features board (`list_features` / `get_feature`) → the agent writes a storyboard per feature
   (`describe_storyboards`, `storyboard_guide`, `validate_storyboard`), linked with `upsert_feature {storyboard}`.
2. **Executable storyboards (new, gaps 3–5):** an optional `do` on instruction steps, `pay` and `totp-enrol` step
   kinds, the email-window fix, and the `assert` on every check step encouraged by validation (a warning when a
   check has no `assert`).
3. **Runner (new, gap 1):** `@stubyard/playwright`:
   - `runStoryboard(page, {project, storyboard, vars, record: "video"|"trace"})` → `{walkthroughId, verdict}`.
   - Uses the extension's DOM engine (fill, Radix, capture, assert) injected into the page, so humans and agents
     share one set of fill rules.
   - Per step: resolve → act → screenshot → `report_step`. On failure: screenshot, DOM snippet, console errors →
     `failed` with a reason; finish `fail` with `allowIncomplete`.
   - Ships as an npm package **and** a Docker image `stubyard-runner` (Playwright + package), so any agent can run
     `docker run stubyard-runner --project p --tag smoke`.
4. **Agent runs first-class (gap 2):** `executor: "agent"`, MCP `start_walkthrough` / `report_step` /
   `finish_walkthrough` / `run_storyboard` (the last runs the runner image from stubyard itself, so an MCP-only
   agent can say "run this storyboard" and get the verdict back).
5. **Evidence (gap 8):** video or trace per run, console and network errors per step, `summary.html` with them, and
   JUnit for CI.
6. **Setup through MCP only (gaps 5, 7):** `create_payment_instance`, `add_authenticator`, `create_webhook_endpoint`,
   so the agent never needs curl.
7. **Distribution (gap 6, 10):** published `@stubyard/client` and `@stubyard/playwright`, the ghcr image, a compose
   example (app, stubyard, runner) and an updated `AGENTS.snippet.md` with the 10-line "run my storyboards" recipe.

Rough order: 3, 11, 5-tool, 6, 7 (all S, about a day together) → 2 (M) → 1 + 4 (L) → 8, 9, 10.

## 4. Other features worth adding for agent testing

- **Accessibility and console checks per step** (axe-core in the runner; `check.a11y: "serious"`). Cheap and very useful for generated apps such as Hyper's output.
- **Visual baselines:** compare a step's screenshot with the last passing run (per step id) and flag changes. Pairs naturally with storyboards.
- **Data reset hooks:** a storyboard `before`/`after` that calls the app's own seed/cleanup URL (stubyard already cleans its side; Class PROvia's "keep test data" rule makes an app-side hook useful).
- **Flake handling:** retry a failed step once with a fresh resolve, and record "passed on retry".
- **Storyboard from a recording:** turn a human's extension recording (rrweb) into a draft storyboard with selectors, for the agent to refine.
- **Playwright MCP pairing:** document using stubyard MCP together with a browser MCP (Playwright MCP / Claude in Chrome). An agent can already explore the app interactively, then save what worked as a storyboard (`save_page_snapshot`, `data_set_from_snapshot`).
- **Cross-app sharing:** Hyper-generated apps share auth and admin patterns, so ship storyboard **templates** (sign-up + email confirm, staff login + 2FA, payment) that an agent fills in with an app's selectors.

## 5. Class PROvia specifics

- Its four storyboards (`docs/stubyard/classprovia-storyboards.json`) were written for human runs. Of the gaps it reported, the first four (one email per step → `since`, vars in selectors, Moyasar decline return, mada brand) are fixed in 0.16.0. The test-user dropdown is improved (the payment page preselects the walkthrough's actor) but not checked against the extension here.
- To run them by an agent today, its agent would need the runner glue above plus app-specific handling for every `instruction` step (about half of the 25–47 steps), which is exactly gap 4.
- Its staff 2FA uses email codes locally because the authenticator path was not set up; with `add_authenticator` and `totp-enrol` (gap 5) the TOTP path becomes automatable too.
