import { describe, expect, it } from 'vitest';
import { MAX_TEXT, matchRule, normalizeMatch, regexSafetyProblem } from '../src/autoreplies/match.js';
import { render } from '../src/autoreplies/template.js';

const vars = {
  otp: '1234',
  links: ['https://a.test/x', 'https://b.test/y'],
  subject: 'Hi <there>',
  body: 'Body',
  from: 'app@a.test',
  to: 'u@a.test',
  channel: 'email' as const,
  user: { name: 'Ann', email: 'u@a.test', phone: null, role: 'customer' },
  captures: { 'body.1': '42', 'body.code': 'XY' },
  now: new Date('2026-01-02T03:04:05.000Z'),
};

describe('auto-reply templates', () => {
  it('renders variables, captures and helpers', () => {
    const r = render('{{otp}} {{link}} {{links.1}} {{ user.name }} {{$1}} {{body.code}} {{now}} {{channel}}', vars);
    expect(r).toEqual({ text: '1234 https://a.test/x https://b.test/y Ann 42 XY 2026-01-02T03:04:05.000Z email', warnings: [] });
    expect(render('{{random.digits:6}}', vars).text).toMatch(/^\d{6}$/);
    expect(render('{{uuid}}', vars).text).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('escapes values in HTML and warns on unknown variables', () => {
    expect(render('<b>{{subject}}</b>', vars, { html: true }).text).toBe('<b>Hi &lt;there&gt;</b>');
    const r = render('a{{nope}}b{{body.9}}', vars, { field: 'reply.text' });
    expect(r.text).toBe('ab');
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/reply.text: \{\{nope\}\}/);
  });
});

describe('auto-reply matching', () => {
  const subject = { channel: 'sms' as const, to: '+923001234567', from: '+1555', subject: null, body: 'Your code is 9911. Reply STOP', otp: '9911', links: [], instanceSlug: 'tw', user: { id: 'u1', name: 'Customer 1', email: 'c1@a.test', phone: '+923001234567', whatsapp: null, role: 'customer' } };
  it('bare strings are case-insensitive contains; equals trims; regex captures', () => {
    expect(matchRule({ channel: 'sms', match: normalizeMatch({ body: 'reply stop' }) }, subject).matched).toBe(true);
    expect(matchRule({ channel: 'any', match: normalizeMatch({ body: { equals: ' your code is 9911. reply stop ' } }) }, subject).matched).toBe(true);
    const r = matchRule({ channel: 'any', match: normalizeMatch({ body: { regex: '/code is (?<c>\\d+)/' } }) }, subject);
    expect(r.captures).toEqual({ 'body.1': '9911', 'body.c': '9911' });
  });
  it('user, role, instance, hasOtp, hasLink', () => {
    const ok = (m: unknown) => matchRule({ channel: 'any', match: normalizeMatch(m) }, subject).matched;
    expect(ok({ user: 'Customer 1' })).toBe(true);
    expect(ok({ user: 'c1@a.test' })).toBe(true);
    expect(ok({ user: '923001234567' })).toBe(true);
    expect(ok({ user: 'someone else' })).toBe(false);
    expect(ok({ role: 'Customer' })).toBe(true);
    expect(ok({ instance: 'tw' })).toBe(true);
    expect(ok({ instance: 'other' })).toBe(false);
    expect(ok({ hasOtp: true, hasLink: false })).toBe(true);
    expect(ok({ hasLink: true })).toBe(false);
  });
  it('clips the text matched by a regex to 8 KB', () => {
    expect(MAX_TEXT).toBe(8 * 1024);
    const big = { ...subject, body: 'a'.repeat(9 * 1024) + 'NEEDLE' };
    expect(matchRule({ channel: 'any', match: normalizeMatch({ body: { regex: 'NEEDLE' } }) }, big).matched).toBe(false);
    const fits = { ...subject, body: 'a'.repeat(7 * 1024) + 'NEEDLE' };
    expect(matchRule({ channel: 'any', match: normalizeMatch({ body: { regex: 'NEEDLE' } }) }, fits).matched).toBe(true);
  });
});

describe('auto-reply regex safety (ReDoS)', () => {
  const subject = { channel: 'sms' as const, to: '+1', from: null, subject: null, body: null as string | null, otp: null, links: [], instanceSlug: null, user: null };
  const evil = [
    '(a+)+$',
    '(a*)*b',
    '/^(a+)+$/i',
    '(a|a)*',
    '(a|aa)+$',
    '(.*a){20}',
    '(\\w+\\s?)+$',
    '^(([a-z])+.)+[A-Z]([a-z])+$',
    '(x+x+)+y',
    '((ab)*)+$',
    '(?:a?){30}a{30}',
    '(\\d+)*$',
    '.*.*.*.*.*x',
    '(a)\\1',
    '(?<n>a)\\k<n>',
  ];
  it.each(evil)('refuses %s at save time', (p) => {
    expect(regexSafetyProblem(p.replace(/^\/(.*)\/i$/, '$1'))).not.toBeNull();
    expect(() => normalizeMatch({ body: { regex: p } })).toThrow(/match\.body\.regex: .*allowed/);
  });
  it('accepts ordinary patterns', () => {
    for (const p of ['/reply\\s+yes/i', 'code (\\d{4,8})', '/order #(?<num>\\d+)/i', '(\\d{1,3}\\.){3}\\d{1,3}', '^(yes|no)$', '^\\w+@\\w+\\.com$', '[a+]+', '\\(a+\\)+', 'code: (.*) expires (.*)', '\\p{L}+'])
      expect(() => normalizeMatch({ body: { regex: p } }), p).not.toThrow();
  });
  it('a stored unsafe pattern (saved before the check) never runs: no match, with the reason', () => {
    const t0 = Date.now();
    const r = matchRule({ channel: 'any', match: { body: { regex: '(a+)+$' } } }, { ...subject, body: 'a'.repeat(40) + '!' });
    expect(r.matched).toBe(false);
    expect(r.reasons[0]).toMatch(/refused: nested quantifiers/);
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it('a slow pattern that passes the check is stopped after the time limit', () => {
    const t0 = Date.now();
    const r = matchRule({ channel: 'any', match: normalizeMatch({ body: { regex: '\\d+\\s*\\d+b' } }) }, { ...subject, body: '1'.repeat(8000) });
    expect(r).toMatchObject({ matched: false, timedOut: true });
    expect(r.reasons[0]).toMatch(/took longer than 100 ms/);
    expect(Date.now() - t0).toBeLessThan(2000);
    // Normal matching still works after a stopped one.
    expect(matchRule({ channel: 'any', match: normalizeMatch({ body: { regex: 'code (\\d+)' } }) }, { ...subject, body: 'code 42' }).captures).toEqual({ 'body.1': '42' });
  });
});
