import { describe, expect, it } from 'vitest';
import { StubyardError } from '@stubyard/client/http';
import { hubAuthOf, needsToken, TOKEN_NEEDED, withHubToken, wrapFetch } from '../src/shared/hubAuth';
import { loadSettings, saveSettings, type SettingsArea, withDefaults } from '../src/shared/settings';
import { errorText } from '../src/sidepanel/hub';
import { maskToken } from '../src/sidepanel/screens/Settings';

const memoryArea = (init: Record<string, unknown> = {}): SettingsArea & { data: Record<string, unknown> } => {
  const data: Record<string, unknown> = { ...init };
  return {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
    set: async (items) => void Object.assign(data, structuredClone(items)),
  };
};

describe('API token header (hub with sign-in on)', () => {
  const auth = hubAuthOf({ apiUrl: 'http://hub.test:4000', apiToken: 'sy_secret' });

  it('adds Authorization: Bearer to requests for the hub origin only', () => {
    const h = (init: RequestInit | undefined) => new Headers(init?.headers).get('authorization');
    expect(h(withHubToken('http://hub.test:4000/api/projects', undefined, auth))).toBe('Bearer sy_secret');
    expect(h(withHubToken(new URL('http://hub.test:4000/api/stream'), { headers: { accept: 'text/event-stream' } }, auth))).toBe('Bearer sy_secret');
    expect(h(withHubToken('http://hub.test:4001/api/projects', undefined, auth))).toBeNull();
    expect(h(withHubToken('https://hub.test:4000/api/projects', undefined, auth))).toBeNull();
    expect(h(withHubToken('http://app.test/login', undefined, auth))).toBeNull();
    expect(h(withHubToken('http://hub.test:4000/api/x', { headers: { Authorization: 'Bearer other' } }, auth))).toBe('Bearer other');
  });

  it('sends nothing without a token', () => {
    const init = { method: 'POST' };
    expect(withHubToken('http://hub.test:4000/api/projects', init, hubAuthOf({ apiUrl: 'http://hub.test:4000', apiToken: '' }))).toBe(init);
  });

  it('wraps fetch and follows a changed token', async () => {
    const seen: (string | null)[] = [];
    const base = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return new Response('ok');
    }) as typeof fetch;
    let current = auth;
    const f = wrapFetch(base, async () => current);
    await f('http://hub.test:4000/api/projects');
    current = hubAuthOf({ apiUrl: 'http://hub.test:4000', apiToken: 'sy_new' });
    await f('http://hub.test:4000/api/projects', { method: 'POST', body: '{}' });
    await f('http://elsewhere.test/');
    expect(seen).toEqual(['Bearer sy_secret', 'Bearer sy_new', null]);
  });

  it('explains a 401 with how to get a token', () => {
    const err = new StubyardError(401, 'Sign in required');
    expect(needsToken(err)).toBe(true);
    expect(errorText(err)).toBe(TOKEN_NEEDED);
    expect(TOKEN_NEEDED).toMatch(/create one in the dashboard → API tokens/);
    expect(needsToken(new StubyardError(403, 'Forbidden'))).toBe(false);
  });

  it('keeps the token in local settings (trimmed) and shows it masked', async () => {
    expect(withDefaults({}).apiToken).toBe('');
    expect(withDefaults({ apiToken: 42 }).apiToken).toBe('');
    const area = memoryArea();
    await saveSettings({ apiToken: '  sy_abcdefghijklmnopqrstuvwxyz  ' }, area);
    expect(area.data.apiToken).toBe('sy_abcdefghijklmnopqrstuvwxyz');
    expect((await loadSettings(area)).apiToken).toBe('sy_abcdefghijklmnopqrstuvwxyz');
    expect(maskToken('sy_abcdefghijklmnopqrstuvwxyz')).toBe('sy_abcd…wxyz');
    expect(maskToken('short')).toBe('••••');
  });
});
