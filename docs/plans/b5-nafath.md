# B5: Nafath, the Saudi national SSO (implementation plan)

Spec: `docs/plans/feature-ideas-2026-11-24.md` §B5 and its "Related" line. Research: `docs/plans/research-nafath.md`.
**Migration 34 is reserved for B5** (A2 = 32, C1 = 33, B6 = 35).

## 1. What we build

The real flow:
1. The app sends a national ID to Nafath and gets back a `transId` and a 2-digit `random`.
2. The person opens the Nafath app, picks the matching number, and approves or rejects.
3. The app polls `/status` or receives a signed callback (a JWT verified against Nafath's JWK set).

In stubyard:
- **Test users** get a national ID or Iqama number plus optional identity attributes.
- **A Nafath instance** is a fake Nafath MFA API at `/nafath/<project>/<instance>/…`, on the real paths. Host mode also
  accepts `nafath.api.elm.sa` and `rabet-nafath.api.elm.sa`.
- **The "Nafath app"** can be any of these:
  - a card in the user's workspace on the dashboard;
  - a prompt in the extension's walkthrough widget or side panel;
  - the MCP tool `approve_nafath`;
  - an auto-decision with a delay.
- **The card** shows three numbers: the right one approves, Reject rejects, and a wrong one fails the request.
- **Callbacks** are RS256 JWTs signed with a key per instance, served at `/api/v1/mfa/jwk`.
- **Fault rules:** `rejected`, `expired`, `wrong_number`, `already_active`, `down`, `timeout`, `slow`, `rate_limit`,
  `invalid_credentials`, `bad_signature`, `unknown_kid`, `no_callback`, `duplicate_callback` and `approve:<ms>`.

## 2. Architecture: its own module (like Push), not a login preset

`PresetDef` is built around OAuth (authorize and token, clients, PKCE), Nafath needs a transactions table anyway, and
the global `auth_rules` actions don't fit its outcomes.

- **Template:** Push (`server/src/push/*`), which has instances, records, fault rules, `export.ts`, `mcp-tools.ts`,
  `host.ts` and its own route prefix.
- **Reused:** `auth/keys.ts` (`generateSigningKey`) and `auth/jwt.ts` (`signJwt`, `corruptSignature`, `b64u`).
- **New module:** `server/src/nafath/`, with `types`, `repo`, `service`, `faults`, `claims`, `callbacks`, `host`,
  `export`, `guide`, `mcp-tools` and `national-id`.
- **Exception:** UAE Pass is OIDC, so it becomes a normal login preset (L5).

## 3. Data (migration 34)

```sql
ALTER TABLE test_users ADD COLUMN national_id TEXT;            -- 10 digits; 1… citizen (nin), 2… resident (iqamaNumber)
ALTER TABLE test_users ADD COLUMN identity TEXT NOT NULL DEFAULT '{}'; -- firstNameAr, fatherNameAr, grandFatherNameAr, familyNameAr,
                                                                -- englishFirstName…LastName, dateOfBirthG, gender (M/F), nationalityCode,
                                                                -- idExpiryDateG, isMinor; later emiratesId, crNumbers[], address{}
CREATE UNIQUE INDEX idx_test_users_national_id ON test_users(project_id, national_id) WHERE national_id IS NOT NULL;
CREATE TABLE nafath_instances (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, name TEXT NOT NULL, preset TEXT NOT NULL DEFAULT 'nafath',
  app_id TEXT NOT NULL UNIQUE, app_key TEXT NOT NULL,         -- APP-ID unique across the hub (host mode finds the instance by it)
  config TEXT NOT NULL DEFAULT '{}',                           -- callbackUrl, ttlSeconds(200), autoDecision, autoDelayMs, services[], callbackFields, …
  keys TEXT NOT NULL DEFAULT '[]',                             -- [{kid, privatePem, publicJwk, status, createdAt}]
  strict INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  UNIQUE (project_id, slug));
CREATE TABLE nafath_requests (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES nafath_instances(id) ON DELETE CASCADE,
  test_user_id TEXT REFERENCES test_users(id) ON DELETE SET NULL, run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  trans_id TEXT NOT NULL UNIQUE, random TEXT NOT NULL, choices TEXT NOT NULL DEFAULT '[]',
  national_id TEXT NOT NULL, service TEXT, locale TEXT, request_id TEXT,
  status TEXT NOT NULL DEFAULT 'WAITING',                      -- WAITING | COMPLETED | REJECTED | EXPIRED
  reason TEXT,                                                 -- rejected | wrong_number | expired | rule:<id> | auto
  decided_by TEXT, chosen TEXT, token TEXT, callback TEXT NOT NULL DEFAULT '[]',
  log_id TEXT, polls INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT);
CREATE INDEX idx_nafath_requests_project ON nafath_requests(project_id, created_at);
CREATE INDEX idx_nafath_requests_user ON nafath_requests(test_user_id, status);
CREATE TABLE nafath_rules (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE, instance_id TEXT,
  match TEXT NOT NULL DEFAULT '{}',                            -- {user, nationalId, service}
  fault TEXT NOT NULL, remaining INTEGER, hits INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
```

**National IDs** (`nafath/national-id.ts`):
- 10 digits with a Luhn check digit (the public validators' rule; not checked against an official source).
- `1…` is a citizen (claim `nin`) and `2…` is a resident (claim `iqamaNumber`).
- `UserRepo.generate()` gives every new user an ID: customers alternate citizen and resident, staff are citizens.
- Existing users get IDs when the project's first Nafath instance is created (`ensureNationalIds(projectId)`). There is
  no SQL backfill.

**`UserRepo.resolve()` pitfall:** a 10-digit ID matches the phone regex today. Check `/^[12]\d{9}$/` against
`national_id` **before** the phone lookup. Also add `findByNationalId()` and extend `checkUnique` to `national_id`.

## 4. Endpoints

### 4.1 Fake Nafath (app-facing, open route prefix `/nafath/`)

`B = /nafath/<project>/<instance>`. `B/nafath-sandbox/…` and `B/stg/…` are accepted too.

| Real call | Notes |
|---|---|
| `POST /api/v1/mfa/request?local=ar&requestId=<uuid>`, body `{nationalId, service}` | Headers `APP-ID`, `APP-KEY` and `X-Forwarded-For` (strict warns when it's missing). 200 `{transId (uuid), random (2-digit string)}` |
| `POST /api/v1/mfa/request/status`, body `{nationalId, transId, random}` | 200 `{status}`: WAITING, COMPLETED, REJECTED or EXPIRED. Expiry is checked on read against the **auth** clock, default 200 s |
| `GET /api/v1/mfa/request/info?transId&random&nationalId` | 200 `{status, transId, person:{…claims}}` once COMPLETED, otherwise a 400 |
| `GET /api/v1/mfa/jwk` | `{keys:[{kty:'RSA',use:'sig',alg:'RS256',kid,n,e}]}`; retired keys stay listed until dropped |
| unknown path | 404 `{"message":"No Mapping Rule matched"}` |

**Errors** use the body `{code, message, reference}`:
- `400-034-050`: a transaction is already active for this ID;
- `400-034-051`: expired;
- `400-034-053`: not found;
- 403: wrong APP-ID or APP-KEY;
- `401-033-024`: not approved yet (web flow, L7).

**Lax vs strict:**
- Lax (the default) accepts any credentials and an unknown ID. An unknown ID gives an unassigned request, shown on the
  instance's Requests list, and the problem is noted in `resolved.warnings`.
- Strict answers with the errors above.
- In both modes, a second request while one is WAITING gives `400-034-050`.

**Host mode** (`nafath/host.ts`, like `push/host.ts`): `nafath.api.elm.sa` and `rabet-nafath.api.elm.sa` go to
`/nafath/_host/…`, and the instance is found by `APP-ID`.

### 4.2 Control API (`/api/projects/:slug/nafath`)

- **Overview:** `GET /nafath` returns the instances and reference data (faults, statuses, error codes).
- **Instances:**
  - `POST /nafath/instances`; `GET` / `PATCH` / `DELETE /nafath/instances/:instance`;
  - `POST …/:instance/keys/rotate {dropOld}`;
  - `GET …/:instance/connect`.
- **Requests:**
  - `GET /nafath/requests?user&status&run&limit`;
  - `GET /nafath/requests/wait?user&nationalId&after&timeout` (long poll);
  - `GET /nafath/requests/:id`.
- **Decisions:**
  - `POST /nafath/requests/:id/choose {number}`: the right number gives COMPLETED, a wrong one REJECTED with reason
    `wrong_number`;
  - `POST …/:id/approve` and `POST …/:id/reject`;
  - `POST …/:id/callback/resend`.
- **Other:**
  - `POST /nafath/requests {user, instance, service}` starts a request without the app;
  - `DELETE /nafath/requests?user&run` resets;
  - `GET` / `POST` / `DELETE /nafath/faults`.
- **Permissions:**
  - `${B}/nafath`: read `project.view`, write `project.providers`;
  - `${B}/nafath/requests`: read `project.view`, write `walkthroughs.run`;
  - `'/nafath/'` in `OPEN_ROUTE_PREFIXES`.
- **Event:** `'nafath.changed'` on every create, decision, expiry and callback.

### 4.3 Callbacks

- **When:** on COMPLETED or REJECTED, if `config.callbackUrl` is set.
- **Body:** POST JSON `{transId, requestId, status, token}`; `config.callbackFields: "compat"` adds `transactionId`.
- **Delivery:** `sendOutbound` (allowlist, traffic `purpose: "Nafath callback"`) through `hub.schedules`, with the
  allowlisted action `nafath.callback` (`POST /nafath/requests/:id/callback/deliver`). Retries at 5 s, 30 s and 120 s.
- **Token:** RS256 with header `{alg, kid, typ:'JWT'}`. Payload:

```json
{ "iss": "<B>", "aud": "<APP-ID>", "iat": 0, "exp": 0, "jti": "…",
  "status": "COMPLETED", "transId": "…", "requestId": "…", "service": "…",
  "nin": "1…", "iqamaNumber": "2…",
  "firstName": "…", "fatherName": "…", "grandFatherName": "…", "familyName": "…",
  "englishFirstName": "…", "englishSecondName": "…", "englishThirdName": "…", "englishLastName": "…",
  "nationality": "…", "nationalityCode": "SA", "dateOfBirthG": "dd-MM-yyyy", "gender": "M",
  "idExpiryDateG": "…", "isMinor": false }
```

- **Claims:**
  - only one of `nin` / `iqamaNumber`, picked by the first digit;
  - built in `nafath/claims.ts` from `user.identity`, with defaults derived from the name;
  - REJECTED carries a signed token with `status: "REJECTED"` and no person claims;
  - EXPIRED sends no callback (`config.callbackOnExpired` opts in).
- **Faults:** `bad_signature` corrupts the signature; `unknown_kid` signs with a kid not in the JWK set;
  `no_callback` and `duplicate_callback` do what they say.

## 5. The "Nafath app" UX

1. **User workspace** (`web/src/pages/UserWorkspace.tsx`):
   - a `NafathCard` quick card: with a WAITING request it shows the service, a countdown, three number buttons and
     Reject; otherwise a hint and the national ID;
   - a "Nafath" tab with the history (status, reason, decided by, callback attempts, decoded token);
   - the header shows "National ID" or "Iqama";
   - the user form (`components/users.tsx`) gets National ID and an identity JSON editor.
2. **Providers → Nafath category** (`web/src/components/NafathProviders.tsx`, appended like `PUSH_CATEGORY`):
   - instances: URLs, APP-ID / APP-KEY, callback URL, TTL, auto-decision, strict, key rotation, faults;
   - a Requests table with actions (including unassigned requests).
3. **Extension** (`packages/extension/src/run/NafathPrompt.tsx`):
   - shown above the step card in the widget and in the side panel's Walkthrough screen;
   - visible while one of the walkthrough's actors has a WAITING request;
   - polls every 2 s, only while a walkthrough is active.
4. **Agents:** MCP `approve_nafath`.
5. **Auto-decision:**
   - instance config `autoDecision: 'none'|'approve'|'reject'|'wrong_number'|'expire'` with `autoDelayMs` (default
     3000), using the allowlisted schedule action `nafath.decide`;
   - rules `approve:<ms>` / `rejected:<ms>` per user or run;
   - the default is `none`.

## 6. MCP tools (`server/src/nafath/mcp-tools.ts`, all composite, each with a COMPOSITE_ROUTE line)

| Tool | Route line |
|---|---|
| `list_nafath_requests {project, user?, status?, run?, limit?}` | `['GET', `${P}/nafath/requests`]` |
| `wait_for_nafath_request {project, user?, national_id?, after?, timeout_seconds?, run?}` | `['GET', `${P}/nafath/requests/wait`]` |
| `approve_nafath {project, user?\|id?, decision: approve\|reject\|wrong_number, number?, wait_seconds?}` | `['POST', `${P}/nafath/requests/x/choose`]` |
| `set_nafath_fault {project, fault, instance?, user?, national_id?, times?, run?}` (`none` clears) | `['POST', `${P}/nafath/faults`]` |
| `reset_nafath {project, user?, run?}` | `['DELETE', `${P}/nafath/requests`]` |
| `create_nafath_instance {project, slug?, callback_url?, auto_decision?, strict?}` | `['POST', `${P}/nafath/instances`]` |

`upsert_test_user` in `storyboards/mcp-tools.ts` gains `national_id`.

## 7. Connect snippets (`nafath/guide.ts` → `setupGuide()` sections `nafath-<instance>`)

- **Env:** `NAFATH_BASE_URL`, `NAFATH_APP_ID`, `NAFATH_APP_KEY` and `NAFATH_JWK_URL`, with hosts from `hostVariants`.
- **Node `fetch` example:** request → poll → verify with `jose` `createRemoteJWKSet`.
- **Laravel `devmahmoudmustafa/laravel-nafath`:** the endpoint overrides.
- **`hamada-emam-tech/nafath-php`:** the base URL.
- **Callback:** a note that stubyard calls the instance's callback URL (Elm registers it in real Nafath).
- **Host mode:** the hosts entry plus the CA.

## 8. Slices

| Slice | Depends | Owns | Delivers / tests |
|---|---|---|---|
| S1 Data: national ID | – | db/migrations.ts (v34, all §3 tables), repos/users.ts, nafath/national-id.ts, routes/api.ts (user create/patch/generate pass `nationalId`, `identity`), maintenance/export.ts (users section), packages/client/src/users.ts (type) | generator and checksum; `resolve()` by ID before phone; uniqueness 409; export round-trip. `server/test/nafath-users.e2e.test.ts` |
| S2a Core service | S1 | nafath/{types,repo,faults,claims,service}.ts | instances (APP-ID/KEY, keys), lifecycle, three choices, lazy expiry on the auth clock, already_active, rules (skip and consume like push), claims and JWT. `server/test/nafath.unit.test.ts` |
| S2b HTTP + wiring | S2a | http/routes/nafath.ts, hub.ts, index.ts, http/app.ts, access/permissions.ts, events.ts | §4.1/§4.2 routes, prefix aliases, error and 404 bodies, run attribution, traffic `resolved.kind='nafath'`. `server/test/nafath.e2e.test.ts` (request → WAITING → choose → COMPLETED; the JWK verifies; strict 403; `400-034-050`; expiry via a time offset) |
| S2c Callbacks + auto-decision | S2b | nafath/callbacks.ts, nafath/service.ts, schedules/actions.ts (`nafath.callback`, `nafath.decide`), routes/nafath.ts | signed callback to a local server, retries, all faults, autoDecision. `server/test/nafath-callback.e2e.test.ts` |
| S2d Host, export, retention, Connect | S2c | nafath/{host,export,guide}.ts, http/app.ts (rewriteUrl), setup/guide.ts, maintenance/retention.ts, index.ts | export (APP-KEY and keys only with `?secrets=1`, otherwise regenerated with a warning). `server/test/nafath-ops.e2e.test.ts` |
| S3 MCP | S2c | nafath/mcp-tools.ts, routes/mcp.ts, storyboards/mcp-tools.ts | `server/test/nafath-mcp.e2e.test.ts`; access.e2e stays green |
| S4 Client | S2c | packages/client/src/nafath.ts, packages/client/package.json (`./nafath`), index.ts | list, wait, approve, reject, choose, fault. `server/test/nafath.sdk.test.ts` |
| S5 Providers UI | S2d | web/src/nafathApi.ts, components/NafathProviders.tsx, pages/ProvidersPage.tsx, nav.ts | instance CRUD, Connect, faults, Requests, live updates |
| S6 Inbox card + user form | S5 | components/NafathCard.tsx, pages/UserWorkspace.tsx, components/users.tsx, web/src/api.ts | card, tab, national ID |
| S7 Extension prompt | S4 | packages/extension/src/run/NafathPrompt.tsx, widget/WidgetCard.tsx, sidepanel/screens/Walkthrough.tsx, widget/widget.css | prompt for walkthrough actors |
| S8 Docs | all | docs/AGENT_GUIDE.md (Nafath section, status table, MCP list), docs/GUIDE.md, CHANGELOG.md (`## Unreleased` / `### Added`, migration 34 line), README.md | |

Order: S1, then S2a → S2b → S2c, then S2d ∥ S3 ∥ S4, then S5 → S6 and S7 (after S4), and S8 last.

### Related (later slices; "Related" in the spec)

| Slice | Owns | Notes |
|---|---|---|
| L1 Mock template packs + per-user data | mocks/templates/index.ts, mocks/match.ts (`{{user.*}}`), mocks/handler.ts (`match.userBy`), routes/mocks.ts (`GET /api/mock-templates`, `POST …/mocks/templates/:id`), permissions.ts, MocksPage.tsx, mcp.ts (`apply_mock_template`) | needs S1 and S3 |
| L2 Yakeen | mocks/templates/yakeen.ts | research first (access is gated, possibly SOAP) |
| L3 Wathq | mocks/templates/wathq.ts | `GET /commercialregistration/info/{id}` and `/fullinfo/{id}`, `apiKey` header |
| L4 National Address | mocks/templates/national-address.ts | v3.1 `address-free-text`, `address-geocode`, by phone; `api_key`; `language=A/E` |
| L5 UAE Pass | auth/presets/uaepass.ts, presets/index.ts, auth-uaepass test | OIDC `/idshub/authorize`, `/idshub/token`, `/idshub/userinfo`; scope `urn:uae:digitalid:profile:general` |
| L6 Absher / Elm OTP | nafath/elm-otp.ts | no public spec; research first |
| L7 Nafath web flow | nafath/web.ts | `GET /api/v2/oidc/session`, `POST /api/v2/oidc/jwt {state}`, `401-033-024` while pending |
| L8 Storyboard recipe `twoFactor: {kind:'nafath'}` | storyboards | optional |

## 9. Decisions

1. **Architecture:** its own module; UAE Pass is a login preset.
2. **URLs:** `/nafath/<project>/<instance>` plus the `/nafath-sandbox` and `/stg` aliases, and host mode for both Elm
   hosts. APP-ID is unique across the hub.
3. **Callback body:** `{transId, requestId, status, token}`, with `compat` adding `transactionId`.
4. **National IDs:** filled when the first instance is created, and by `generate()`; the column is nullable.
5. **Unknown ID:** lax mode gives an unassigned request with a warning; strict gives a `400-034-053`-style error.
6. **Clock:** the existing `auth` time feature.
7. **Credentials:** APP-ID and APP-KEY generated per instance; lax accepts anything, strict answers 403.
8. **The card:** three numbers.
9. **Auto-approve:** off by default.
10. **Expiry:** lazy, on read; no sweeper.
11. **Widget:** polls every 2 s, only while a walkthrough is active.
12. **Lint:** optional, after S8.
