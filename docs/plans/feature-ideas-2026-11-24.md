# Feature ideas for stubyard (2026-11-24)

Analysis only; nothing here is started. Sources read: README, CHANGELOG (through Unreleased), docs/GUIDE.md,
docs/AGENT_GUIDE.md, docs/PLAN.md and the plans in .cache/specs. Ideas already shipped are left out.

Size: **S** = a few days of one agent stream, **M** = about a week with a migration and docs, **L** = several phases.
Fit = how well it matches "light, local-first, single container": **Yes**, **Partly** (needs care), **No**.

Caveat for group (b): provider API shapes below are from general knowledge, not checked against current vendor
docs. Each one needs the same research pass the payment gateways got (research-pay-R1..R3) before it is built.

## Top 5 to build first

| # | Idea | Size | Why first |
|---|---|---|---|
| 1 | **Agent-run storyboards** (A1) | M | The biggest gap. Agents can write storyboards but only people can run them; the ontology already reserves `agentRun` / `executor: "agent"`. This turns every storyboard into a regression test an agent can run after each change. |
| 2 | **Run expectations and a single verdict** (A2) | S–M | Agents currently have to assemble pass/fail from many tools. One declared expectation set per run with one answer (and JUnit output) makes results reliable and CI-ready. It is also what A1 needs to report on. |
| 3 | **GCC and global messaging presets pack** (B1) | S each | Cheapest coverage gain. Only Twilio, Vonage and Meta are named presets today; Saudi apps mostly use Unifonic, Taqnyat, Msegat and similar. The generic adapter and inbox already exist, so each preset is mostly a request/response map and a delivery-report format. |
| 4 | **OpenAPI import and contract checks** (C1) | M | Generated apps often call an API slightly wrong, and a lenient fake hides it until production. Checking each request against a spec, and building mocks from a spec, catches that class of bug. Listed in CONCEPT as not done. |
| 5 | **Saudi identity and e-invoicing: Nafath, then ZATCA Fatoora** (B5, B6) | M + L | Almost every Saudi consumer or B2B app needs one of them, both sandboxes are awkward to use, and neither exists in common local tools. Nafath maps directly onto test users (the test user "approves in the app"). |

Order: 2 → 1 (the verdict format first, the runner uses it), 3 in parallel (independent, small), then 4, then 5.

---

## (a) Agent e2e automation

### A1. Agent-run storyboards — **top 5** — M — Fit: Yes
- **What:** the reserved v2 of walkthroughs. MCP / REST tools `start_walkthrough {executor: "agent"}`,
  `resolve_step` (returns the rendered step: URL, selectors, values, the user to log in as, the code or email link
  once it arrives) and `report_step` (status, note, screenshot, captured values). The agent drives its own browser
  (Playwright MCP, Claude in Chrome, a Playwright script); stubyard stays the source of steps, data and evidence.
- **Second part (S):** `GET /storyboards/<slug>/export?format=playwright` generates a Playwright spec from a
  storyboard using `@stubyard/client` (login recipe, data-set fill, wait for email, assertions), so a flow a person
  walked once becomes a CI test.
- **Scenario:** the agent changes Class PROvia's enrolment form, then runs the "parent enrols a child and pays"
  storyboard itself: logs in as the fresh parent, fills the form from the data set, completes the Moyasar page, opens
  the receipt email, reports each step. The person only reviews a failed run, with the recording.
- **Keep it light:** do not put Chromium in the image. The browser stays outside (the agent's, or CI's).
- **Notes:** an agent run needs its own cleanup path and a clear mark in the walkthrough list (`executor` column
  exists already). Sign-off stays a human action.

### A2. Run expectations and one verdict — **top 5** — S–M — Fit: Yes
- **What:** a test run (or walkthrough) can declare expectations: "exactly 1 email to customer with an OTP", "1
  payment captured for 150.00 SAR", "webhook /webhooks/moyasar answered 2xx", "no message to Unassigned", "no provider
  call failed with 4xx", "no lint errors". `GET /runs/<key>/verdict` and MCP `check_run` return pass/fail per item
  with the log ids as evidence. Also `report.junit.xml` next to the existing JSON / HTML report.
- **Why:** today an agent calls `get_messages`, `list_payments`, `get_traffic`, `lint_report` and judges by itself;
  it often misses the unexpected thing (a second email, a retry storm, a 401 on a callback).
- **Scenario:** after a checkout test the verdict says "failed: 2 SMS sent to customer1 (expected 1), log ids …" and
  the agent finds a double submit.
- **Includes:** default "nothing unexpected" checks that need no declaration.

### A3. Fault sweep — S–M — Fit: Yes
- **What:** run one test command or storyboard repeatedly, each time with one fault from a list (SMS provider down,
  email bounce, payment declined, 3-D Secure abandoned, webhook delayed / duplicated / out of order, storage 503, LLM
  timeout), and produce a matrix of how the app behaved. Builds on existing rules, scenarios and the scheduler.
- **Scenario:** "sign-up survives SMS failure by falling back to email: yes. Order page after a duplicate payment
  webhook: charged twice: no, but two receipt emails: fail."

### A4. Project checkpoints — S — Fit: Yes
- **What:** save and restore a named state of a project's test data (users, inboxes, payments, files, rules), e.g.
  `checkpoint save after-onboarding` / `restore`. Today there is reset and export / import, but no quick restore
  point.
- **Scenario:** an agent builds the "school with 3 classes and a paid invoice" state once, then restores it before
  each test instead of replaying onboarding.
- **Optional:** a per-project "app reset hook" URL that stubyard calls on restore so the app's database follows.

### A5. Topic-scoped agent guide — S — Fit: Yes
- **What:** docs/AGENT_GUIDE.md is about 410 KB (roughly 100k tokens). Add an MCP `guide {topic}` tool and
  `GET /api/agent-guide?topic=` that return an index first and one section on request, the way `storyboard_guide`
  already works for storyboards. (Check first what the existing query parameters of `/api/agent-guide` cover.)
- **Why:** an agent that loads the whole guide spends most of its context before it starts; one that skips it guesses.

### A6. CLI and Playwright / Cypress fixtures — S–M — Fit: Yes
- Already in PLAN phase 10, still open. `npx stubyard wait-code admin`, `stubyard run start`, `stubyard verdict`;
  a Playwright fixture (`test.extend`) that starts a run, sets headers and attaches the report to the test result.
  Publishing `@stubyard/client` to npm belongs here ("not on npm yet" in the README).

### A7. Proxy / record mode for any API — M — Fit: Partly
- Already in PLAN, still open. stubyard sits in front of a real API, records traffic, turns it into mocks and
  can inject faults. LLM record-to-mock already does this for two providers; this is the general form.
- **Partly** because it sends traffic out; it must follow `STUBYARD_OUTBOUND_ALLOW` and mask secrets in recordings.

### A8. Agent activity journal — S — Fit: Yes
- **What:** a per-session list of what an agent did through MCP (tool, arguments, result size, time), shown in the
  dashboard and attachable to a run. In Teams mode it ties to the token.
- **Scenario:** "why is the SMS provider failing?" — the journal shows an agent set a rule an hour ago and never
  reset it. Could also warn about leftover rules at the end of a session.

### A9. Mock GraphQL, WebSocket and SSE — M — Fit: Yes
- API mocks cover plain HTTP only. GraphQL by operation name, and scripted WebSocket / SSE streams, cover
  real-time and BFF-style third parties.

---

## (b) More fake providers and integrations

### B1. Messaging presets pack — **top 5** — S each — Fit: Yes
- **Saudi / GCC SMS:** Unifonic, Taqnyat, Msegat, 4Jawaly, Oursms, Mobily business SMS. Include what Saudi senders
  actually hit: sender-ID not approved, balance exhausted, blocked hours for promotional SMS, Arabic (UCS-2)
  segment counts (the segment counter exists).
- **Global SMS:** Infobip, Bird (MessageBird), Plivo, Sinch, Telnyx, Amazon SNS SMS.
- **WhatsApp BSPs:** 360dialog (in the catalog text but not a preset), Unifonic, Infobip, Gupshup. Add the **template
  lifecycle**: create a template, approval / rejection and quality webhooks, sending an unapproved template fails.
- **Email APIs:** Resend, Postmark, Brevo, Mailjet, Mailchimp Transactional.
- **Scenario:** Class PROvia sends OTPs through Unifonic; today the developer has to hand-configure the generic SMS
  preset and gets no Unifonic-shaped errors or delivery reports.

### B2. Push additions — S–M — Fit: Yes
- Web Push (VAPID), listed as not done; Expo push API; OneSignal REST; Huawei Push Kit (relevant in GCC).

### B3. Captcha verification fakes — S — Fit: Yes
- reCAPTCHA, hCaptcha and Cloudflare Turnstile `siteverify` endpoints plus a tiny widget script that returns a token.
  Outcome per test user or rule (pass, fail, low score).
- **Scenario:** an agent's e2e test of sign-up no longer needs the app to switch captcha off in test mode.

### B4. Analytics and error-tracking sinks — S–M — Fit: Yes
- Accept Segment, GA4 Measurement Protocol, Mixpanel, PostHog and Sentry envelopes; store the events per test user
  and offer `wait_for_event` / assertions.
- **Scenario:** "assert `purchase_completed` fired once with value 150" and "no Sentry error during this run".

### B5. Nafath (Saudi national SSO) — **top 5** — M — Fit: Yes
- **What:** the app sends a national ID, gets a 2-digit number, the person confirms in the Nafath app, the app gets a
  callback or polls for the result. In stubyard the test user gets a national ID / Iqama number, and the "Nafath
  app" is a card in the user's inbox and in the walkthrough widget with the number, Approve and Reject; rules for
  expired, rejected, wrong number.
- **Related, S each once B5 exists:** UAE Pass (OIDC-like, fits the login providers), Absher / Elm OTP, Yakeen
  identity lookup, Wathq commercial-registration lookup, Saudi National Address lookup. The lookups are mostly canned
  data per test user; ship them as mock templates.

### B6. ZATCA Fatoora e-invoicing — **top 5** — L (M for phase 1) — Fit: Yes
- **Phase 1 (M):** onboarding (compliance CSID, production CSID), compliance checks, reporting (simplified) and
  clearance (standard) endpoints with the right response shapes; rules for warnings, rejections and outage; an
  invoices view per project.
- **Phase 2 (L):** real checks: UBL structure, invoice hash chain and counter, QR TLV content, signature present,
  VAT arithmetic. Report them as lint like `payment_lint`.
- **Scenario:** an agent builds invoicing; stubyard says "previous invoice hash does not match invoice 41" instead of
  the developer finding out in ZATCA's sandbox.
- **Later, same engine:** UAE e-invoicing (Peppol-based), Egypt ETA, Pakistan FBR.

### B7. Hosted KYC flows — M — Fit: Yes
- Sumsub, Onfido, Veriff, Persona: create a verification, hosted page with a selectable outcome (approved, rejected,
  resubmission), signed webhook. Reuses the payment engine's "hosted page + outcome + webhook" pattern.

### B8. Shipping and delivery — M engine + S per carrier — Fit: Yes
- Create shipment, label PDF, tracking, and a scripted tracking timeline delivered by webhook through the scheduler
  (picked up → out for delivery → delivered / failed attempt / returned).
- Carriers: Aramex, SMSA, SPL (Saudi Post), Naqel, DHL Express; aggregators OTO and Torod (Saudi), Shippo / EasyPost.

### B9. Maps and location (server APIs) — M — Fit: Partly
- Google Geocoding, Places, Distance Matrix, Directions; Mapbox equivalents; deterministic answers from a small
  built-in gazetteer plus per-project fixtures.
- **Partly:** the JS map widgets and tiles cannot be faked sensibly; only server-side calls. Keep data tiny.

### B10. Calendar and meetings — M — Fit: Yes
- Google Calendar and Microsoft Graph calendar events (the Google and Microsoft login fakes already issue tokens),
  Zoom meetings and webhooks, Google Meet links, BigBlueButton. ICS attachments shown in the email inbox.
- **Scenario:** a tutoring or class app schedules a lesson; the test checks the event exists and the teacher's
  email has a valid invite, then stubyard sends "meeting ended" so attendance logic runs.

### B11. More payments — S–M each — Fit: Yes
- Apple Pay / Google Pay token flows (documented as not simulated for Moyasar), SADAD bill payment, Telr, Noon
  Payments, Paymob, ClickPay, Thawani, Fawry. Stripe Billing (subscriptions, customer portal, invoices) and Stripe
  Connect if not already covered beyond Checkout and PaymentIntents (check §Z first).
- Open banking: Lean, Tarabut (account linking page with outcomes, like a login provider).

### B12. Login additions — M each — Fit: Yes / Partly
- **SAML IdP** (listed as not supported): needed by B2B SaaS. Fit: Yes.
- **SCIM client tester:** stubyard plays Okta / Entra provisioning users into the app. Fit: Yes.
- **Passkeys / WebAuthn:** a virtual authenticator through the extension. Fit: Partly (needs the debugger
  permission; scary prompt). Lower priority.
- **Telegram** login and Bot API, **Slack / Teams / Discord incoming webhooks** as channels in the inbox. S each.

### B13. LLM and media mocks — S–M — Fit: Yes
- Google Gemini API format (record-to-mock refuses it today), image generation, speech-to-text and text-to-speech
  endpoints with canned outputs.

### B14. Voice calls — M — Fit: Yes
- Twilio Voice / TwiML and Vonage Voice: the call appears in the timeline with what was said; DTMF replies. Voice
  OTP through Verify exists; this is the general case (also still open in PLAN).

### Skip
- SQS / SNS / Pub/Sub, DynamoDB, Firebase Auth / Firestore: LocalStack and the Firebase emulator already do these
  well; link to them in the guide instead.

---

## (c) Quality and observability

### C1. OpenAPI import and contract checks — **top 5** — M — Fit: Yes
- **Import:** an OpenAPI file becomes API mocks (paths, example responses, scenarios per response code).
- **Check:** every request to a mock, and every response the app gives to a stubyard webhook, is validated against
  the spec; failures show in traffic and in the run verdict (A2).
- **Strict provider mode:** the built-in fakes flag unknown parameters, wrong types and deprecated fields instead of
  ignoring them (PayPal was already checked against its published OpenAPI specs; reuse those where vendors publish
  them).
- **Scenario:** the app sends `amount: "150.00"` to a gateway that wants minor units as an integer; the fake accepts
  it today, the real one would reject it.

### C2. Baseline comparison between runs — M — Fit: Yes
- Mark a run or walkthrough as the baseline; later runs are compared: messages sent (count, recipients, template
  shape), provider calls, webhooks, payments, step results.
- **Scenario:** after a refactor: "this run sends the welcome email twice and no longer calls the Stripe refund
  endpoint".

### C3. Visual diffs of step screenshots — M — Fit: Yes
- Compare each step's screenshot with the baseline walkthrough's (pixel diff with a threshold and ignore regions),
  shown side by side in the walkthrough drawer. Tracked runs already store screenshots.
- Also for emails: render the HTML at phone and desktop widths and diff against the last approved version.

### C4. Accessibility check per step — S–M — Fit: Yes
- The extension runs axe-core on the page at each step (or on demand) and stores the violations with the step;
  summary per walkthrough, also returned to agents.
- **Scenario:** an agent gets "the Pay button has no accessible name; contrast 2.9:1 on the error text" as part of
  the run result and fixes it in the same session.

### C5. Console, network and performance capture per step — S–M — Fit: Yes
- The extension records uncaught errors, console errors, failed requests and Core Web Vitals (LCP, CLS, INP) between
  steps and attaches them to the step. No such capture exists today.
- **Scenario:** a step "passes" visually but the page logged a 500 from `/api/enrolments`; the result shows it.

### C6. Provider-usage findings per run — S — Fit: Yes
- Extends lint: duplicate sends to the same user within seconds, missing idempotency keys on payment calls, no
  retry after a 5xx, polling too fast, webhook handler slower than the provider's timeout, secrets in query strings.

### C7. Webhook handler conformance test — S–M — Fit: Yes
- One button / tool that fires a set at the app's endpoint: bad signature, replayed event, duplicate, out of order,
  old timestamp, large body, slow provider retry. The webhook security check covers part; this adds the idempotency
  and ordering cases with a pass/fail table.

### C8. Flow timeline — M — Fit: Yes
- One time-ordered view for a run or a test user across channels: app request → SMS sent → code read → payment
  created → webhook delivered → email sent, with links to the log entries. Also returned as compact JSON for agents.

### C9. HAR / cURL export of traffic — S — Fit: Yes
- Export selected log entries or a whole run as HAR, or one entry as cURL, to attach to bug reports.

### C10. Localisation and RTL checks — S — Fit: Yes
- Content checks for Arabic: mixed-direction text without marks, Arabic-Indic vs Latin digits in OTPs, SMS over the
  UCS-2 segment budget, missing `dir="rtl"` in email HTML, untranslated placeholders.

---

## (d) Team and workflow

### D1. Features ↔ storyboards ↔ results — S–M — Fit: Yes
- A feature shows the latest result of its linked storyboard(s) ("verified 2 days ago by QA, passed"); a feature can
  require a passed walkthrough before Done. A failed step can create a task on the feature with the screenshot and a
  link to the moment in the recording.

### D2. Test plans (release sign-off) — M — Fit: Yes
- A named set of storyboards for a version, assigned to people, with a matrix of results and one printable sign-off
  report. Agent runs (A1) fill the matrix first; people do the rest.

### D3. Comments and mentions — S–M — Fit: Yes
- Comments on features, tasks, walkthrough steps and recordings (with a timestamp). An open question in the features
  backlog. In-app only at first.

### D4. Outgoing notifications — S — Fit: Partly
- Optional webhook (Slack / Teams format) for "walkthrough failed", "sign-off needed", "feature assigned". **Partly:**
  it is real outbound traffic, so off by default and bound to the outbound allowlist.

### D5. Read-only share links — S — Fit: Yes
- A signed, expiring link to one walkthrough report or recording for a client or designer without an account.

### D6. Config as code — M — Fit: Yes
- A `stubyard.yaml` in the app's repository (providers, test users, rules, mocks, storyboards) with `plan` / `apply`
  and drift display, so an agent sets a project up from the repo and a teammate gets the same setup. Seeding with
  `STUBYARD_SEED` exists; the declarative diff and apply do not.

### D7. Project templates and cloning — S — Fit: Yes
- "New project from template": Saudi e-commerce (Moyasar, Tabby, Unifonic, ZATCA), SaaS (Stripe, SendGrid, Google
  login), marketplace. Clone a project for a branch or a second developer.

### D8. GitHub / GitLab link for the features board — M — Fit: Partly
- Export features and tasks to issues or Markdown, optional two-way sync. **Partly:** needs a real token and outbound
  calls; export to Markdown alone is S and fully local.

### D9. Single sign-on for stubyard itself — M — Fit: Partly
- OIDC sign-in (Google Workspace, Entra) in Teams mode. An open question in the teams plan. Only useful on a server.

### D10. Agent identities — S — Fit: Yes
- A token type for agents with a name ("Claude on CI"), shown in the audit log, features board and walkthroughs, so
  agent actions are told apart from the person's.
