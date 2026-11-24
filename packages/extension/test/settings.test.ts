import { describe, expect, it } from 'vitest';
import {
  DEFAULT_API_URL,
  loadSettings,
  needsHostPermission,
  normalizeApiUrl,
  originPattern,
  pageOrigin,
  rememberProject,
  saveSettings,
  setActiveWalkthrough,
  type SettingsArea,
  touchesSettings,
  withDefaults,
} from '../src/shared/settings';

const memoryArea = (init: Record<string, unknown> = {}): SettingsArea & { data: Record<string, unknown> } => {
  const data: Record<string, unknown> = { ...init };
  return {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
    set: async (items) => void Object.assign(data, structuredClone(items)),
  };
};

describe('normalizeApiUrl', () => {
  it('adds http:// and drops a trailing slash', () => {
    expect(normalizeApiUrl('localhost:4000')).toBe('http://localhost:4000');
    expect(normalizeApiUrl(' https://hub.test/stubyard/ ')).toBe('https://hub.test/stubyard');
    expect(normalizeApiUrl('http://127.0.0.1:4000/')).toBe('http://127.0.0.1:4000');
  });
  it('rejects non-http URLs and junk', () => {
    expect(normalizeApiUrl('')).toBeNull();
    expect(normalizeApiUrl('ftp://x')).toBeNull();
    expect(normalizeApiUrl('http://')).toBeNull();
    expect(normalizeApiUrl('http://x/?a=1')).toBeNull();
  });
});

describe('host permissions and origins', () => {
  it('localhost and 127.0.0.1 over http on any port need no permission', () => {
    expect(needsHostPermission('http://localhost:4000')).toBe(false);
    expect(needsHostPermission('http://127.0.0.1:8183/x')).toBe(false);
    expect(needsHostPermission('https://localhost:4443')).toBe(true);
    expect(needsHostPermission('http://stubyard.lan:4000')).toBe(true);
  });
  it('originPattern drops the port; pageOrigin only for http(s)', () => {
    expect(originPattern('https://app.test:8443/a/b')).toBe('https://app.test/*');
    expect(pageOrigin('http://localhost:3183/register?x=1')).toBe('http://localhost:3183');
    expect(pageOrigin('chrome://extensions')).toBeNull();
    expect(pageOrigin(undefined)).toBeNull();
    expect(pageOrigin('not a url')).toBeNull();
  });
});

describe('withDefaults', () => {
  it('fills defaults and drops malformed entries', () => {
    const s = withDefaults({
      apiUrl: 'ftp://bad',
      lastProjectByOrigin: { 'http://a': 'p1', 'http://b': 3 },
      activeWalkthroughByWindow: { '1': { project: 'p', id: 'w' }, '2': { project: 'p' }, '3': { project: 'p', id: 'w3', origins: ['http://a', 4, ''] }, '4': { project: 'p', id: 'w4', origins: 'x' } },
      signedOffBy: 'QA',
      widgetEnabled: 'yes',
      widgetHiddenOrigins: ['https://a.test/path', 'https://a.test', 'ftp://x', 7, 'nonsense'],
    });
    expect(s).toEqual({
      apiUrl: DEFAULT_API_URL,
      lastProjectByOrigin: { 'http://a': 'p1' },
      activeWalkthroughByWindow: { '1': { project: 'p', id: 'w' }, '3': { project: 'p', id: 'w3', origins: ['http://a'] }, '4': { project: 'p', id: 'w4' } },
      signedOffBy: 'QA',
      widgetEnabled: true,
      widgetHiddenOrigins: ['https://a.test'],
      apiToken: '',
    });
    expect(withDefaults(null).apiUrl).toBe(DEFAULT_API_URL);
    expect(withDefaults({ widgetEnabled: false }).widgetEnabled).toBe(false);
  });
  it('touchesSettings: only settings keys count (the widget placement key does not)', () => {
    expect(touchesSettings({ widgetPlacementByOrigin: {} })).toBe(false);
    expect(touchesSettings({ activeWalkthroughByWindow: {} })).toBe(true);
    expect(touchesSettings({ widgetEnabled: {} })).toBe(true);
  });
});

describe('storage', () => {
  it('saves a normalised apiUrl and keeps other keys', async () => {
    const area = memoryArea({ signedOffBy: 'Ann' });
    const s = await saveSettings({ apiUrl: 'localhost:4001/' }, area);
    expect(s.apiUrl).toBe('http://localhost:4001');
    expect(area.data.apiUrl).toBe('http://localhost:4001');
    expect((await loadSettings(area)).signedOffBy).toBe('Ann');
  });
  it('remembers and forgets projects per origin', async () => {
    const area = memoryArea();
    await rememberProject('http://localhost:3183', 'classprovia', area);
    await rememberProject('http://localhost:8183', 'other', area);
    expect((await loadSettings(area)).lastProjectByOrigin).toEqual({ 'http://localhost:3183': 'classprovia', 'http://localhost:8183': 'other' });
    await rememberProject('http://localhost:8183', null, area);
    expect((await loadSettings(area)).lastProjectByOrigin).toEqual({ 'http://localhost:3183': 'classprovia' });
  });
  it('sets and clears the walkthrough of a window', async () => {
    const area = memoryArea();
    await setActiveWalkthrough(7, { project: 'p', id: 'w1' }, area);
    await setActiveWalkthrough(9, { project: 'p', id: 'w2' }, area);
    await setActiveWalkthrough(7, null, area);
    expect((await loadSettings(area)).activeWalkthroughByWindow).toEqual({ '9': { project: 'p', id: 'w2' } });
  });
});
