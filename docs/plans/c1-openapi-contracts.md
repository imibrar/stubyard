# C1: OpenAPI import and contract checks (implementation plan)

Spec: `docs/plans/feature-ideas-2026-11-24.md` §C1. A2 (run verdict, `docs/plans/a2-run-verdict.md`) is built in
parallel and consumes `contractSummary()`. **Migration 33 is reserved for C1** (A2 = 32, B5 = 34, B6 = 35).

## 0. Findings

- **API mocks:**
  - Code: `server/src/repos/mocks.ts` (table `api_mocks`), `server/src/mocks/match.ts` and
    `server/src/mocks/handler.ts`, reached through `MessagingSimulator.handleMock` when the instance slug is `api`
    (`messages/simulator.ts`).
  - Mocks are per project and first match wins by `position`.
  - Paths use `:name` and `*`, including `*` inside a segment.
  - A scenario is `{name, status, headers, body, delayMs, behaviour}`.
  - The handler sets `req.trafficResolved` and `req.trafficOutcome`.
- **Traffic log:** `repos/logs.ts` (`traffic_logs`) and `traffic/logger.ts`.
  - Inbound rows are written by hooks in `http/app.ts`.
  - SSE events `log.created` / `log.updated` carry `summarize(log)`.
  - `/api/logs` lives in `routes/api.ts`.
  - The run report counts unmatched, invalid, internal_error and network_error as problems.
- **Messages lint is the model to follow:** a JSON `lint` column, an indexed `lint_level` column, and `lintSummary()`
  in `lint/report.ts`.
- **`webhooks/schema.ts`** is a validator with no dependencies (a draft-07/2020-12 subset, `{path, message}` errors).
  Its gaps:
  - `$ref` resolves only against the schema passed in;
  - `oneOf` is strict ("matches more than one");
  - `new RegExp(pattern)` is compiled on every check.
- **Dependencies:** ajv is present only through fastify (transitive). There is no YAML parser.
- **Outbound calls** all go through `sendOutbound(traffic, req)` in `traffic/outbound.ts`, which has 12 callers. It
  holds the full response text before clipping it.
- **Webhook templates** (`repos/webhooks.ts`, `webhooks/service.ts dispatch()`) pass `resolved.templateId`.
- **Built-in payment gateways** all go through `withCheckoutKit` in `payments/presets.ts` (`GatewayCtx`: path, query,
  resolved, inst). `payments/common.ts` has `parseBracketForm`. Login providers' `config.strict` means something else.
- **MCP:** `call` tools are mapped to permissions automatically; `run` tools need a COMPOSITE_ROUTE line. Feature
  modules export tool arrays that are spread into `TOOLS`.
- **Permissions:** `access/permissions.ts` (AREAS longest-prefix match, EXACT overrides).
- **Export:** `maintenance/export.ts` `EXPORT_SECTIONS` imports in array order and clears in reverse.
- **Hub wiring:** `server/src/index.ts` `createHub()`, types in `server/src/hub.ts`.

## 1. Dependencies

- **YAML:** add `yaml` (eemeli, ISC, no deps) to `server/package.json`, and parse on the server only.
  `maxAliasCount` stays at its default of 100.
- **JSON Schema:** extend `webhooks/schema.ts` instead of adding ajv. It gets a 4th `opts` argument that is backwards
  compatible:
  - `root?: unknown`: `$ref` resolves against this document;
  - `oneOf: 'strict' | 'lenient'`: lenient passes when several branches match; with `discriminator.propertyName`,
    pick the branch via `mapping` or `#/components/schemas/<value>`;
  - a regex cache (`Map`); skip `pattern` on strings over 10 000 chars and report `info` "not checked";
  - numeric formats `int32` / `int64` (range) and `float` / `double` (no-op).
  - Unsupported keywords (`unevaluatedProperties`, `dependentSchemas`) give an import warning.

## 2. Import

### 2.1 Inputs

- **Text:** `{spec: "<text>"}` from a dashboard upload (read as text in the browser), from paste, or from MCP.
- **URL:** `{url}`, fetched by `contracts/fetch.ts`:
  - GET, http(s) only, 15 s timeout, 10 MB, at most 3 redirects, no credentials;
  - block 169.254.0.0/16, fe80::/10 and `metadata.google.internal`;
  - never echo the response body on failure;
  - `STUBYARD_SPEC_FETCH=0` turns URL import off.
- **Format:** text starting with `{` is JSON, otherwise YAML.
- **Versions:** OpenAPI 3.0.x and 3.1.x. Swagger 2.0 is rejected: "convert to OpenAPI 3 first (e.g. converter.swagger.io)".
- **Size:** route bodyLimit 12 MB, document cap 10 MB.

### 2.2 `$ref`

- **Local refs only.** They stay in the stored document (cycles are common), and validation passes `root = document`.
- **`deref(node)`** with a visited set resolves `$ref` in parameters, requestBodies, responses and headers at compile
  time.
- **External refs** give an import warning, and their target is treated as `{}`.

### 2.3 Normalization (OAS 3.0 → the validator's dialect)

- `nullable: true` → `type: [t,'null']`, plus `null` in `enum`.
- Boolean `exclusiveMinimum` / `exclusiveMaximum` → the numeric form.
- Drop `example`, `xml` and `externalDocs`; keep `discriminator`.
- `readOnly` / `writeOnly` get request and response views:
  - in a request, readOnly properties are removed from `required`, and sending one is a warn;
  - writeOnly is handled the same way in responses.

### 2.4 Storage (migration 33)

```sql
CREATE TABLE api_specs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'mock',        -- mock = an API the app calls; app = the app's own API (response checks)
  prefix TEXT NOT NULL DEFAULT '',          -- below /mock/<project>/api (role=mock); unique per project among role=mock
  mode TEXT NOT NULL DEFAULT 'report',      -- off | report | strict
  openapi_version TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', api_version TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '{}',        -- {kind:'upload'|'url'|'inline', url?, filename?}
  document TEXT NOT NULL,                   -- normalized JSON (refs kept)
  options TEXT NOT NULL DEFAULT '{}',       -- {unknownParams:'ignore'|'warn', unknownFields:'ignore'|'warn', checkAuth:boolean, include:{tags?,paths?}}
  warnings TEXT NOT NULL DEFAULT '[]',
  operations INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (project_id, name));
CREATE INDEX idx_api_specs_project ON api_specs(project_id);
ALTER TABLE api_mocks ADD COLUMN spec_id TEXT REFERENCES api_specs(id) ON DELETE SET NULL;
ALTER TABLE api_mocks ADD COLUMN spec_operation TEXT;   -- "GET /users/{id}"
ALTER TABLE api_mocks ADD COLUMN spec_hash TEXT;        -- hash of the generated mock at last import (edit detection)
ALTER TABLE webhook_templates ADD COLUMN contract TEXT; -- {spec, operation?}; NULL = auto by URL
ALTER TABLE traffic_logs ADD COLUMN contract TEXT;      -- ContractResult JSON; NULL = not checked
ALTER TABLE traffic_logs ADD COLUMN contract_level TEXT;-- error|warn|info; NULL = clean or not checked
CREATE INDEX idx_logs_contract ON traffic_logs(project_id, contract_level) WHERE contract_level IS NOT NULL;
CREATE INDEX idx_logs_run_contract ON traffic_logs(run_id, contract_level) WHERE run_id IS NOT NULL AND contract IS NOT NULL;
```

Only the normalized JSON is stored, not the YAML.

### 2.5 Spec → mocks (`contracts/mapping.ts` + `contracts/examples.ts`)

- **One mock per operation.** `/users/{id}` becomes `prefix + /users/:id`; `{name}.{ext}` becomes `*.*`. The contract
  check extracts the real params with its own regex.
- **Order:** literal-first (`/users/me` before `/users/{id}`), then by path length; inserted after the existing mocks.
- **Name:** the `operationId`, or `METHOD path`. If taken, `<spec> · <name>`.
- **Description:** the summary plus "from spec <name>".
- **Scenarios, one per response code:**
  - named `"200 OK"` (status text, or the description trimmed to 40 characters);
  - `2XX` → 200, `4XX` → 400, `default` → `"default (500)"`;
  - named examples add scenarios `"200 · <name>"`, max 5 per code;
  - the active scenario is the lowest 2xx.
- **Body**, in order of preference:
  1. the media type's `example`;
  2. the first `examples[*].value`;
  3. the schema's `example`;
  4. generated from the schema.
- **The generator:**
  - prefers `const`, `default`, `enum[0]` or `examples[0]`;
  - then formats: uuid → `{{uuid}}`, date-time → `{{now}}`, email → `user@example.test`, uri → `https://example.test/x`;
  - then types: `"string"`, minimum or 0, `true`; arrays get one item, objects get all properties;
  - depth cap 6, cycle guard; `allOf` is merged; `oneOf` / `anyOf` take the first branch;
  - a string property named like a path param becomes `"{{params.<name>}}"`.
- **Headers:** `content-type` (prefer `application/json`), plus response headers that have an example.
- **Filters:** `include: {tags?, paths? (globs), operations?}`. The hard cap is 300 mocks per import; above it, 400
  "spec has N operations; pass include.tags/paths".
- **role=app** specs create no mocks. OAS 3.1 `webhooks` / `callbacks` are not mapped in this version.

### 2.6 Re-import

- **How:** POST with an existing `name` upserts; `POST /contracts/specs/:spec/reimport` fetches the URL again.
- **Diff by `spec_operation`:**
  - **new operation:** create the mock;
  - **changed operation, mock unedited** (content hash equals `spec_hash`): replace method, path, scenarios and
    description, keeping enabled, activeScenario (if it still exists), hits and position;
  - **changed operation, mock edited:** keep it and report it as `kept` (`overwriteEdited: true` replaces it);
  - **operation removed:** by default (`removeMissing: 'disable'`), disable the mock and add "(removed from spec)" to
    its description; `'delete'` and `'keep'` are also accepted.
- **`dryRun: true`** returns `{spec, create, update, kept, removed, warnings}` without writing. The dashboard always
  previews first.
- **Same document hash:** `{unchanged: true}`.

## 3. Contract checks, and the shape A2 queries

### 3.1 Types (`server/src/contracts/types.ts`)

```ts
export type ContractSeverity = 'error' | 'warn' | 'info';
export type ContractSubject = 'mock-request' | 'app-response' | 'provider-request';
export const CONTRACT_CHECKS = [
  { id: 'contract.unknown-operation', severity: 'error', label: 'Endpoint not in the spec' },
  { id: 'contract.method-not-allowed', severity: 'error', label: 'Method not in the spec' },
  { id: 'contract.param', severity: 'error', label: 'Parameter invalid or missing' },
  { id: 'contract.unknown-param', severity: 'warn', label: 'Undeclared parameter' },
  { id: 'contract.content-type', severity: 'error', label: 'Content type not accepted' },
  { id: 'contract.body-missing', severity: 'error', label: 'Required body missing' },
  { id: 'contract.body', severity: 'error', label: 'Body does not match the schema' },
  { id: 'contract.unknown-field', severity: 'warn', label: 'Undeclared body field' },
  { id: 'contract.read-only', severity: 'warn', label: 'readOnly field sent' },
  { id: 'contract.auth-missing', severity: 'warn', label: 'Credentials missing' },
  { id: 'contract.deprecated', severity: 'warn', label: 'Deprecated operation / parameter / field used' },
  { id: 'contract.response-status', severity: 'error', label: 'Status not declared' },
  { id: 'contract.response-body', severity: 'error', label: 'Response body does not match' },
  { id: 'contract.response-header', severity: 'warn', label: 'Response header missing / invalid' },
  { id: 'contract.unchecked', severity: 'info', label: 'Could not be checked' },
] as const;
export type ContractCheckId = (typeof CONTRACT_CHECKS)[number]['id'];
export interface ContractIssue {
  check: ContractCheckId; severity: ContractSeverity; side: 'request' | 'response';
  where: 'path' | 'query' | 'header' | 'cookie' | 'body' | 'status' | 'content-type' | 'auth' | 'operation';
  name?: string; pointer?: string; message: string;
  actual?: string;   // <=80 chars, never credentials, card-like digits masked on /pay
  expected?: string;
}
export interface ContractResult {            // stored in traffic_logs.contract
  v: 1; subject: ContractSubject; source: 'spec' | 'provider';
  spec: { id: string; name: string; version: string } | null;
  provider: { preset: string; instance: string } | null;
  operation: { key: string; operationId: string | null; deprecated: boolean } | null;
  mode: 'report' | 'strict'; enforced: boolean; level: ContractSeverity | null;
  counts: { error: number; warn: number; info: number };
  issues: ContractIssue[]; truncated?: boolean;   // max 50 issues
}
```

The same file also holds `SpecDocument`, `CompiledOperation {key, method, pathTemplate, regex, paramNames,
parameters, requestBody, responses, security, deprecated, operationId}` and `CompiledSpec`.

### 3.2 Traffic shape (`repos/logs.ts`)

- `TrafficLog` gains `contract` and `contractLevel`.
- `TrafficLogSummary` gains `contractLevel` and `contractIssues: number`, without the `contract` blob.
- `LogPatch` gains `contract` and `contractLevel` (`contract` goes in `JSON_FIELDS`).
- `LogQuery.contract?: 'checked' | 'issues' | 'error' | 'warn'`.
- **Outcome:** report mode keeps the outcome; a strict-mode 400 sets `invalid`.

### 3.3 The A2 interface (`server/src/contracts/report.ts`)

```ts
export interface ContractViolation {
  logId: string; receivedAt: string; method: string | null; url: string | null;
  subject: ContractSubject; spec: string | null; provider: string | null; operation: string | null;
  level: ContractSeverity; issues: ContractIssue[];
}
export interface ContractSummary {
  checked: number; withIssues: number; error: number; warn: number; info: number;
  byCheck: { check: ContractCheckId; label: string; count: number }[];
  bySource: { spec: string | null; provider: string | null; checked: number; withIssues: number }[];
  violations: ContractViolation[];   // newest first, limit default 50, max 500
}
export function contractSummary(hub: Hub, projectId: string,
  opts?: { runId?: string; since?: string; minLevel?: ContractSeverity; spec?: string; subject?: ContractSubject; limit?: number }): ContractSummary;
```

- **A2 expectation kind:** `{kind: "contract", maxLevel: "warn", spec?}`. It fails on any violation above `maxLevel`,
  with the violations' `logId`s as evidence.
- **A2 default check:** `contract` with `maxLevel: 'warn'`.
- **REST:** `GET /api/projects/:slug/contracts/issues?run=&since=&level=&spec=&subject=&limit=`.
- **Ownership:** C1 does not edit `runs/report.ts` or the verdict files. Whichever of A2 and C1 lands second adds the
  `contract` kind or default and a `contract: {checked, withIssues, error, warn}` block in the run report.

### 3.4 Request checks for spec-backed mocks (`contracts/validate.ts`, `contracts/runtime.ts`)

- **Which spec:** for each `/mock/<p>/api/...` request, the role=mock spec with the longest matching `prefix` whose
  mode is not `off`. This doesn't depend on which mock answered.
- **Operation lookup:** compiled regexes, literal-first. A wrong method gives `method-not-allowed`; no match gives
  `unknown-operation`, which is also recorded on the handler's 404 branch.
- **Parameters** (path, query, header, cookie):
  - coerced by type: integer `^-?\d+$`, number, boolean;
  - arrays use `style: form`, with explode true (repeated keys) or false (comma-separated); bracket keys mean
    deepObject; path and header use `simple`; `content` params are parsed as JSON;
  - required checks; header names are case-insensitive; `Accept`, `Content-Type` and `Authorization` params are
    ignored;
  - undeclared ones give `unknown-param` when `options.unknownParams = 'warn'` (the default in strict mode).
- **Body:**
  - `body-missing` when required; content type with wildcards and `+json`;
  - JSON via `validateSchema(schema, body, 50, {root: doc, oneOf: 'lenient'})`, with the path becoming the pointer;
  - form via `parseBracketForm`, then coerced, then validated;
  - multipart: required part names only; binary: content type only; invalid JSON gives `contract.body`.
- **Unknown fields** (warn): a walker over `properties`, `allOf`, `$ref` and the matching `anyOf` / `oneOf` branch. It
  skips `additionalProperties` / `patternProperties`, and is on by default in strict mode.
- **`deprecated`** gives a warn, and so does **`auth-missing`** (apiKey header/query/cookie or http bearer/basic,
  checking presence only).
- **Strict mode:** the spec's `mode: 'strict'`, or the per-request header `X-Hub-Contract: strict|report|off`. On any
  error-level issue, answer 400 (401 when the only errors are auth) with:

  ```json
  { "error": "Request does not match the OpenAPI contract", "spec": "crm", "operation": "POST /users",
    "issues": [ ... ], "requestId": "<log id>", "hint": "Contract mode is strict. Send X-Hub-Contract: report to only record issues." }
  ```

  and set outcome `invalid`. The check runs after run attribution and before the scenario plays.
- **Recording:** `recordContract(hub, logId, result)` → `hub.traffic.update(logId, {contract, contractLevel})`, which
  publishes `log.updated`. It also merges `resolved.contract = {spec, operation, level}`.

### 3.5 The app's responses to stubyard calls

- **Specs with role `app`:** no mocks are created.
- **Hook:**
  - `TrafficLogger` gains an `outboundObserver?: (req: OutboundRequest, res: {logId, status, headers, text}) =>
    void`, set per hub;
  - `sendOutbound` calls it after `traffic.finish` (any status) inside try/catch, with the full text;
  - the hub sets it to `contracts.checkAppResponse`.
- **Matching:**
  1. the explicit `OutboundRequest.contract = {spec, operation?}`, which `WebhookService.dispatch` fills from
     `tpl.contract`;
  2. otherwise auto-match: for each role=app spec, strip each `servers[].url` path (and also try without stripping),
     then match method + path;
  3. no match means no check.
- **Checks:**
  - the status must be declared (exact, then `NXX`, then `default`), otherwise `response-status`;
  - the body against the schema for its content type (`response-body`);
  - required headers (`response-header`).
- There is no strict mode for responses.

## 4. Provider strict mode for the built-in fakes

- **Approach:** curated per-endpoint contracts as code in `server/src/contracts/providers/<preset>.ts`, each a JSON
  Schema subset with a provenance comment. Vendor specs are not vendored.
- **Interfaces:**

  ```ts
  export interface ProviderOperation { method: string; path: string; operationId: string; encoding: 'json' | 'form';
    query?: JsonSchema; body?: JsonSchema; deprecated?: string[]; source: string }
  export interface ProviderContract { preset: string; operations: ProviderOperation[];
    strictError(issues: ContractIssue[], op: ProviderOperation): { status: number; headers?: Record<string, string>; body: unknown } }
  ```

- **Instance flag:** `config.contract: 'off' | 'report' | 'strict'` (default `off`; `strict: true` is an alias), on
  payment and messaging instances, with no migration.
- **Hooks:** payments in `withCheckoutKit`'s route in `payments/presets.ts`, before `g.route(c)`; messaging in
  `simulator.handleMock` after `adapter.match`. Both record with `subject 'provider-request'` and
  `source 'provider'`.
- **Phase 1:**
  - **Stripe:** payment_intents create, confirm and capture, checkout sessions, refunds. Form-encoded, amount integer.
    Errors: `400 {error:{type:'invalid_request_error', code:'parameter_unknown'|'parameter_invalid_integer', param,
    message}}`.
  - **PayPal:** Orders v2 create, capture and authorize. `amount.value` is a decimal string, `currency_code` 3
    letters. Errors: `400 {name:'INVALID_REQUEST', details:[{field, issue}]}`.
  - **Moyasar:** `/v1/payments` and `/v1/invoices`. Amount must be an integer in halalas. Errors: `400
    {type:'invalid_request_error', message, errors:{amount:[…]}}`.
  - **Twilio:** Messages.json, form-encoded, `To` required, `From` or `MessagingServiceSid` required. Errors: `400
    {code:21604, message, more_info, status:400}`.
- **Phase 2:** SendGrid, Resend, OpenAI, Checkout.com, Meta WhatsApp. **Phase 3:** the other gateways.

## 5. REST (`server/src/http/routes/contracts.ts`)

- **Base:** `/api/projects/:slug/contracts`.
- **Permissions:** an AREAS line `{route: `${B}/contracts`, read: 'project.view', write: 'project.providers'}`, plus
  EXACT `POST ${B}/contracts/check` → `project.view`.

| Method | Path | Notes |
|---|---|---|
| GET | `/contracts/specs` | list without `document`: mock count, issues in the last 24 h, `mockBaseUrl` |
| POST | `/contracts/specs` | `{spec?, url?, name?, role?, prefix?, mode?, options?, include?, dryRun?, overwriteEdited?, removeMissing?}`; 201 or 200 `{spec, plan, warnings}` |
| GET | `/contracts/specs/:spec` | `?document=1`; operations list |
| PATCH | `/contracts/specs/:spec` | mode, prefix, role, options, name |
| POST | `/contracts/specs/:spec/reimport` | |
| DELETE | `/contracts/specs/:spec` | `?mocks=keep\|delete` (default keep) |
| POST | `/contracts/check` | a request or a response dry run, nothing logged |
| GET | `/contracts/issues` | `ContractSummary` |
| GET | `/contracts/checks` | the `CONTRACT_CHECKS` catalog |

- `/api/logs?contract=`.
- Mock responses gain `specId`, `specOperation` and `specEdited`.
- Webhook templates accept `contract: {spec, operation?} | null`.
- `config.contract` is validated on instance PATCH.
- Bus event `contracts.changed`; an import also publishes `mocks.changed`.

## 6. MCP (`server/src/contracts/mcp-tools.ts`, all `call` tools)

- `import_openapi`, `list_api_specs`, `get_api_spec`, `set_contract_mode`, `reimport_openapi`.
- `delete_api_spec` (destructiveHint).
- `check_contract` and `get_contract_issues` (readOnly).
- `get_traffic` gains a `contract` param.

## 7. Dashboard

- **Mocks page:**
  - an "Import OpenAPI" button opens a drawer (`components/SpecImport.tsx`) with File, URL and Paste tabs, the fields
    name, prefix, mode, role and tag filter, a Preview (dry-run table) and Import;
  - an "API specs" card: one row per spec with title + version, operation count, prefix, the copyable base URL, a mode
    select, "N issues (24 h)" linking to traffic `contract=issues`, Re-import and Delete;
  - mock rows get a spec chip and an "edited" badge.
- **Traffic:** a contract badge on rows, a "Contract issues" filter option, and a Contract section in the log drawer
  (`components/ContractIssues.tsx`).
- **Webhooks page:** an "Your app's API spec" card (`role=app`) and a Contract select on templates.
- **Provider strict mode:** set through the API and MCP in phase 1.
- **Client package:**
  - `web/src/contractsApi.ts`;
  - `packages/client/src/contracts.ts`: `importOpenApi`, `contractIssues`, and `expectNoContractIssues`, which throws
    listing up to 10 issues with log ids.

## 8. Export / import

- **`apiSpecs` section** before `mocks`; it maps ids with `ctx.ids.set('specs', …)`.
- **`mocks` section:** exports `specId`, `specOperation` and `specHash`, mapped on import.
- **Templates:** `contract` names the spec by name.
- **Version:** `EXPORT_VERSION` stays at 1.

## 9. Docs

- **`docs/AGENT_GUIDE.md`:** a new section "OpenAPI contracts" (the next free letter), covering:
  - import, prefix and base URL, modes, `X-Hub-Contract`, the issue shape, `get_contract_issues`;
  - app response checks, provider strict mode, and the limits (local refs only, 300 operations, 10 MB);
  - a recipe: import → run tests → `get_contract_issues {run}` → fix;
  - a feature-status row, and cross-links from the API mocks and traffic sections.
- **`CHANGELOG.md`:** under `## Unreleased` / `### Added`, plus "Migration 33: …".
- **`docs/GUIDE.md`:** a paragraph.

## 10. Tests

- **`contracts-openapi.unit.test.ts`:** YAML/JSON detection, 3.0/3.1, Swagger 2 rejected, nullable and exclusive*,
  local refs, a cyclic schema, the external-ref warning, path conversion, ordering, the cap, `include`.
- **`contracts-mapping.unit.test.ts`:** example precedence, generator guards, scenarios per code, `{{params.id}}`, the
  re-import diff and edit detection.
- **`schema-options.unit.test.ts`:** `root`, lenient oneOf + discriminator, the regex cache, the long-string pattern
  skip, int32/int64, webhook behaviour unchanged (`webhooks.e2e` and `redos-linear` still pass).
- **`contracts-validate.unit.test.ts`:**
  - params: coercion, explode, deepObject, a case-insensitive required header, path type;
  - bodies: JSON pointer errors, form bodies, content-type wildcards;
  - unknown-field off by default and quiet on allOf; lenient oneOf;
  - readOnly, deprecated, auth-missing; response `default` and body mismatch.
- **`contracts.e2e.test.ts`:**
  - YAML import with a dry run, then the mocks exist;
  - a bad body gives 200 + an error-level log, listed in `/contracts/issues`;
  - issues by run (`X-Hub-Run`);
  - strict mode gives 400 `invalid`, and `X-Hub-Contract: report` overrides it;
  - an unknown path gives 404 + `unknown-operation`;
  - `/api/logs?contract=issues`;
  - re-import keeps the edited mock and disables the removed operation;
  - URL import from a local server, and a 169.254.x URL refused;
  - an export → import round trip;
  - MCP `import_openapi`, `get_contract_issues` and `check_contract`;
  - delete with `mocks=keep`.
- **`contracts-outbound.e2e.test.ts`:** a local app answers a template with a wrong body or status → `app-response`
  issue; the template override; a payment webhook auto-match; an unmatched URL is not checked.
- **`contracts-providers.e2e.test.ts` (phase 1):**
  - Stripe strict: `amount: "150.00"` gives 400 `parameter_invalid_integer`; an unknown param gives
    `parameter_unknown`;
  - report mode gives 200 + an issue; `off` records nothing;
  - Moyasar, PayPal, Twilio.
- **`access.e2e.test.ts`** stays green.

## 11. Slices (~30 min; no two slices in the same wave edit the same file)

| Wave | Slice | Owns | Needs |
|---|---|---|---|
| 0 | S0 Types + migration + log shape | contracts/types.ts (new), db/migrations.ts (v33), repos/logs.ts, test contracts-logs.unit.test.ts | – |
| 1 | S1a OpenAPI loader | server/package.json + package-lock.json (`yaml`), contracts/openapi.ts (parse, detect, normalize, compileSpec, deref), contracts-openapi.unit test | S0 |
| 1 | S1b Validator options | webhooks/schema.ts, schema-options.unit test | – |
| 1 | S2 Mapping + examples | contracts/examples.ts, contracts/mapping.ts (`specToMocks`, `planReimport`), contracts-mapping.unit test | S0 |
| 1 | S4 Storage | contracts/repo.ts (SpecRepo), repos/mocks.ts (spec fields, setSpecLink, content hash), repos/webhooks.ts (template `contract`) | S0 |
| 2 | S3 Validator | contracts/validate.ts (`validateRequest`, `validateResponse`, unknown-field walker, coercion), contracts-validate.unit test | S0, S1b |
| 2 | S5a Service | contracts/service.ts (import/reimport/dry run/delete, compiled cache, `specForMockPath`, `appSpecsFor`; the constructor calls `installObserver(hub)` from runtime.ts, stubbed until S5b), contracts/fetch.ts, contracts/report.ts, hub.ts, index.ts | S1a, S2, S4 |
| 3 | S5b Runtime | contracts/runtime.ts (`checkMockRequest`, `checkAppResponse`, `recordContract`, strict reply, masking, `installObserver`), mocks/handler.ts, traffic/logger.ts (`outboundObserver`), traffic/outbound.ts, webhooks/service.ts | S3, S5a |
| 3 | S6 REST | routes/contracts.ts, http/app.ts, access/permissions.ts, routes/api.ts (`/api/logs?contract=`), routes/mocks.ts (`specEdited`) | S5a |
| 3 | S12 Export | maintenance/export.ts | S4 |
| 4 | S7 MCP + client | contracts/mcp-tools.ts, routes/mcp.ts, packages/client/src/contracts.ts, packages/client/src/index.ts | S6 |
| 4 | S8 Web mocks | web/src/contractsApi.ts, components/SpecImport.tsx, pages/MocksPage.tsx, web/src/hooks.ts | S6 |
| 4 | S9 Web traffic | web/src/api.ts (log types and the ContractIssue/ContractResult web types; S8 imports them from here), components/TrafficLog.tsx, components/ContractIssues.tsx | S6 |
| 4 | S13a e2e mocks | server/test/contracts.e2e.test.ts | S5b, S6, S12 (MCP cases after S7) |
| 4 | S13b e2e outbound | server/test/contracts-outbound.e2e.test.ts | S5b, S6 |
| 5 | S10 Web webhooks | web/src/pages/WebhooksPage.tsx | S8 |
| 5 | S11a Providers: framework + Stripe | contracts/providers/index.ts, providers/stripe.ts, payments/presets.ts, contracts-providers.e2e test | S3, S5b |
| 5 | S11b PayPal + Moyasar | providers/paypal.ts, providers/moyasar.ts, appends to the providers test | S11a |
| 5 | S11c Twilio | providers/twilio.ts, messages/simulator.ts, contracts-providers-sms.e2e test | S11a |
| 5 | S14 Docs | docs/AGENT_GUIDE.md, CHANGELOG.md, docs/GUIDE.md | last |

## 12. Decisions

1. **Migration:** 33 (reserved).
2. **Specs:** a separate `api_specs` record linked from mocks, distinguished by `prefix`. No mock collections.
3. **Default mode for an imported spec:** `report`.
4. **Default for provider contracts:** `off`.
5. **Unknown params and fields:** ignored in report mode, warned in strict mode, configurable per spec (Stripe's
   contract uses `additionalProperties: false`).
6. **OAS 3.1 webhooks / callbacks → templates:** phase 2.
7. **Strict-mode error body:** the stubyard shape (a spec-example body is a later option).
8. **ajv:** not now.
9. **`actual`:** at most 80 characters, never auth or cookie values, card digits masked.
10. **URL import:** not subject to the outbound allowlist; the SSRF limits apply instead, plus
    `STUBYARD_SPEC_FETCH=0`.
11. **Run report integration:** done by whichever of A2 / C1 lands second (§3.3).
