import { render } from '../autoreplies/template.js';
import type { ProjectSettings } from '../repos/projects.js';
import { digits, fakeValue, parseFake, seededRandom, seedOf, uuidFrom } from './fake.js';
import type { DataEntry } from './schema.js';
import type { RenderedEntry } from './types.js';

/**
 * Storyboard template variables (docs/design/storyboards.md §2). Server-side only: the extension never renders
 * templates, it gets rendered values from resolve / preview. Built on the auto-reply renderer through `extra`.
 */

export const DEFAULT_PASSWORD = 'Password123!';
export const DEFAULT_PHONE_PREFIX = '+92300';

/** A test user as templates see it. `password` is the stored one (null = the project default applies). */
export interface RenderUser {
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  password: string | null;
}

export interface RenderContext {
  project: { slug: string; name: string; settings: ProjectSettings };
  /** While authoring (preview) use PREVIEW_WALKTHROUGH. `origin` '' = appOrigins[0]. */
  walkthrough: { id: string; key: string; startedAt: string; origin: string };
  /** Users of the walkthrough by actor key (null = the actor's user could not be resolved). */
  actors: Record<string, RenderUser | null | undefined>;
  /** Actor key of the step being rendered ({{user.*}}); null = no actor. */
  actor?: string | null;
  /** Walkthrough vars: inputs given at start plus captured values ({{vars.x}}). */
  vars: Record<string, string>;
  /** Fixed "now" (tests); default: the current time. */
  now?: Date;
}

/** Walkthrough identity used while authoring (data-set preview, storyboard preview). */
export const PREVIEW_WALKTHROUGH = { id: 'preview', key: 'preview' } as const;

/** Placeholder for a fresh actor while authoring (no user is created): role "participant" → "Fresh Participant", participant.preview@<domain>. */
export function previewFreshUser(project: RenderContext['project'], role: string): RenderUser {
  const title = role.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { name: `Fresh ${title}`, email: `${role}.preview@${emailDomainOf(project)}`, phone: null, role, password: null };
}

export const emailDomainOf = (p: RenderContext['project']) => p.settings.emailDomain || `${p.slug}.test`;
export const phonePrefixOf = (p: RenderContext['project']) => p.settings.phonePrefix || DEFAULT_PHONE_PREFIX;
export const passwordOf = (u: RenderUser, p: RenderContext['project']) => u.password ?? p.settings.defaultPassword ?? DEFAULT_PASSWORD;

/** Help for the dashboard picker, GET /api/storyboard-schema and describe_storyboards. */
export const TEMPLATE_VARIABLE_HELP: { name: string; help: string }[] = [
  { name: 'user.email', help: "The step actor's test user: user.name, user.email, user.phone, user.role, user.password, user.firstName, user.lastName" },
  { name: 'users.admin.email', help: 'Any actor of the walkthrough by key: users.<actorKey>.<same fields as user>' },
  { name: 'vars.regNo', help: 'Walkthrough vars: inputs given at start and values captured by earlier capture steps' },
  { name: 'unique', help: 'The walkthrough key (6 chars a-z0-9): use it in anything the app needs to be unique' },
  { name: 'walkthrough.key', help: 'walkthrough.id, walkthrough.key, walkthrough.started (YYYY-MM-DD)' },
  { name: 'project.emailDomain', help: 'project.slug, project.name, project.emailDomain, project.phonePrefix' },
  { name: 'app.origin', help: 'The app origin chosen at start (default: the first of the project appOrigins)' },
  { name: 'fake.firstName', help: 'Fake data, the same value for the whole walkthrough: fake.firstName, fake.lastName, fake.fullName, fake.company, fake.jobTitle, fake.city, fake.word' },
  { name: 'fake.firstName:2', help: 'A suffix gives another value (fake.lastName:2, fake.email:b …)' },
  { name: 'fake.email', help: '<first>.<last>.<unique>@<emailDomain>, built from fake.firstName and fake.lastName' },
  { name: 'fake.phone', help: 'Project phone prefix + digits (12 digits in all)' },
  { name: 'fake.digits:6', help: 'N digits (1-32), the same for the whole walkthrough' },
  { name: 'date.today', help: 'YYYY-MM-DD (UTC); offsets: date.+7d, date.-18y, date.+2m, date.+1w, date.+3h' },
  { name: 'datetime.+1d', help: 'YYYY-MM-DDTHH:mm (UTC, for datetime-local inputs); datetime.now and the same offsets as date' },
  { name: 'uuid', help: 'A UUID, the same for the whole walkthrough (uuid:2 for another one)' },
  { name: 'random.digits:6', help: 'N digits, the same for the whole walkthrough (random.digits:6:2 for another one)' },
  { name: 'now', help: 'The render time, ISO 8601' },
];

export const USER_FIELDS = ['name', 'email', 'phone', 'role', 'password', 'firstName', 'lastName'] as const;
type UserField = (typeof USER_FIELDS)[number];

export type ParsedVariable =
  | { t: 'now' }
  | { t: 'unique' }
  | { t: 'walkthrough'; field: 'id' | 'key' | 'started' }
  | { t: 'project'; field: 'slug' | 'name' | 'emailDomain' | 'phonePrefix' }
  | { t: 'app.origin' }
  /** actor null = {{user.*}} (the step's actor); a key = {{users.<key>.*}}. */
  | { t: 'user'; actor: string | null; field: UserField }
  | { t: 'vars'; name: string }
  | { t: 'fake' }
  | { t: 'date'; time: boolean; offset: { n: number; unit: 'h' | 'd' | 'w' | 'm' | 'y' } | null }
  | { t: 'uuid' }
  | { t: 'digits'; n: number };

const KEY_RE = '[a-z][a-zA-Z0-9_]{0,31}'; // schema KEY
const SUFFIX_RE = '[A-Za-z0-9_-]{1,32}';
const isUserField = (f: string): f is UserField => (USER_FIELDS as readonly string[]).includes(f);

/** Parses a variable name (without braces); null = not a storyboard variable. Used by renderFor and by validation. */
export function parseVariable(raw: string): ParsedVariable | null {
  const name = raw.trim();
  switch (name) {
    case 'now':
      return { t: 'now' };
    case 'unique':
      return { t: 'unique' };
    case 'app.origin':
      return { t: 'app.origin' };
    case 'walkthrough.id':
    case 'walkthrough.key':
    case 'walkthrough.started':
      return { t: 'walkthrough', field: name.slice('walkthrough.'.length) as 'id' | 'key' | 'started' };
    case 'project.slug':
    case 'project.name':
    case 'project.emailDomain':
    case 'project.phonePrefix':
      return { t: 'project', field: name.slice('project.'.length) as 'slug' | 'name' | 'emailDomain' | 'phonePrefix' };
  }
  let m = /^user\.([A-Za-z]+)$/.exec(name);
  if (m) return isUserField(m[1]) ? { t: 'user', actor: null, field: m[1] } : null;
  m = new RegExp(`^users\\.(${KEY_RE})\\.([A-Za-z]+)$`).exec(name);
  if (m) return isUserField(m[2]) ? { t: 'user', actor: m[1], field: m[2] } : null;
  m = new RegExp(`^vars\\.(${KEY_RE})$`).exec(name);
  if (m) return { t: 'vars', name: m[1] };
  if (name.startsWith('fake.')) return parseFake(name) ? { t: 'fake' } : null;
  m = /^(date|datetime)\.(?:(today|now)|([+-])(\d{1,4})([hdwmy]))$/.exec(name);
  if (m) {
    const offset = m[2] ? null : { n: Number(m[4]) * (m[3] === '-' ? -1 : 1), unit: m[5] as 'h' | 'd' | 'w' | 'm' | 'y' };
    return { t: 'date', time: m[1] === 'datetime', offset };
  }
  if (new RegExp(`^uuid(?::${SUFFIX_RE})?$`).test(name)) return { t: 'uuid' };
  m = new RegExp(`^random\\.digits:(\\d{1,2})(?::${SUFFIX_RE})?$`).exec(name);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 32) return { t: 'digits', n: Number(m[1]) };
  return null;
}

export const isKnownVariable = (name: string) => parseVariable(name) !== null;

function addMonths(d: Date, n: number): void {
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last)); // Jan 31 + 1m = Feb 28/29, not Mar 3
}

/** "today" + an offset in UTC: date.+7d, date.-18y, date.+2m (month end clamped), date.+1w, datetime.+3h. */
export function shiftDate(base: Date, offset: { n: number; unit: 'h' | 'd' | 'w' | 'm' | 'y' } | null): Date {
  const d = new Date(base.getTime());
  if (!offset) return d;
  const { n, unit } = offset;
  if (unit === 'h') d.setUTCHours(d.getUTCHours() + n);
  else if (unit === 'd') d.setUTCDate(d.getUTCDate() + n);
  else if (unit === 'w') d.setUTCDate(d.getUTCDate() + 7 * n);
  else addMonths(d, unit === 'm' ? n : 12 * n);
  return d;
}

const splitName = (name: string): { firstName: string; lastName: string } => {
  const s = name.trim();
  const i = s.indexOf(' ');
  return i < 0 ? { firstName: s, lastName: '' } : { firstName: s.slice(0, i), lastName: s.slice(i + 1).trim() };
};

function userField(u: RenderUser, field: UserField, ctx: RenderContext): string {
  switch (field) {
    case 'password':
      return passwordOf(u, ctx.project);
    case 'firstName':
    case 'lastName':
      return splitName(u.name)[field];
    case 'name':
    case 'role':
      return u[field];
    case 'email':
    case 'phone':
      return u[field] ?? '';
  }
}

/** The walkthrough origin, else the first project app origin, else ''. */
export const originOf = (ctx: RenderContext) => ctx.walkthrough.origin || ctx.project.settings.appOrigins?.[0] || '';

/** Value of one variable; pushes a warning (and returns '') when it is unknown or has no value. */
function resolveVariable(name: string, ctx: RenderContext, field: string, warnings: string[]): string {
  const p = parseVariable(name);
  const empty = (why: string) => {
    warnings.push(`${field}: {{${name}}} ${why}; left empty`);
    return '';
  };
  if (!p) return empty('is not a known storyboard variable');
  const seeded = () => seededRandom(seedOf(ctx.walkthrough.id, name));
  switch (p.t) {
    case 'now':
      return (ctx.now ?? new Date()).toISOString();
    case 'unique':
      return ctx.walkthrough.key;
    case 'walkthrough':
      return p.field === 'started' ? ctx.walkthrough.startedAt.slice(0, 10) : ctx.walkthrough[p.field];
    case 'project':
      if (p.field === 'emailDomain') return emailDomainOf(ctx.project);
      if (p.field === 'phonePrefix') return phonePrefixOf(ctx.project);
      return ctx.project[p.field];
    case 'app.origin':
      return originOf(ctx) || empty('has no value (the project has no appOrigins)');
    case 'user': {
      const key = p.actor ?? ctx.actor ?? null;
      if (!key) return empty('has no actor (the step has none)');
      if (!(key in ctx.actors)) return empty(`refers to actor "${key}", which the storyboard does not have`);
      const u = ctx.actors[key];
      if (!u) return empty(`has no user (actor "${key}" is not resolved)`);
      return userField(u, p.field, ctx);
    }
    case 'vars': {
      const v = ctx.vars[p.name];
      return v === undefined ? empty('has no value yet (not given at start or captured)') : v;
    }
    case 'fake':
      return fakeValue(name, {
        seed: ctx.walkthrough.id,
        unique: ctx.walkthrough.key,
        emailDomain: emailDomainOf(ctx.project),
        phonePrefix: phonePrefixOf(ctx.project),
      })!;
    case 'date': {
      const iso = shiftDate(ctx.now ?? new Date(), p.offset).toISOString();
      return p.time ? iso.slice(0, 16) : iso.slice(0, 10);
    }
    case 'uuid':
      return uuidFrom(seeded());
    case 'digits':
      return digits(p.n, seeded());
  }
}

/** Renders one template for a walkthrough step (or a preview). Unknown / empty variables become '' plus a warning. */
export function renderFor(ctx: RenderContext, template: string | null | undefined, field = 'template'): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const actor = ctx.actor ? ctx.actors[ctx.actor] : null;
  const r = render(
    template,
    {
      otp: null,
      links: [],
      subject: null,
      body: null,
      from: null,
      to: null,
      channel: 'email',
      user: actor ? { name: actor.name, email: actor.email, phone: actor.phone, role: actor.role } : null,
      captures: {},
      now: ctx.now,
      // Every name is answered here (unknown ones with a warning), so auto-reply variables such as {{otp}} never leak in.
      extra: (name) => resolveVariable(name, ctx, field, warnings),
    },
    { field },
  );
  return { text: r.text, warnings: [...warnings, ...r.warnings] };
}

/** Renders a URL template; a result starting with "/" gets the walkthrough origin in front. '' → null. */
export function renderUrl(ctx: RenderContext, template: string | null | undefined, field = 'url'): { url: string | null; warnings: string[] } {
  const r = renderFor(ctx, template, field);
  const text = r.text.trim();
  if (!text) return { url: null, warnings: r.warnings };
  if (text.startsWith('/') && !text.startsWith('//')) {
    const origin = originOf(ctx);
    if (!origin) return { url: text, warnings: [...r.warnings, `${field}: "${text}" is relative and the project has no appOrigins`] };
    return { url: origin + text, warnings: r.warnings };
  }
  return { url: text, warnings: r.warnings };
}

/** Renders the values of data-set entries (strings and string arrays; booleans pass through). */
export function renderEntries(ctx: RenderContext, entries: DataEntry[], field = 'entries'): { entries: RenderedEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const one = (t: string, f: string) => {
    const r = renderFor(ctx, t, f);
    warnings.push(...r.warnings);
    return r.text;
  };
  const out = entries.map((e, i): RenderedEntry => {
    const f = `${field}[${i}].value`;
    const value = typeof e.value === 'boolean' ? e.value : Array.isArray(e.value) ? e.value.map((v, j) => one(v, `${f}[${j}]`)) : one(e.value, f);
    const r: RenderedEntry = { key: e.key, value, kind: e.kind };
    if (e.selector !== undefined) r.selector = e.selector;
    if (e.label !== undefined) r.label = e.label;
    return r;
  });
  return { entries: out, warnings };
}
