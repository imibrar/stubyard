# A2: Run expectations and one verdict (implementation plan)

Spec: `docs/plans/feature-ideas-2026-11-24.md` §A2. A1 (agent walkthroughs) is done. **Migration 32 is reserved for A2**
(C1 = 33, B5 = 34, B6 = 35 are built in parallel).

## 0. Constraints from today's code

- **Isolation is by `run_id`, not by time.** `messages.run_id`, `traffic_logs.run_id`, `payments.run_id` and
  `schedules.run_id` are set by attribution (`server/src/runs/resolver.ts`). Outbound calls take their `runId` from
  whatever caused them: payment webhooks `payments/webhooks.ts` `deliver()` → `sendOutbound({runId: p.runId,
  resolved: {kind:'payment-webhook', payment, event, eventId, attempt}})`, templates in `webhooks/service.ts`, and
  status callbacks from the message. A run's data is `WHERE run_id = ?`.
- **Stop freezes the report, then purge deletes the data.** `RunService.stop()` calls `buildReport()` before
  cancelling the run's schedules (`schedules.cancelForRun`). `withRun`, the docs and agents use `stop?purge=1`.
  **The verdict must therefore be frozen at stop, inside the frozen report.**
- **Run report** (`server/src/runs/report.ts`) holds messages, lint (messages only), traffic problems
  (`PROBLEM_OUTCOMES`), rules, mocks, storage and warnings. It has no payments today.
- **Traffic outcomes** (`repos/logs.ts`) are ok, unmatched, invalid, rejected, forced_error, internal_error,
  network_error and pending.
  - `forced_error` is a deliberate fault and is never "unexpected".
  - Outbound `rejected` means the app answered ≥400.
  - Outbound `network_error` comes with `errorType` `blocked_by_allowlist`, `timeout` or `connection_failed`.
- **Messages:** `duplicateOfId` (same content, another instance, within 60 s), `appliedRule`,
  `metadata.wa.template.name` and `lint[]`.
- **Payments:** `amount` is an integer in minor units (`payments/engine.ts` `fromDecimal()`, `currencyDigits`), and
  `lintLevel` is a column.
- **User refs:** `hub.users.resolve(projectId, ref, runId)` resolves "customer" to the run's customer.
- **MCP access:**
  - Single-call tools (`call:`) are auto-mapped from their route. A COMPOSITE_ROUTE line for one of them makes
    `staleCompositeRoutes()` fail.
  - Composite tools (`run:`) **need** a COMPOSITE_ROUTE line.
  - `/api/projects/:slug/runs/...` is covered by the `${B}/runs` area (read `project.view`, write `walkthroughs.run`).
- **Walkthroughs** have no link to runs. `finish_walkthrough` is a composite MCP tool.

## 1. Expectation model

### 1.1 Stored document (per run)

```jsonc
{ "items": [ /* Expectation[], at most 50 */ ], "defaults": true /* false, or { "<defaultName>": false } */ }
```

| Where | Shape | Effect |
|---|---|---|
| `POST /api/projects/:p/runs` | `"expectations": {items, defaults}`; a bare array is shorthand for `{items}` | set at start |
| `PATCH …/runs/:run` | `"expectations": …` | replace; 409 when the run is stopped |
| `PUT …/runs/:run/expectations[?append=1]` | `{items?, defaults?}` | replace, or append items and merge defaults; 409 when stopped; returns the doc |
| `GET …/runs/:run/expectations` | | the doc |
| `POST …/runs/:run/verdict` | `{items?, defaults?, settle?}` | ad-hoc evaluation, nothing saved (also on stopped runs) |

### 1.2 Expectation item

Common fields on every item:

| Field | Meaning |
|---|---|
| `kind` | `message`, `payment`, `webhook`, `provider_call`, `traffic` or `lint` |
| `name?` | label in the verdict and in JUnit (default: generated, e.g. "exactly 1 sms to customer") |
| `count?` | `n` (exactly) or `{min?, max?}`; default `{min: 1}`; `0` means "none" |
| `each?` | a condition every matched entry must also meet (same fields as the selector) |
| `severity?` | `fail` (default) or `warn` |
| `since?` | ISO time: only entries from then on |

Selectors:

| kind | Fields |
|---|---|
| `message` | `channel`; `direction` (default outbound); `to` (user ref resolved in the run, or a raw address or phone); `unassigned: true`; `otp: true\|false\|"<code>"`; `contains` (string or string[], all must appear, case-insensitive, searched in subject + text); `subject` (contains); `template` (WhatsApp template name); `status` (string or list); `rule: true\|false` |
| `payment` | `gateway` (instance slug); `status` (one or a list); `amount` (major units, `"150.00"` or `150`, compared in minor units via `fromDecimal`); `currency`; `user` (ref, matched on the test user or `customerEmail`); `reference` |
| `webhook` (stubyard → app, outbound log rows) | `url` (substring); `source` (`payment`, `template`, `sequence`, `status_callback`, `email_event`, `inbound`, `verify` or `any`, from `resolved.kind` / `resolved.purpose`); `event`; `status` |
| `provider_call` (app → stubyard, inbound log rows under /mock /pay /llm /storage /auth /push) | `instance`; `method`; `path` (contains); `status`; `outcome` |
| `traffic` (any log row of the run) | `direction`, `protocol`, `outcome` (list), `status`, `url` (contains) |
| `lint` | `source` (`messages`, `payments` or `all`; default `all`); `severity` (minimum level, default `error`); `check` (finding id) |

HTTP `status` accepts a number, `"2xx"`/`"3xx"`/`"4xx"`/`"5xx"`, `"error"` (no response), or a list of these. There are
**no regexes**; text matching is plain substring.

Example:

```json
{ "items": [
  { "name": "one OTP email to the customer", "kind": "message", "channel": "email", "to": "customer", "otp": true, "count": 1 },
  { "kind": "payment", "status": "paid", "amount": "150.00", "currency": "SAR", "count": 1 },
  { "kind": "webhook", "url": "/webhooks/moyasar", "count": { "min": 1 }, "each": { "status": "2xx" } },
  { "kind": "message", "unassigned": true, "count": 0 },
  { "kind": "provider_call", "status": "4xx", "count": 0 },
  { "kind": "lint", "severity": "error", "count": 0 }
], "defaults": { "duplicateMessages": false } }
```

### 1.3 Default "nothing unexpected" checks

These are on unless turned off with `defaults: false` or `{name: false}`.

| Name | Fails when (run-scoped) | Notes |
|---|---|---|
| `providerCalls` | inbound rows with outcome unmatched, invalid, rejected or internal_error | `forced_error` is excluded |
| `appCallbacks` | outbound rows with outcome rejected or network_error | Grouped by `resolved.eventId`: if the last attempt succeeded, earlier failures are a **warn** |
| `lintErrors` | messages with an error-level finding, or payments with `lintLevel = 'error'` | |
| `duplicateMessages` | `duplicateOfId` set, or two outbound messages with the same channel, to, subject and text | |
| `unassignedMessages` | run messages with no test user | |
| `failedMessages` | failed, rejected, bounced or timeout messages with no `appliedRule` | |
| `pendingWork` | run schedules still pending, or messages still `scheduled` | **pending** on an active run, **warn** at stop ("cancelled at stop: N queued deliveries") |

**Declared expected failures are excluded from the defaults.** A declared item whose selector names a failure (status
4xx/5xx/error, an outcome other than ok, or a failed message status) marks the entries it matched as accounted for, and
no default check counts those entries.

### 1.4 Storage

Migration **32**:

```sql
ALTER TABLE runs ADD COLUMN expectations TEXT NOT NULL DEFAULT '{}';
ALTER TABLE walkthroughs ADD COLUMN run_check TEXT;
```

- The verdict is **not** a column. `buildReport()` adds `report.verdict: RunVerdict`, so the report frozen at stop
  contains it.
- Old stopped runs have no `verdict` in their report. `GET …/verdict` then evaluates live and sets `frozen: false`
  plus a note. If the data was purged, it answers `409 {error: "Run was stopped and purged before verdicts existed"}`.
- Runs with no expectations still get a verdict from the defaults. Existing report fields are unchanged.

## 2. Evaluation engine: `server/src/runs/verdict.ts`

```ts
export type ItemStatus = 'pass' | 'fail' | 'warn' | 'pending';
export interface Evidence { type: 'message' | 'log' | 'payment' | 'schedule'; id: string; summary: string; url: string }
export interface VerdictItem {
  id: string;            // "e1".."eN" declared, "default:duplicateMessages" for defaults
  name: string; kind: string; source: 'declared' | 'default';
  status: ItemStatus; expected: string; actual: number;
  message: string;       // "2 SMS to Customer 1 (w3) (expected exactly 1)"
  evidence: Evidence[];  // at most 20; `more` holds the rest of the count
  more?: number;
}
export interface RunVerdict {
  run: { id: string; key: string; status: string; startedAt: string; stoppedAt: string | null };
  verdict: 'pass' | 'fail' | 'pending';   // a stopped run is only pass or fail
  summary: string;
  counts: { pass: number; fail: number; warn: number; pending: number };
  items: VerdictItem[];
  evaluatedAt: string; frozen: boolean; notes: string[];
}
export function evaluateRun(hub: Hub, run: Run, doc: ExpectationDoc, opts?: { stopping?: boolean }): RunVerdict;
```

- **Scope:** `WHERE run_id = ?` on messages, traffic_logs, payments and schedules, plus each item's `since`. Each
  source loads its slim rows once and matches in memory. The cap is 5 000 rows per source; when it is hit, a note is
  added.
- **Recipient resolution:** resolve `to` with `hub.users.resolve(projectId, ref, run.id)` and match the test user (or
  their email, phone or WhatsApp). Otherwise normalize the value (`normalizeEmail` / `normalizePhone`) and compare it
  to `to_addr`.
- **Evidence URLs:** `/api/messages/<id>`, `/api/logs/<id>`, `/api/projects/<slug>/payments/<id>` and
  `/api/projects/<slug>/schedules/<id>`, each with a short summary.
- **Overall result:** any fail → `fail`; otherwise any pending → `pending`; otherwise `pass`. Warns never fail. With
  `stopping`, pending items become warns.
- **Settle:** `RunService.verdict(run, {settleMs})` polls every 250 ms until `pendingWork` is empty (60 s at most).
  `stop` accepts `settle` too.
- **Parsing:** `server/src/runs/expectations.ts` holds the zod schemas, `parseExpectations` (accepts the array
  shorthand; on error, `HttpError(400, msg, {issues})` with paths like `items[2].count`), `mergeExpectations(cur,
  patch, append)` and `DEFAULT_CHECKS` (names + descriptions).
- **Limits:** 50 items; `name` ≤ 120 characters; `contains` ≤ 10 strings of ≤ 300 characters each.

## 3. API, MCP, client, dashboard, walkthrough

### 3.1 REST (`server/src/http/routes/runs.ts`)

| Route | Notes |
|---|---|
| `GET …/runs/:run/verdict[?settle=10][&assert=1][&format=junit]` | Active run: evaluated live. Stopped run: `report.verdict`. With `assert=1`, answers **422** unless the verdict is pass. |
| `POST …/runs/:run/verdict` `{items?, defaults?, settle?}` | ad-hoc evaluation, nothing saved |
| `GET …/runs/:run/report.junit.xml[?download=1][&settle=]` | `application/xml; charset=utf-8`, nosniff, filename `stubyard-run-<key>.junit.xml` |
| `POST …/runs/:run/stop?settle=<s>&purge=1` | waits for pending run work (60 s at most) before freezing; the response adds `verdictUrl` and `junitUrl` |
| `GET/PUT …/runs/:run/expectations`, `expectations` in POST / PATCH | §1.1 |

- `hub.runs.view()` adds `verdict` (the frozen verdict's value, or null) and `expectations: {items: n}`.
- **Permissions:** add one EXACT entry, `['POST', '/api/projects/:slug/runs/:run/verdict', 'project.view']`.
- **JUnit** (`server/src/runs/junit.ts`, `renderVerdictJunit(verdict, {project})`):
  - one `<testsuites>` containing one `<testsuite name="stubyard run <key> (<project>)">` with
    `<properties>` run and verdict, and one `<testcase classname="stubyard.<project>.<key>.<kind|default>">` per item;
  - fail → `<failure type="expectation" message=…>` with the evidence lines; pending → `<skipped>`; warn → pass with
    `<system-out>`;
  - escape `& < > " '`, drop characters XML 1.0 doesn't allow, and set `time` to the run duration on the suite.

### 3.2 MCP (`server/src/http/routes/mcp.ts`)

- **`check_run`**, a composite tool (`run:`): input `{project, run, expectations?, wait_seconds?, junit?}`.
  - With `expectations`: POST `…/verdict`. Without: GET `…/verdict?settle=`.
  - COMPOSITE_ROUTE line: `check_run: ['GET', `${P}/runs/x/verdict`]`.
- **`set_run_expectations`**, a single-call tool (`call:` → PUT `…/expectations?append=`). It gets **no**
  COMPOSITE_ROUTE line.
- `start_run` gains `expectations`, and `stop_run` gains `settle_seconds`.
- The `instructions` string says: "For one pass/fail answer for a test run use check_run."

### 3.3 Client (`packages/client/src/runs.ts`)

- **Types:** `RunExpectation`, `RunExpectations`, `RunVerdict`, `VerdictItem`; `RunReport.verdict?`;
  `RunView.verdict?`; `StartRunOptions.expectations?`.
- **`RunHandle`:**
  - `expect(items, {append?, defaults?})`, `verdict({settleMs?})`, `junit({settleMs?})`;
  - `assertPassed({settleMs?})` throws `Error("stubyard run w3 failed: <summary>")` with `.verdict` attached;
  - `stop({purge?, settleMs?})`.
- **Functions:** `getRunVerdict(...)`, `setRunExpectations(...)`.
- **`withRun({expectations?, assertVerdict?})`:** after `fn` succeeds, stops with settle (default 5 s) and throws if
  the verdict fails. An error from `fn` still takes precedence.

### 3.4 Dashboard (`web/src/pages/RunsPage.tsx`) and the HTML report

- **Run list:** a verdict badge column (pass ok, fail danger, pending warn, none "–"); active runs show "live".
- **Run detail:**
  - a Verdict card at the top, from `report.verdict`: overall badge and summary, then an items table (status, name,
    expected, actual, message);
  - evidence chips linking to the message, the traffic entry and the payment;
  - a "Download JUnit" button;
  - the expectations JSON, read-only.
- **`server/src/runs/report-html.ts`:** a Verdict section after the header, and a verdict tile.

### 3.5 Walkthrough link (slice S7)

- **Finish takes a run:** `POST …/walkthroughs/:id/finish` and MCP `finish_walkthrough` accept `run` (key or id).
- **What is stored:** the server evaluates the run's verdict and stores
  `{runId, key, verdict, summary, failed: [{id, message}]}` in `walkthroughs.run_check`, shown as `runCheck`.
- **Default verdict:** in the MCP tool, the default verdict becomes `fail` when the run verdict fails. An explicit
  `verdict` always wins.
- **Sign-off:** unchanged.
- **Guide:** `guide.ts` topic `agent-run` gets one bullet.

## 4. Docs

- **`docs/AGENT_GUIDE.md`:**
  - new §N.7 "Expectations and the verdict": the model, the defaults, the expected-failure rule, the verdict JSON,
    `settle` / `assert`, JUnit, a CI curl recipe (`curl -fsS ".../verdict?assert=1&settle=10"`), and "stop with settle
    before purge";
  - §N.4 routes; §N.5 and §F MCP tools; §X client helpers; the §1 feature-status row;
  - agent rule: "declare what the test should cause, call check_run before stop_run".
- **`docs/CI.md`:** publishing `report.junit.xml` (GitHub `dorny/test-reporter`, GitLab `artifacts:reports:junit`).
- **`docs/GUIDE.md`:** a paragraph on the Runs page Verdict panel.
- **`CHANGELOG.md`:** under `## Unreleased`, `### Added` (above `### Fixed`): the feature, plus "Migration 32:
  `runs.expectations`, `walkthroughs.run_check`".

## 5. Tests (server/test)

| File | Covers |
|---|---|
| `runs-expectations.e2e.test.ts` (S1) | create with expectations (shorthand and doc), PATCH/PUT replace and append, GET, 400 with the issue path, PUT on a stopped run → 409, migration on a fresh DB |
| `runs-verdict.e2e.test.ts` (S2) | messages (count, `to` role ref, `otp`, `contains`, WhatsApp `template`, `unassigned`); defaults (duplicate SMS → fail with both ids; failed message without a rule → fail, with a rule → pass; lint error → fail; provider call `rejected` → fail; `forced_error` not counted); payments (Stripe paid 150.00 SAR → pass, wrong amount → fail); webhooks against a local `http.createServer` app (500 → fail; 500 then 200 → warn; `each`); expected-failure exemption; pending, then `settle` → pass; stop freezes the verdict and it survives purge; `defaults: false` |
| `runs-verdict-api.e2e.test.ts` (S3) | `assert=1` → 422 or 200; ad-hoc POST doesn't save; JUnit is well-formed with escaping; the `download=1` header; MCP `check_run` (with and without expectations, `junit`) and `set_run_expectations` via `/mcp`; the `stop?settle=` response urls |
| `access.e2e.test.ts` | must stay green |
| `runs-verdict.sdk.test.ts` (S4) | client helpers, `assertPassed`, `withRun({assertVerdict})` |
| `runs-verdict-html.e2e.test.ts` (S5) | HTML Verdict section with escaping; a pre-A2 report renders without it |
| `walkthrough-run-check.e2e.test.ts` (S7) | finish with `run`, `runCheck`, default fail, an explicit verdict wins |

Harness: copy `runs.e2e.test.ts` and `run-report-time.e2e.test.ts` (`startHub`, `freePort`, `api()`, `waitFor`,
`describe.skipIf(!haveMailpit)`, and the local `http.createServer` app).

## 6. Slices

| Slice | Owns | Depends on |
|---|---|---|
| S1 Model + storage | migrations.ts (v32), repos/runs.ts, runs/expectations.ts (new), runs/service.ts (start / setExpectations), routes/runs.ts (expectations routes and body fields), runs-expectations test | – |
| S2 Engine | runs/verdict.ts (new), runs/report.ts (verdict), runs/service.ts (verdict with settle, stop settle, view.verdict), runs-verdict test | S1 |
| S3 API + JUnit + MCP | routes/runs.ts (verdict / junit / stop settle), runs/junit.ts (new), routes/mcp.ts, access/permissions.ts, runs-verdict-api test | S2 |
| S4 Client | packages/client/src/runs.ts (+ index.ts), runs-verdict.sdk test | S3 |
| S5 Dashboard + HTML | web/src/pages/RunsPage.tsx (+ css), runs/report-html.ts, runs-verdict-html test | S2 |
| S6 Docs | AGENT_GUIDE.md, CI.md, GUIDE.md, CHANGELOG.md | S3 |
| S7 Walkthrough link | storyboards/walkthroughs.ts, types.ts, mcp-tools.ts, guide.ts, ontology.ts, packages/client/src/walkthroughs.ts, the web walkthrough view, walkthrough-run-check test | S3 |

Order: S1 → S2 → S3 → (S4 ∥ S5 ∥ S6) → S7.

## 7. Decisions

1. The verdict lives inside the frozen report; only `expectations` is a column.
2. `stop?settle=` and `verdict?settle=`; `withRun({assertVerdict})` uses a 5 s settle by default; deliveries
   cancelled at stop are a warn.
3. Unattributed traffic during parallel runs is not in v1 (a captureUnattributed run catches it through
   `unassignedMessages`).
4. A failure that a retry later fixed is a warn.
5. Storyboards and walkthroughs don't declare expectations in v1; a run is linked at finish (S7).
6. Expectations can't be edited after stop (409); an ad-hoc POST still works.
7. Substring matching only, no regex.
8. `check_run` is read-only (POST with `project.view`); saving goes through `set_run_expectations`.
9. Defaults are on by default; the verdict is new, so nothing existing changes.
