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

// ---------------------------------------------------------------- agent runs (helpers)

const STEP_RESULTS = ['done', 'failed', 'skipped'] as const;

/** A path with some query parameters set (the resolved waitPath is relative: /api/projects/…/messages/wait?…). */
function withQuery(path: string, set: Record<string, string | number | null>): string {
  const u = new URL(path, 'http://x');
  for (const [k, v] of Object.entries(set)) {
    if (v === null) u.searchParams.delete(k);
    else u.searchParams.set(k, String(v));
  }
  return `${u.pathname}${u.search}`;
}

/** Substring (case-insensitive) or /regex/flags, as the extension matches subjects and links. */
function matches(text: string | null | undefined, pattern: string | null | undefined): boolean {
  if (!pattern) return true;
  const re = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
  if (re) {
    try {
      return new RegExp(re[1], re[2]).test(text ?? '');
    } catch {
      return false;
    }
  }
  return (text ?? '').toLowerCase().includes(pattern.toLowerCase());
}

/** The link an email step opens (the extension's rule): link.pattern / link.index, else the only non-unsubscribe link. */
function pickLink(links: string[], pattern: string | null, index: number | null): string | null {
  const unique = [...new Set(links)];
  const candidates = pattern ? unique.filter((l) => matches(l, pattern)) : unique;
  if (index !== null && index !== undefined) return candidates[index] ?? null;
  if (pattern) return candidates[0] ?? null;
  const normal = unique.filter((l) => !/unsubscribe/i.test(l));
  return normal.length === 1 ? normal[0] : null;
}

/** Waits (up to `seconds`) for the email step's message, skipping newer ones whose subject does not match. */
async function waitForStepMessage(api: Api, r: Json, seconds: number): Promise<Json | null> {
  const waitPath = String(r.waitPath);
  const subject = (r.subject as string | null) ?? null;
  const until = Date.now() + seconds * 1000;
  let path = waitPath;
  for (;;) {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) return null;
    let msg: Json;
    try {
      msg = (await api('GET', withQuery(path, { timeout: left }))) as Json;
    } catch (err) {
      if (statusOf(err) === 408) return null;
      throw err;
    }
    if (matches(msg.subject as string | null, subject)) return msg;
    // The newest one does not match: an older one in the window may; else wait for a newer one.
    const recent = (await api('GET', withQuery(waitPath, { timeout: null, after: null }).replace(/\/messages\/wait\?/, '/messages?')).catch(() => [])) as Json[];
    const found = (Array.isArray(recent) ? recent : []).find((m) => matches(m.subject as string | null, subject));
    if (found) return found;
    path = withQuery(waitPath, { after: String(msg.cursor ?? msg.id) });
  }
}

/** What the agent does for a resolved step, in one line (the extension's automation, done by the agent's browser). */
function stepTodo(r: Json): string {
  const kind = (r.step as Json).kind;
  switch (kind) {
    case 'open':
      return 'Open `url` in your browser.';
    case 'login':
      return 'Open `url`, fill `selectors.username` with `username` and `selectors.password` with `password`, then submit (`selectors.submit`, or Enter). Then the 2FA code if `twoFactor.kind` is not none (see twoFactor.todo).';
    case 'logout':
      return r.url ? 'Open `url` to sign the actor out.' : 'Sign the actor out by hand (intent says how).';
    case 'fill':
      return 'Fill every entry of `entries` (field key → value; key is the field id, name, data-testid, label or placeholder) in the form (`formId` when set, after opening `url` when set). Do not submit unless intent says so.';
    case 'email':
      return 'Use the message that arrived: open `link` (or another of `message.links`) unless `open` is "none", or type `code`. No message yet: call resolve_step again (wait_seconds).';
    case 'capture':
      return 'Read the value from the page (`selector` / `attribute`, or `textPattern` group 1 over the page text) and report it as report_step `value`.';
    case 'check':
      return 'Verify `expect` on the page (and `assert`: textPresent, selector, urlMatches when set); report failed with a note and a screenshot when it does not hold.';
    default:
      return 'Do what `text.intent` says.';
  }
}

/**
 * POST …/resolve plus what an agent needs that the extension does by itself: the current TOTP code, the email step's
 * message (waited for up to waitSeconds, then recorded on the step like the extension does), the link to open, a todo
 * line and the report_step call to make.
 */
async function resolveForAgent(api: Api, root: string, stepId: string, waitSeconds: number): Promise<Json> {
  const r = (await api('POST', `${root}/steps/${enc(stepId)}/resolve`, {})) as Json;
  const out: Json = { ...r, todo: stepTodo(r) };
  const step = r.step as Json;
  const tf = r.twoFactor as Json | undefined;
  if (step.kind === 'login' && tf && tf.kind !== 'none') {
    if (tf.kind === 'totp') {
      const code = typeof tf.codePath === 'string' ? await getOrNull(api, tf.codePath) : null;
      out.twoFactor = { ...tf, code: code?.code ?? null, remaining: code?.remaining ?? null, todo: 'Type `code` into `selector` (get_2fa_code or resolve_step again for a fresh one when `remaining` is low).' };
    } else {
      const u = new URL(String(tf.waitPath), 'http://x');
      out.twoFactor = {
        ...tf,
        todo: 'After submitting the password, call wait_for_message with `wait` (code_only), then type its otp into `selector`.',
        wait: { user: u.searchParams.get('user'), channel: u.searchParams.get('channel'), code_only: true, after: u.searchParams.get('after') },
      };
    }
  }
  if (step.kind === 'email') {
    const msg = waitSeconds > 0 ? await waitForStepMessage(api, r, waitSeconds) : null;
    if (msg) {
      const links = Array.isArray(msg.links) ? (msg.links as string[]) : [];
      const link = pickLink(links, (r.linkPattern as string | null) ?? null, (r.linkIndex as number | null) ?? null);
      out.message = { id: msg.id, subject: msg.subject ?? null, from: msg.from ?? null, to: msg.to ?? null, otp: msg.otp ?? null, links, bodyText: typeof msg.bodyText === 'string' ? msg.bodyText.slice(0, 2000) : null, createdAt: msg.createdAt };
      out.code = msg.otp ?? null;
      out.link = link;
      // What arrived goes on the step (the extension records the same), so the result shows it.
      await api('PATCH', `${root}/steps/${enc(stepId)}`, { data: { messageId: msg.id, subject: msg.subject ?? null, link } });
    } else {
      out.message = null;
      out.code = null;
      out.link = null;
      if (waitSeconds > 0) (out.warnings as string[]).push(`No matching ${String(r.channel)} message within ${waitSeconds}s`);
    }
  }
  out.report = `report_step {walkthrough, step: "${stepId}", status: done | failed | skipped, note?, data?, ${step.kind === 'capture' ? 'value, ' : ''}screenshot?}`;
  return out;
}

/** The walkthrough fields an agent needs (no steps' full definitions: resolve_step gives them one at a time). */
function runBrief(w: Json): Json {
  return { id: w.id, key: w.key, status: w.status, mode: w.mode, executor: w.executor, runner: w.runner ?? null, currentStepId: w.currentStepId, counts: w.counts };
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
    description: 'Authenticator (TOTP) keys of the project: label and linked user (no secrets). A totp login recipe names one by label (twoFactor.authenticator). Add one with add_authenticator (secret or otpauth:// link from the app’s 2FA setup).',
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
    description: 'Walkthroughs (runs of storyboards by a human with the extension, or by an agent), newest first: key, status (active | finished | abandoned), mode (tracked | quick), executor (human | agent) and runner, verdict, storyboard and version, step counts. Quick test runs are left out unless mode is quick or all.',
    inputSchema: obj(
      {
        project: PROJECT,
        storyboard: s('Storyboard slug or id'),
        status: s('Status', { enum: ['active', 'finished', 'abandoned'] }),
        mode: s('Run mode (default tracked)', { enum: ['tracked', 'quick', 'all'] }),
        executor: s('Only runs by a human (extension) or an agent (default both)', { enum: ['human', 'agent'] }),
        limit: { type: 'number', description: 'Max (default 50)' },
      },
      ['project'],
    ),
    annotations: RO,
    run: async (a, { api }) => api('GET', `${base(a)}/walkthroughs${qs({ storyboard: a.storyboard, status: a.status, mode: a.mode, executor: a.executor, limit: a.limit })}`),
  },
  {
    name: 'get_walkthrough_result',
    description: 'Result of one walkthrough (id or key): executor and runner, per step status, the tester\'s note and data (fill counts, email subject/link, captured value), screenshot counts, vars, actors (passwords masked), the verdict (signoff.verdictBy: human | agent; signedOffBy stays null on an agent run until a person signs it off) and duration. No images.',
    inputSchema: obj({ project: PROJECT, id: s('Walkthrough id or key') }, ['project', 'id']),
    annotations: RO,
    run: async (a, { api }) => api('GET', `${base(a)}/walkthroughs/${enc(String(a.id))}/summary`),
  },
  {
    name: 'list_walkthrough_recordings',
    description:
      'The recording of one walkthrough (id or key): mode (off | dom | video), kind (dom | video), mime, markers (step changes), paused, stopped (why it stopped at the size cap), bytes stored and the cap, and its segments (one per recorded page load: no, url, stepId, startedAt, endedAt, durationMs, bytes, events, status recording | complete | cut). The events themselves are only served by REST (GET …/recording/segments/:no) for the dashboard player.',
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

  // ---------------------------------------------------------------- agent runs (executor "agent")
  {
    name: 'start_walkthrough',
    description:
      'Run a storyboard yourself, in your own browser (Playwright, Claude in Chrome, a script): starts a walkthrough with executor "agent" (no extension). Fresh actors get new test users. ' +
      'Returns the run (id, key), its actors WITH passwords (to log in), the step list and the first step resolved (as resolve_step). Then per step: act in the browser → report_step (it returns the next step) → finish_walkthrough. ' +
      'inputs: values of the storyboard inputs (missing required ones → 400 listing them). mode quick: no screenshots, not in the default list. A person signs the run off later in the dashboard.',
    inputSchema: obj(
      {
        project: PROJECT,
        storyboard: s('Storyboard slug or id'),
        label: s('Label of this run, e.g. "after the enrolment form change"'),
        inputs: o('Storyboard input values {name: value} (strings)'),
        actors: o('Override the user per actor key {actorKey: user id | email | name | role}'),
        origin: s('App origin (default: the project\'s first app origin)'),
        mode: s('tracked (default: evidence and a verdict, kept in history) | quick', { enum: ['tracked', 'quick'] }),
        runner: obj({ name: s('Runner name, e.g. "playwright-mcp", "claude-in-chrome", "my-playwright-script"'), version: s('Runner version') }, ['name']),
        record: s('"video": you will upload a video (POST …/recording/chunks kind "video"); default off', { enum: ['off', 'video'] }),
        uses: arr('Ids or keys of earlier walkthroughs whose captured values this run reuses', { type: 'string' }),
      },
      ['project', 'storyboard'],
    ),
    run: async (a, { api }) => {
      const runner = a.runner === undefined ? undefined : objectArg(a.runner, 'runner');
      const w = (await api('POST', `${base(a)}/walkthroughs`, {
        storyboard: a.storyboard,
        executor: 'agent',
        runner,
        label: a.label,
        vars: a.inputs === undefined ? undefined : objectArg(a.inputs, 'inputs'),
        actors: a.actors === undefined ? undefined : objectArg(a.actors, 'actors'),
        origin: a.origin,
        mode: a.mode,
        record: a.record,
        uses: a.uses,
      })) as Json;
      const root = `${base(a)}/walkthroughs/${enc(String(w.id))}`;
      const steps = Array.isArray(w.steps) ? (w.steps as Json[]) : [];
      const step = w.currentStepId ? await resolveForAgent(api, root, String(w.currentStepId), 0) : null;
      return {
        ...runBrief(w),
        storyboard: w.storyboard,
        origin: w.origin,
        actors: w.actors,
        vars: w.vars,
        steps: steps.map((x) => ({ id: x.id, kind: x.kind, title: x.title, ...(x.optional ? { optional: true } : {}) })),
        step,
        warnings: w.warnings,
      };
    },
  },
  {
    name: 'resolve_step',
    description:
      'One step of an agent walkthrough, rendered for you: kind, text (title, intent, expect), todo (what to do in the browser), url, the actor; login: username, password, selectors and twoFactor (current TOTP code, or how to wait for the email/SMS code); fill: entries (field → value); ' +
      'email: waits up to wait_seconds for the message and returns message (subject, otp, links), code and link (the one the step opens); capture: selector / textPattern; check: expect and assert. Default step: the current one. Marks it active.',
    inputSchema: obj(
      {
        project: PROJECT,
        walkthrough: s('Walkthrough id or key (from start_walkthrough)'),
        step: s('Step id (default: the current step)'),
        wait_seconds: { type: 'number', description: 'Email steps: how long to wait for the message (default 30, max 120; 0 = do not wait)' },
      },
      ['project', 'walkthrough'],
    ),
    run: async (a, { api }) => {
      const root = `${base(a)}/walkthroughs/${enc(String(a.walkthrough))}`;
      let stepId = typeof a.step === 'string' && a.step ? a.step : null;
      if (!stepId) {
        const w = (await api('GET', root)) as Json;
        if (w.status !== 'active') throw new Error(`Walkthrough ${String(w.key)} is ${String(w.status)}`);
        if (!w.currentStepId) return { walkthrough: runBrief(w), step: null, done: true, next: 'Every step is reported: finish_walkthrough {walkthrough, verdict?}' };
        stepId = String(w.currentStepId);
      }
      const wait = Math.min(Math.max(Number(a.wait_seconds ?? 30) || 0, 0), 120);
      return resolveForAgent(api, root, stepId, wait);
    },
  },
  {
    name: 'report_step',
    description:
      'Record a step result of an agent walkthrough: status done | failed | skipped (the walkthrough step statuses), note (why it failed, what you saw), data (merged into the step data, e.g. {filled: 12}), value (capture steps: the captured value, sets the var), ' +
      'screenshot (data:image/jpeg|png;base64,… at most 600 KB; not kept on quick runs). Moves to the next open step and returns it resolved (email steps: not waited for, call resolve_step). next null = every step is reported: finish_walkthrough.',
    inputSchema: obj(
      {
        project: PROJECT,
        walkthrough: s('Walkthrough id or key'),
        step: s('Step id'),
        status: s('Result', { enum: [...STEP_RESULTS] }),
        note: s('What happened (at most 4000 characters)'),
        data: o('Evidence merged into the step data (at most 64 KB as JSON)'),
        value: s('Capture steps: the value read from the page'),
        screenshot: s('Screenshot as a data URL (data:image/jpeg;base64,…), at most 600 KB'),
      },
      ['project', 'walkthrough', 'step', 'status'],
    ),
    run: async (a, { api }) => {
      if (!(STEP_RESULTS as readonly unknown[]).includes(a.status)) throw new Error(`status must be one of ${STEP_RESULTS.join(', ')}`);
      const root = `${base(a)}/walkthroughs/${enc(String(a.walkthrough))}`;
      const stepPath = `${root}/steps/${enc(String(a.step))}`;
      const warnings: string[] = [];
      const w = (await api('PATCH', stepPath, { status: a.status, note: a.note, data: a.data === undefined ? undefined : objectArg(a.data, 'data'), value: a.value })) as Json;
      let screenshot: unknown = null;
      if (a.screenshot !== undefined && a.screenshot !== null && a.screenshot !== '') {
        try {
          screenshot = await api('POST', `${stepPath}/shots`, { dataUrl: a.screenshot });
        } catch (err) {
          warnings.push(`screenshot not stored: ${(err as Error).message}`);
        }
      }
      const next = w.status === 'active' && w.currentStepId ? await resolveForAgent(api, root, String(w.currentStepId), 0) : null;
      return {
        walkthrough: runBrief(w),
        reported: { step: a.step, status: a.status, screenshot },
        next,
        ...(next ? {} : { done: true, hint: 'No open step left: finish_walkthrough {walkthrough, verdict?}' }),
        warnings,
      };
    },
  },
  {
    name: 'finish_walkthrough',
    description:
      'Finish an agent walkthrough with your verdict: pass | fail | partial (default: fail when a step failed, partial when one was skipped or left open, else pass). allowIncomplete: open steps are marked skipped "not run" (else 409 lists them). ' +
      'This sets the run\'s result only: signoff.verdictBy is "agent" and signedOffBy stays null until a person signs the run off in the dashboard. Human runs are finished from the extension, not here.',
    inputSchema: obj(
      {
        project: PROJECT,
        walkthrough: s('Walkthrough id or key'),
        verdict: s('Your verdict', { enum: ['pass', 'fail', 'partial'] }),
        note: s('Summary of the run (at most 4000 characters)'),
        allowIncomplete: b('Mark open steps skipped ("not run") instead of failing with 409'),
      },
      ['project', 'walkthrough'],
    ),
    run: async (a, { api }) => {
      const root = `${base(a)}/walkthroughs/${enc(String(a.walkthrough))}`;
      let verdict = a.verdict;
      if (verdict === undefined) {
        const c = ((await api('GET', root)) as Json).counts as Record<string, number>;
        verdict = c.failed ? 'fail' : c.skipped || c.pending || c.active ? 'partial' : 'pass';
      }
      const w = (await api('POST', `${root}/finish`, { verdict, note: a.note, allowIncomplete: a.allowIncomplete === true })) as Json;
      return { ...runBrief(w), signoff: w.signoff, finishedAt: w.finishedAt, result: `get_walkthrough_result {id: "${String(w.key)}"}` };
    },
  },
];
