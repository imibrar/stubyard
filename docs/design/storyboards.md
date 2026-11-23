# Storyboards + Chrome extension: implementation design (stubyard v0.14.0)

> **Design record for stubyard 0.14.0.** This is how the feature was planned and built, including each slice's
> recorded deviations ("Choices made in Slice …"). It is not kept up to date after the release: where it differs from
> the code, the code wins. The user-facing reference is [AGENT_GUIDE.md §AF](../AGENT_GUIDE.md) and the walkthrough is
> [GUIDE.md §15](../GUIDE.md#15-storyboards-and-the-chrome-extension).

This design is built on the code as it is today. Paths are absolute. Contracts between slices (SQL, zod, REST, messages, client signatures) are exact. If an implementer changes one, it has to be changed in this document and in `server/src/storyboards/schema.ts` together.

---

## 0. Findings from reading the code (these drive the design)

1. **Blocker found: the API guard will reject the extension's writes.** `/Volumes/d/GitRepo/stubyard/server/src/http/guard.ts` returns 403 for any POST/PUT/PATCH/DELETE whose `Origin` host is not in the allowlist. Chrome sends `Origin: chrome-extension://<id>` on extension fetches that are not GET, and `hostOf()` turns that into `<id>`, which is not allowed. The fix is part of Slice 0:
   - A new config value `extensionOrigins: string[]` from `STUBYARD_EXTENSION_ORIGINS`, read via `envVar()`. Default `chrome-extension://*`. `''` turns the exception off. A list such as `chrome-extension://abcd…` pins it to one extension id.
   - In `registerGuard`, if the origin is `chrome-extension://<id>` (`id` = `[a-z0-9]+`, compared lower-case) and matches the list, skip the Origin and Sec-Fetch-Site checks. Keep the Host check and the JSON-only check. The check is `extensionOriginChecker(config)` in `guard.ts`.
   - Leave `crossSiteChecker` (LLM mocks) as it is.
   - Rationale: web pages cannot forge a `chrome-extension://` Origin. An extension that already has localhost host permission can drive the dashboard anyway, so this does not widen the threat model. Wildcard CORS is still not added.
   - GET requests and the SSE stream already work: there is no Origin check on GET, and host_permissions bypass CORS.
2. **No zod imports in the server yet.** Routes validate by hand, although `zod 4.6.7` is a dependency. Storyboards will use zod: `schema.ts` is the single source, and `z.toJSONSchema()` feeds the MCP `describe` output, so the ontology can never drift from the validation.
3. **`render()` in `/Volumes/d/GitRepo/stubyard/server/src/autoreplies/template.ts`** has a closed `lookup()`. Additive change: `TemplateVars.extra?: (name: string) => string | undefined`, consulted **first** in `lookup()`. Auto-replies are unchanged.
4. **`FIRST_NAMES` in `/Volumes/d/GitRepo/stubyard/server/src/repos/users.ts`** is not exported. Export it and add `LAST_NAMES` in a new `storyboards/fake.ts`.
5. **`GET /users/:id/latest`** returns only `link = links[0]`. Additive change: also return `links: string[]`. `GET /messages/wait` (long poll, `user`, `channel`, `q`, `since`, `after`, `otp`, `timeout ≤ 120`) already returns the full message with `links`. Email steps use it.
6. **TOTP**: `GET /api/projects/:p/authenticators/:id/code` returns `{code, nextCode, remaining, period, validFrom, validUntil}`. The extension never needs the secret.
7. **Runs and fresh users.** Run users are purged after a run stops (TTL default 120 min). That is too short for a manual walkthrough that can span days. Walkthroughs therefore create **project** test users (`run_id NULL`) for "fresh" actors, record their ids, and can delete them when the walkthrough is deleted.
8. **Dockerfile** copies every workspace `package.json` before `npm ci`. A new workspace must be added in **both** the `build` and `deps` stages, or `npm ci` fails on the lockfile. The root `test` script runs only the server. **No jsdom or happy-dom anywhere in the repo**: add `happy-dom` (pinned) as a devDependency of the extension only. `@types/chrome` is needed too.
9. **Class PROvia facts used by the pilot:**
   - Staff and person login inputs have ids `email` and `password` (react-hook-form `id={field.name}`).
   - The staff 2FA page `/auth/staff-user/2fa-challenge` has an `InputOTP` with id `code`, which is a real `<input>`.
   - The sign-up page `/auth/person/register` has fields `email, password, confirmPassword, title(select), firstName, lastName, phone(phone widget), nationality, country, organisationName, jobTitle, preferredLanguage(select)`, and a "Create account" button. The confirmation link is emailed.
   - Form Builder fields are `fld-<code>`. The profile block codes are `title` (Radix Select), `first_name`, `last_name`, `email`, `mobile`, `country` (Radix Select), `organisation`, `job_title`. The built-in fallback uses `phone`.
   - Radio groups and multi-select checkboxes have **no ids**; only `<Label htmlFor="fld-x">` points at them.
   - The wizard buttons are "Next" and "Submit registration". Radix Select only renders its hidden native `<select>` inside a `<form>`, and FormRenderer is not a form, so value-to-label mapping must fall back to option text.
   - The result shows "Registration number: **HCE27-R-00435**". Emails: "Your registration is confirmed" and "Complete your payment" (approved but paid).
   - Admin area: `/admin/registrations` and `/admin/registrations/view/:id`. One active registration per person and event, so the pilot must use a fresh participant.
   - The prototype test pack (`ref-docs/MANUAL_PROTOTYPE_FLOW_TEST_CASES.md`) describes the older prototype URLs, not this app. The pilot follows the real routes.

---

## 1. Data model

### 1.1 Migration 24
Append this to `/Volumes/d/GitRepo/stubyard/server/src/db/migrations.ts`:

```sql
-- Storyboards: per-project manual walkthroughs (steps), data sets for form filling, login recipes per role,
-- page snapshots (scanned form fields), walkthroughs (one human run through a storyboard) and their screenshots.
CREATE TABLE login_recipes (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', login_url TEXT NOT NULL,
  fields TEXT NOT NULL DEFAULT '{}', two_factor TEXT NOT NULL DEFAULT '{"kind":"none"}',
  logout_url TEXT, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (project_id, role));
CREATE TABLE data_sets (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  match TEXT NOT NULL DEFAULT '{}', entries TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (project_id, slug));
CREATE TABLE storyboards (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', intent TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]', inputs TEXT NOT NULL DEFAULT '[]', actors TEXT NOT NULL DEFAULT '[]',
  steps TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1, content_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (project_id, slug));
CREATE TABLE page_snapshots (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'extension', url TEXT NOT NULL, url_pattern TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '', form_id TEXT, fields TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL);
CREATE INDEX idx_page_snapshots_project ON page_snapshots(project_id, created_at);
CREATE TABLE walkthroughs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  storyboard_id TEXT REFERENCES storyboards(id) ON DELETE SET NULL,
  key TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', executor TEXT NOT NULL DEFAULT 'human',
  status TEXT NOT NULL DEFAULT 'active', origin TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL, actors TEXT NOT NULL DEFAULT '{}', vars TEXT NOT NULL DEFAULT '{}',
  current_step_id TEXT, verdict TEXT, signed_off_by TEXT, signed_off_at TEXT, summary_note TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL, finished_at TEXT, updated_at TEXT NOT NULL,
  UNIQUE (project_id, key));
CREATE INDEX idx_walkthroughs_project ON walkthroughs(project_id, updated_at);
CREATE INDEX idx_walkthroughs_storyboard ON walkthroughs(storyboard_id);
CREATE TABLE walkthrough_steps (
  walkthrough_id TEXT NOT NULL REFERENCES walkthroughs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL, position INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  note TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}', started_at TEXT, finished_at TEXT,
  PRIMARY KEY (walkthrough_id, step_id));
CREATE TABLE walkthrough_shots (
  id TEXT PRIMARY KEY, walkthrough_id TEXT NOT NULL REFERENCES walkthroughs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX idx_walkthrough_shots_wt ON walkthrough_shots(walkthrough_id, step_id);
```

Notes:
- **Screenshots are stored as BLOBs**, not files on disk. The project's ON DELETE CASCADE then cleans them up with no orphan sweep, and they are never exported.
- Caps: ≤ 600 KB each (JPEG), ≤ 40 per walkthrough, ≤ 50 MB per project. Over the cap the server returns 413 with a message.
- `executor` is reserved for agent execution later: it accepts only `'human'` in v1.
- `walkthroughs.actors` is JSON `Record<actorKey, {userId, email, name, role, created: boolean}>`, with no FK. Users can be deleted independently, and the view then shows `missing: true`.

### 1.2 Project settings (additive)
Change `ProjectSettings` in `/Volumes/d/GitRepo/stubyard/server/src/repos/projects.ts` and in `web/src/api.ts`:

```ts
/** Origins of the app under test (e.g. "http://localhost:3183"); the extension finds the project by them. */
appOrigins?: string[];
```

`ProjectRepo.update` validates: an array of strings, each `new URL(x).origin === x` after normalisation (lowercase, no trailing slash, no path), http or https only. Otherwise 400 `appOrigins[i] must be an origin like http://localhost:3183`. The normalised, de-duplicated list is what is stored (`normalizeAppOrigins` in `projects.ts`). `roles` gets the same "array of strings" check as `lintDisabled`. The settings are already in the project export, so `appOrigins` travels with it. (Slice 0 changes the server only; `web/src/api.ts` is Slice 6.)

### 1.3 zod schemas
These go in `/Volumes/d/GitRepo/stubyard/server/src/storyboards/schema.ts`, the contract file. The web and the extension mirror the TypeScript types by hand in their API clients (no cross-workspace import).

```ts
import { z } from 'zod';
export const SLUG = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'lowercase letters, digits, dashes; max 48');
export const KEY = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,31}$/, 'lowercase letter first, then letters, digits, _'); // camelCase ok: vars.regNo
export const STEP_ID = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/);
export const TEMPLATE = z.string().max(2000);           // may contain {{…}}
export const SELECTOR = z.string().min(1).max(500);      // CSS selector (checked with a parse attempt in the extension only)
export const ROLE = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);   // same normalisation as test_users.role

export const LoginRecipe = z.object({
  role: ROLE,
  name: z.string().max(100).default(''),
  loginUrl: TEMPLATE,                                     // absolute, or "/path" (resolved against the walkthrough origin)
  fields: z.object({
    username: SELECTOR.default('#email'),
    password: SELECTOR.default('#password'),
    submit: SELECTOR.optional(),                          // only highlighted, never clicked
  }).prefault({}),                                        // prefault, not default: zod 4 returns a default as-is
  twoFactor: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    z.object({ kind: z.literal('totp'), selector: SELECTOR.default('#code'),
               authenticator: z.string().max(200).optional() }),   // label; default: the key linked to the user
    z.object({ kind: z.enum(['email-otp', 'sms-otp']), selector: SELECTOR,
               subject: z.string().max(200).optional() }),          // optional subject filter for the OTP message
  ]).default({ kind: 'none' }),
  logoutUrl: TEMPLATE.nullable().default(null),
  notes: z.string().max(2000).default(''),
});

export const FIELD_KINDS = ['auto','text','select','radio','checkbox','radix-select','radix-checkbox','radix-radio','date','otp','skip'] as const;
export const DataEntry = z.object({
  key: z.string().min(1).max(200),                       // element id, name, data-testid, label text or placeholder
  value: z.union([TEMPLATE, z.boolean(), z.array(TEMPLATE).max(50)]),
  kind: z.enum(FIELD_KINDS).default('auto'),
  selector: SELECTOR.optional(),                         // overrides key matching
  label: z.string().max(200).optional(),                 // human label (from a scan)
  note: z.string().max(500).optional(),
});
export const DataSet = z.object({
  slug: SLUG, name: z.string().min(1).max(100), description: z.string().max(2000).default(''),
  match: z.object({ urlPattern: z.string().max(500).optional(),   // glob on path(+query): "/register/*", "*" = one segment, "**" = any (rules below)
                    formId: z.string().max(200).optional() }).default({}),
  entries: z.array(DataEntry).max(300),
}).superRefine(uniqueKeys);                              // duplicate entry key -> issue at entries[i].key

export const Actor = z.object({
  key: KEY, label: z.string().max(100).default(''),
  role: ROLE,                                            // picks the login recipe; for fresh users also their role
  user: z.string().max(200).optional(),                  // existing test user ref (id, email, name, role); omitted = first user with `role`
  fresh: z.boolean().default(false),                     // create a new test user per walkthrough
  name: TEMPLATE.optional(),                             // fresh users: name template, default "{{fake.firstName}} {{fake.lastName}}"
}).refine((a) => !(a.fresh && a.user), { message: 'fresh actors cannot name an existing user', path: ['user'] });

export const Input = z.object({ name: KEY, label: z.string().max(100), required: z.boolean().default(false),
                                default: z.string().max(500).optional(), help: z.string().max(500).optional() });

const Base = {
  id: STEP_ID.optional(),                                // assigned s1, s2… when missing; stable afterwards
  title: z.string().min(1).max(200),
  intent: z.string().min(1).max(1000),                   // one plain-language sentence: what the user does and why (agent-friendly)
  actor: KEY.optional(),                                 // default: the previous step's actor (first step: first actor)
  notes: z.string().max(4000).default(''),
  optional: z.boolean().default(false),
  screenshot: z.enum(['off','offer','required']).default('offer'),
  target: z.object({ selector: SELECTOR.optional(), text: z.string().max(200).optional() }).optional(), // hint for highlight / future agent
};
export const Step = z.discriminatedUnion('kind', [
  z.object({ ...Base, kind: z.literal('open'), url: TEMPLATE }),
  z.object({ ...Base, kind: z.literal('login'), actor: KEY, recipe: ROLE.optional(), url: TEMPLATE.optional() }),
  z.object({ ...Base, kind: z.literal('logout'), url: TEMPLATE.optional() }),
  z.object({ ...Base, kind: z.literal('fill'), dataSet: SLUG, url: TEMPLATE.optional(), formId: z.string().max(200).optional() }),
  z.object({ ...Base, kind: z.literal('email'), actor: KEY,
    channel: z.enum(['email','sms','whatsapp']).default('email'),
    match: z.object({ subject: z.string().max(300).optional(),   // substring, or /regex/flags
                      text: TEMPLATE.optional() }).default({}),  // substring that must be in subject or body
    link: z.object({ pattern: z.string().max(300).optional(),    // substring or /regex/ on the URL
                     index: z.number().int().min(0).max(50).optional() }).optional(), // omitted = human picks
    timeoutSec: z.number().int().min(5).max(600).default(120),
    open: z.enum(['same-tab','new-tab','none']).default('same-tab'),
    since: STEP_ID.optional() }),                         // window starts at that earlier step's startedAt
  z.object({ ...Base, kind: z.literal('instruction') }),
  z.object({ ...Base, kind: z.literal('capture'), var: KEY,
    selector: SELECTOR.optional(), attribute: z.string().max(100).optional(),  // default: textContent / value
    textPattern: z.string().max(300).optional(),                               // regex; group 1 (or whole match) is the value
    required: z.boolean().default(true) })
    .refine((s) => s.selector || s.textPattern, { message: 'capture needs selector or textPattern', path: ['selector'] }),
  z.object({ ...Base, kind: z.literal('check'), expect: z.string().min(1).max(1000),
    assert: z.object({ textPresent: TEMPLATE.optional(), selector: SELECTOR.optional(),
                       urlMatches: z.string().max(300).optional() }).optional() }),
]);
export const Storyboard = z.object({
  slug: SLUG, name: z.string().min(1).max(150), description: z.string().max(4000).default(''),
  intent: z.string().max(1000).default(''), tags: z.array(z.string().max(40)).max(20).default([]),
  inputs: z.array(Input).max(20).default([]),
  actors: z.array(Actor).min(1).max(10),
  steps: z.array(Step).min(1).max(150),
});
export const UserSpec = z.object({ email: z.string().email(), name: z.string().min(1).max(100), role: ROLE,
  phone: z.string().optional(), password: z.string().optional(), notes: z.string().optional() });
export const Bundle = z.object({
  format: z.literal('stubyard-storyboards'), version: z.literal(1),
  project: z.object({ appOrigins: z.array(z.string()).optional(), roles: z.array(ROLE).optional(),
                      defaultPassword: z.string().optional() }).optional(),
  users: z.array(UserSpec).default([]), loginRecipes: z.array(LoginRecipe).default([]),
  dataSets: z.array(DataSet).default([]), storyboards: z.array(Storyboard).default([]),
});
export const ScannedField = z.object({
  key: z.string(), id: z.string().nullable(), name: z.string().nullable(), testId: z.string().nullable(),
  kind: z.enum(FIELD_KINDS), inputType: z.string().nullable(), label: z.string().nullable(),
  placeholder: z.string().nullable(), value: z.union([z.string(), z.boolean(), z.array(z.string())]).nullable(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).max(400).optional(),
  required: z.boolean(), visible: z.boolean(), formId: z.string().nullable(), duplicateKey: z.boolean().default(false),
});
export const PageSnapshot = z.object({ url: z.string().url(), urlPattern: z.string().default(''), title: z.string().default(''),
  formId: z.string().nullable().default(null), fields: z.array(ScannedField).max(500), note: z.string().max(2000).default(''),
  source: z.enum(['extension','agent']).default('agent') });
```

The API returns objects with server fields added: `id, version, createdAt, updatedAt`, steps with their ids assigned, and `refs` (see 1.4).

`schema.ts` also exports `uniqueKeys`, the enum lists (`STEP_KINDS`, `FIELD_KINDS`, `TWO_FACTOR_KINDS`, `WALKTHROUGH_STATUSES`, `STEP_STATUSES`, `VERDICTS`), `STORYBOARD_SCHEMAS` (the map published as JSON Schema; `z.toJSONSchema(x, {io:'input'})` works on every entry), and the TS types (`Storyboard` = parsed output, `StoryboardInput` = `z.input`, likewise for the others, plus `StepOf<K>`). The view and service types (`StoryboardView`, `WalkthroughView`, `ResolvedStep`, `ImportResult`, `StoryboardService`, `WalkthroughService` …) are in `server/src/storyboards/types.ts`.

**URL patterns** (`storyboards/urlPattern.ts` exports `urlPatternScore(pattern, url) → number|null` and `matchUrlPattern`; the extension's `src/shared/urlPattern.ts` has the same rules and names):
- A glob on the URL path; the query is matched too only when the pattern contains `?` (in the given order). The fragment is ignored, a trailing `/` is ignored on both sides, a pattern without a leading `/` gets one, and an origin in the pattern or URL is ignored.
- `*` = any characters inside one path segment (no `/`); `**` = any characters, `/` included, and at a segment boundary also nothing (`/admin/**` matches `/admin`). Every other character is literal; matching is case-sensitive.
- An empty or missing pattern matches every URL (score 0). `/register/*` matches `/register/HCE27` but not `/register` or `/register/HCE27/step2` (use `/register/**`).
- The score is the number of literal characters; the higher one wins (`matchScore`).

### 1.4 Reference validation
`storyboards/validate.ts`, pure: `(project, storyboard, ctx) → {errors, warnings}`. Each issue has the shape `{path, code, message, expected?}`.

| code | path example | rule |
|---|---|---|
| `schema` | `steps[3].url` | a zod issue (path joined as `a.b[3].c`) |
| `duplicate_step_id` | `steps[5].id` | — |
| `unknown_actor` | `steps[2].actor` | not in `actors[].key`; `expected` = the keys |
| `missing_data_set` | `steps[4].dataSet` | not in the DB or in the same bundle; `expected` = slugs |
| `missing_login_recipe` | `steps[6].recipe` | no recipe for `recipe ?? actor.role` |
| `unknown_role` (warning) | `actors[1].role` | not in `settings.roles` and no test user has it |
| `missing_user` | `actors[1].user` | the ref does not resolve; for a non-fresh actor without `user`, no user has the role |
| `unknown_variable` | `steps[7].url` | a `{{x}}` that is not a known variable/generator |
| `var_not_captured` | `steps[9].assert.textPresent` | `{{vars.x}}` with no earlier `capture` step and no `inputs[].name === x` |
| `var_used_before_capture` | — | the capture step comes later than its use |
| `missing_authenticator` | `loginRecipes[admin].twoFactor.authenticator` | totp with no label match and no key linked to the resolved user (warning if the actor is fresh) |
| `no_password` (warning) | `actors[0]` | user.password null and no project `defaultPassword` (falls back to `Password123!`) |
| `relative_url_no_origin` (warning) | `steps[0].url` | starts with `/` and the project has no `appOrigins` |
| `no_app_origins` (warning) | `project.appOrigins` | — |
| `masked_value` (warning, bundle import only) | `dataSets[0].entries[1].value` | a `"***"` value with no stored value of the same key to keep; it is imported as `"***"` |

Choices made in Slice 1: `missing_login_recipe` always points at `steps[i].recipe` (also when the role comes from the actor); `var_used_before_capture` points at the field that uses the var; duplicate actor keys and input names are `schema` issues; `no_password` is checked only for actors that have a login step. `GET /storyboards/:slug` re-validates on read and lists every current issue (errors included) under `warnings`, since references can change after the save.

Over HTTP, an invalid write returns **400** `{error: "Storyboard is invalid (3 problems)", details: {errors, warnings}}`. `HttpError` already carries `details`. Every issue is listed, not just the first one.

---

## 2. Template variables (server-side only; the extension never renders templates)

`storyboards/render.ts` exports `renderFor(ctx, template, field) → {text, warnings}`. It calls `render(template, baseVars, {field})` with `baseVars = {otp:null, links:[], subject:null, body:null, from:null, to:null, channel:'email', user: actorUser, captures:{}, extra}`.

`ctx` is `RenderContext = {project: {slug, name, settings}, walkthrough: {id, key, startedAt, origin}, actors: Record<actorKey, RenderUser | null>, actor?: actorKey | null, vars, now?}` with `RenderUser = {name, email, phone, role, password (stored, nullable)}`. Also exported:
- `renderUrl(ctx, template, field) → {url: string|null, warnings}`: the "resolver" prefixing of relative URLs below ('' → null; a warning when there is no origin).
- `renderEntries(ctx, entries, field) → {entries: RenderedEntry[], warnings}`: data-set values (strings and string arrays rendered, booleans as-is).
- `parseVariable(name)` / `isKnownVariable(name)`: for the `unknown_variable` / `var_not_captured` checks of validation.
- `PREVIEW_WALKTHROUGH`, `previewFreshUser(project, role)`, `DEFAULT_PASSWORD`, `emailDomainOf`, `phonePrefixOf`, `passwordOf`, `originOf`.

`extra` answers **every** name: anything that is not a storyboard variable below (including auto-reply variables such as `{{otp}}`, `{{link}}`, `{{body.1}}`) renders empty with the warning `<field>: {{x}} is not a known storyboard variable; left empty`.

`extra(name)` resolves:

| Variable | Value |
|---|---|
| `user.name/email/phone/role/password/firstName/lastName` | The step's actor. firstName/lastName come from splitting the name on its first space. password = user.password ?? settings.defaultPassword ?? `Password123!` |
| `users.<actorKey>.<same fields>` | Any actor of the walkthrough |
| `vars.<name>` | Walkthrough vars: inputs given at start plus captured values. Missing → empty plus a warning |
| `unique` | Walkthrough key, 6 chars `[a-z0-9]`, e.g. `k7m2qp` |
| `walkthrough.id` / `walkthrough.key` / `walkthrough.started` (YYYY-MM-DD) | — |
| `project.slug/name/emailDomain/phonePrefix` | — |
| `app.origin` | The walkthrough origin (chosen at start; default `appOrigins[0]`) |
| `fake.firstName`, `fake.lastName`, `fake.fullName`, `fake.company`, `fake.jobTitle`, `fake.city`, `fake.word`, `fake.email` (`<first>.<last>.<unique>@<emailDomain>`, lower-case), `fake.phone` (phonePrefix + digits padded to 12, the same algorithm as `users.generate`), `fake.digits:N` (1–32) | **Deterministic**: a seeded PRNG of `sha256(walkthroughId + '|' + name)`. The same name gives the same value for the whole walkthrough, so pressing Fill twice is idempotent. A suffix gives a different value: `fake.firstName:2`, `fake.digits:6:b` (suffix `[A-Za-z0-9_-]{1,32}`). `fake.fullName` and `fake.email` are built from `fake.firstName` / `fake.lastName` with the same suffix, so they agree; `fake.email:2` also adds `.2` before the `@` |
| `date.today`, `date.+7d`, `date.-18y`, `date.+2m`, `date.+1w`, `date.+3h` | `YYYY-MM-DD` in UTC. Units `h d w m y` (m = months); month/year steps clamp to the month end (Jan 31 + 1m = Feb 28) |
| `datetime.now`, `datetime.<offset>` | `YYYY-MM-DDTHH:mm` (datetime-local, UTC); `today` and `now` both mean no offset |
| `uuid`, `random.digits:N` | Overridden to be deterministic per name, as fake does (documented). `uuid:2`, `random.digits:6:2` give other values |
| `now` | From the base renderer |

Relative URLs (a template that renders to something starting with `/`) are prefixed with `app.origin` by the resolver.

`TEMPLATE_VARIABLE_HELP` (name + help) is exported for the dashboard picker and `describe`.

In the authoring context (no walkthrough), `preview` uses walkthrough id `preview` and key `preview` (`PREVIEW_WALKTHROUGH`), and actor users are resolved as at start, with no fresh user created: fresh actors get a placeholder user `previewFreshUser(project, role)` = `{name:'Fresh <Role>', email:'<role>.preview@<domain>'}` (role `participant` → `Fresh Participant`, `participant.preview@<domain>`).

---

## 3. REST API

All routes are under `/api/projects/:slug`. JSON only. Errors are `HttpError` (`{error, details?}`). Route files:
- `/Volumes/d/GitRepo/stubyard/server/src/http/routes/storyboards.ts` (authoring)
- `/Volumes/d/GitRepo/stubyard/server/src/http/routes/walkthroughs.ts`

Both are registered in `http/app.ts` after `registerPersonaRoutes`. Events on the bus:
- `storyboards.changed` `{kind:'storyboard'|'dataSet'|'loginRecipe'|'snapshot', slug|id, deleted?}`
- `walkthrough.changed` `{id, stepId?, status}`

### 3.1 Discovery (top level)
- `GET /api/storyboards/match?origin=<origin>` → `{origin, projects:[{slug,name,storyboards:number}]}`. It compares the normalised origin with every project's `settings.appOrigins` and returns an empty list when nothing matches.
- `GET /api/storyboard-schema` → `{schemas: {LoginRecipe, DataEntry, DataSet, Actor, Step, Storyboard, Bundle, PageSnapshot}: JSONSchema, variables: TEMPLATE_VARIABLE_HELP, fieldKinds, stepKinds}`. Used by the dashboard and by MCP `describe`.

### 3.2 Login recipes
- `GET /login-recipes` → `LoginRecipeView[]` (`LoginRecipe & {id, createdAt, updatedAt, users: number}`)
- `GET /login-recipes/:role` → view
- `PUT /login-recipes/:role` body `LoginRecipe` (role in the body is optional and must equal the param) → 200 or 201 (upsert)
- `DELETE /login-recipes/:role` → `{deleted: role}`. 409 when a storyboard uses it, unless `?force=1`.

### 3.3 Data sets
- `GET /data-sets?url=<page url>` → `DataSetView[]`, where `DataSetView = DataSet & {id, createdAt, updatedAt, usedBy: string[]}`. With `url`, only data sets whose `urlPattern` matches, plus `matchScore`.
- `GET /data-sets/:slug` → view
- `PUT /data-sets/:slug` body `DataSet` → upsert (200/201)
- `PATCH /data-sets/:slug` body `{name?, description?, match?, entries?, upsertEntries?: DataEntry[], removeKeys?: string[]}` → view. `upsertEntries` merges by key.
- `DELETE /data-sets/:slug` → 409 when used by a storyboard, unless `?force=1`
- `POST /data-sets/:slug/preview` body `{storyboard?: slug, actor?: key, walkthrough?: id}` → `{entries: RenderedEntry[], warnings}`
- `POST /data-sets/from-snapshot` body `{snapshot: id, slug, name, include?: 'visible'|'all', values?: Record<key, template>}` → view (201). Keys come from `field.key`, kinds from the snapshot, values from `values[key]` ?? the snapshot's current value. 409 when the slug exists.
- Preview without `walkthrough`: `storyboard` defaults to the first storyboard that uses the data set, `actor` to the actor of its first fill step using it; with no storyboard at all, `actor` is read as a test-user ref.
- The slug `from-snapshot` is reserved (and `export`, `import`, `validate`, `match` for storyboards), so no PUT can shadow a static route.

`RenderedEntry = {key, value: string|boolean|string[], kind, selector?, label?}`

### 3.4 Storyboards
- `GET /storyboards?tag=` → `StoryboardBrief[]` (`{id, slug, name, description, tags, version, steps:number, actors:[{key,role,fresh}], updatedAt, lastWalkthrough?: {id,status,verdict,startedAt}}`)
- `GET /storyboards/:slug` → `StoryboardView` = `Storyboard` (steps with ids) + `{id, version, createdAt, updatedAt, refs:{dataSets:string[], roles:string[], vars:{captured:string[], inputs:string[]}}, warnings}`
- `PUT /storyboards/:slug` body `Storyboard` → upsert. Validation runs first (400 with every issue). `version` is bumped only when `content_hash` (sha256 of the canonical JSON) changes. Warnings come back in `warnings`.
- `DELETE /storyboards/:slug` → `{deleted}` (walkthroughs keep their snapshot; `storyboard_id` becomes NULL)
- `POST /storyboards/validate` body `{storyboard: Storyboard}` or `{slug}` → `{ok, errors, warnings, refs}`. Always 200: this is the dry run.
- `POST /storyboards/:slug/duplicate` body `{slug, name?}` → view

### 3.5 Page snapshots
- `POST /page-snapshots` body `PageSnapshot` → 201 `{id, …}`. Keep the newest 200 per project.
- `GET /page-snapshots?url=&limit=` → brief list `{id, url, urlPattern, title, formId, fields:number, source, createdAt}`
- `GET /page-snapshots/:id` → full
- `DELETE /page-snapshots/:id`

### 3.6 Bundle
- `GET /storyboards/export?storyboards=a,b&secrets=1` → `Bundle`. It contains the named storyboards (default all), the data sets and recipes they reference (all of them when none is named), the users the actors reference by `user`, and `project.appOrigins/roles`. Literal values (no `{{`) whose key/label matches `/pass(word)?|secret|token|otp/i` or contains `pin` as its own word (`pin`, `pin_code`, `pinCode`; not `shipping`) are masked as `"***"` without `secrets=1`. User passwords are included only with `secrets=1`.
- `POST /storyboards/import` body `{bundle: Bundle, mode?: 'upsert'|'create-only'|'replace', dryRun?: boolean}`:
  - Order: project settings merge → users upsert by email → recipes by role → data sets by slug → storyboards by slug.
  - Validation is done **as a whole** first. Cross-references are satisfied by DB ∪ bundle.
  - Then one `db.transaction`.
  - `replace` deletes every recipe, data set and storyboard of the project first.
  - Response 200 `{ok:true, dryRun, created:{users,loginRecipes,dataSets,storyboards}, updated:{…}, unchanged:{…}, skipped:[{path, reason}], warnings}`, or 400 `{error, details:{errors:[{path:'storyboards[0].steps[3].dataSet',…}], warnings}}`. Each of `created/updated/unchanged` holds string lists of keys (user email, recipe role, data-set and storyboard slug); see `ImportResult` in `types.ts`.
  - Paths are prefixed with the bundle collection and index.
  - Slice 1 choices: `replace` deletes only the recipes, data sets and storyboards the bundle lacks and updates the others in place, so ids, versions and walkthrough links survive (the end state is the same). A dry run makes the same writes inside the transaction and rolls them back, so write-time failures show up too. A write that fails inside the transaction (e.g. a user phone already taken) rolls everything back and answers 409/400 `Import failed at users[1]: …` with `details.errors[0].path`. A masked `"***"` data-set value keeps the stored value of the same key (re-importing a masked export changes nothing); `project.appOrigins`/`roles` are merged as a union, `defaultPassword` replaced. Export includes `project.defaultPassword` only with `secrets=1`.

### 3.7 Walkthroughs
`WalkthroughView`:
```ts
{ id, key, label, status: 'active'|'finished'|'abandoned', executor: 'human', origin,
  storyboard: { id: string|null, slug, name, version },
  inputs: Input[], actors: Record<string, {userId, name, email, phone, role, password, created: boolean, missing?: true}>,
  vars: Record<string,string>, currentStepId: string|null,
  steps: Array<Step & { id: string; position: number; status: 'pending'|'active'|'done'|'skipped'|'failed';
                         note: string; data: Record<string,unknown>; startedAt: string|null; finishedAt: string|null;
                         shots: { id: string; bytes: number; createdAt: string }[] }>,
  counts: { pending, active, done, skipped, failed },
  signoff: { verdict: 'pass'|'fail'|'partial'|null, signedOffBy: string|null, signedOffAt: string|null, note: string },
  startedAt, finishedAt, updatedAt, warnings: string[] }
```

Routes:
- `POST /walkthroughs` body `{storyboard: slug|id, origin?: string, label?: string, vars?: Record<string,string>, actors?: Record<actorKey, userRef>}` → 201 `WalkthroughView`.
  - Required inputs are checked (400 listing what is missing).
  - Users are created for fresh actors: `email = <role>.<key>@<emailDomain>` (with `-2`… on clash), name from the template, role, password null (the project default applies), notes `Created by walkthrough <key> (<storyboard slug>)`, where `<key>` is the walkthrough key. They also get a phone number (`fake.phone` shape, seeded per walkthrough and actor) so sms/whatsapp steps work.
  - Non-fresh actors are resolved like `users.requireRef` (override from body.actors, else `actor.user`, else role); an unresolvable ref, or an override for a key the storyboard does not have, is 400 and nothing is created. Existing refs are resolved before any fresh user is created, all in one transaction.
  - One `walkthrough_steps` row is inserted per snapshot step.
- `GET /walkthroughs?storyboard=&status=&limit=50` → brief list
- `GET /walkthroughs/:id` → view (`:id` also accepts the key)
- `PATCH /walkthroughs/:id` body `{label?, vars?: Record<string,string|null>, currentStepId?, origin?}` → view (a vars null deletes the var)
- `POST /walkthroughs/:id/refresh` → re-snapshot from the current storyboard. Rows are kept by step id, new steps are added as pending, and removed steps stay with `data.removed=true`. 409 when the storyboard was deleted.
- `POST /walkthroughs/:id/steps/:stepId/resolve` body `{}` → `ResolvedStep`. Side effects: `status 'pending'→'active'`, `startedAt` set, `currentStepId` set. `ResolvedStep` is `{step, actor: {key, userId, name, email, role} | null, url: string|null, target: {selector, text} | null (rendered), warnings: string[], text: {title?, intent, expect?, notes?}, kind-specific}`. `text` holds the step's display text rendered with the step's context (a variable without a value renders as '', with no warning):
  - `open`: `{url}`
  - `login`: `{url, username, password, selectors:{username, password, submit?}, twoFactor: {kind:'none'} | {kind:'totp', selector, codePath: '/api/projects/<p>/authenticators/<id>/code', label} | {kind:'email-otp'|'sms-otp', selector, waitPath: '/api/projects/<p>/messages/wait?user=<uid>&channel=email&otp=1&after=<cursor>&timeout=60'}}`. The cursor is taken at resolve time; `channel` is `sms` for `sms-otp`, and `&q=<subject>` is added when the recipe has `twoFactor.subject`. Without a recipe: 409 `missing_login_recipe`. A totp recipe whose authenticator cannot be found (no label match, no key linked to the user) resolves to `{kind:'none'}` plus a warning, so the human types the code.
  - `logout`: `{url: string|null}` (`step.url ?? recipe.logoutUrl`)
  - `fill`: `{url: string|null, dataSet: {slug, name, match}, formId: string|null, entries: RenderedEntry[]}`
  - `email`: `{channel, user:{id,email,phone}, waitPath: '/api/projects/<p>/messages/wait?user=<uid>&channel=<c>&since=<step.startedAt>&q=<text>&timeout=60', subject: string|null, linkPattern: string|null, linkIndex: number|null, open}`. Subject regex and link filtering are done by the panel on the returned messages. `since` is the `startedAt` of the nearest earlier step that was started (else the walkthrough start): the app usually sends the mail while the previous step is being done, before the human opens the email step, so the step's own `startedAt` would miss it. It is stable, so a re-resolve still sees the same mail. With `since: <stepId>` the window starts at that step's `startedAt` (not started yet: the window before it), for a second mail sent by the same action as the first.
  - `capture`: `{var, selector, attribute, textPattern, required}`
  - `check`: `{expect, assert: {textPresent: rendered|null, selector, urlMatches} | null}`
  - `instruction`: `{}`
- `PATCH /walkthroughs/:id/steps/:stepId` body `{status?: 'pending'|'done'|'skipped'|'failed', note?: string, data?: Record<string,unknown>, value?: string}` → view.
  - `data` is shallow-merged. Conventional keys: `fill: {filled, unmatched, skipped, errors, details[]}`, `email: {messageId, subject, link}`, `check: {assertion: {present, at}}`, `login: {twoFactorFilled: boolean}`.
  - `value` is only for capture steps: it sets `vars[step.var] = value` and `data.value`.
  - A final status sets `finishedAt`, and `currentStepId` moves to the next pending step.
- `POST /walkthroughs/:id/steps/:stepId/shots` body `{dataUrl: 'data:image/jpeg;base64,…'|'data:image/png;base64,…'}` → 201 `{id, bytes}` (413 over the caps)
- `GET /walkthroughs/:id/shots/:shotId` → the image bytes (content-type from mime)
- `DELETE /walkthroughs/:id/shots/:shotId`
- `POST /walkthroughs/:id/finish` body `{verdict: 'pass'|'fail'|'partial', signedOffBy: string (1..100), note?: string, allowIncomplete?: boolean}` → view. 409 when non-optional steps are pending/active, unless `allowIncomplete`; those steps are then marked `skipped` with note "not run". Optional steps still open are marked the same way.
- `POST /walkthroughs/:id/abandon` body `{note?}` → view. `POST /walkthroughs/:id/reopen` → status active (clears signoff); 409 "Its test data was cleaned up; start a new run" when its cleanup is `cleaned`.
- `DELETE /walkthroughs/:id?users=1&force=1` → `{deleted, users: n, kept: CleanupKept[]}`. A run with cleanup `pending` answers 409 unless `users=1` or `force=1`. With `users=1`, the fresh users it created are deleted with their messages, by the cleanup rules (see "Addendum: cleanup of test data"): Keep-pinned users stay and are listed in `kept`; users other runs still need answer 409 (`details.kept`) unless `force=1`, which leaves them.
- `GET /walkthroughs/:id/summary` → `{walkthrough: brief, steps:[{id,title,kind,status,note,data,shots:number}], vars, actors, signoff, durationMs}`. Actor passwords are masked as `***` (summaries get shared; the view and resolve carry the real one).
- Status rules: resolve, step PATCH, refresh, finish and abandon need an `active` walkthrough (409 otherwise; reopen first). PATCH of the walkthrough, shots and delete work in any status. Resolve answers 409 `missing_user` when a login/email step's actor user was deleted and 409 `missing_data_set` when a fill step's data set is gone.
- `GET /walkthroughs/:id/summary.html` → a printable page. Screenshots are inlined as `data:` URIs. CSP `default-src 'none'; img-src data:; style-src 'unsafe-inline'`. Escaping is the same as `runs/report-html.ts`.

Users-route change: `GET /users/:id/latest` adds `links: string[]`.

---

## 4. MCP: ontology-driven authoring (for the class-provia agent)

New file `/Volumes/d/GitRepo/stubyard/server/src/storyboards/mcp-tools.ts` exports `STORYBOARD_MCP_TOOLS`. It is spread into `TOOLS` in `http/routes/mcp.ts` and uses the `run(a,{api})` pattern of `personas/mcp-tools.ts`, so every tool goes through REST and REST validation. The `initialize.instructions` text gets one sentence: "To author manual test walkthroughs, call describe_storyboards first."

### 4.1 `describe_storyboards {object?}` (read-only)
It returns `ONTOLOGY` from `/Volumes/d/GitRepo/stubyard/server/src/storyboards/ontology.ts`. The constant is hand-written prose; the schemas come from `GET /api/storyboard-schema`, so the shapes cannot drift.

Without `object`:
```json
{ "objects": [{ "name": "project", "is": "...", "key": "slug", "relations": [...] }, ...],
  "relations": [
    {"from":"storyboard.actors[].role","to":"loginRecipe.role","cardinality":"many-to-one","required":"for login steps"},
    {"from":"storyboard.actors[].user","to":"testUser (id|email|name|role)","cardinality":"many-to-one","required":"unless fresh"},
    {"from":"step(fill).dataSet","to":"dataSet.slug","cardinality":"many-to-one","mustExistFirst":true},
    {"from":"step.actor","to":"storyboard.actors[].key"},
    {"from":"loginRecipe.twoFactor.authenticator","to":"authenticator.label"},
    {"from":"{{vars.x}}","to":"step(capture).var = x (earlier) | storyboard.inputs[].name = x"},
    {"from":"dataSet.match.urlPattern","to":"page URL path (glob)"},
    {"from":"dataSet.entries[].key","to":"page field id|name|data-testid|label|placeholder (see pageSnapshot.fields[].key)"},
    {"from":"walkthrough","to":"storyboard (snapshot at start)","note":"results; read-only for agents"},
    {"from":"agentRun","to":"walkthrough","note":"RESERVED for v2 (executor='agent'); no tools yet"}],
  "buildOrder": ["project.appOrigins + roles", "test users (existing staff) / decide fresh actors", "authenticators (exist already; reference by label)",
                 "login recipes per role", "page snapshots (from extension or pasted)", "data sets", "storyboards", "validate_storyboard", "import or upsert"],
  "enums": { "stepKinds": [...], "fieldKinds": [...], "twoFactorKinds": [...], "walkthroughStatus": [...], "stepStatus": [...] },
  "variables": [ {name, help} ... ],
  "validationCodes": [ {code, meaning, fix} ... ] }
```

With `object` (one of `project`, `role`, `loginRecipe`, `testUser`, `authenticator`, `storyboard`, `actor`, `input`, `step`, `step.open`, `step.login`, `step.logout`, `step.fill`, `step.email`, `step.instruction`, `step.capture`, `step.check`, `dataSet`, `dataEntry`, `pageSnapshot`, `templateVariables`, `walkthrough`, `agentRun`), it returns `{name, is, fields:[{name, type, required, default, enum?, rules, refersTo?}], jsonSchema, validation:[…], example, pitfalls:[…]}`. Examples come from the Class PROvia pilot, so they are realistic. Pitfalls include:
- "fill never clicks Next/Submit: add an instruction step after it"
- "use {{unique}} in anything the app requires to be unique"
- "Radix selects: kind radix-select; value = visible option text"

### 4.2 `storyboard_guide {topic?}` (read-only)
Topics: `business-flow`, `forms`, `login`, `email`, `variables`, `multi-step-forms`, `checklist`. It returns markdown recipes. They cover:
- One actor per role, plus fresh actors for anyone the flow creates.
- Each switch of actor needs `logout` (previous actor) + `login` (next), because there is one session per browser profile.
- `open` before `fill` (or `fill.url`).
- Data sets are linked by `match.urlPattern` and/or `formId`, with keys taken from a page snapshot.
- Wizard forms use one `fill` per step, or one fill pressed repeatedly with `instruction` "Click Next" between.
- `capture` → `{{vars.x}}` in later `open` URLs, search instructions and checks.
- An `email` step after any action that sends mail, with `link.pattern` for confirmation links.
- `check` with `assert.textPresent` for observable outcomes.
- Every step needs `intent` (what and why, in one sentence, no selectors).
- The checklist: run `validate_storyboard` until `ok`, then import.

### 4.3 Authoring tools
`project` is required on every tool. Upserts are keyed by slug or role or email and are idempotent.

| Tool | Input | Calls |
|---|---|---|
| `set_app_origins` | `{project, origins: string[], roles?: string[]}` | PATCH /api/projects/:p `{settings:{appOrigins, roles}}` |
| `upsert_test_user` | `{project, email, name, role, phone?, password?}` | GET /users/:email → PATCH or POST /users |
| `upsert_login_recipe` | `{project, recipe: LoginRecipe}` | PUT /login-recipes/:role |
| `list_login_recipes` / `delete_login_recipe` | `{project}` / `{project, role, force?}` | — |
| `upsert_data_set` | `{project, dataSet: DataSet}` | PUT /data-sets/:slug |
| `patch_data_set_entries` | `{project, slug, upsert?: DataEntry[], remove?: string[]}` | PATCH |
| `list_data_sets` / `get_data_set` / `delete_data_set` | `{project, url?}` / `{project, slug}` / `{project, slug, force?}` | — |
| `preview_data_set` | `{project, slug, storyboard?, actor?}` | POST preview |
| `save_page_snapshot` | `{project, url, title?, formId?, fields: Array<{key, label?, kind?, id?, name?, options?, required?}> , note?}` (the pasted field list; missing props filled with null/auto) | POST /page-snapshots (source 'agent') |
| `list_page_snapshots` / `get_page_snapshot` | `{project, url?}` / `{project, id}` | — |
| `data_set_from_snapshot` | `{project, snapshot, slug, name, values?: Record<string,string>, include?}` | POST /data-sets/from-snapshot |
| `upsert_storyboard` | `{project, storyboard: Storyboard}` | PUT /storyboards/:slug |
| `validate_storyboard` | `{project, storyboard?: Storyboard, slug?}` | POST /storyboards/validate |
| `list_storyboards` / `get_storyboard` / `delete_storyboard` | — | — |
| `import_storyboard_bundle` | `{project, bundle: Bundle, mode?, dry_run?}` | POST /storyboards/import |
| `export_storyboard_bundle` | `{project, storyboards?: string[]}` | GET export |
| `list_walkthroughs` | `{project, storyboard?, status?}` | read-only |
| `get_walkthrough_result` | `{project, id}` | GET summary (no images) |

Error surfacing: the REST `details.errors` are put into the tool result text as JSON, so the agent sees every path. That needs a small change to `injectJson` and `callTool` in mcp.ts: on 4xx, include `details` in the text (`stubyard answered 400: <error>\n<details JSON>`). The change is additive.

Reserved for v2 (no tools): `start_walkthrough` with `executor:'agent'`, `resolve_step`, `report_step`. The ontology marks them reserved.

### 4.4 Connecting the class-provia agent (text to hand to the owner; do not edit that repo)
`.mcp.json` at the class-provia repo root (port 4000 on the Linux machine, 14000 on the Windows kit):
```json
{ "mcpServers": { "stubyard": { "type": "http", "url": "http://localhost:4000/mcp" } } }
```
Or run `claude mcp add --transport http stubyard http://localhost:4000/mcp`. HANDOFF §6 says registering devhub/stubyard as an MCP server **needs the owner's OK**, so the note must ask for it first.

HANDOFF/CLAUDE.md note:
> **Manual walkthroughs (stubyard Storyboards).** Business flows for manual testing live in stubyard project `classprovia` as storyboards. To add or change one: call `describe_storyboards`, then `storyboard_guide {topic:"business-flow"}`. Take field keys from a page snapshot: the owner presses "Send to stubyard" in the extension's Page data view, or you paste the fields from the page's source (Form Builder fields are `fld-<fieldCode>`). Build it with `import_storyboard_bundle {dry_run:true}` until it has no errors, then import. Never put real passwords in a bundle: staff use their stubyard test-user password; fresh participants get the project default password. Use `{{unique}}` in every e-mail, organisation and name the app needs to be unique (data is not reset between walkthroughs).

### 4.5 Choices made in Slice 3 (where the code differs from or adds to the text above)
- **Schemas:** `ontology.ts` calls `z.toJSONSchema(x, {io:'input'})` on the schema.ts objects directly (the same call `GET /api/storyboard-schema` makes) instead of fetching that route. Field lists (type, required, default, enum, limits) are generated from the JSON Schema; the prose per field is hand-written, and `ontologyDrift()` (asserted empty by the e2e test) fails on any schema field without a doc or doc without a field.
- **Objects:** `bundle` was added to the `describe_storyboards` object list. The examples come from `CLASS_PROVIA_PILOT` in `ontology.ts`; `docs/examples/classprovia-storyboards.json` is that constant (the e2e test compares them).
- **Upsert results:** `upsert_login_recipe`, `upsert_data_set`, `upsert_storyboard`, `patch_data_set_entries`, `upsert_test_user` and `set_app_origins` return `status: created | updated | unchanged` (GET before the write, then a content comparison), so a re-run shows that nothing changed.
- **`set_app_origins`** also takes `email_domain` and `default_password` (fresh actors depend on both, and no other MCP tool sets them).
- **`list_authenticators`** (read-only: label, linked user, no secrets) was added so the agent can check `twoFactor.authenticator` labels. `GET /authenticators` answers `{serverTime, offsetMs, items}`.
- **`data_set_from_snapshot`:** REST answers 409 when the slug exists; the tool turns that into `status: "exists"` with the stored data set and changes nothing, so the build sequence can be re-run. Changes go through `patch_data_set_entries` / `upsert_data_set`.
- **`save_page_snapshot`:** a `"/path"` URL gets the first appOrigin in front (error when there is none); `urlPattern` defaults to the URL path.
- **Tool inputs:** `bundle`, `storyboard`, `recipe` and `dataSet` are also accepted as JSON text.
- **mcp.ts:** besides `details` in 4xx text (`stubyard answered <status>: <error>\n<details JSON>`, for `call` and `run` tools), a `run` tool that returns a string (`storyboard_guide` markdown) is sent as plain text, not JSON-quoted.
- **Rendering (code wins):** only urls, recipe login/logout URLs, data-entry values, fresh actor names, `email.match.text` and `check.assert.textPresent` are rendered. `title`, `intent`, `expect` and `notes` were shown as written at first; since commit 3c14961 resolve also returns them rendered in `text` (§3.7).
- **`missing_login_recipe`** is raised for login steps only; a logout step without a recipe resolves to `url: null` (the human signs out by hand).

---

## 5. @stubyard/client additions (browser-safe fetch, no Node APIs)

New files in `/Volumes/d/GitRepo/stubyard/packages/client/src/`, re-exported from `index.ts`, with subpath exports added to `package.json`. The client version goes from 0.6.0 to 0.7.0.

```ts
// http.ts
export interface HubTarget { apiUrl?: string; project: string; fetch?: typeof fetch }
export class StubyardError extends Error { status: number; details?: unknown }
export function hubFetch<T>(t: Pick<HubTarget,'apiUrl'|'fetch'>, method: string, path: string, body?: unknown, init?: { signal?: AbortSignal; allow?: number[] }): Promise<{ status: number; body: T }>;

// users.ts
export function listUsers(t: HubTarget): Promise<HubUser[]>;
export function getUser(t: HubTarget, ref: string): Promise<HubUser & { inbox: unknown; latest: unknown }>;
export function latestMessage(t: HubTarget, ref: string, o?: { channel?: Channel; otp?: boolean }): Promise<{ message: HubMessage; otp: string | null; link: string | null; links: string[] } | null>;

// messages.ts
export function messageCursor(t: HubTarget, o?: { user?: string; channel?: Channel }): Promise<string>;
export function waitForMessagePath(t: Pick<HubTarget,'apiUrl'|'fetch'>, path: string, o?: { signal?: AbortSignal }): Promise<HubMessage | null>; // follows a server-made waitPath; null on 408
export function getMessage(t: Pick<HubTarget,'apiUrl'|'fetch'>, id: string): Promise<HubMessage>;

// authenticators.ts
export function getTotpCode(t: Pick<HubTarget,'apiUrl'|'fetch'>, codePath: string): Promise<{ code: string; nextCode: string; remaining: number; period: number; validUntil: number }>;
export function getTotpCodeBy(t: HubTarget, o: { label?: string; user?: string }): Promise<{ id: string; label: string; code: string; remaining: number; period: number }>;

// stream.ts — fetch + ReadableStream SSE parser (EventSource is not available in MV3 service workers)
export function subscribe(t: HubTarget & { run?: string }, o: { types?: string[]; onEvent: (e: { type: string; projectId: string | null; data: unknown }) => void; onError?: (err: unknown) => void; signal: AbortSignal; retryMs?: number }): void;

// storyboards.ts
export function matchProjects(t: Pick<HubTarget,'apiUrl'|'fetch'>, origin: string): Promise<{ origin: string; projects: { slug: string; name: string; storyboards: number }[] }>;
export function listStoryboards(t: HubTarget): Promise<StoryboardBrief[]>;
export function getStoryboard(t: HubTarget, slug: string): Promise<StoryboardView>;
export function upsertStoryboard(t: HubTarget, sb: StoryboardInput): Promise<StoryboardView>;
export function validateStoryboard(t: HubTarget, sb: StoryboardInput | { slug: string }): Promise<ValidationResult>;
export function deleteStoryboard(t: HubTarget, slug: string): Promise<void>;
export function listDataSets(t: HubTarget, o?: { url?: string }): Promise<DataSetView[]>;
export function getDataSet(t: HubTarget, slug: string): Promise<DataSetView>;
export function upsertDataSet(t: HubTarget, ds: DataSetInput): Promise<DataSetView>;
export function listLoginRecipes(t: HubTarget): Promise<LoginRecipeView[]>;
export function upsertLoginRecipe(t: HubTarget, r: LoginRecipeInput): Promise<LoginRecipeView>;
export function savePageSnapshot(t: HubTarget, s: PageSnapshotInput): Promise<{ id: string }>;
export function listPageSnapshots(t: HubTarget, o?: { url?: string }): Promise<PageSnapshotBrief[]>;
export function importBundle(t: HubTarget, bundle: StoryboardBundle, o?: { mode?: 'upsert'|'create-only'|'replace'; dryRun?: boolean }): Promise<ImportResult>;
export function exportBundle(t: HubTarget, o?: { storyboards?: string[]; secrets?: boolean }): Promise<StoryboardBundle>;

// walkthroughs.ts
export function startWalkthrough(t: HubTarget, o: { storyboard: string; origin?: string; label?: string; vars?: Record<string,string>; actors?: Record<string,string> }): Promise<WalkthroughView>;
export function listWalkthroughs(t: HubTarget, o?: { storyboard?: string; status?: string }): Promise<WalkthroughBrief[]>;
export function getWalkthrough(t: HubTarget, id: string): Promise<WalkthroughView>;
export function patchWalkthrough(t: HubTarget, id: string, p: { label?: string; vars?: Record<string,string|null>; currentStepId?: string }): Promise<WalkthroughView>;
export function resolveStep(t: HubTarget, id: string, stepId: string): Promise<ResolvedStep>;
export function updateStep(t: HubTarget, id: string, stepId: string, p: { status?: StepStatus; note?: string; data?: Record<string,unknown>; value?: string }): Promise<WalkthroughView>;
export function addScreenshot(t: HubTarget, id: string, stepId: string, dataUrl: string): Promise<{ id: string; bytes: number }>;
export function finishWalkthrough(t: HubTarget, id: string, o: { verdict: 'pass'|'fail'|'partial'; signedOffBy: string; note?: string; allowIncomplete?: boolean }): Promise<WalkthroughView>;
export function abandonWalkthrough(t: HubTarget, id: string, note?: string): Promise<WalkthroughView>;
export function summaryUrl(t: HubTarget, id: string): string;   // .../summary.html
```

The types (`HubUser`, `HubMessage`, `StoryboardView`, `ResolvedStep`, `WalkthroughView`…) are hand-written in `packages/client/src/storyboard-types.ts` and mirror sections 1.3 and 3. The default `apiUrl` is `http://localhost:4000`.

---

## 6. Chrome extension: `packages/extension` (`@stubyard/extension`, private)

### 6.1 Layout and build
```
packages/extension/
  package.json        scripts: build (vite build && vite build -c vite.content.config.ts), typecheck (tsc --noEmit), test (vitest run)
                      deps: react, react-dom (same versions as web); dev: vite, @vitejs/plugin-react, typescript, vitest, happy-dom (pinned), @types/chrome
  tsconfig.json       moduleResolution "Bundler", lib ES2022+DOM, types ["chrome"], strict, jsx react-jsx
  vite.config.ts      multi-entry: sidepanel.html, src/background.ts → dist/ (ESM; background is "type":"module");
                      alias '@stubyard/client' → ../client/src/index.ts (no prebuild needed); publicDir 'public' (manifest, icons)
  vite.content.config.ts  build.lib { entry: src/content/index.ts, formats:['iife'], name:'stubyardContent', fileName: () => 'content.js' }, emptyOutDir:false
  vitest.config.ts    environment 'happy-dom'
  public/manifest.json, public/icons/*
  sidepanel.html
  src/background.ts
  src/content/{index.ts, dom.ts, match.ts, fill.ts, radix.ts, scan.ts, capture.ts}
  src/shared/{protocol.ts, settings.ts, urlPattern.ts}
  src/sidepanel/{main.tsx, App.tsx, hub.ts, state.ts, screens/*.tsx, steps/*.tsx, panel.css}
  test/{fill.test.ts, scan.test.ts, match.test.ts, radix.test.ts, urlPattern.test.ts, fixtures/*.html}
```

Repo wiring:
- Root `package.json`: add the workspace `packages/extension`.
- `"typecheck"` appends `&& npm run typecheck -w @stubyard/extension`.
- `"test"` becomes `npm test -w server && npm test -w @stubyard/extension`.
- `"build"` appends `&& npm run build -w @stubyard/extension`.
- Dockerfile: add `COPY packages/extension/package.json packages/extension/` to the build and deps stages. The extension is not shipped in the image.
- CI needs no change (it uses the root scripts).
- Optional: `deploy/make-bundle.sh` zips `packages/extension/dist` as `stubyard-extension.zip`.

### 6.2 manifest.json
```json
{ "manifest_version": 3, "name": "stubyard walkthroughs", "version": "0.1.0",
  "description": "Walk through stubyard storyboards: fill forms, log in as test users, follow emails.",
  "action": { "default_title": "stubyard" },
  "side_panel": { "default_path": "sidepanel.html" },
  "background": { "service_worker": "background.js", "type": "module" },
  "permissions": ["sidePanel", "storage", "scripting", "tabs", "activeTab"],
  "host_permissions": ["<all_urls>"],   // 0.1.1: was localhost/127.0.0.1 only; captureVisibleTab needs <all_urls>
  "optional_host_permissions": ["http://*/*", "https://*/*"],
  "commands": { "fill-form": { "suggested_key": { "default": "Alt+Shift+F" }, "description": "Fill the current form" } },
  "icons": { "16": "icons/16.png", "48": "icons/48.png", "128": "icons/128.png" } }
```

Match patterns without a port match every port (Chrome), so `http://localhost/*` covers :3183, :8183 and :4000. HTTPS app origins or other hosts are requested at runtime with `chrome.permissions.request({origins:[origin + '/*']})` from a button click in the panel (a user gesture). The same applies to a custom stubyard base URL.

### 6.3 Roles
- **Service worker** (`background.ts`, kept minimal; it holds no state):
  - `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})` on install.
  - Relays `commands.onCommand('fill-form')` to the panel with `chrome.runtime.sendMessage({type:'panel.command', command:'fill-form'})`.
  - Alt+Shift+F goes to the active tab's widget first (`widget.command`); only when no widget takes it does the worker relay `panel.command`. Alt+Shift+W (`toggle-widget`) collapses or shows the widget.
  - `src/background/widgetSync.ts` injects the content script into the eligible tabs of a window with an active walkthrough (the run's origin and the project's `appOrigins`, top frame only), sends `widget.mount` / `widget.unmount`, and mints a fresh single-use token for each widget frame (`widget.token`).
  - Nothing else is kept there. If it dies, nothing is lost.
- **Side panel** (React): all stubyard calls (through `@stubyard/client`), all UI and state.
  - State lives in stubyard (the walkthrough).
  - `chrome.storage.local` holds `{apiUrl, lastProjectByOrigin: Record<origin, slug>, activeWalkthroughByWindow: Record<windowId, {project, id}>, signedOffBy}`.
  - On open it reads the active tab (`chrome.tabs.query({active:true,currentWindow:true})`) and resumes the walkthrough stored for that window via `GET /walkthroughs/:id`.
  - It listens to `chrome.tabs.onUpdated` (status complete) and `onActivated` to refresh the page context.
  - It subscribes to `/api/stream?project=` (client `subscribe`) for `walkthrough.changed` and `storyboards.changed`, so the dashboard and the panel stay in sync.
- **Content script** (`content.js`, IIFE): injected on demand with `chrome.scripting.executeScript({target:{tabId, allFrames:false}, files:['content.js']})` before the first message to a tab and again after each navigation. It is idempotent: `window.__stubyardContent` holds the running instance (`version`, `alive()`, `dispose()`); a new injection keeps a live instance of the same version and replaces anything else (an older version, or an orphan left by an extension reload or update, whose widget host it also removes). It has no stubyard access; it only does DOM work and answers messages.
  - It answers `widget.suspend` / `widget.resume` for screenshots, and hosts the on-page step widget: a plain `<div data-stubyard-widget>` with a closed shadow root holding the extension's `widget.html` frame (see docs/design/floating-widget.md).
  - Content-script contract 0.6.0 (`CONTENT_VERSION`): `widget.mount` (no token; the host asks the worker with `widget.token`) / `widget.unmount`, `widget.toggle` (Alt+Shift+W), the `announce` frame message with a fixed `kind` only, and the progress message without a title. The highlighted element is marked `data-stubyard-target` so the widget keeps clear of it. `fill` and `setValue` take an optional `origin` and refuse when the page is on another origin; `probe` reports `origin`.

### 6.4 Messaging protocol (`src/shared/protocol.ts`)
Panel to content uses `chrome.tabs.sendMessage(tabId, req)`, and content answers through `sendResponse` (async, `return true`). If the content script is not injected, the panel sees "Receiving end does not exist", injects, and retries once.

```ts
export type ContentRequest =
  | { type: 'ping' }                                                         // → { ok: true, version: string, url: string }
  | { type: 'scan'; includeHidden?: boolean }                                // → ScanResult
  | { type: 'fill'; entries: RenderedEntry[]; formId?: string | null; overwrite?: boolean } // → FillReport
  | { type: 'probe'; selector: string }                                      // → { present: boolean; visible: boolean; value: string | null }
  | { type: 'setValue'; selector: string; value: string }                    // → { ok: boolean; error?: string } (login, 2FA)
  | { type: 'capture'; selector?: string; attribute?: string; textPattern?: string } // → { value: string | null; matchedText: string | null }
  | { type: 'assert'; textPresent?: string; selector?: string; urlMatches?: string } // → { ok: boolean; details: string[] }
  | { type: 'highlight'; selector?: string; text?: string };                 // → { found: boolean } (outline 2 s, scrollIntoView)
export interface ScanResult { url: string; title: string; forms: { formId: string | null; fields: ScannedField[] }[]; fields: ScannedField[]; duplicates: string[] }
export interface FillReport { filled: number; unmatched: number; skipped: number; errors: number;
  details: { key: string; status: 'filled' | 'unmatched' | 'skipped' | 'error'; matchedBy?: 'selector'|'id'|'name'|'testid'|'label'|'placeholder'|'aria-label'; kind?: string; reason?: string }[] }
export type PanelMessage = { type: 'panel.command'; command: 'fill-form' };
```

`ScannedField` and `RenderedEntry` have the same shapes as on the server (copied types).

### 6.5 Fill engine (`content/match.ts`, `fill.ts`, `radix.ts`)
**Visibility:** `el.getClientRects().length > 0`, `getComputedStyle` visibility is not hidden, no `[hidden]` ancestor, and not `aria-hidden="true"` (Radix's hidden native `<select>` is aria-hidden, so it is excluded as a target but used for option maps). Disabled or readonly elements count as `skipped`.

**Match**, per entry, first hit wins, visible elements only, scoped to `form#formId` / `[name=formId]` when `formId` is given:
1. `selector` (`querySelectorAll`, the first visible match)
2. `#CSS.escape(key)`
3. `[name="key"]` (radios: every element in the group)
4. `[data-testid="key"]`
5. label: a `<label>` whose normalised text (trimmed, `*` removed, whitespace collapsed, case-insensitive) equals the key. Then `label.htmlFor` → that element, else a nested control, else **label-scope**: the nearest ancestor of the label (up to 3 levels) holding `[role=radio]`, `[role=checkbox]`, `input`, `select`, `textarea` or `[role=combobox]`. Also `aria-labelledby` targets.
6. `[placeholder="key"]` (case-insensitive compare)
7. `[aria-label="key"]`

Special rule: when the key equals the `for` of a label and no element has that id (radio groups and multi-selects in FormRenderer), use label-scope (5). Not visible or not found → `unmatched` with reason `not on this page (later wizard step?)`.

**Kind detection** (`kind: 'auto'`):
- `input[type=checkbox]` → checkbox; `radio` → radio; `date|datetime-local|time|month` → date
- `select` → select
- `button[role=combobox]` or `[aria-haspopup=listbox]` → radix-select
- `[role=checkbox]` or `[role=switch]` → radix-checkbox
- `[role=radio]` / `[role=radiogroup]` → radix-radio
- `input[type=file]` → skipped (`file upload not supported in v1`)
- `contenteditable` → skipped
- otherwise text

**Setters:**
- **text/date/otp:** `el.focus()`. Then `Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v)`, using the HTMLInputElement or HTMLTextAreaElement prototype setter so React's value tracker sees a change. Dispatch `new Event('input',{bubbles:true})` and `new Event('change',{bubbles:true})`, then `el.blur()` (react-hook-form `onBlur`/`onTouched` modes). The value is checked afterwards: if `el.value !== v`, as with masked phone inputs, the result is `error: 'field rewrote the value to "…"'`, except when the digits are equal (counted as filled).
- **native select:** find an option by value, then exact text, then case-insensitive text. Set it with the HTMLSelectElement value setter, dispatch input+change. No option → error listing up to 10 option texts.
- **native checkbox:** desired = `value === true || value === 'true' || value === 'on' || value === 'yes'`. Click if `checked !== desired` (a click fires React's onChange correctly). Array value on a group of same-name checkboxes: tick exactly those whose value or label matches.
- **native radio:** click the radio in the group whose value or label matches.
- **radix-checkbox:** read `aria-checked` (or `data-state`) and click if it differs. Arrays in label-scope: every `[role=checkbox]` in scope, matched by `value` attribute or the text of its enclosing label (`multi-select`).
- **radix-radio:** in scope, `[role=radio]` whose `value` attribute or label text matches → `click()`.
- **radix-select** (`radix.ts`):
  1. Skip if the trigger text already equals the target.
  2. Open: dispatch `pointerdown` (`new PointerEvent('pointerdown',{bubbles:true, button:0, pointerType:'mouse', ctrlKey:false})`) on the trigger. If no `[role=listbox]` appears within 300 ms (MutationObserver), `focus()` and dispatch `keydown` `Enter`, then `ArrowDown`.
  3. Wait ≤ 1500 ms for `[role=listbox]` (the one in `aria-controls`, else the last visible one in the document).
  4. Candidate label: if a hidden native select sits next to the trigger (inside a form), map value → option text; else the value itself.
  5. Find `[role=option]` with normalised text equal to the label/value (exact → case-insensitive → startsWith). Then `scrollIntoView`, `focus()`, and `click()`. With no pointerdown, Radix's pointer type ref stays non-mouse, so `onClick` selects. Fallback: `keydown Enter` on the focused option.
  6. If no option matched: `keydown Escape` and `error: 'no option "X" (options: …)'`.
  7. Wait until the listbox closes (≤ 500 ms) before the next entry. Entries are processed **sequentially**.

**Wizard rule:** the engine only fills **visible** fields and never clicks buttons other than select triggers/options and checkbox/radio controls. It never submits, presses Enter in text fields, or clicks Next/Submit. Pressing "Fill form" again on step 2 fills that step's fields; step-1 fields are then hidden and show as unmatched ("not on this page"). The panel shows the counts plus an expandable detail list and the hint "Fill this step, check it, click Next yourself, then press Fill again."

**Overwrite:** default `true`. Values are deterministic per walkthrough, so filling again is idempotent. An unchanged value is counted as `skipped: already set`.

### 6.6 Page scan (`scan.ts`)
- Candidates: `input:not([type=hidden],[type=submit],[type=button],[type=reset],[type=image]), select:not([aria-hidden=true]), textarea, [role=combobox], [role=checkbox], [role=switch], [role=radiogroup]`. Radios are grouped by name into one field. Radix radio groups use the radiogroup with label-scope keys.
- `key` = id ?? name ?? data-testid ?? label (for label-scope groups: the label's `for`, e.g. `fld-dietary`).
- label = `label[for]`, else an ancestor label, else `aria-labelledby`, else `aria-label`.
- value: checkbox → boolean; radix-select → trigger text; multi → string[].
- options: native options; radix-select options are unknown until opened, so the panel's "Load options" button opens and closes each Radix select to read them (optional, off by default).
- `formId` = closest `form` id/name.
- `duplicates` = keys seen twice (shown in red: "ids/names must be unique per form").
- `includeHidden` adds hidden fields with `visible:false` (for whole-wizard snapshots, where the later steps are often not in the DOM; documented).

### 6.7 Login with 2FA wait
The panel's Login step:
1. **Go to login** opens `resolved.url` if the tab is not already on it.
2. **Fill login**: `setValue(username)` and `setValue(password)`. Then `highlight(selectors.submit ?? 'button[type=submit]')`. The panel says "Click Log in".
3. If `twoFactor.kind !== 'none'`: the panel polls `probe(selector)` every 1000 ms (for ≤ 5 min, re-injecting after navigation) until it is visible.
   - **totp:** `getTotpCode(codePath)`. If `remaining < 4`, wait until `validUntil` and fetch again. Then `setValue(selector, code)`. The panel shows the code with a local countdown from `validUntil`.
   - **email-otp / sms-otp:** `waitForMessagePath(waitPath)` (long poll, repeated until the deadline), take `message.otp`, then `setValue`.
   - The human clicks Verify.
4. The human marks the step done. `data: {twoFactorFilled}`.

The 2FA wait is stored in the step's data (`twoFactorPending`, with an optional `origin`; null once it ended), so the on-page widget of the next page resumes it after Log in navigates, and the panel and the widget never both wait. See docs/design/floating-widget.md, "Phase 1b".

### 6.8 Email step and link picker
"Wait for email" calls `waitForMessagePath(resolved.waitPath)` in a loop until `timeoutSec` (Cancel aborts with AbortController). The panel filters by `subject` (substring or `/re/`) and keeps the newest match.

The card shows subject, from, time and a body excerpt (`getMessage` for `bodyText`), plus **Links**: all `message.links`, each with a short label (host + path, truncated).
- With `linkPattern`/`linkIndex`, the chosen link is preselected.
- Otherwise the human picks one; links containing `unsubscribe` are deprioritised.
- **Open link** uses `chrome.tabs.update(tabId,{url})` (same-tab) or `chrome.tabs.create` (new-tab).
- Then `updateStep({data:{messageId, subject, link}})`.

The message wait is stored in the step's data (`emailWaitPending`; null once it ended), so the panel and the on-page widget never both wait. See docs/design/floating-widget.md, "Phase 1b".

### 6.9 Identifying the project
On panel open and on tab change: `origin = new URL(tab.url).origin`.
- Use `lastProjectByOrigin[origin]` if set.
- Else call `matchProjects(origin)`: one match → use it; several → a picker; none → a "Choose project" list (`GET /api/projects`) with a button "Add this origin to project" that PATCHes `appOrigins`.
- `chrome://` and other non-http pages show "Open your app first".
- Settings screen: stubyard URL (default `http://localhost:4000`, with a connection test calling `GET /api/system`, and a permission request when the host is not localhost), and the sign-off name.

### 6.10 Side panel screens
1. **Connect/Settings**: base URL, status, project override.
2. **Home** (project): active walkthroughs (Resume), the storyboard list (name, steps, last result), the Page data tab.
3. **Start walkthrough**: storyboard description, actors (shows fresh vs existing user, with an override picker), inputs form, origin select → `startWalkthrough`.
4. **Walkthrough**: header (storyboard, key `{{unique}}`, progress n/m, vars chip list); the ordered step list (status icons; clicking a step makes it current); the current step card with title, intent, notes, actor badge ("You should be logged in as Admin") and the kind-specific controls:
   - open: Go
   - login: Go, Fill login, 2FA status
   - logout: Go / instruction
   - fill: Open page (if url), Fill form, report
   - email: Wait, message, links, Open
   - instruction: Highlight (if target)
   - capture: Capture → editable value → Save
   - check: Run assertion (if any), Pass/Fail
   
   Footer on every step: **Done**, **Skip**, **Fail**, note field, **Screenshot** (`chrome.tabs.captureVisibleTab(windowId,{format:'jpeg',quality:60})` → `addScreenshot`; auto-prompt when `screenshot:'required'`), and **Next**. Every status change PATCHes immediately (resumable).
5. **Summary**: a table of steps (status, note, captured values, shot thumbnails), the verdict (pass/fail/partial, defaulting to fail if any step failed), signed-off-by name and note → **Sign off** (`finishWalkthrough`), and **Open printable report** (`summary.html` in a new tab).
6. **Page data** (works without a walkthrough): Scan → a table of key, label, kind and current value, side by side with the matching data set (`listDataSets({url})`), with each row marked match/unmatched. Actions:
   - Fill from <data set>
   - Save page as data set (slug and name prompt; values = the current values; `match.urlPattern` derived from the path, with numeric/uuid segments → `*`) → `upsertDataSet`
   - Send to stubyard as snapshot (`savePageSnapshot` with `includeHidden`) for agents
   - Copy JSON

### 6.11 Tests (`packages/extension/test`, vitest + happy-dom)
- **match.test.ts:** priority order (id over name over testid over label over placeholder), label-scope for radio groups, formId scoping, invisible elements excluded.
- **fill.test.ts:**
  - Text/textarea through a React-like value tracker shim (a test installs an `_valueTracker`-style own-property setter and asserts the input event fires after the prototype setter).
  - Native select by value/text; checkbox/radio toggling; boolean and array values; file → skipped; readonly → skipped; the report counts; the wizard (hidden step fields → unmatched, no button clicked: a spy on every `button` click except role controls).
- **radix.test.ts:** a hand-built Radix-like fixture (a trigger `button[role=combobox][aria-controls]` that renders a listbox on pointerdown/Enter, options `[role=option]` selecting on click) and `[role=checkbox][aria-checked]`.
- **scan.test.ts:** fixture forms (a copy of the FormRenderer DOM shape: `fld-*` ids, label htmlFor, a radiogroup without id), duplicates detection, Radix aria-hidden select excluded.
- **urlPattern.test.ts:** `/register/*`, `**`, and query handling.

Real-browser behaviour (Radix pointer events, React 19) is checked by hand against Class PROvia; list this in the slice acceptance.

### 6.12 Choices made in Slice 5a (where the design above was open)
- **Build and deps:** in 5a the package `build` script runs only `vite build -c vite.content.config.ts`, and only the dev dependencies the content engine needs are installed (vite, vitest, typescript, happy-dom 21.0.4, @types/chrome 0.3.7). Slice 5b adds `vite build &&`, react, react-dom and @vitejs/plugin-react.
- **urlPattern semantics** (`src/shared/urlPattern.ts`; the server's `storyboards/urlPattern.ts` must behave the same): the pattern is a glob on the path; `*` = any characters within one segment, `**` = any characters across segments, and `/**` may also match nothing (`/admin/**` matches `/admin`). The query is compared only when the pattern contains `?`. The hash is ignored, a trailing `/` is ignored on both sides, a pattern without a leading `/` gets one, and an empty pattern matches every URL with score 0. `matchScore` = the number of literal (non-`*`) characters in the pattern; a higher score is a more specific match. `derivePattern` replaces numeric, uuid and 24+ hex-character segments with `*`.
- **formId not found:** when `form#formId` / `form[name=formId]` is not on the page, matching uses the whole document.
- **Visibility:** besides the §6.5 rules, any ancestor with computed `display:none` makes an element invisible. In Chrome `getClientRects` already covers this; the extra check keeps DOM shims (happy-dom) honest.
- **Kind detection:** an `<input>` with `role=combobox` (autocomplete) is typed into as text; only non-input comboboxes are `radix-select`. Contenteditable is reported as skipped. In a same-name checkbox group, a string value that is not a yes/no word is treated as a one-item list.
- **Scan:** fields with no key at all (no id, name, data-testid, label or placeholder) are left out. Every `aria-hidden="true"` control is left out, not only the Radix select, since Radix checkboxes and radios render hidden bubble inputs too. Same-name native checkboxes are grouped like radios (value `string[]`). `input[type=file]` has kind `skip` (FIELD_KINDS has no file kind) and inputType `file`. Option values of Radix checkboxes/radios with the default value `on` use the label text. Label-scope groups are found from labels whose `for` names no element.
- **Protocol additions:** `CaptureResult` has an optional `error` (invalid selector or pattern). A handler that throws answers `{error: string}`. `assert.urlMatches` is a substring or `/regex/flags` on `location.href`, and `textPresent` is compared case-insensitively with whitespace collapsed. `highlight` by text prefers buttons, links, labels and tabs, and falls back to the innermost element whose text contains it.

**Choices made in Slice 5b (side panel and service worker):**
- **Client import:** the panel imports `@stubyard/client/<module>` (http, users, messages, authenticators, stream, storyboards, walkthroughs, storyboard-types), never the package index, which also re-exports Node-oriented helpers (`runs.ts` reads `process`). `vite.config.ts` aliases `^@stubyard/client/(.+)$` to `../client/src/$1.ts`; `tsconfig.json` has the matching `paths` entry. No client build is needed first.
- **Build:** `vite build` (sidepanel.html + `background.js`, ES module, `emptyOutDir: true`) runs first, then the content IIFE build. `base: './'`. `public/icons/{16,48,128}.png` are generated placeholders.
- **Panel layout:** `src/sidepanel/{main.tsx, App.tsx, context.tsx, hub.ts, tabs.ts, state.ts, panel.css}`, `screens/{Home, Start, Walkthrough, Summary, PageData, Settings}.tsx`, `steps/{StepCard, LoginControls, FillControls, EmailControls, SimpleControls}.tsx`. `state.ts` holds the pure view-model helpers (tested in `test/state.test.ts`); `src/shared/settings.ts` is tested in `test/settings.test.ts`.
- **Calls the client does not cover** go through `hubJson` in `sidepanel/hub.ts`: `GET /api/system`, `GET /api/projects`, `GET`/`PATCH /api/projects/:p` (adding an app origin sends the whole `settings.appOrigins` list, since settings merge shallowly), `POST /data-sets/:slug/preview` (Page data "Fill from", with `walkthrough` when one of the same project is open), and the message list fallback below.
- **Project override** is `lastProjectByOrigin[origin]` (Settings: "Use for this origin" / "Forget choice"); no new storage key. A single origin match is used without being stored, so later App-origin changes on the hub take effect.
- **Window ids** are not stable across browser restarts, so a stored `activeWalkthroughByWindow` entry can be lost then; Home lists the project's active walkthroughs with **Resume** as the way back.
- **Step data keys** are flat: fill `{filled, unmatched, skipped, errors, details}`; email `{messageId, subject, link}` (the message is saved when it arrives, the link when it is opened); login `{twoFactorFilled: true}`; check `{assertion: {present, at, details}}`. The panel re-reads them to show the fill report and the chosen message after a reopen.
- **Email subject filter:** the wait returns the newest message since the step started. When its subject does not match, the panel looks through `GET /messages` with the same filters (waitPath without `timeout`/`after`) for an older match, else waits again with `after=<cursor>`.
- **Screenshots:** a step with `screenshot: 'required'` and no shot takes one automatically when Done is pressed. Thumbnails load `GET /walkthroughs/:id/shots/:shotId`.
- **Page access:** for an app origin outside localhost/127.0.0.1 without a granted permission, a banner offers "Grant access" (`chrome.permissions.request`, user gesture). A custom stubyard URL asks the same way on "Save and test".
- **Alt+Shift+F** fills from the open fill step, or from the selected data set on Page data.
- **Not in 5b:** the Radix "Load options" button, `POST /walkthroughs/:id/refresh` and `/reopen` in the panel (the dashboard covers them), and per-actor login state tracking (the actor hint is text only).

---

## 7. Dashboard (`/Volumes/d/GitRepo/stubyard/web/src`)
- `storyboardsApi.ts`: types (mirroring §1.3 and §3) and helpers, using `api`/`qs` from `api.ts` as `personasApi.ts` does.
- `pages/StoryboardsPage.tsx` at route `storyboards/*` in `ProjectPage.tsx`, with sub-tabs through `?tab=`:
  - **Storyboards:** the list. The editor (`components/StoryboardEditor.tsx`) has header fields, an actors table, inputs, and an ordered step list (add by kind, drag/up-down to reorder, a per-kind form, a template-variable picker from `/api/storyboard-schema`). The validation panel calls `POST /storyboards/validate` on a 500 ms debounce and shows each issue with its path, clickable to focus the step. Plus a JSON tab (raw editing) and Duplicate/Delete.
  - **Data sets:** list and editor (`components/DataSetEditor.tsx`): match fields, an entries grid (key, kind, value, selector, label), a Preview with an actor, "Create from snapshot".
  - **Login recipes:** one card per role (role from `settings.roles` and users).
  - **Page snapshots:** read-only list and viewer, with a "Make data set" action.
  - **Walkthroughs:** list with filters, a detail drawer (steps, notes, shots as `<img src=/api/…/shots/:id>`), links to Summary and HTML, Delete (with a "also delete created users" checkbox).
  - **Import/Export:** a JSON bundle textarea or file, Dry run / Import with the result, and Download export.
- `components/Shell.tsx`: add `<NavItem to={`/p/${slug}/storyboards`} icon=… label="Storyboards" />` near Auto-replies, using an existing icon name.
- `ProjectPage.tsx` SettingsTab: an "App origins" input (comma or line separated) saved into `settings.appOrigins`.
- `hooks.ts` EVENT_TYPES: add `'storyboards.changed', 'walkthrough.changed'`.
- `api.ts` ProjectSettings: `appOrigins?: string[]`; `UserLatest` gets `links`.
- Check the pages at 390, 768, 1280 and 1920 px.

---

## 8. Housekeeping
- **Hub/wiring:** `storyboards?: StoryboardService` (repos for recipes, data sets, storyboards, snapshots, plus bundle import/export and validation) and `walkthroughs?: WalkthroughService` are in `hub.ts` (optional fields, interfaces in `storyboards/types.ts`, added in Slice 0). Construct them in `createHub()` (`index.ts`) and call `registerStoryboardExport()` there. `HubEventType` already has `'storyboards.changed' | 'walkthrough.changed'` (Slice 0).
- **Export** (`storyboards/export.ts`, `registerExportSection`, placed after `users`): sections `loginRecipes` (table `login_recipes`), `dataSets` (`data_sets`, with secret-literal masking unless `includeSecrets`) and `storyboards` (`storyboards`). Walkthroughs and snapshots are not exported. On import, existing slugs/roles are skipped with a warning, as personas do.
- **Reset** (`POST /projects/:slug/reset` in `api.ts`): `hub.storyboards?.resetProject(p.id)` (Slice 1) deletes page snapshots; `hub.walkthroughs?.resetProject(p.id)` (Slice 2) deletes walkthroughs, steps and shots. Storyboards, data sets and recipes stay, and so do the users fresh actors created (documented).
- **Retention** (`maintenance/retention.ts`): `report.walkthroughsPurged = this.purgePerProject(now, (pid, cutoff) => this.hub.walkthroughs?.purgeOlderThan(pid, cutoff) ?? 0)`. It deletes non-active walkthroughs with `updated_at < cutoff` and snapshots older than the cutoff. Add `walkthroughsPurged?: number` to `MaintenanceReport`.
- **Project delete:** the CASCADE covers it.
- **Versions:** release 0.14.0, bumped in `package.json`, `server`, `web`, `VERSION` in `api.ts` and `version` in `mcp.ts`; client 0.7.0.
- **Docs:**
  - `docs/AGENT_GUIDE.md` gets a new section **AF. Storyboards and walkthroughs**: AF.1 concepts and ontology, AF.2 step kinds, AF.3 data sets and fill rules, AF.4 template variables, AF.5 REST API, AF.6 bundle format, AF.7 MCP tools (describe/guide/build order), AF.8 the extension (install unpacked, permissions, the guard env `STUBYARD_EXTENSION_ORIGINS`), AF.9 not supported (file upload, iframes, shadow DOM, agent execution).
  - `docs/GUIDE.md` gets **§16 Storyboards and the browser extension** (a walkthrough with screenshots).
  - `docs/DEVELOPMENT.md`: layout line for `packages/extension`, "next free migration is 25", extension build/test commands.
  - `CHANGELOG.md`: 0.14.0 Added (Storyboards, data sets, login recipes, walkthroughs, page snapshots, MCP authoring tools, extension, client 0.7.0), Changed (`/users/:id/latest` returns `links`; the guard accepts extension origins), Migration 24.

---

## 9. Class PROvia pilot bundle
This file is `docs/examples/classprovia-storyboards.json`, and the MCP e2e test imports it. Values marked VERIFY must be confirmed with a Page data scan on the real pages. The engine tolerates missing keys: they show as unmatched.

```json
{
  "format": "stubyard-storyboards", "version": 1,
  "project": { "appOrigins": ["http://localhost:3183"], "roles": ["admin", "participant"] },
  "users": [
    { "email": "admin@classprovia.test", "name": "Class PROvia admin", "role": "admin",
      "notes": "Super admin. Password = SEED_USER_PASSWORD: set it in stubyard by hand, never in this file." }
  ],
  "loginRecipes": [
    { "role": "participant", "name": "Participant portal", "loginUrl": "/auth/person/login",
      "fields": { "username": "#email", "password": "#password", "submit": "button[type=submit]" },
      "twoFactor": { "kind": "none" }, "logoutUrl": null,
      "notes": "Sign out from the user menu (top right)." },
    { "role": "admin", "name": "Staff (Admin)", "loginUrl": "/auth/staff-user/login",
      "fields": { "username": "#email", "password": "#password", "submit": "button[type=submit]" },
      "twoFactor": { "kind": "totp", "selector": "#code", "authenticator": "Class PROvia admin 2FA" },
      "logoutUrl": null, "notes": "2FA page: /auth/staff-user/2fa-challenge (6-box code input, id=code)." }
  ],
  "dataSets": [
    { "slug": "person-sign-up", "name": "Participant sign-up", "match": { "urlPattern": "/auth/person/register" },
      "entries": [
        { "key": "email", "value": "{{user.email}}" },
        { "key": "password", "value": "{{user.password}}" },
        { "key": "confirmPassword", "value": "{{user.password}}" },
        { "key": "title", "value": "Dr", "kind": "radix-select", "note": "VERIFY id=title on the trigger" },
        { "key": "firstName", "value": "{{user.firstName}}" },
        { "key": "lastName", "value": "{{user.lastName}}" },
        { "key": "phone", "value": "{{fake.phone}}", "note": "VERIFY: phone widget with country SA; may rewrite the value" },
        { "key": "nationality", "value": "Saudi" },
        { "key": "country", "value": "Saudi Arabia" },
        { "key": "organisationName", "value": "Flow Test Org {{unique}}" },
        { "key": "jobTitle", "value": "QA Tester" },
        { "key": "preferredLanguage", "value": "English", "kind": "radix-select" }
      ] },
    { "slug": "event-registration", "name": "Event registration form (Form Builder)", "match": { "urlPattern": "/register/*" },
      "description": "Profile block of the published registration form (fld-<fieldCode>). Fields of later steps: scan each step and add them.",
      "entries": [
        { "key": "fld-title", "value": "Dr", "kind": "radix-select" },
        { "key": "fld-first_name", "value": "{{user.firstName}}" },
        { "key": "fld-last_name", "value": "{{user.lastName}}" },
        { "key": "fld-email", "value": "{{user.email}}" },
        { "key": "fld-mobile", "value": "{{fake.phone}}" },
        { "key": "fld-phone", "value": "{{fake.phone}}", "note": "built-in fallback form" },
        { "key": "fld-country", "value": "Saudi Arabia", "kind": "radix-select", "note": "VERIFY option label" },
        { "key": "fld-organisation", "value": "Flow Test Org {{unique}}" },
        { "key": "fld-job_title", "value": "QA Tester" }
      ] }
  ],
  "storyboards": [ {
    "slug": "registration-approval", "name": "Registration needing approval",
    "intent": "A new participant registers in a category that needs approval, an admin approves it, and the participant is told.",
    "tags": ["registration", "REG-02", "REG-03"],
    "inputs": [ { "name": "event", "label": "Event code", "default": "HCE27" } ],
    "actors": [
      { "key": "participant", "label": "New participant", "role": "participant", "fresh": true, "name": "{{fake.firstName}} Flow-{{unique}}" },
      { "key": "admin", "label": "Admin", "role": "admin", "user": "admin@classprovia.test" }
    ],
    "steps": [
      { "id": "signup-open", "kind": "open", "actor": "participant", "title": "Open sign-up", "intent": "Open the participant sign-up page.", "url": "/auth/person/register" },
      { "id": "signup-fill", "kind": "fill", "title": "Fill sign-up form", "intent": "Fill the new participant's account details.", "dataSet": "person-sign-up" },
      { "id": "signup-submit", "kind": "instruction", "title": "Create account", "intent": "Click Create account and wait for the 'check your email' message.", "target": { "text": "Create account" } },
      { "id": "confirm-email", "kind": "email", "actor": "participant", "title": "Confirm email address", "intent": "Open the confirmation link from the sign-up email.", "link": { "pattern": "confirm-email" }, "timeoutSec": 180 },
      { "id": "confirm-check", "kind": "check", "title": "Account confirmed", "intent": "Check the page says the email address is confirmed.", "expect": "A confirmation message is shown." },
      { "id": "participant-login", "kind": "login", "actor": "participant", "title": "Log in as the participant", "intent": "Sign in with the new account." },
      { "id": "register-open", "kind": "open", "title": "Open event registration", "intent": "Go to the list of events open for registration.", "url": "/register" },
      { "id": "pick-category", "kind": "instruction", "title": "Choose event and category", "intent": "Pick event {{vars.event}}, then a category marked 'Approval needed'." },
      { "id": "register-fill", "kind": "fill", "title": "Fill registration form", "intent": "Fill the registration form; on a multi-step form press Fill on each step and click Next yourself.", "dataSet": "event-registration" },
      { "id": "register-submit", "kind": "instruction", "title": "Submit registration", "intent": "Click Submit registration.", "target": { "text": "Submit registration" } },
      { "id": "reg-no", "kind": "capture", "title": "Note the registration number", "intent": "Read the registration number shown after submitting.", "var": "regNo", "textPattern": "Registration number:\\s*([A-Z0-9]+-[A-Z]-\\d+)" },
      { "id": "pending-check", "kind": "check", "title": "Status is Pending review", "intent": "Check the registration waits for approval.", "expect": "Status badge shows Pending review; no pass is issued.", "assert": { "textPresent": "Pending review" }, "screenshot": "required" },
      { "id": "participant-logout", "kind": "logout", "title": "Sign out participant", "intent": "Sign out from the user menu." },
      { "id": "admin-login", "kind": "login", "actor": "admin", "title": "Log in as admin", "intent": "Sign in as the admin; the 2FA code is filled when the code page appears." },
      { "id": "admin-open", "kind": "open", "title": "Open registrations", "intent": "Open the admin registrations list.", "url": "/admin/registrations" },
      { "id": "admin-find", "kind": "instruction", "title": "Find the registration", "intent": "Search for {{vars.regNo}} and open the record." },
      { "id": "approve", "kind": "instruction", "title": "Approve", "intent": "Click Approve on registration {{vars.regNo}} and confirm.", "target": { "text": "Approve" } },
      { "id": "approved-check", "kind": "check", "title": "Approved", "intent": "Check the registration is approved or confirmed.", "expect": "Status becomes Approved / Confirmed (paid categories: waiting for payment).", "screenshot": "required" },
      { "id": "admin-logout", "kind": "logout", "title": "Sign out admin", "intent": "Sign out from the user menu." },
      { "id": "decision-email", "kind": "email", "actor": "participant", "title": "Participant is told", "intent": "Check the participant received the decision email for {{vars.regNo}}.", "match": { "subject": "/confirmed|Complete your payment/", "text": "{{vars.regNo}}" }, "open": "none" },
      { "id": "final-check", "kind": "check", "title": "Email content", "intent": "Check the email names the registration number and the right outcome.", "expect": "Email says registration {{vars.regNo}} is confirmed (free) or approved with a payment request (paid)." }
    ] } ]
}
```

The pilot assumes:
- The stubyard project has an authenticator labelled "Class PROvia admin 2FA".
- The project `emailDomain` is `classprovia.test` (fresh participant email `participant.<key>@classprovia.test`), and the app's SMTP lands in project `classprovia`.
- The project default password meets the app's password rules.

---

## 10. Slices
Every slice ends with `./scripts/npm.sh run typecheck` and its own tests. Slices 1–5 run in parallel once Slice 0 has landed.

### Slice 0: contracts and foundations (~40 turns; blocks all)
Files:
- `server/src/db/migrations.ts` (v24)
- `server/src/storyboards/schema.ts` (all zod, `uniqueKeys`, exported TS types)
- `server/src/storyboards/fake.ts`
- `server/src/storyboards/render.ts`
- `server/src/storyboards/urlPattern.ts` (moved here from Slice 1: the unit test covers the glob)
- `server/src/storyboards/types.ts` (view types, `StoryboardService`, `WalkthroughService`)
- `server/src/events.ts` (`storyboards.changed`, `walkthrough.changed`)
- `server/src/autoreplies/template.ts` (`extra`)
- `server/src/repos/users.ts` (export `FIRST_NAMES`)
- `server/src/repos/projects.ts` (`appOrigins` + validation)
- `server/src/config.ts` (`extensionOrigins`)
- `server/src/http/guard.ts`
- `server/src/http/routes/api.ts` (`links` in latest)
- `hub.ts` (optional fields `storyboards?`, `walkthroughs?` typed as interfaces in `storyboards/types.ts`)

Tests:
- `server/test/storyboards.unit.test.ts`: schema accept/reject per kind, render variables, fake determinism, date offsets, the URL glob.
- `server/test/guard-extension.e2e.test.ts`: POST with `Origin: chrome-extension://x` → not 403; `Origin: http://evil.test` → 403; `STUBYARD_EXTENSION_ORIGINS=''` → 403.
- An auto-replies regression via the existing suite.

Check: `./scripts/npm.sh test -w server -- test/storyboards.unit.test.ts test/auto-replies.unit.test.ts test/guard-extension.e2e.test.ts`.

### Slice 1: authoring service and REST (~100; after 0)
Files: `server/src/storyboards/{service.ts, repo.ts, validate.ts, bundle.ts, export.ts}` (`urlPattern.ts` landed in Slice 0), `server/src/http/routes/storyboards.ts`, `app.ts`, `index.ts`, `api.ts` (reset hook for snapshots).

Acceptance: every §3.1–3.6 route; validation codes from §1.4 with paths; idempotent PUT (version unchanged on re-PUT); bundle dry-run and transactional rollback; masking; project export/import round trip.

Test: `server/test/storyboards.e2e.test.ts` → `./scripts/npm.sh test -w server -- test/storyboards.e2e.test.ts`.

### Slice 2: walkthroughs (~90; after 0; uses Slice 1's repo interfaces from `storyboards/types.ts`. Stub them if Slice 1 has not landed, then integrate)
Files: `server/src/storyboards/walkthroughs.ts` (service: start, fresh users, resolve, patch, shots caps, finish, summary, summary-html, purge, reset), `server/src/http/routes/walkthroughs.ts`, `maintenance/retention.ts`, the reset in `api.ts`.

Acceptance:
- Start with fresh and existing actors; missing inputs → 400.
- Resolve per kind: a login totp `codePath` that actually returns a code; email `waitPath` returning a message sent to the fresh user via the existing SMTP path; fill entries rendered and the same on a second resolve.
- A capture sets vars, used in a later resolve.
- Finish rules; summary.html CSP header; shots caps → 413; retention purge; delete `?users=1`.

Test: `server/test/walkthroughs.e2e.test.ts`.

### Slice 3: MCP ontology and authoring tools (~80; after 1, and after 2 for the walkthrough tools)
Files: `server/src/storyboards/{ontology.ts, guide.ts, mcp-tools.ts}`, `http/routes/mcp.ts` (spread, instructions line, `details` in error text), `docs/examples/classprovia-storyboards.json`.

Acceptance: `describe_storyboards` with no object and with each object returns a jsonSchema and an example; `storyboard_guide` topics; every tool in §4.3.

Test: `server/test/storyboards-mcp.e2e.test.ts` builds the **Class PROvia pilot purely through MCP JSON-RPC** on a fresh hub:
1. `create_project classprovia`.
2. `set_app_origins`; create the authenticator through REST setup, the only non-MCP step (the secret is test data).
3. `upsert_test_user` (admin).
4. `upsert_login_recipe` ×2.
5. `save_page_snapshot` (pasted fields of the sign-up page), then `data_set_from_snapshot`.
6. `upsert_data_set` for event-registration.
7. `validate_storyboard` with a deliberately broken storyboard (asserts the codes `missing_data_set`, `unknown_actor`, `var_not_captured`, `missing_login_recipe` with their paths).
8. `upsert_storyboard` (the fixed one).
9. Re-run the whole sequence and assert `unchanged` / same version (idempotency).
10. `import_storyboard_bundle` of the example JSON in dry_run and real mode.
11. `export_storyboard_bundle` equals the input modulo ids.
12. `get_walkthrough_result` after a REST-driven walkthrough (if Slice 2 has landed).

Command: `./scripts/npm.sh test -w server -- test/storyboards-mcp.e2e.test.ts`.

### Slice 4: @stubyard/client (~40; after 0, against the contract)
Files: `packages/client/src/{http.ts, users.ts, messages.ts, authenticators.ts, stream.ts, storyboards.ts, walkthroughs.ts, storyboard-types.ts, index.ts}`, `packages/client/package.json` (exports, 0.7.0).

Acceptance: compiles with `lib DOM`, no Node imports; the SSE parser handles split chunks and comments.

Test: `server/test/client-storyboards.e2e.test.ts`, which imports `../../packages/client/src/index.js` and drives start → resolve → update → finish against a hub (after 1 and 2). Command: `./scripts/npm.sh run typecheck`.

### Slice 5a: extension content engine (~90; after 0, independent of the server)
Files: `packages/extension/{package.json, tsconfig.json, vitest.config.ts, vite.content.config.ts}`, `src/content/*`, `src/shared/{protocol.ts, urlPattern.ts}`, `test/*`; root `package.json`, `Dockerfile`, `package-lock.json` (`./scripts/npm.sh install`).

Acceptance: the §6.11 tests pass. Commands: `./scripts/npm.sh test -w @stubyard/extension`, `./scripts/npm.sh run typecheck`.

### Slice 5b: extension side panel and worker (~100; after 4 and 5a; against the server after 1 and 2)
Files: `public/manifest.json`, `vite.config.ts`, `sidepanel.html`, `src/background.ts`, `src/sidepanel/**`, `src/shared/settings.ts`.

Acceptance:
- `./scripts/npm.sh run build -w @stubyard/extension` produces `dist/` with manifest, background.js, content.js and sidepanel.html.
- A manual checklist on Class PROvia (load unpacked):
  1. Origin match.
  2. Start the pilot walkthrough.
  3. Sign-up fill (report counts).
  4. Email link opens.
  5. Participant login.
  6. Wizard fill on each step.
  7. Capture regNo.
  8. Admin login with auto TOTP.
  9. Approve.
  10. Decision email.
  11. Close and reopen the panel mid-way: the walkthrough resumes.
  12. Kill the worker (chrome://serviceworker-internals): nothing is lost.
  13. Sign off.
  14. summary.html shows the shots.

### Slice 6: dashboard (~100; after 1 and 2, against the contract)
Files: `web/src/storyboardsApi.ts`, `web/src/pages/StoryboardsPage.tsx`, `web/src/components/{StoryboardEditor, DataSetEditor, LoginRecipes, WalkthroughDrawer, BundleImport}.tsx`, `web/src/styles/storyboards.css`, `ProjectPage.tsx` (route + App origins setting), `components/Shell.tsx`, `hooks.ts`, `api.ts`.

Acceptance: `./scripts/npm.sh run typecheck`, `./scripts/npm.sh run build`; the editor round-trips the pilot JSON; validation issues show with paths; layout checked at 390, 768, 1280 and 1920 px.

### Slice 7: docs and release prep (~40; after all)
Files: `docs/AGENT_GUIDE.md` (AF), `docs/GUIDE.md` (§16), `docs/DEVELOPMENT.md`, `CHANGELOG.md`, version bumps, `deploy/make-bundle.sh` (extension zip, optional), and the HANDOFF/CLAUDE.md note text from §4.4 handed to the owner.

Acceptance: the full suite passes twice: `./scripts/npm.sh test` ×2, then `./scripts/npm.sh run build`.

Parallelism: 0 → {1, 4, 5a} in parallel → {2 (it can start right after 0), 3 after 1, 6 after 1} → 5b after 4 and 5a → 7.

---

## Addendum: quick test runs (after the slices, still 0.14.0; extension 0.2.0)
A tracked walkthrough (per-step Done/Skip/Fail, notes, screenshots, sign-off) was too heavy for everyday manual
testing, so a walkthrough now has a run mode. This adds to §1.1, §1.3, §3.4, §3.7 and §8:
- **Migration 25:** `walkthroughs.mode TEXT NOT NULL DEFAULT 'tracked'` and `storyboards.preferred_mode TEXT NOT NULL DEFAULT 'tracked'`.
- **Schema:** `Storyboard.preferredMode: z.enum(['quick','tracked']).default('tracked')`, a hint for which start button the extension shows first. It is in the storyboard content (bundles, project export, `StoryboardBrief`), and in the content hash only when it is `quick`, so hashes of storyboards saved before migration 25 do not change (no version bump on re-PUT).
- **Start:** `POST /walkthroughs {mode?: 'tracked'|'quick'}`, default `tracked` (not the storyboard's `preferredMode`); other values 400. `WalkthroughView` and `WalkthroughBrief` carry `mode`.
- **List:** `GET /walkthroughs?mode=tracked|quick|all`, default `tracked`, so history and older callers never see quick runs; `StoryboardBrief.lastWalkthrough` ignores them too. `list_walkthroughs` (MCP) takes `mode`.
- **Quick-run rules:** screenshot upload 409 ("Quick test runs don't keep screenshots"); step PATCH and resolve unchanged; `finish` takes `verdict` and `signedOffBy` as optional (stored null / `''`) and skips open steps as if `allowIncomplete` were set. Summary and report work as before.
- **Cleanup:** nothing is deleted automatically. Quick runs stay hidden from history and appear in the Cleanup list until their test data is cleaned (their record goes then) or dismissed; see "Addendum: cleanup of test data".
---

## Addendum: cleanup of test data (still 0.14.0; migration 26, extension 0.3.0)
Walkthroughs create test data: fresh users and the messages sent to them. Nothing is cleaned automatically; cleanup is
a button the user presses, in the extension's side panel or the dashboard. Phase 2 (an optional `cleanup` recipe in
storyboards, for data inside the app under test) is not built.

**What a run's test data is**
- Its **fresh users** (actors with `created: true` in `walkthroughs.actors`) and each one's **messages** (email, SMS,
  WhatsApp, with their codes). Messages are deleted first (`hub.messages.delete(projectId, {testUserId})`; they reference
  users with ON DELETE SET NULL and would land in Unassigned), then the user. Orphaned Mailpit copies are deleted after
  the transaction; a Mailpit failure is logged, not thrown.
- For **quick** runs, also the walkthrough record (steps and shots cascade) once it is fully cleaned. **Tracked** runs
  keep their record, steps, notes, screenshots and sign-off.
- **Captured vars** are shown only: "values in your app, not removed by stubyard". They usually identify records the
  run created in the app under test.

**Migration 26**
- `walkthroughs.cleanup_status TEXT NOT NULL DEFAULT 'none'` (`none | pending | cleaned | dismissed`), `cleanup_at`,
  `cleanup_report` (JSON: the last `CleanupRunResult`; a dismissal adds `dismissNote`).
- `test_users.keep INTEGER NOT NULL DEFAULT 0`: the **Keep** pin, a shared fixture cleanup never deletes.
- `walkthrough_uses (walkthrough_id, project_id, source_walkthrough_id, user_id, kind, created_at)`, unique per
  `(walkthrough_id, source_walkthrough_id, kind, COALESCE(user_id, ''))`, CASCADE with both runs.
- Backfill: runs whose actors contain `"created":true` become `pending`.
- Startup backfill (in code, `WalkthroughCleanup.backfill`, every start, idempotent): `walkthrough_uses` kind `actor`
  rows for runs from before migration 26 (an actor with `created: false` whose user is another run's `created: true`
  actor in the same project; INSERT OR IGNORE on the unique index), then pending runs with nothing left are settled.

**Status lifecycle:** `none` (nothing created) → `pending` as soon as a fresh user is created (at start, or when a refresh
adds a fresh actor) → `cleaned` (every created user removed, already gone or Keep-pinned) or `dismissed` ("leave it": the
data stays, the run leaves the list; reopen brings it back to `pending`).
- **Settling:** a pending, non-active run with no existing non-Keep fresh user left becomes `cleaned` (lazily on
  `GET /cleanup` and `GET /walkthroughs/:id/cleanup`, right after `DELETE /users/:id` or a Keep pin through
  `PATCH /users/:id`, and in the startup backfill). Un-pinning (`keep` true → false) sets a `cleaned` creating run back
  to `pending`.
- `POST /walkthroughs/:id/reopen` of a run whose cleanup is `cleaned` → 409 "Its test data was cleaned up; start a new
  run".

**Dependencies** (`storyboards/cleanup.ts`)
- *actor*: when `resolveActors` resolves an actor to an existing user (override, `user` ref or role) that is another
  run's fresh user (LIKE prefilter on `"userId":"<id>"`, confirmed by parsing), a row B → A with that user is recorded.
- *declared*: `POST /walkthroughs {uses?: string[]}` (ids or keys of the project's walkthroughs, at most 20; unknown →
  400 naming it) for runs that reuse values A captured, which stubyard cannot see. One row per source, user NULL; the
  run then depends on all of A's fresh users.
- A dependent **still needs** the data while it is active or while its own cleanup is `pending`. A non-active `none`
  dependent (finished, created nothing), and `cleaned` or `dismissed` ones, block nothing.

**REST**
- `GET /api/projects/:slug/cleanup?status=pending|cleaned|dismissed|all&mode=all|quick|tracked` (defaults pending, all)
  → `{items: CleanupItem[], counts: {pending, active, cleaned, dismissed}, truncated}`. Active runs are never items;
  `active` counts the active runs with pending data. Newest finished first; at most 500 items (`truncated: true` when
  the cap cut the list).
- `GET /walkthroughs/:id/cleanup` → one `CleanupItem` (any status; an active run gets a warning). It lists the fresh
  users (`exists`, `keep`, message count, `usedBy`), the vars, the runs it `uses`, what a default cleanup would remove
  now (`removable`), warnings and `lastReport`.
- `POST /cleanup {walkthroughs: 1..100 ids|keys, skipUsers?, onConflict?: ask|keep|include, dryRun?}`
  - Unknown run → 404; an active one → 409 "Walkthrough K is still active: finish or abandon it first".
  - Users to delete: fresh users that exist, are not Keep-pinned and not in `skipUsers` (ids or emails; at most 500,
    400 beyond).
  - A conflict is such a user still needed by a run outside the selection. `ask` (default): 409 `{error, conflicts}`
    and nothing changes (a dryRun returns 200 with the conflicts instead). `keep`: those users stay (`used-by`).
    `include`: the non-active dependents join the selection, transitively, only through users that will actually be
    deleted (exist, not Keep-pinned, not skipped); active ones keep their users (`used-by-active`). A selected `none`
    run keeps its status. The 409 body carries `requestId`.
  - One transaction. A run is `cleaned` when no created user remains that is not Keep-pinned, else `partial` (it stays
    pending, with `cleanup_report` updated). Cleaned tracked runs get `cleanup_status = cleaned`, `cleanup_at` and the
    report; cleaned quick runs are deleted (`removed.record`) once none of their users remains: a Keep-pinned user
    keeps the record (`cleaned`, hidden from the default list) so un-pinning can reopen it.
  - Events: `walkthrough.changed {id, status, cleanup, deleted?}` per run, `user.changed {deleted}` per user.
- `POST /walkthroughs/:id/cleanup/dismiss {note?}` (409 while active, once cleaned, or on a `none` run) and
  `…/cleanup/reopen` (409 unless dismissed) → the `CleanupItem`.
- Clients: after the conflict dialog's **Clean both** / **Keep those users**, a second dryRun with that `onConflict`
  feeds a confirm (which runs, how many users / messages / records) before the real call. Clean up is offered for any
  pending, non-active run with an existing non-Keep fresh user, even when every such user is used by another run.
- Users: `POST /users` and `PATCH /users/:id` accept `keep`; every user view carries it; project export / import carry it.
- `DELETE /walkthroughs/:id?users=1&force=1`: a `pending` run → 409 "has test data to clean up: use Clean up, ?users=1,
  or ?force=1" unless `users=1` or `force=1`. `users=1` follows the cleanup rules (never Keep-pinned users, messages go
  too); a user kept for `used-by` / `used-by-active` → 409 listing them (`details.kept`) unless `force=1`, which deletes
  the run and leaves those users. Returns `{deleted, users, kept}`.
- Fresh actors of one walkthrough get distinct names (fake values are seeded per walkthrough; a name equal to an
  earlier actor's is re-rolled with another seed, up to 5 times).

**Retention and reset:** the retention purge (`purgeOlderThan`) skips runs with `cleanup_status = 'pending'`, so no run
with uncleaned data becomes untraceable. Project reset still deletes every walkthrough.

**Client** (`@stubyard/client/walkthroughs`): `listCleanup`, `cleanupPreview`, `cleanupRuns` (+ `cleanupConflicts(err)`
for the 409 body), `dismissCleanup`, `reopenCleanup`; `startWalkthrough` takes `uses`; `setUserKeep` in
`@stubyard/client/users`. Types: `CleanupStatus`, `CleanupRunRef`, `CleanupUser`, `CleanupItem`, `CleanupList`,
`CleanupKept`, `CleanupRunResult`, `CleanupConflict`, `CleanupResult`; `WalkthroughView` / `WalkthroughBrief` carry
`cleanupStatus` and `cleanupAt`, `HubUser` carries `keep`.

---

## Addendum: walkthrough recording, R1 DOM recording (0.15.0; migration 27, extension 0.5.0)
The extension can record the app pages of a walkthrough with rrweb (DOM events, not video), so a reviewer replays what
the tester did on the dashboard. R1 is DOM recording only; `record: "video"` was accepted and recorded as DOM until R2
(next addendum) made it a video of the tab.

**Turning it on**
- Storyboard fields `record: "off" | "dom" | "video"` (default `off`) and `recordMaskAllInputs` (default false). Both are
  left out of the content hash at their defaults, so old storyboards keep their hash.
- `POST /walkthroughs` takes `record` (override) and `maskAllInputs`. Without `record`, tracked runs follow the storyboard;
  quick runs are off. `video` adds a warning to the run. The extension's Start screen has a Recording select
  (storyboard default / record / do not record); the client's `startWalkthrough` passes both. There is no MCP start tool.
- The run keeps `walkthroughs.record` (what was asked) and `walkthroughs.recording` (JSON: mode, paused, stopped,
  stoppedAt, maskAllInputs). `PATCH …/walkthroughs/:id/recording {paused?, mode?, maskAllInputs?}` pauses, resumes, or
  switches recording on (`mode: "dom"`, also clears a stop at the cap) or off for the rest of the run.
- `WalkthroughView.recording`: `{mode, requested, maskAllInputs, paused, stopped, stoppedAt, maskSelectors, segmentCount,
  bytes, maxBytes}`. `maskSelectors` (only while recording) are the password and 2FA selectors of the run's login recipes
  plus one-time-code and card inputs.

**Extension**
- `content/recorder.ts`: rrweb `record()` in the top frame of tabs whose window has the run open and whose page is one of
  the run's origins (`ActiveWalkthrough.origins`; none when a run was opened by a panel without origins).
  - Masking (as built in R1; replaced by "Addendum: walkthrough recording privacy" below, which masks every input by
    default): password inputs always; inputs whose autocomplete is one-time-code / *-password / cc-number / cc-csc;
    names, ids, labels or placeholders like otp, totp, mfa, 2fa, one-time, verification code, cvv; the run's
    `maskSelectors`; every field stubyard typed a password or 2FA code into (`setValue` `secret`). `maskAllInputs`
    masks everything. Masked values become `*` (max 32).
  - Not recorded: the widget host (`[data-stubyard-widget]`, blockSelector) and `[data-stubyard-ignore]`; the side panel
    is an extension page and never recorded. Canvas, fonts, cross-origin iframes: off.
  - Sampling: mousemove 50 ms, scroll 150 ms, input `last`.
  - Segments: one per page load and one per resume, with a random key, the url, the step and startedAt. A
    `stubyard.step` custom event (`{stepId}`) is added at a segment start and on every step change.
  - Chunks: every 5 s, early at 2000 events, on visibilitychange (hidden) and on pagehide (final: the segment ends).
    A back/forward-cache restore starts a new segment. Chunks that fail for a network reason are retried (max 12).
- `background/recordingSync.ts`: the service worker starts, updates or stops the recorders (on tab load, storage
  changes and `recording.sync` from the panel or the widget when the run's step or recording state changes) and uploads
  chunks with the settings' hub URL. It checks each chunk's sender: top frame, an origin of the run open in that tab's
  window, same project and walkthrough. The page never sees the hub URL.
- A 409 (off), 413 (cap), 404 or 400 answer stops the recorder for that run; the chunk replies also carry the hub state,
  so a pause or step change made elsewhere is followed without waiting for the views.
- UI: a red-dot line with Pause / Resume under the run header in the side panel and in the widget card; the collapsed
  pill has a red dot (hollow while paused). CONTENT_VERSION 0.7.0 (`recording.start`, `recording.stop`, `setValue.secret`).
- Isolated world: the recorder sees the DOM, not the page's JS. Rules added with CSSOM `insertRule` (CSS-in-JS) after the
  snapshot and values set by page scripts without input events may be missing in the replay.

**Server (`storyboards/recordings.ts`, migration 27)**
- Tables `walkthrough_recordings` (one row per segment: no, key, step, url, started/ended, bytes, events, status
  `recording | complete | cut`) and `walkthrough_recording_chunks` (gzip NDJSON per chunk, PK segment + seq). Both CASCADE
  with the walkthrough and the project.
- `POST …/recording/chunks {segment: {key, url, startedAt, stepId}, seq, events, final?}` (body limit 10 MB):
  201 stored, 200 for a repeated seq. Limits: 8 MB of events and 50 000 events per chunk (413), and per walkthrough
  `settings.recordingMaxMb` (default 50 MB, gzip bytes). Going over the cap cuts the segment, sets
  `recording.stopped` and answers 413: recording has stopped until the recording is deleted or mode dom is set again.
- `GET …/recording` lists segments; `GET …/recording/segments/:no` streams the events as NDJSON (gzip when accepted;
  header `x-recording-segment`); `DELETE …/recording` removes all segments.
- Retention: recordings whose last segment ended more than `settings.recordingRetentionDays` (default 14; 0 keeps them)
  ago are purged by maintenance (`recordingsPurged`). Bundle export carries the storyboard's `record` setting, never
  recordings.
- MCP: `list_walkthrough_recordings` (read-only), `delete_walkthrough_recording` (destructive). Ontology and the
  storyboard guide mention the field.

**Dashboard**: the walkthrough drawer has Details and Recording tabs. Recording lists the segments (path, step,
duration, size, live/cut) and plays one with rrweb-player (loaded on first use) under our own controls: play/pause,
a timeline with step markers (a click jumps there), step chips, speed 1x / 2x / 4x, skip inactivity, size of the cap,
Pause / Resume / "Record the rest" while the run is active, and Delete.

**Measured** (test/widget-spike/recording1.py, simple fixture pages, headless Chrome): about 8 KB per minute stored
(gzip) and 47 KB per minute raw while typing, moving the mouse and scrolling. Real apps with a larger DOM cost more per
page load (the full snapshot), so the 50 MB default should cover hours.

## Addendum: walkthrough recording, R2 video mode (0.15.0; no migration, extension 0.5.0)
`record: "video"` records the tab as a video (WebM) instead of the DOM. For apps whose replay as DOM is poor (canvas,
CSS-in-JS, cross-origin iframes) or when a reviewer wants exactly what the screen showed. A video cannot mask what is
typed by hand: the run warns at start, the Start screen and the storyboard editor say so.

**Extension** (permissions `tabCapture` and `offscreen`: Chrome shows a permission prompt when the extension updates)
- Start: tab capture needs the extension invoked on the tab (activeTab). Starting a video run from the side panel calls
  `video.start` right after the run opens; the run bar and the widget card have **Record video**, and the command
  **Alt+Shift+V** (`record-video`) starts it from the keyboard (a command always invokes the extension). If Chrome
  refuses ("Extension has not been invoked for the current page"), the error says to click the toolbar button or press
  Alt+Shift+V.
- `background/videoSync.ts` (service worker): checks the run (open in the tab's window, active, mode video, not stopped,
  no other tab capturing), gets `chrome.tabCapture.getMediaStreamId({targetTabId})`, opens the offscreen document
  (reason USER_MEDIA) and keeps the capture in `chrome.storage.session.videoCapture` (`VideoSession`); the last end
  reason goes to `videoEnded`. One capture at a time. It follows the run from chunk replies and syncs: pause / resume,
  step changes (markers), another origin in the tab (paused, `pausedFor: 'origin'`), mode off, the run ending or
  closed in the window (stop). Chunks are accepted only from the offscreen document's URL and the running key.
- `offscreen/videoRecorder.ts`: getUserMedia with `chromeMediaSource: 'tab'`, video only, at most 1280 px wide (aspect
  kept) and 8 fps; MediaRecorder WebM VP9 (else VP8, else plain WebM) at 500 kbps, a chunk every 5 s. Chunks go to
  the worker one at a time, in order (a WebM file is its chunks joined), base64. Pause / resume keep one segment and
  leave paused time out of the media time; step markers are offsets (ms) into the media time. A failed upload is
  retried after 2, 5, 10, 20, 30 s; more than 24 chunks waiting stops the video. Close to the cap
  (`maxBytes - bytes < max(2 × last chunk, 64 KB)`) it stops by itself so the last chunk still fits. The track's
  `ended` (tab closed, capture ended) stops it. The last data is the final chunk; then `video.ended`.
- The page (CONTENT_VERSION 0.8.0, `recording.video {on}`): while video is on, every field the extension typed a
  password or a 2FA code into gets `-webkit-text-security: disc !important` (set before the value lands) and the
  widget folds to its pill (opened again after, if video folded it). Typed by hand is visible.
- Views: the run bar shows "Recording a video of this tab · at least N min left of 50 MB", "paused (outside the run)",
  or "not running" with the last end reason; the pill's dot follows the capture.

**Server** (no migration; `storyboards/recordings.ts`)
- A video segment is a `walkthrough_recordings` row whose `segment_key` starts with `video.` (extension keys cannot
  contain a dot); its chunks are raw WebM (not gzip); a chunk row with `seq = -1` (0 bytes) holds the segment's
  metadata JSON `{mime, durationMs, markers, width, height}`.
- `POST …/recording/chunks {kind: "video", segment, seq, data (base64), mime, durationMs, markers, width?, height?,
  final?}`: 409 unless the run records video (and a DOM chunk for a video run is 409), 413 at the cap (same cap,
  stop and cut as DOM). seq 0 must start with the EBML header. `events_count` counts chunks.
- `GET …/recording/segments/:no` for video: `video/webm` with `Accept-Ranges: bytes`, 206 for one range (also
  suffix and open ranges), 416 past the end, `nosniff`, `no-store` while recording. Chrome's MediaRecorder writes no
  Duration: the hub writes one into the Info element of chunk 0 when serving (`webmSetDuration`), so the served file
  is ~18 bytes bigger than `bytes`, and a `<video>` shows the length and seeks.
- `recording.mode` is `video`; segment views have `kind` (`dom` | `video`), `mime` and `markers` for video.
- A run can hold both kinds (switched mode mid-run); `record: "both"` was not built.

**Dashboard**: the Recording tab plays a video segment in a `<video>` under the same controls (timeline with step
markers, step chips, 1x / 2x / 4x via `playbackRate`); Video and Page (DOM) tabs when a run has both kinds; "at least
N min of video left" while recording.

**Measured** (test/widget-spike/recording2.py, headless Chrome 158, VP9): a form and a list page with typing, scrolling
and mouse moves at 1280×714: about 1.0 MB per minute. A page animating all the time, 1920×1080 tab captured at
1280×662: about 2.35 MB per minute. So 50 MB holds 20 to 50 minutes (at least 13 at the 500 kbps ceiling).


## Addendum: walkthrough recording privacy (security review of R1; migration 27 amended, CONTENT_VERSION 0.9.0)
A review of R1 found that masking by field look-alikes missed fields, a "show password" toggle could leak, maskAll left
text in clear, URLs carried tokens, replay loaded resources from any site, and some limits could be dodged. What
changed (what is still not covered: AGENT_GUIDE §AF.10 "Not masked" and GUIDE §15 "What is masked, and what is not"):

**Masking (extension, `shared/recording.ts`, `content/sensitive.ts`)**
- Every input value is masked by default (rrweb `maskAllInputs: true`, all values through `maskInputFn`). A storyboard
  shows plain fields with `recordPrivacy.unmaskSelectors`; a field that looks sensitive stays masked even when it
  matches: password type (or ever was), `-webkit-text-security` (inline or computed), short numeric code boxes
  (maxlength 1-8 with a numeric inputmode, tel/number type or a digit pattern, or maxlength 1), autocomplete
  one-time-code / *-password / cc-*, names, ids, labels and placeholders with password / secret / token / key / otp /
  card / iban / cvv / expiry words, the run's `maskSelectors`, and a field holding a value the extension typed as a
  secret.
- `SensitiveTracker` (content script, a MutationObserver started before rrweb's) remembers every element seen as a
  password (also after its type changes) and the id / name / autocomplete / form position of removed password inputs,
  so a text input that replaces one is masked too. It also remembers values the extension typed as secrets: `setValue
  secret` and `fill` entries whose target looks sensitive.
- Text: contenteditable and `[data-stubyard-mask]` and `recordPrivacy.maskTextSelectors` are starred; other text is
  checked for secret shapes (otpauth URLs, JWTs, provider keys, base32 seeds, long hex, Luhn card numbers, "key: …"
  labels, values the extension typed). `recordMaskAllInputs` (strict) masks every input and all text.
- Blocked (not recorded at all): hidden inputs, the widget, `[data-stubyard-block]`, `recordPrivacy.blockSelectors`.
- Video: while video records, the same checks put `-webkit-text-security: disc` on sensitive fields (a stylesheet for
  what CSS can match, per field on focus / input / tracker changes), also while typing by hand. Page text is not masked
  in a video.

**URLs**: query values and fragments become `*` (names kept), token-like path segments `*`, userinfo dropped, only
http(s) kept; in the extension (segment URL, Meta href, video session) and again on the server (segment URL, Meta
href, the `x-recording-segment` header, which is now ASCII-only JSON).

**Replay**: the dashboard mounts rrweb-player into `<iframe sandbox="allow-same-origin" src=…/recording/player>`, a hub
page served with `default-src 'none'; img-src data: <app origins>; style-src 'unsafe-inline' <app origins>; font-src
data: <app origins>; script-src 'none'; frame-src/child-src/media-src/object-src/connect-src 'none'; form-action
'none'; base-uri 'none'; frame-ancestors 'self'`, `Referrer-Policy: no-referrer`. rrweb's replay frame inside inherits
it. `UNSAFE_replayCanvas` stays false. Events stream to the player (48 MB at most per segment).

**Run state and limits (server)**
- Chunks for a run that is no longer active answer 409 (a segment that exists gets 15 s after the end for its last
  flush, cut at the end). `recording.pausedAt` is stored; events after it are dropped (video: 8 s grace).
- An empty chunk of an unknown segment creates nothing: the recorders send one every 2 s as a heartbeat (DOM and
  video) and follow the state in the answer.
- Caps: 1000 segments per run (stop), 32 MB uncompressed per segment (413 `segmentFull`: the recorder starts a new
  segment), 10 × `recordingMaxMb` uncompressed per walkthrough (stop), next to the compressed cap. `raw_bytes` on
  `walkthrough_recordings`; segment views have `rawBytes`.
- Large pages: an event over 7 MB (a huge snapshot) is not sent; a `stubyard.note` custom event says why and the
  dashboard shows it; the next page load records again.

**Storyboard**: `recordPrivacy {unmaskSelectors, maskSelectors, maskTextSelectors, blockSelectors}` (each at most 50
selectors; empty lists leave the content hash alone; column `storyboards.record_privacy`, JSON). `WalkthroughView
.recording` adds `maskAllText`, `pausedAt`, `unmaskSelectors`, `maskTextSelectors`, `blockSelectors`.

**Checked by** unit tests (`packages/extension/test/recording.test.ts`, `recordingVideo.test.ts`), the server e2e
suites (`walkthrough-recording*.e2e.test.ts`) and the headless regression `test/widget-spike/recording-secrev.py`
(19 PASS / FAIL checks, all passed on 2026-11-23, with `recording1.py` and `recording2.py`).

**Known gaps** (also in AGENT_GUIDE §AF.10 and GUIDE §15)
- Outside strict mode, page text is masked only by pattern: a secret in a format the patterns do not know is in clear.
- `href` / `src` URLs of the page's own elements inside the snapshot are not redacted; only the page URL is.
- Meta hrefs stored before these rules are not rewritten (segment URLs are redacted when shown).
- The pause cut-off compares browser event timestamps with the hub clock; a tester clock far off moves it.
- `SensitiveTracker` watches the main document only: a show-password toggle in a shadow root or a same-origin iframe
  is not remembered (the field is still masked by its type).
- Video: page text and fields that do not look sensitive are visible; a browser without `-webkit-text-security` would
  show no dots (Chrome has it).
- Not changed: the hub guard lets the app under test (same host, another port) POST chunks and DELETE a recording
  (reported as information by the review); the editor has no `recordPrivacy` fields;
  `@stubyard/client`'s `getRecordingEvents` reads the whole response instead of streaming.

**Docs**: CHANGELOG "Unreleased", AGENT_GUIDE §AF.10, GUIDE §15 "Recording a walkthrough", DEVELOPMENT (harnesses,
code map).

## 11. Open questions (they do not block coding; they decide pilot data)
1. **Password:** does the stubyard project's default password satisfy Class PROvia's sign-up password rules? If not, set `defaultPassword` in project `classprovia` or give fresh actors a password template; that is a small schema addition, `Actor.password?: TEMPLATE`.
2. **Approval categories:** is there a category with "Approval needed" open for registration on HCE27 (and is it free or paid)? The `decision-email` subject regex covers both cases.
3. **Consent to register the MCP server:** the owner must approve registering stubyard as an MCP server in the class-provia repo (HANDOFF §6 rule).

### Critical Files for Implementation
- /Volumes/d/GitRepo/stubyard/server/src/db/migrations.ts
- /Volumes/d/GitRepo/stubyard/server/src/http/guard.ts
- /Volumes/d/GitRepo/stubyard/server/src/autoreplies/template.ts
- /Volumes/d/GitRepo/stubyard/server/src/http/routes/mcp.ts
- /Volumes/d/GitRepo/stubyard/server/src/maintenance/export.ts
- /Volumes/d/GitRepo/stubyard/web/src/pages/ProjectPage.tsx
- /Volumes/d/GitRepo/class-provia/react/src/custom/forms/FormRenderer.tsx
