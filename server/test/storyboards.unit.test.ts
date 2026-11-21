import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { normalizeAppOrigins } from '../src/repos/projects.js';
import { fakeValue, parseFake } from '../src/storyboards/fake.js';
import { isKnownVariable, parseVariable, previewFreshUser, renderEntries, renderFor, renderUrl, shiftDate, type RenderContext } from '../src/storyboards/render.js';
import { Actor, Bundle, DataSet, LoginRecipe, PageSnapshot, Step, STEP_KINDS, STORYBOARD_SCHEMAS, Storyboard } from '../src/storyboards/schema.js';
import { matchUrlPattern, urlPatternScore } from '../src/storyboards/urlPattern.js';

const issues = (r: { success: boolean; error?: z.ZodError }) => (r.error?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`);

const base = { title: 'T', intent: 'Do it.' };

describe('storyboard schemas', () => {
  it('accepts one minimal step of every kind and fills defaults', () => {
    const steps = [
      { ...base, kind: 'open', url: '/x' },
      { ...base, kind: 'login', actor: 'admin' },
      { ...base, kind: 'logout' },
      { ...base, kind: 'fill', dataSet: 'sign-up' },
      { ...base, kind: 'email', actor: 'admin' },
      { ...base, kind: 'instruction' },
      { ...base, kind: 'capture', var: 'reg_no', textPattern: 'No: (\\d+)' },
      { ...base, kind: 'check', expect: 'It worked' },
    ];
    expect(steps.map((s) => s.kind).sort()).toEqual([...STEP_KINDS].sort());
    for (const s of steps) {
      const r = Step.safeParse(s);
      expect(issues(r), s.kind).toEqual([]);
      expect(r.data).toMatchObject({ notes: '', optional: false, screenshot: 'offer' });
    }
    const email = Step.parse(steps[4]);
    expect(email).toMatchObject({ channel: 'email', match: {}, timeoutSec: 120, open: 'same-tab' });
    expect(Step.parse(steps[6])).toMatchObject({ required: true });
    expect(Step.safeParse({ ...base, kind: 'capture', var: 'regNo', selector: '#no' }).success).toBe(true); // camelCase keys (pilot)
  });

  it('rejects bad steps with paths', () => {
    expect(Step.safeParse({ ...base, kind: 'teleport' }).success).toBe(false);
    expect(issues(Step.safeParse({ ...base, kind: 'open' }))).toEqual([expect.stringMatching(/^url: /)]);
    expect(issues(Step.safeParse({ ...base, kind: 'login' }))).toEqual([expect.stringMatching(/^actor: /)]);
    expect(issues(Step.safeParse({ ...base, kind: 'fill', dataSet: 'Not A Slug' }))).toEqual([expect.stringMatching(/^dataSet: lowercase/)]);
    expect(issues(Step.safeParse({ ...base, kind: 'capture', var: 'x' }))).toEqual(['selector: capture needs selector or textPattern']);
    expect(issues(Step.safeParse({ ...base, kind: 'capture', var: '1x', selector: '#a' }))).toEqual([expect.stringMatching(/^var: lowercase letter first/)]);
    expect(issues(Step.safeParse({ ...base, kind: 'email', actor: 'a', timeoutSec: 1 }))).toEqual([expect.stringMatching(/^timeoutSec: /)]);
    expect(issues(Step.safeParse({ ...base, kind: 'check', expect: '' }))).toEqual([expect.stringMatching(/^expect: /)]);
    expect(issues(Step.safeParse({ title: 'T', kind: 'instruction' }))).toEqual([expect.stringMatching(/^intent: /)]);
    expect(issues(Step.safeParse({ ...base, kind: 'instruction', id: 'Bad Id' }))).toEqual([expect.stringMatching(/^id: /)]);
  });

  it('login recipes: defaults (fields, two-factor) and the two-factor union', () => {
    const r = LoginRecipe.parse({ role: 'admin', loginUrl: '/login' });
    expect(r).toEqual({
      role: 'admin',
      name: '',
      loginUrl: '/login',
      fields: { username: '#email', password: '#password' },
      twoFactor: { kind: 'none' },
      logoutUrl: null,
      notes: '',
    });
    expect(LoginRecipe.parse({ role: 'admin', loginUrl: '/l', twoFactor: { kind: 'totp' } }).twoFactor).toEqual({ kind: 'totp', selector: '#code' });
    expect(LoginRecipe.parse({ role: 'a', loginUrl: '/l', twoFactor: { kind: 'sms-otp', selector: '#otp' } }).twoFactor.kind).toBe('sms-otp');
    expect(issues(LoginRecipe.safeParse({ role: 'a', loginUrl: '/l', twoFactor: { kind: 'email-otp' } }))).toEqual([expect.stringMatching(/^twoFactor.selector: /)]);
    expect(issues(LoginRecipe.safeParse({ role: 'Admin', loginUrl: '/l' }))).toEqual([expect.stringMatching(/^role: /)]);
  });

  it('data sets: duplicate entry keys are reported at entries[i].key', () => {
    const ok = DataSet.parse({ slug: 'sign-up', name: 'Sign up', entries: [{ key: 'email', value: '{{user.email}}' }, { key: 'agree', value: true }, { key: 'tags', value: ['a', 'b'] }] });
    expect(ok.match).toEqual({});
    expect(ok.entries[0]).toEqual({ key: 'email', value: '{{user.email}}', kind: 'auto' });
    const bad = DataSet.safeParse({ slug: 's', name: 'S', entries: [{ key: 'a', value: '1' }, { key: 'b', value: '2' }, { key: 'a', value: '3' }] });
    expect(issues(bad)).toEqual(['entries.2.key: duplicate key "a" (also entries[0].key)']);
    expect(issues(DataSet.safeParse({ slug: 's', name: 'S', entries: [{ key: 'a', value: 1 }] }))).toEqual([expect.stringMatching(/^entries.0.value: /)]);
    expect(issues(DataSet.safeParse({ slug: 's', name: 'S', entries: [{ key: 'a', value: 'x', kind: 'slider' }] }))).toEqual([expect.stringMatching(/^entries.0.kind: /)]);
  });

  it('actors: fresh actors cannot name a user', () => {
    expect(Actor.parse({ key: 'p', role: 'participant', fresh: true })).toMatchObject({ fresh: true, label: '' });
    expect(issues(Actor.safeParse({ key: 'p', role: 'participant', fresh: true, user: 'x@y.test' }))).toEqual(['user: fresh actors cannot name an existing user']);
  });

  it('storyboards need actors and steps; bundles default their collections', () => {
    const sb = { slug: 'flow', name: 'Flow', actors: [{ key: 'admin', role: 'admin' }], steps: [{ ...base, kind: 'instruction' }] };
    expect(Storyboard.parse(sb)).toMatchObject({ description: '', intent: '', tags: [], inputs: [] });
    expect(issues(Storyboard.safeParse({ ...sb, actors: [], steps: [] }))).toHaveLength(2);
    expect(issues(Storyboard.safeParse({ ...sb, steps: [{ ...base, kind: 'open' }] }))).toEqual([expect.stringMatching(/^steps.0.url: /)]);
    const b = Bundle.parse({ format: 'stubyard-storyboards', version: 1 });
    expect(b).toEqual({ format: 'stubyard-storyboards', version: 1, users: [], loginRecipes: [], dataSets: [], storyboards: [] });
    expect(Bundle.safeParse({ format: 'other', version: 1 }).success).toBe(false);
    expect(issues(Bundle.safeParse({ format: 'stubyard-storyboards', version: 1, dataSets: [{ slug: 's', name: 'S', entries: [{ key: 'a', value: '' }, { key: 'a', value: '' }] }] }))).toEqual([
      expect.stringMatching(/^dataSets.0.entries.1.key: duplicate/),
    ]);
  });

  it('page snapshots and the JSON Schema export', () => {
    const field = { key: 'email', id: 'email', name: 'email', testId: null, kind: 'text', inputType: 'email', label: 'Email', placeholder: null, value: '', required: true, visible: true, formId: null };
    const s = PageSnapshot.parse({ url: 'http://localhost:3183/auth/person/register', fields: [field] });
    expect(s).toMatchObject({ urlPattern: '', title: '', formId: null, note: '', source: 'agent' });
    expect(s.fields[0].duplicateKey).toBe(false);
    expect(PageSnapshot.safeParse({ url: '/relative', fields: [] }).success).toBe(false);
    for (const [name, schema] of Object.entries(STORYBOARD_SCHEMAS)) {
      const js = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
      expect(js, name).toBeTypeOf('object');
    }
  });
});

const NOW = new Date('2026-01-31T10:20:30.000Z');
const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({
  project: { slug: 'classprovia', name: 'Class PROvia', settings: { phonePrefix: '+966', appOrigins: ['http://localhost:3183'] } },
  walkthrough: { id: 'wt-1', key: 'k7m2qp', startedAt: '2026-01-30T08:00:00.000Z', origin: '' },
  actors: {
    participant: { name: 'Sara Ann Khan', email: 'participant.k7m2qp@classprovia.test', phone: '+966500000001', role: 'participant', password: null },
    admin: { name: 'Admin', email: 'admin@classprovia.test', phone: null, role: 'admin', password: 'S3cret!' },
  },
  actor: 'participant',
  vars: { event: 'HCE27' },
  now: NOW,
  ...over,
});

describe('storyboard template variables', () => {
  it('user, users, vars, unique, walkthrough, project and app variables', () => {
    const t = (s: string, c = ctx()) => renderFor(c, s);
    expect(t('{{user.name}}|{{user.firstName}}|{{user.lastName}}|{{user.email}}|{{user.role}}|{{user.password}}')).toEqual({
      text: 'Sara Ann Khan|Sara|Ann Khan|participant.k7m2qp@classprovia.test|participant|Password123!',
      warnings: [],
    });
    expect(t('{{users.admin.password}} {{users.admin.phone}}|{{users.admin.lastName}}').text).toBe('S3cret! |');
    const withDefault = ctx({ project: { ...ctx().project, settings: { defaultPassword: 'Pw!1' } } });
    expect(t('{{user.password}}', withDefault).text).toBe('Pw!1');
    expect(t('{{vars.event}} {{unique}} {{walkthrough.id}} {{walkthrough.key}} {{walkthrough.started}}').text).toBe('HCE27 k7m2qp wt-1 k7m2qp 2026-01-30');
    expect(t('{{project.slug}} {{project.name}} {{project.emailDomain}} {{project.phonePrefix}} {{app.origin}} {{now}}').text).toBe(
      'classprovia Class PROvia classprovia.test +966 http://localhost:3183 2026-01-31T10:20:30.000Z',
    );
    expect(t('{{app.origin}}', ctx({ walkthrough: { ...ctx().walkthrough, origin: 'http://localhost:8183' } })).text).toBe('http://localhost:8183');
  });

  it('missing values and unknown variables render empty with a warning (auto-reply variables included)', () => {
    const r = renderFor(ctx(), 'a{{vars.regNo}}b{{otp}}c{{nope}}d{{users.ghost.email}}', 'steps[2].url');
    expect(r.text).toBe('abcd');
    expect(r.warnings).toHaveLength(4);
    expect(r.warnings[0]).toMatch(/^steps\[2\]\.url: \{\{vars\.regNo\}\} has no value yet/);
    expect(r.warnings[1]).toMatch(/\{\{otp\}\} is not a known storyboard variable/);
    expect(renderFor(ctx({ actor: null }), '{{user.email}}').warnings[0]).toMatch(/has no actor/);
    expect(renderFor(ctx({ actors: { participant: null }, actor: 'participant' }), '{{user.email}}').warnings[0]).toMatch(/not resolved/);
    expect(isKnownVariable('vars.x')).toBe(true);
    expect(isKnownVariable('user.age')).toBe(false);
    expect(isKnownVariable('link')).toBe(false);
    expect(isKnownVariable('fake.nope')).toBe(false);
    expect(isKnownVariable('date.+7x')).toBe(false);
    expect(parseVariable(' users.admin.email ')).toEqual({ t: 'user', actor: 'admin', field: 'email' });
  });

  it('fake data is deterministic per walkthrough and name; a suffix gives another value', () => {
    const one = renderFor(ctx(), '{{fake.firstName}}|{{fake.lastName}}|{{fake.fullName}}|{{fake.email}}|{{fake.phone}}|{{fake.company}}|{{fake.digits:6}}|{{uuid}}|{{random.digits:4}}');
    const again = renderFor(ctx(), '{{fake.firstName}}|{{fake.lastName}}|{{fake.fullName}}|{{fake.email}}|{{fake.phone}}|{{fake.company}}|{{fake.digits:6}}|{{uuid}}|{{random.digits:4}}');
    expect(one.warnings).toEqual([]);
    expect(again.text).toBe(one.text);
    const [first, last, full, email, phone, company, d6, uuid, r4] = one.text.split('|');
    expect(full).toBe(`${first} ${last}`);
    expect(email).toBe(`${first}.${last}.k7m2qp@classprovia.test`.toLowerCase());
    expect(phone).toMatch(/^\+966\d{9}$/);
    expect(company.length).toBeGreaterThan(0);
    expect(d6).toMatch(/^\d{6}$/);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(r4).toMatch(/^\d{4}$/);
    // Another walkthrough gives other values (with overwhelming likelihood across these fields).
    const other = renderFor(ctx({ walkthrough: { ...ctx().walkthrough, id: 'wt-2' } }), '{{fake.digits:12}}|{{uuid}}').text;
    expect(other).not.toBe(renderFor(ctx(), '{{fake.digits:12}}|{{uuid}}').text);
    // Suffixes
    const fakeCtx = { seed: 'wt-1', unique: 'k7m2qp', emailDomain: 'x.test', phonePrefix: '+92300' };
    const names = new Set(Array.from({ length: 8 }, (_, i) => fakeValue(`fake.digits:12:${i}`, fakeCtx)));
    expect(names.size).toBe(8);
    expect(fakeValue('fake.email:2', fakeCtx)).toMatch(/\.k7m2qp\.2@x\.test$/);
    expect(fakeValue('fake.phone', fakeCtx)).toMatch(/^\+92300\d{7}$/);
    expect(parseFake('fake.firstName:2')).toEqual({ gen: 'firstName', n: null, suffix: '2' });
    expect(parseFake('fake.digits:6:b')).toEqual({ gen: 'digits', n: 6, suffix: 'b' });
    expect(parseFake('fake.digits')).toBeNull();
    expect(parseFake('fake.digits:40')).toBeNull();
    expect(renderFor(ctx(), '{{uuid}}').text).not.toBe(renderFor(ctx(), '{{uuid:2}}').text);
  });

  it('date offsets (UTC, month ends clamped) and datetime', () => {
    const t = (s: string) => renderFor(ctx(), s).text;
    expect(t('{{date.today}} {{date.+7d}} {{date.+1w}} {{date.-18y}} {{date.+1m}} {{date.-2d}}')).toBe('2026-01-31 2026-02-07 2026-02-07 2008-01-31 2026-02-28 2026-01-29');
    expect(t('{{datetime.now}} {{datetime.+3h}} {{datetime.+1d}}')).toBe('2026-01-31T10:20 2026-01-31T13:20 2026-02-01T10:20');
    expect(shiftDate(new Date('2024-02-29T00:00:00Z'), { n: 1, unit: 'y' }).toISOString().slice(0, 10)).toBe('2025-02-28');
  });

  it('URLs get the origin in front; entries render per value type', () => {
    expect(renderUrl(ctx(), '/register/{{vars.event}}')).toEqual({ url: 'http://localhost:3183/register/HCE27', warnings: [] });
    expect(renderUrl(ctx(), 'https://other.test/a').url).toBe('https://other.test/a');
    expect(renderUrl(ctx(), '').url).toBeNull();
    const noOrigin = renderUrl(ctx({ project: { ...ctx().project, settings: {} } }), '/x');
    expect(noOrigin.url).toBe('/x');
    expect(noOrigin.warnings[0]).toMatch(/relative/);
    const r = renderEntries(ctx(), [
      { key: 'email', value: '{{user.email}}', kind: 'auto' },
      { key: 'agree', value: true, kind: 'checkbox', selector: '#agree' },
      { key: 'tags', value: ['{{vars.event}}', '{{vars.nope}}'], kind: 'radix-checkbox', label: 'Tags' },
    ]);
    expect(r.entries).toEqual([
      { key: 'email', value: 'participant.k7m2qp@classprovia.test', kind: 'auto' },
      { key: 'agree', value: true, kind: 'checkbox', selector: '#agree' },
      { key: 'tags', value: ['HCE27', ''], kind: 'radix-checkbox', label: 'Tags' },
    ]);
    expect(r.warnings).toEqual([expect.stringMatching(/^entries\[2\]\.value\[1\]: \{\{vars\.nope\}\}/)]);
    expect(previewFreshUser(ctx().project, 'participant')).toMatchObject({ name: 'Fresh Participant', email: 'participant.preview@classprovia.test' });
  });
});

describe('data-set URL patterns', () => {
  it('* is one segment, ** is anything, query only when the pattern has one', () => {
    expect(matchUrlPattern('/register/*', 'http://localhost:3183/register/HCE27')).toBe(true);
    expect(matchUrlPattern('/register/*', '/register/HCE27/')).toBe(true);
    expect(matchUrlPattern('/register/*', '/register/HCE27/step2')).toBe(false);
    expect(matchUrlPattern('/register/*', '/register')).toBe(false);
    expect(matchUrlPattern('/register/**', '/register/HCE27/step2')).toBe(true);
    expect(matchUrlPattern('/register/**', '/register')).toBe(true); // ** at a segment boundary may be empty
    expect(matchUrlPattern('register/*', '/register/x')).toBe(true); // leading slash added
    expect(matchUrlPattern('http://localhost:3183/register/*', 'http://localhost:8183/register/x#top')).toBe(true); // origin, fragment ignored
    expect(matchUrlPattern('/auth/person/register', 'http://localhost:3183/auth/person/register?next=/x')).toBe(true);
    expect(matchUrlPattern('/admin/*/view/*', '/admin/registrations/view/42')).toBe(true);
    expect(matchUrlPattern('/x?step=2', '/x?step=2')).toBe(true);
    expect(matchUrlPattern('/x?step=2', '/x?step=3')).toBe(false);
    expect(matchUrlPattern('/x?step=*', '/x?step=3')).toBe(true);
    expect(matchUrlPattern('/a.b', '/aXb')).toBe(false);
    expect(matchUrlPattern('', '/anything')).toBe(true);
    expect(matchUrlPattern(undefined, '/anything')).toBe(true);
    expect(urlPatternScore('/register/*', '/register/x')).toBe('/register/'.length);
    expect(urlPatternScore('/register/*', '/other')).toBeNull();
    expect(urlPatternScore('', '/other')).toBe(0);
  });
});

describe('project appOrigins', () => {
  it('normalises and rejects non-origins', () => {
    expect(normalizeAppOrigins([' HTTP://LocalHost:3183/ ', 'http://localhost:3183', 'https://app.test'])).toEqual(['http://localhost:3183', 'https://app.test']);
    expect(() => normalizeAppOrigins(['http://localhost:3183', 'http://localhost:3183/app'])).toThrow('appOrigins[1] must be an origin like http://localhost:3183');
    expect(() => normalizeAppOrigins(['localhost:3183'])).toThrow(/appOrigins\[0\]/);
    expect(() => normalizeAppOrigins(['chrome-extension://abc'])).toThrow(/appOrigins\[0\]/);
  });
});
