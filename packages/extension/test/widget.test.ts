// Pure rules of the on-page widget (src/shared/widget.ts): eligibility, origins, placement and corner snap, the
// bottom sheet, the token in the frame URL, the hello check, and the per-tab state in storage.session.
import { describe, expect, it } from 'vitest';
import {
  cardLayout,
  clampPoint,
  defaultPlacement,
  helloAllowed,
  widgetTakesFill,
  isSheet,
  nudge,
  parsePlacement,
  pillLayout,
  placementToPoint,
  readTabState,
  runOrigins,
  type SessionArea,
  setTabOverride,
  sheetYFromTop,
  snapToCorner,
  tokenFromHash,
  effectiveOverride,
  isHostAnnouncement,
  originAllowed,
  overrideKey,
  overrideStale,
  parseOverride,
  tabOfKey,
  tokenKey,
  tokenLooksValid,
  widgetEligibility,
  widgetEligible,
  widgetHash,
  widgetRunsKind,
} from '../src/shared/widget';

const run = { project: 'p', id: 'w1', origins: ['http://localhost:3183', 'https://app.test'] };
const vp = { width: 1280, height: 800 };
const card = { width: 340, height: 300 };

describe('widgetEligibility', () => {
  it("shows on the run's origins only, port included", () => {
    expect(widgetEligible({ enabled: true, active: run, url: 'http://localhost:3183/register?x=1' })).toBe(true);
    expect(widgetEligible({ enabled: true, active: run, url: 'https://app.test/' })).toBe(true);
    expect(widgetEligibility({ enabled: true, active: run, url: 'http://localhost:8183/' }).reason).toBe('other-origin');
    expect(widgetEligibility({ enabled: true, active: run, url: 'http://app.test/' }).reason).toBe('other-origin');
  });
  it('needs an open run, an http(s) page and the top frame', () => {
    expect(widgetEligibility({ enabled: true, active: null, url: 'http://localhost:3183/' }).reason).toBe('no-run');
    expect(widgetEligibility({ enabled: true, active: run, url: 'chrome://extensions' }).reason).toBe('not-http');
    expect(widgetEligibility({ enabled: true, active: run, url: undefined }).reason).toBe('not-http');
    expect(widgetEligibility({ enabled: true, active: run, url: 'http://localhost:3183/', frameId: 3 }).reason).toBe('frame');
  });
  it('the Settings switch turns it off; runs without stored origins show nowhere', () => {
    expect(widgetEligibility({ enabled: false, active: run, url: 'http://localhost:3183/' }).reason).toBe('disabled');
    expect(widgetEligibility({ enabled: true, active: { project: 'p', id: 'w' }, url: 'http://localhost:3183/' }).reason).toBe('no-origins');
  });
  it('"Hide on this tab" always wins; "Show on this tab" shows it on any http(s) page, also with the switch off', () => {
    expect(widgetEligibility({ enabled: true, active: run, override: 'hide', url: 'http://localhost:3183/' }).reason).toBe('hidden-on-tab');
    expect(widgetEligibility({ enabled: false, active: run, override: 'show', url: 'https://login.idp.test/' })).toEqual({ show: true, reason: 'shown-on-tab' });
    expect(widgetEligible({ enabled: true, active: null, override: 'show', url: 'https://app.test/' })).toBe(false);
    expect(widgetEligible({ enabled: true, active: run, override: 'show', url: 'file:///x.html' })).toBe(false);
  });
});

describe('runOrigins', () => {
  it("the run's origin first, then the appOrigins, normalised and without duplicates", () => {
    expect(runOrigins('http://localhost:3183', ['http://localhost:3183/', 'https://app.test/path', 'junk', ''])).toEqual(['http://localhost:3183', 'https://app.test']);
    expect(runOrigins('', null)).toEqual([]);
    expect(runOrigins(undefined, ['http://a.test:8080'])).toEqual(['http://a.test:8080']);
  });
});

describe('placement', () => {
  it('starts bottom-right, bottom-left on RTL pages', () => {
    expect(defaultPlacement(false)).toEqual({ corner: 'bottom-right', x: 16, y: 16 });
    expect(defaultPlacement(true)).toEqual({ corner: 'bottom-left', x: 16, y: 16 });
    expect(placementToPoint(defaultPlacement(false), card, vp)).toEqual({ left: 1280 - 340 - 16, top: 800 - 300 - 16 });
    expect(placementToPoint(defaultPlacement(true), card, vp)).toEqual({ left: 16, top: 800 - 300 - 16 });
  });
  it('snaps to the nearest corner and keeps the distances from its edges', () => {
    expect(snapToCorner({ left: 100, top: 50 }, card, vp)).toEqual({ corner: 'top-left', x: 100, y: 50 });
    expect(snapToCorner({ left: 900, top: 60 }, card, vp)).toEqual({ corner: 'top-right', x: 1280 - 340 - 900, y: 60 });
    expect(snapToCorner({ left: 20, top: 480 }, card, vp)).toEqual({ corner: 'bottom-left', x: 20, y: 800 - 300 - 480 });
    expect(snapToCorner({ left: 920, top: 480 }, card, vp)).toEqual({ corner: 'bottom-right', x: 20, y: 20 });
  });
  it('a drop outside the viewport is clamped first', () => {
    expect(snapToCorner({ left: 2000, top: -50 }, card, vp)).toEqual({ corner: 'top-right', x: 4, y: 4 });
  });
  it('follows its corner and stays inside after a resize', () => {
    const p = snapToCorner({ left: 920, top: 480 }, card, vp);
    expect(placementToPoint(p, card, { width: 1000, height: 600 })).toEqual({ left: 1000 - 340 - 20, top: 600 - 300 - 20 });
    // Far from the corner on a big screen, then a small window: still fully visible.
    const far = { corner: 'bottom-right' as const, x: 1500, y: 900 };
    expect(placementToPoint(far, card, { width: 800, height: 600 })).toEqual({ left: 4, top: 4 });
  });
  it('clampPoint keeps a margin; a box larger than the viewport sticks to the top-left', () => {
    expect(clampPoint({ left: -10, top: 1000 }, card, vp)).toEqual({ left: 4, top: 800 - 300 - 4 });
    expect(clampPoint({ left: 50, top: 50 }, { width: 2000, height: 2000 }, vp)).toEqual({ left: 4, top: 4 });
  });
  it('arrow keys move 16 px, with Shift 64 px; other keys do nothing', () => {
    expect(nudge({ left: 100, top: 100 }, 'ArrowRight', false, card, vp)).toEqual({ left: 116, top: 100 });
    expect(nudge({ left: 100, top: 100 }, 'ArrowUp', true, card, vp)).toEqual({ left: 100, top: 36 });
    expect(nudge({ left: 100, top: 10 }, 'ArrowUp', true, card, vp)).toEqual({ left: 100, top: 4 });
    expect(nudge({ left: 100, top: 100 }, 'a', false, card, vp)).toBeNull();
  });
  it('parsePlacement drops malformed values', () => {
    expect(parsePlacement({ corner: 'top-left', x: 10.4, y: 3, collapsed: true })).toEqual({ corner: 'top-left', x: 10, y: 3 });
    expect(parsePlacement({ corner: 'top-left', x: 1, y: 2, sheetY: 40 })).toEqual({ corner: 'top-left', x: 1, y: 2, sheetY: 40 });
    expect(parsePlacement({ corner: 'middle', x: 1, y: 2 })).toBeNull();
    expect(parsePlacement({ corner: 'top-left', x: -1, y: 2 })).toBeNull();
    expect(parsePlacement({ corner: 'top-left', x: Number.NaN, y: 2 })).toBeNull();
    expect(parsePlacement('x')).toBeNull();
    expect(parsePlacement(null)).toBeNull();
  });
});

describe('layout: card, bottom sheet, pill', () => {
  it('a 340 px card at its corner, capped at 60 % of the viewport height', () => {
    const l = cardLayout(defaultPlacement(false), 900, vp);
    expect(l).toMatchObject({ sheet: false, width: 340, maxHeight: 480 });
    expect(l.top).toBe(800 - 480 - 16);
  });
  it('under 480 px it is a bottom sheet: full width minus 8 px, any corner', () => {
    expect(isSheet(479)).toBe(true);
    expect(isSheet(480)).toBe(false);
    const phone = { width: 390, height: 844 };
    const l = cardLayout({ corner: 'top-left', x: 100, y: 100 }, 300, phone);
    expect(l).toMatchObject({ sheet: true, left: 4, width: 382, top: 844 - 300 - 4 });
    expect(cardLayout({ corner: 'top-left', x: 0, y: 0, sheetY: 200 }, 300, phone).top).toBe(844 - 300 - 200);
    expect(sheetYFromTop(100, 300, phone)).toBe(844 - 300 - 100);
    expect(sheetYFromTop(-50, 300, phone)).toBe(844 - 300 - 4);
  });
  it('the pill sits at the card corner; bottom-right in the sheet', () => {
    expect(pillLayout({ corner: 'top-left', x: 30, y: 40 }, vp)).toEqual({ left: 30, top: 40 });
    expect(pillLayout({ corner: 'top-left', x: 30, y: 40 }, { width: 390, height: 844 })).toEqual({ left: 390 - 44 - 8, top: 844 - 44 - 8 });
  });
});

describe('token and hello', () => {
  it('the token round-trips through the frame URL hash', () => {
    expect(tokenFromHash(widgetHash('a b/c'))).toBe('a b/c');
    expect(tokenFromHash('#x=1&token=abc')).toBe('abc');
    expect(tokenFromHash('')).toBeNull();
  });
  const base = { widgetUrl: 'chrome-extension://id/widget.html', expected: 'tok' as string | null };
  it('accepts our widget page in its tab with that tab’s token', () => {
    expect(helloAllowed({ ...base, token: 'tok', senderUrl: 'chrome-extension://id/widget.html#token=tok', tabId: 7 })).toBe(true);
  });
  it('widget.html loads its app only for a token of the minted shape (review item 5)', () => {
    expect(tokenLooksValid(crypto.randomUUID())).toBe(true);
    for (const t of [null, '', 'short', 'a'.repeat(200), 'x<script>y-1234567890', '../../../etc/passwd/xx']) expect(tokenLooksValid(t)).toBe(false);
  });
  it('denies a wrong token, another tab, another page, no tab', () => {
    expect(helloAllowed({ ...base, token: 'nope', senderUrl: base.widgetUrl, tabId: 7 })).toBe(false);
    expect(helloAllowed({ ...base, expected: null, token: 'tok', senderUrl: base.widgetUrl, tabId: 8 })).toBe(false); // used up or another tab's
    expect(helloAllowed({ ...base, expected: '', token: '', senderUrl: base.widgetUrl, tabId: 7 })).toBe(false);
    expect(helloAllowed({ ...base, token: 'tok', senderUrl: 'chrome-extension://id/sidepanel.html', tabId: 7 })).toBe(false);
    expect(helloAllowed({ ...base, token: 'tok', senderUrl: 'https://evil.test/widget.html', tabId: 7 })).toBe(false);
    expect(helloAllowed({ ...base, token: 'tok', senderUrl: base.widgetUrl, tabId: undefined })).toBe(false);
    expect(helloAllowed({ ...base, token: '', senderUrl: base.widgetUrl, tabId: 7 })).toBe(false);
  });
});

const memorySession = (init: Record<string, unknown> = {}): SessionArea & { data: Record<string, unknown> } => {
  const data: Record<string, unknown> = structuredClone(init);
  const keysOf = (k: string | string[] | null) => (k === null ? Object.keys(data) : Array.isArray(k) ? k : [k]);
  return {
    data,
    get: async (k) => Object.fromEntries(keysOf(k).filter((x) => x in data).map((x) => [x, structuredClone(data[x])])),
    set: async (items) => void Object.assign(data, structuredClone(items)),
    remove: async (k) => keysOf(k).forEach((x) => delete data[x]),
  };
};

describe('per-tab state (one key per tab)', () => {
  it('sets and clears overrides; drops malformed entries and other keys', async () => {
    const s = memorySession({ [tokenKey(1)]: 'a', [tokenKey(2)]: 5, [overrideKey(3)]: 'maybe', widgetTokens: { '9': 'old' }, other: 1 });
    expect(await readTabState(s)).toEqual({ tokens: { '1': 'a' }, overrides: {} });
    await setTabOverride(4, 'show', s, 'https://app.test/x?y');
    await setTabOverride(5, 'hide', s);
    await setTabOverride(4, null, s);
    expect((await readTabState(s)).overrides).toEqual({ '5': { value: 'hide', origin: null } });
    expect(s.data[overrideKey(4)]).toBeUndefined();
  });
  it('keys name their tab', () => {
    expect(tabOfKey(overrideKey(12))).toBe(12);
    expect(tabOfKey(tokenKey(3))).toBe(3);
    expect(tabOfKey('widgetTabOverride')).toBeNull();
    expect(tabOfKey('widgetToken:x')).toBeNull();
  });
  it('"Show on this tab" applies on its own origin only; "Hide" everywhere (review item 1)', () => {
    const show = parseOverride({ value: 'show', origin: 'https://app.test/' })!;
    expect(show).toEqual({ value: 'show', origin: 'https://app.test' });
    expect(effectiveOverride(show, 'https://app.test/a/b')).toBe('show');
    expect(effectiveOverride(show, 'https://evil.test/')).toBeNull();
    expect(effectiveOverride(show, 'http://app.test/')).toBeNull();
    expect(overrideStale(show, 'https://evil.test/')).toBe(true);
    expect(overrideStale(show, 'https://app.test/')).toBe(false);
    expect(effectiveOverride(parseOverride('show'), 'https://app.test/')).toBeNull(); // no origin: never applies
    expect(effectiveOverride(parseOverride({ value: 'hide', origin: 'https://app.test' }), 'https://evil.test/')).toBe('hide');
    expect(parseOverride({ value: 'maybe' })).toBeNull();
    expect(effectiveOverride(null, 'https://app.test/')).toBeNull();
  });
});

describe('fills stay on the run’s origins (originAllowed, review item 1)', () => {
  it('allows the run’s origins only; unknown origins (undefined) allow, an empty list allows nothing', () => {
    expect(originAllowed('https://app.test/login', run.origins)).toBe(true);
    expect(originAllowed('https://evil.test/login', run.origins)).toBe(false);
    expect(originAllowed('chrome://newtab', run.origins)).toBe(false);
    expect(originAllowed('https://evil.test/', undefined)).toBe(true);
    expect(originAllowed('https://app.test/', [])).toBe(false);
  });
});

describe('page-side announcements are generic (review item 2)', () => {
  it('knows its fixed kinds only', () => {
    expect(isHostAnnouncement('step')).toBe(true);
    expect(isHostAnnouncement('wait-email')).toBe(true);
    for (const k of ['Step 1: secret', 'toString', '__proto__', 3, null]) expect(isHostAnnouncement(k)).toBe(false);
  });
});

describe('step kinds', () => {
  it('runs every kind since phase 1b (login and email too); an unknown kind points to the panel', () => {
    for (const k of ['open', 'logout', 'instruction', 'check', 'capture', 'fill', 'login', 'email']) expect(widgetRunsKind(k)).toBe(true);
    expect(widgetRunsKind('future-kind')).toBe(false);
  });
});

describe('Alt+Shift+F in the widget (widgetTakesFill)', () => {
  const me = { tabId: 3, stepKind: 'fill', resolved: true, active: true };
  const cmd = (tabId: number) => ({ type: 'widget.command', command: 'fill-form', tabId });
  it('takes the press on its own tab for a resolved fill or login step', () => {
    expect(widgetTakesFill(cmd(3), me)).toBe(true);
    expect(widgetTakesFill(cmd(3), { ...me, stepKind: 'login' })).toBe(true);
  });
  it('says no (the panel gets it) for other kinds, an unresolved step or a run that is not active', () => {
    expect(widgetTakesFill(cmd(3), { ...me, stepKind: 'instruction' })).toBe(false);
    expect(widgetTakesFill(cmd(3), { ...me, stepKind: null })).toBe(false);
    expect(widgetTakesFill(cmd(3), { ...me, resolved: false })).toBe(false);
    expect(widgetTakesFill(cmd(3), { ...me, active: false })).toBe(false);
  });
  it('lets a page outside the run’s origins go to the panel (which asks first)', () => {
    expect(widgetTakesFill(cmd(3), { ...me, originOk: false })).toBe(false);
    expect(widgetTakesFill(cmd(3), { ...me, originOk: true })).toBe(true);
  });
  it('does not answer for another tab or another message', () => {
    expect(widgetTakesFill(cmd(4), me)).toBeNull();
    expect(widgetTakesFill({ type: 'panel.command', command: 'fill-form' }, me)).toBeNull();
    expect(widgetTakesFill(null, me)).toBeNull();
  });
});
