import { describe, expect, it } from 'vitest';
import { derivePattern, matchUrlPattern, urlPatternScore } from '../src/shared/urlPattern';

describe('matchUrlPattern', () => {
  it('"*" matches one path segment', () => {
    expect(matchUrlPattern('/register/*', 'http://localhost:3183/register/HCE27')).toBe(true);
    expect(matchUrlPattern('/register/*', 'http://localhost:3183/register/HCE27/')).toBe(true);
    expect(matchUrlPattern('/register/*', 'http://localhost:3183/register/HCE27/step/2')).toBe(false);
    expect(matchUrlPattern('/register/*', 'http://localhost:3183/register')).toBe(false);
    expect(matchUrlPattern('/events/*/edit', '/events/12/edit')).toBe(true);
  });

  it('"**" matches any depth, including none', () => {
    expect(matchUrlPattern('/admin/**', 'http://x/admin')).toBe(true);
    expect(matchUrlPattern('/admin/**', 'http://x/admin/a/b/c')).toBe(true);
    expect(matchUrlPattern('/**/edit', 'http://x/a/b/edit')).toBe(true);
    expect(matchUrlPattern('/**/edit', 'http://x/edit')).toBe(true);
    expect(matchUrlPattern('**', 'http://x/anything/at/all')).toBe(true);
    expect(matchUrlPattern('/admin/**', 'http://x/administrator')).toBe(false);
  });

  it('ignores the query unless the pattern has one; always ignores the hash', () => {
    expect(matchUrlPattern('/auth/person/register', 'http://x/auth/person/register?next=/home#top')).toBe(true);
    expect(matchUrlPattern('/search?tab=*', 'http://x/search?tab=events')).toBe(true);
    expect(matchUrlPattern('/search?tab=*', 'http://x/search')).toBe(false);
    expect(matchUrlPattern('/search?tab=people', 'http://x/search?tab=events')).toBe(false);
  });

  it('empty pattern matches everything; literal characters are escaped', () => {
    expect(urlPatternScore('', 'http://x/a')).toBe(0);
    expect(matchUrlPattern(undefined, 'http://x/a')).toBe(true);
    expect(matchUrlPattern('/a.b', 'http://x/aXb')).toBe(false);
    expect(matchUrlPattern('/a+b', 'http://x/a+b')).toBe(true);
  });

  it('scores more literal patterns higher', () => {
    const url = 'http://x/register/HCE27';
    expect(urlPatternScore('/register/HCE27', url)!).toBeGreaterThan(urlPatternScore('/register/*', url)!);
    expect(urlPatternScore('/register/*', url)!).toBeGreaterThan(urlPatternScore('/**', url)!);
    expect(urlPatternScore('/other', url)).toBeNull();
  });
});

describe('derivePattern', () => {
  it('replaces numeric and uuid segments with "*"', () => {
    expect(derivePattern('http://x/events/42/edit?x=1')).toBe('/events/*/edit');
    expect(derivePattern('http://x/r/0b0e8a3c-7d1e-4c55-9a60-1f2b3c4d5e6f')).toBe('/r/*');
    expect(derivePattern('http://x/register/HCE27')).toBe('/register/HCE27');
  });
});
