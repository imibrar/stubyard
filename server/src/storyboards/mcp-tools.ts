import { storyboardGuide, GUIDE_TOPICS } from './guide.js';
import { describeStoryboards, OBJECT_NAMES } from './ontology.js';

/**
 * MCP tools for storyboard authoring (docs/design/storyboards.md §4), spread into TOOLS in http/routes/mcp.ts. Every
 * write goes through the REST API, so REST validation applies and 400s carry every issue ({path, code, message}).
 * Upserts are keyed by role / slug / email and idempotent: they report status created | updated | unchanged.
 */

type Json = Record<string, unknown>;
type Api = (method: string, url: string, body?: unknown) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface StoryboardTool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  run: (a: Json, ctx: { api: Api }) => Promise<unknown>;
}

const s = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra });
const b = (description: string) => ({ type: 'boolean', description });
const o = (description: string) => ({ type: 'object', description });
const arr = (description: string, items: Json = {}) => ({ type: 'array', description, items });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const enc = encodeURIComponent;
const PROJECT = s('stubyard project slug, e.g. "classprovia"');
const RO = { readOnlyHint: true, openWorldHint: false };
const DESCRIBE = 'Shapes: describe_storyboards {object}.';
const base = (a: Json) => `/api/projects/${enc(String(a.project))}`;
const qs = (q: Record<string, unknown>) => {
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

/** HTTP status of an error thrown by the injected api ("stubyard answered 404: …"). */
const statusOf = (err: unknown) => Number(/^stubyard answered (\d{3})/.exec((err as Error)?.message ?? '')?.[1] ?? 0);

/** GET that answers null on 404. */
async function getOrNull(api: Api, url: string): Promise<Json | null> {
  try {
    return (await api('GET', url)) as Json;
  } catch (err) {
    if (statusOf(err) === 404) return null;
    throw err;
  }
}

/** Objects may arrive as JSON text from some clients. */
function objectArg(v: unknown, name: string): Json {
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      throw new Error(`${name} must be a JSON object (could not parse the string)`);
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${name} must be an object`);
  return v as Json;
}

function keyArg(a: Json, inner: Json, k: string, what: string): string {
  const v = inner[k] ?? a[k];
  if (typeof v !== 'string' || !v) throw new Error(`${what}.${k} is required`);
  return v;
}

/** JSON with sorted keys, without the server fields that change on reads (counts, refs, warnings). */
function content(v: Json): string {
  const skip = new Set(['users', 'usedBy', 'refs', 'warnings', 'matchScore']);
  const norm = (x: unknown, top: boolean): unknown => {
    if (Array.isArray(x)) return x.map((y) => norm(y, false));
    if (x && typeof x === 'object') {
      const out: Json = {};
      for (const k of Object.keys(x).sort()) if (!(top && skip.has(k))) out[k] = norm((x as Json)[k], false);
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(v, true));
}

/** PUT upsert with the status the agent needs: created (nothing before), unchanged (same stored content), updated. */
async function upsert(api: Api, url: string, body: Json): Promise<{ status: 'created' | 'updated' | 'unchanged'; view: Json }> {
  const before = await getOrNull(api, url);
  const view = (await api('PUT', url, body)) as Json;
  const status = !before ? 'created' : content(before) === content(view) ? 'unchanged' : 'updated';
  return { status, view };
}

const briefDataSet = (d: Json) => ({ slug: d.slug, name: d.name, match: d.match, entries: Array.isArray(d.entries) ? d.entries.length : 0, usedBy: d.usedBy, ...(d.matchScore !== undefined ? { matchScore: d.matchScore } : {}), updatedAt: d.updatedAt });

/** Pasted snapshot fields → ScannedField (missing props null / auto / false; visible true). */
function scannedField(f: Json, i: number): Json {
  if (!f || typeof f !== 'object' || typeof f.key !== 'string' || !f.key) throw new Error(`fields[${i}].key is required`);
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  return {
    key: f.key,
    id: str(f.id),
    name: str(f.name),
    testId: str(f.testId),
    kind: typeof f.kind === 'string' ? f.kind : 'auto',
    inputType: str(f.inputType),
    label: str(f.label),
    placeholder: str(f.placeholder),
    value: f.value === undefined ? null : f.value,
    ...(Array.isArray(f.options) ? { options: f.options } : {}),
    required: f.required === true,
    visible: f.visible !== false,
    formId: str(f.formId),
    duplicateKey: f.duplicateKey === true,
  };
}

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return '';
  }
};

export const STORYBOARD_MCP_TOOLS: StoryboardTool[] = [
  // ---------------------------------------------------------------- ontology and guide
  {
    name: 'describe_storyboards',
    description:
      'START HERE to author manual test walkthroughs (storyboards). Without `object`: every object (what it IS, its key, the tools that write it), relations with cardinality and must-exist-first, the build order, enums, template variables and every validation code with meaning and fix. ' +
      `With object (${OBJECT_NAMES.join(', ')}): its fields (type, required, default, enum, rules, refersTo), JSON Schema, validation, a realistic example and pitfalls.`,
    inputSchema: obj({ object: s('One object name (omit for the overview)', { enum: OBJECT_NAMES }) }),
    annotations: RO,
    run: async (a) => describeStoryboards(a.object ? String(a.object) : undefined),
  },
  {
    name: 'storyboard_guide',
    description: `How-to recipes (markdown) for writing storyboards: ${GUIDE_TOPICS.join(', ')}. Without topic: the topic list.`,
    inputSchema: obj({ topic: s('Guide topic', { enum: [...GUIDE_TOPICS] }) }),
    annotations: RO,
    run: async (a) => storyboardGuide(a.topic ? String(a.topic) : undefined),
  },

  // ---------------------------------------------------------------- project, users, authenticators
  {
    name: 'set_app_origins',
    description:
      'Set the project\'s app origins (e.g. ["http://localhost:3183"]: the extension finds the project by them; relative step URLs use the first) and optionally the roles, email domain of fresh users and default password. Values given replace the current ones.',
    inputSchema: obj(
      {
        project: PROJECT,
        origins: arr('Origins like "http://localhost:3183" (scheme://host[:port], no path)', { type: 'string' }),
        roles: arr('Roles of the app, e.g. ["admin", "participant"]', { type: 'string' }),
        email_domain: s('Email domain of fresh users (default "<project>.test")'),
        default_password: s('Password for users without their own (fresh actors); must pass the app\'s password rules'),
      },
      ['project', 'origins'],
    ),
    run: async (a, { api }) => {
      const before = (await api('GET', base(a))) as { settings: Json };
      const patch: Json = { appOrigins: a.origins };
      if (a.roles !== undefined) patch.roles = a.roles;
      if (a.email_domain !== undefined) patch.emailDomain = a.email_domain;
      if (a.default_password !== undefined) patch.defaultPassword = a.default_password;
      const p = (await api('PATCH', base(a), { settings: patch })) as { slug: string; settings: Json };
      const keys = ['appOrigins', 'roles', 'emailDomain', 'defaultPassword'];
      const same = keys.every((k) => JSON.stringify(before.settings[k]) === JSON.stringify(p.settings[k]));
      const st = p.settings;
      return { status: same ? 'unchanged' : 'updated', project: p.slug, settings: { appOrigins: st.appOrigins ?? [], roles: st.roles ?? [], emailDomain: st.emailDomain ?? `${p.slug}.test`, defaultPassword: st.defaultPassword ? '(set)' : '(not set: Password123!)' } };
    },
  },
  {
    name: 'upsert_test_user',
    description:
      'Create or update a test user by email (an existing account of the app, e.g. the admin). Give the password the account really has (omit it to use the project default). Status created | updated | unchanged. Users the flow signs up should be fresh actors instead.',
    inputSchema: obj({ project: PROJECT, email: s('Login email (the upsert key)'), name: s('Full name "First Last"'), role: s('Role, e.g. "admin"'), phone: s('Phone (E.164), optional'), password: s('Password in the app, optional'), notes: s('Notes, optional') }, ['project', 'email', 'name', 'role']),
    run: async (a, { api }) => {
      const email = String(a.email).trim();
      const ex = await getOrNull(api, `${base(a)}/users/${enc(email)}`);
      const want: Json = { name: a.name, role: a.role };
      for (const k of ['phone', 'password', 'notes']) if (a[k] !== undefined) want[k] = a[k];
      const brief = (u: Json) => ({ id: u.id, email: u.email, name: u.name, role: u.role, phone: u.phone, notes: u.notes });
      if (!ex) return { status: 'created', user: brief((await api('POST', `${base(a)}/users`, { email, ...want })) as Json) };
      const patch: Json = {};
      for (const [k, v] of Object.entries(want)) {
        const cur = ex[k];
        const same = k === 'phone' ? String(cur ?? '').replace(/[^\d+]/g, '') === String(v ?? '').replace(/[^\d+]/g, '') : k === 'name' ? String(cur) === String(v).trim() : cur === v;
        if (!same) patch[k] = v;
      }
      if (!Object.keys(patch).length) return { status: 'unchanged', user: brief(ex) };
      return { status: 'updated', changed: Object.keys(patch), user: brief((await api('PATCH', `${base(a)}/users/${enc(String(ex.id))}`, patch)) as Json) };
    },
  },
  {
    name: 'list_authenticators',
    description: 'Authenticator (TOTP) keys of the project: label and linked user (no secrets). A totp login recipe names one by label (twoFactor.authenticator). Keys are added by a human in the dashboard.',
    inputSchema: obj({ project: PROJECT }, ['project']),
    annotations: RO,
    run: async (a, { api }) => (((await api('GET', `${base(a)}/authenticators`)) as { items: Json[] }).items ?? []).map((x) => ({ id: x.id, label: x.label, testUserId: x.testUserId ?? null, issuer: x.issuer ?? null, account: x.account ?? null })),
  },

  // ---------------------------------------------------------------- login recipes
  {
    name: 'upsert_login_recipe',
    description: `Create or replace the login recipe of a role: loginUrl, field selectors, twoFactor (none | totp {selector, authenticator label} | email-otp / sms-otp {selector, subject?}), logoutUrl, notes. Status created | updated | unchanged. ${DESCRIBE}loginRecipe`,
    inputSchema: obj({ project: PROJECT, recipe: o('LoginRecipe {role, name?, loginUrl, fields?, twoFactor?, logoutUrl?, notes?}') }, ['project', 'recipe']),
    run: async (a, { api }) => {
      const r = objectArg(a.recipe, 'recipe');
      const role = keyArg(a, r, 'role', 'recipe');
      const { status, view } = await upsert(api, `${base(a)}/login-recipes/${enc(role)}`, r);
      return { status, recipe: view };
    },
  },
  {
    name: 'list_login_recipes',
    description: 'Login recipes of the project (one per role), with the number of test users per role.',
    inputSchema: obj({ project: PROJECT }, ['project']),
    annotations: RO,
    run: async (a, { api }) => api('GET', `${base(a)}/login-recipes`),
  },
  {
    name: 'delete_login_recipe',
    description: 'Delete the login recipe of a role. Refused (409) while a storyboard uses it unless force.',
    inputSchema: obj({ project: PROJECT, role: s('Role'), force: b('Delete even when storyboards use it') }, ['project', 'role']),
    annotations: { destructiveHint: true },
    run: async (a, { api }) => api('DELETE', `${base(a)}/login-recipes/${enc(String(a.role))}${qs({ force: a.force ? 1 : undefined })}`),
  },

  // ---------------------------------------------------------------- data sets
  {
    name: 'upsert_data_set',
    description: `Create or replace a data set (all its entries): {slug, name, description?, match:{urlPattern?, formId?}, entries:[{key, value, kind?, selector?, label?, note?}]}. Status created | updated | unchanged. To change a few entries use patch_data_set_entries. ${DESCRIBE}dataSet`,
    inputSchema: obj({ project: PROJECT, dataSet: o('DataSet') }, ['project', 'dataSet']),
    run: async (a, { api }) => {
      const d = objectArg(a.dataSet, 'dataSet');
      const slug = keyArg(a, d, 'slug', 'dataSet');
      const { status, view } = await upsert(api, `${base(a)}/data-sets/${enc(slug)}`, d);
      return { status, dataSet: view };
    },
  },
  {
    name: 'patch_data_set_entries',
    description: 'Change some entries of a data set: upsert (merged by key: replaces the entry with that key or appends it) and/or remove (keys). Other entries stay. Also name / description / match.',
    inputSchema: obj(
      { project: PROJECT, slug: s('Data set slug'), upsert: arr('Entries [{key, value, kind?, selector?, label?, note?}]', { type: 'object' }), remove: arr('Keys to remove', { type: 'string' }), name: s('New name'), description: s('New description'), match: o('New match {urlPattern?, formId?}') },
      ['project', 'slug'],
    ),
    run: async (a, { api }) => {
      const before = (await api('GET', `${base(a)}/data-sets/${enc(String(a.slug))}`)) as Json;
      const body: Json = { upsertEntries: a.upsert, removeKeys: a.remove, name: a.name, description: a.description, match: a.match };
      const view = (await api('PATCH', `${base(a)}/data-sets/${enc(String(a.slug))}`, body)) as Json;
      return { status: content(before) === content(view) ? 'unchanged' : 'updated', dataSet: view };
    },
  },
  {
    name: 'list_data_sets',
    description: 'Data sets of the project (slug, name, match, entry count, used by which storyboards). With url: only the ones whose match.urlPattern matches that page, best match first.',
    inputSchema: obj({ project: PROJECT, url: s('Page URL or path to match') }, ['project']),
    annotations: RO,
    run: async (a, { api }) => ((await api('GET', `${base(a)}/data-sets${qs({ url: a.url })}`)) as Json[]).map(briefDataSet),
  },
  {
    name: 'get_data_set',
    description: 'One data set with all entries.',
    inputSchema: obj({ project: PROJECT, slug: s('Data set slug') }, ['project', 'slug']),
    annotations: RO,
    run: async (a, { api }) => api('GET', `${base(a)}/data-sets/${enc(String(a.slug))}`),
  },
  {
    name: 'delete_data_set',
    description: 'Delete a data set. Refused (409) while a storyboard uses it unless force.',
    inputSchema: obj({ project: PROJECT, slug: s('Data set slug'), force: b('Delete even when storyboards use it') }, ['project', 'slug']),
    annotations: { destructiveHint: true },
    run: async (a, { api }) => api('DELETE', `${base(a)}/data-sets/${enc(String(a.slug))}${qs({ force: a.force ? 1 : undefined })}`),
  },
  {
    name: 'preview_data_set',
    description: 'Render a data set\'s values as a walkthrough would (fresh actors get a placeholder user; walkthrough id/key "preview"), with template warnings. storyboard: whose actors (default: the first storyboard using it); actor: actor key (default: the actor of its first fill step).',
    inputSchema: obj({ project: PROJECT, slug: s('Data set slug'), storyboard: s('Storyboard slug'), actor: s('Actor key (or, without storyboard, a test user ref)') }, ['project', 'slug']),
    annotations: RO,
    run: async (a, { api }) => api('POST', `${base(a)}/data-sets/${enc(String(a.slug))}/preview`, { storyboard: a.storyboard, actor: a.actor }),
  },

  // ---------------------------------------------------------------- page snapshots
  {
    name: 'save_page_snapshot',
    description:
      'Save the form fields of a page (pasted from its source, or what you know of it) so data_set_from_snapshot can build a data set from them. fields: [{key (id, else name, data-testid, label), label?, kind? (auto | text | select | radio | checkbox | radix-select | …), id?, name?, testId?, inputType?, placeholder?, value?, options?: [{value, label}], required?, visible?}]; missing props are filled with null / auto. ' +
      'url may be "/path" (the first app origin is put in front). urlPattern defaults to the URL path: give "/register/*" style globs for pages with ids.',
    inputSchema: obj(
      { project: PROJECT, url: s('Page URL or "/path"'), urlPattern: s('Glob for the data set match (default: the URL path)'), title: s('Page title'), formId: s('Form id'), fields: arr('Fields', { type: 'object' }), note: s('Note') },
      ['project', 'url', 'fields'],
    ),
    run: async (a, { api }) => {
      let url = String(a.url);
      if (url.startsWith('/')) {
        const p = (await api('GET', base(a))) as { settings: { appOrigins?: string[] } };
        const origin = p.settings.appOrigins?.[0];
        if (!origin) throw new Error('url is relative and the project has no appOrigins: call set_app_origins or pass a full URL');
        url = origin + url;
      }
      if (!Array.isArray(a.fields)) throw new Error('fields must be an array');
      const body = {
        url,
        urlPattern: a.urlPattern !== undefined ? String(a.urlPattern) : pathOf(url),
        title: a.title ?? '',
        formId: a.formId ?? null,
        fields: (a.fields as Json[]).map(scannedField),
        note: a.note ?? '',
        source: 'agent',
      };
      const snap = (await api('POST', `${base(a)}/page-snapshots`, body)) as Json;
      return { id: snap.id, url: snap.url, urlPattern: snap.urlPattern, fields: Array.isArray(snap.fields) ? snap.fields.length : 0, next: `data_set_from_snapshot {project, snapshot: "${String(snap.id)}", slug, name, values}` };
    },
  },
  {
    name: 'list_page_snapshots',
    description: 'Page snapshots (newest first): id, url, urlPattern, number of fields, source (extension | agent). With url: snapshots of that page.',
    inputSchema: obj({ project: PROJECT, url: s('Page URL'), limit: { type: 'number', description: 'Max (default 50)' } }, ['project']),
    annotations: RO,
    run: async (a, { api }) => api('GET', `${base(a)}/page-snapshots${qs({ url: a.url, limit: a.limit })}`),
  },
  {
    name: 'get_page_snapshot',
    description: 'One page snapshot with every scanned field (key, id, name, testId, kind, label, options, required, visible…).',
    inputSchema: obj({ project: PROJECT, id: s('Snapshot id') }, ['project', 'id']),
    annotations: RO,
    run: async (a, { api }) => api('GET', `${base(a)}/page-snapshots/${enc(String(a.id))}`),
  },
  {
    name: 'data_set_from_snapshot',
    description:
      'Create a data set from a page snapshot: one entry per field (visible ones unless include "all"), key and kind from the scan, value from values[key] (templates such as "{{user.email}}") else the scanned value; match from the snapshot urlPattern / formId. ' +
      'If the data set already exists nothing is changed and status is "exists" (change it with patch_data_set_entries or upsert_data_set).',
    inputSchema: obj(
      { project: PROJECT, snapshot: s('Snapshot id'), slug: s('New data set slug'), name: s('Data set name'), values: o('Values by field key, e.g. {"email": "{{user.email}}"}'), include: s('visible (default) or all', { enum: ['visible', 'all'] }) },
      ['project', 'snapshot', 'slug', 'name'],
    ),
    run: async (a, { api }) => {
      try {
        const d = (await api('POST', `${base(a)}/data-sets/from-snapshot`, { snapshot: a.snapshot, slug: a.slug, name: a.name, values: a.values, include: a.include })) as Json;
        return { status: 'created', dataSet: d };
      } catch (err) {
        if (statusOf(err) !== 409) throw err;
        const d = await getOrNull(api, `${base(a)}/data-sets/${enc(String(a.slug))}`);
        if (!d) throw err;
        return { status: 'exists', note: `Data set "${String(a.slug)}" already exists and was not changed; use patch_data_set_entries or upsert_data_set to change it.`, dataSet: d };
      }
    },
  },

  // ---------------------------------------------------------------- storyboards
  {
    name: 'validate_storyboard',
    description: 'Dry run: check a storyboard (or a saved one by slug) against the schema and the project (data sets, login recipes, users, authenticators, variables). Returns {ok, errors, warnings, refs}; each issue is {path, code, message, expected?}. Repeat until ok is true. Codes: describe_storyboards → validationCodes.',
    inputSchema: obj({ project: PROJECT, storyboard: o('Storyboard to check'), slug: s('Or: the slug of a saved storyboard') }, ['project']),
    annotations: RO,
    run: async (a, { api }) => api('POST', `${base(a)}/storyboards/validate`, a.storyboard !== undefined ? { storyboard: objectArg(a.storyboard, 'storyboard') } : { slug: a.slug }),
  },
  {
    name: 'upsert_storyboard',
    description: `Create or replace a storyboard {slug, name, intent?, tags?, inputs?, actors, steps, preferredMode?}. preferredMode "quick" makes the extension offer a quick test first (simple form-fill / smoke flows); default "tracked". Validated first: a 400 lists every issue with its path. The version goes up only when the content changes. Status created | updated | unchanged. ${DESCRIBE}storyboard / step.<kind>`,
    inputSchema: obj({ project: PROJECT, storyboard: o('Storyboard') }, ['project', 'storyboard']),
    run: async (a, { api }) => {
      const sb = objectArg(a.storyboard, 'storyboard');
      const slug = keyArg(a, sb, 'slug', 'storyboard');
      const { status, view } = await upsert(api, `${base(a)}/storyboards/${enc(slug)}`, sb);
      return { status, slug: view.slug, version: view.version, steps: Array.isArray(view.steps) ? view.steps.length : 0, refs: view.refs, warnings: view.warnings, storyboard: view };
    },
  },
  {
    name: 'list_storyboards',
    description: 'Storyboards of the project: slug, name, version, preferredMode, step count, actors, last tracked walkthrough.',
    inputSchema: obj({ project: PROJECT, tag: s('Only storyboards with this tag') }, ['project']),
    annotations: RO,
    run: async (a, { api }) => api('GET', `${base(a)}/storyboards${qs({ tag: a.tag })}`),
  },
  {
    name: 'get_storyboard',
    description: 'One storyboard in full (steps with ids, version, refs) plus its current validation issues as warnings.',
    inputSchema: obj({ project: PROJECT, slug: s('Storyboard slug or id') }, ['project', 'slug']),
    annotations: RO,
    run: async (a, { api }) => api('GET', `${base(a)}/storyboards/${enc(String(a.slug))}`),
  },
  {
    name: 'delete_storyboard',
    description: 'Delete a storyboard. Its walkthroughs keep their results (and their own copy of the steps).',
    inputSchema: obj({ project: PROJECT, slug: s('Storyboard slug') }, ['project', 'slug']),
    annotations: { destructiveHint: true },
    run: async (a, { api }) => api('DELETE', `${base(a)}/storyboards/${enc(String(a.slug))}`),
  },

  // ---------------------------------------------------------------- bundles
  {
    name: 'import_storyboard_bundle',
    description:
      'Import a bundle {format:"stubyard-storyboards", version:1, project?, users, loginRecipes, dataSets, storyboards} in one transaction, validated as a whole (references may point into the bundle). dry_run: validate and report without writing. ' +
      'mode upsert (default) | create-only (skip existing) | replace (also delete recipes, data sets and storyboards the bundle lacks). Returns created / updated / unchanged keys per collection; a 400 lists every issue with paths like storyboards[0].steps[3].dataSet. ' +
      `${DESCRIBE}bundle`,
    inputSchema: obj({ project: PROJECT, bundle: o('The bundle (object, or JSON text)'), mode: s('Import mode', { enum: ['upsert', 'create-only', 'replace'] }), dry_run: b('Validate only; nothing is written') }, ['project', 'bundle']),
    run: async (a, { api }) => api('POST', `${base(a)}/storyboards/import`, { bundle: objectArg(a.bundle, 'bundle'), mode: a.mode, dryRun: a.dry_run === true }),
  },
  {
    name: 'export_storyboard_bundle',
    description: 'Export storyboards (default all) with the data sets, login recipes and users they reference, and the project appOrigins / roles, as a bundle for import_storyboard_bundle. Secret-looking literal values are masked "***" unless include_secrets.',
    inputSchema: obj({ project: PROJECT, storyboards: arr('Storyboard slugs (default all)', { type: 'string' }), include_secrets: b('Include passwords and secret-looking values') }, ['project']),
    annotations: RO,
    run: async (a, { api }) => {
      const names = Array.isArray(a.storyboards) ? (a.storyboards as unknown[]).map(String).join(',') : undefined;
      return api('GET', `${base(a)}/storyboards/export${qs({ storyboards: names, secrets: a.include_secrets ? 1 : undefined })}`);
    },
  },

  // ---------------------------------------------------------------- results (read-only)
  {
    name: 'list_walkthroughs',
    description: 'Walkthroughs (human runs of storyboards), newest first: key, status (active | finished | abandoned), mode (tracked | quick), verdict, storyboard and version, step counts. Quick test runs are left out unless mode is quick or all.',
    inputSchema: obj(
      {
        project: PROJECT,
        storyboard: s('Storyboard slug or id'),
        status: s('Status', { enum: ['active', 'finished', 'abandoned'] }),
        mode: s('Run mode (default tracked)', { enum: ['tracked', 'quick', 'all'] }),
        limit: { type: 'number', description: 'Max (default 50)' },
      },
      ['project'],
    ),
    annotations: RO,
    run: async (a, { api }) => api('GET', `${base(a)}/walkthroughs${qs({ storyboard: a.storyboard, status: a.status, mode: a.mode, limit: a.limit })}`),
  },
  {
    name: 'get_walkthrough_result',
    description: 'Result of one walkthrough (id or key): per step status, the tester\'s note and data (fill counts, email subject/link, captured value), screenshot counts, vars, actors (passwords masked), sign-off verdict and duration. No images.',
    inputSchema: obj({ project: PROJECT, id: s('Walkthrough id or key') }, ['project', 'id']),
    annotations: RO,
    run: async (a, { api }) => api('GET', `${base(a)}/walkthroughs/${enc(String(a.id))}/summary`),
  },
  {
    name: 'list_walkthrough_recordings',
    description:
      'The recording of one walkthrough (id or key): mode (off | dom), paused, stopped (why it stopped at the size cap), bytes stored and the cap, and its segments (one per recorded page load: no, url, stepId, startedAt, endedAt, durationMs, bytes, events, status recording | complete | cut). The events themselves are only served by REST (GET …/recording/segments/:no) for the dashboard player.',
    inputSchema: obj({ project: PROJECT, id: s('Walkthrough id or key') }, ['project', 'id']),
    annotations: RO,
    run: async (a, { api }) => api('GET', `${base(a)}/walkthroughs/${enc(String(a.id))}/recording`),
  },
  {
    name: 'delete_walkthrough_recording',
    description: 'Delete every recorded segment of a walkthrough (the step results, notes and screenshots stay). A stop at the size cap is cleared, so a run still in progress records again from its next page load.',
    inputSchema: obj({ project: PROJECT, id: s('Walkthrough id or key') }, ['project', 'id']),
    annotations: { destructiveHint: true },
    run: async (a, { api }) => api('DELETE', `${base(a)}/walkthroughs/${enc(String(a.id))}/recording`),
  },
];
