// Phase 2 rules of the on-page widget (src/shared/widget.ts): the auto-nudge off highlighted / primary buttons, the
// per-site hide list, Settings "Reset position", the hub-offline retry, and the step announcements.
import { describe, expect, it } from 'vitest';
import {
  avoidPlacement,
  cardLayout,
  defaultPlacement,
  overlapArea,
  pillAvoidPlacement,
  placementOrigins,
  resetPlacements,
  retryDelay,
  stepAnnouncement,
  unreachable,
  widgetEligibility,
  type WidgetPlacement,
} from '../src/shared/widget';

const vp = { width: 1280, height: 800 };
const H = 200;
const br = defaultPlacement(false);
/** The box of the card at a placement (as the host lays it out). */
const box = (p: WidgetPlacement, height = H, viewport = vp) => {
  const l = cardLayout(p, height, viewport);
  return { left: l.left, top: l.top, width: l.width, height: Math.min(height, l.maxHeight) };
};

describe('overlapArea', () => {
  it('is the shared area, 0 when apart or only touching', () => {
    expect(overlapArea({ left: 0, top: 0, width: 10, height: 10 }, { left: 5, top: 5, width: 10, height: 10 })).toBe(25);
    expect(overlapArea({ left: 0, top: 0, width: 10, height: 10 }, { left: 10, top: 0, width: 10, height: 10 })).toBe(0);
  });
});

describe('avoidPlacement (auto-nudge)', () => {
  const submitBR = { left: 1150, top: 740, width: 100, height: 40 }; // under the bottom-right card
  it('keeps the place when nothing is covered', () => {
    expect(avoidPlacement(br, H, vp, [])).toEqual({ placement: br, moved: false });
    expect(avoidPlacement(br, H, vp, [{ left: 20, top: 20, width: 80, height: 30 }])).toEqual({ placement: br, moved: false });
  });
  it('moves to the same edge across first (bottom-left), never saving anything', () => {
    const r = avoidPlacement(br, H, vp, [submitBR]);
    expect(r.moved).toBe(true);
    expect(r.placement.corner).toBe('bottom-left');
    expect(overlapArea(box(r.placement), submitBR)).toBe(0);
  });
  it('keeps clear of a button just next to the card (8 px of room)', () => {
    const b = box(br);
    const near = { left: b.left - 6, top: b.top + 20, width: 4, height: 20 };
    expect(avoidPlacement(br, H, vp, [near]).moved).toBe(true);
  });
  it('tries the other corners in order and takes the first free one', () => {
    const blockers = [submitBR, { left: 20, top: 740, width: 100, height: 40 }]; // both bottom corners
    expect(avoidPlacement(br, H, vp, blockers).placement.corner).toBe('top-right');
  });
  it('when every corner covers something, takes the one that covers least (ties keep the place)', () => {
    const big = (b: ReturnType<typeof box>) => ({ ...b });
    const all = (['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const).map((corner) => big(box({ corner, x: 16, y: 16 })));
    expect(avoidPlacement(br, H, vp, all)).toEqual({ placement: br, moved: false });
    const lessOnTopLeft = [...all.slice(0, 3), { ...all[3], width: 10, height: 10 }];
    expect(avoidPlacement(br, H, vp, lessOnTopLeft).placement.corner).toBe('top-left');
  });
  it('the bottom sheet goes to the top edge', () => {
    const phone = { width: 390, height: 844 };
    const btn = { left: 100, top: 790, width: 190, height: 44 };
    const r = avoidPlacement(br, H, phone, [btn]);
    expect(r.moved).toBe(true);
    expect(box(r.placement, H, phone).top).toBe(4);
  });
  it('the pill (collapsed) checks its own small box', () => {
    const pillBtn = { left: 1200, top: 720, width: 60, height: 60 };
    expect(pillAvoidPlacement(br, vp, [pillBtn]).placement.corner).toBe('bottom-left');
    expect(pillAvoidPlacement(br, vp, [{ left: 900, top: 700, width: 60, height: 40 }]).moved).toBe(false); // the card's area, not the pill's
  });
});

describe('per-site hide list', () => {
  const run = { project: 'p', id: 'w1', origins: ['https://app.test'] };
  it('hides it on a listed site; "Show on this tab" still wins', () => {
    expect(widgetEligibility({ enabled: true, active: run, url: 'https://app.test/a', hiddenOrigins: ['https://app.test'] }).reason).toBe('hidden-on-site');
    expect(widgetEligibility({ enabled: true, active: run, url: 'https://app.test/a', hiddenOrigins: ['https://other.test'] }).show).toBe(true);
    expect(widgetEligibility({ enabled: true, active: run, url: 'https://app.test/a', hiddenOrigins: ['https://app.test'], override: 'show' }).show).toBe(true);
  });
});

describe('Settings "Reset position"', () => {
  const all = { 'https://a.test': { corner: 'top-left', x: 1, y: 2 }, 'http://b.test:8080': { collapsed: true }, junk: 1 };
  it('lists the origins with a saved place', () => {
    expect(placementOrigins(all)).toEqual(['http://b.test:8080', 'https://a.test']);
    expect(placementOrigins(null)).toEqual([]);
  });
  it('forgets one origin, or all', () => {
    expect(resetPlacements(all, 'https://a.test')).toEqual({ 'http://b.test:8080': { collapsed: true }, junk: 1 });
    expect(resetPlacements(all, null)).toEqual({});
  });
});

describe('hub offline', () => {
  it('retries after 3, 6, 12, then every 30 s', () => {
    expect([1, 2, 3, 4, 9].map(retryDelay)).toEqual([3, 6, 12, 30, 30]);
  });
  it('tells "not reachable" from an error answer', () => {
    expect(unreachable('Failed to fetch')).toBe(true);
    expect(unreachable('NetworkError when attempting to fetch resource.')).toBe(true);
    expect(unreachable('Walkthrough not found')).toBe(false);
    expect(unreachable(null)).toBe(false);
  });
});

describe('stepAnnouncement', () => {
  const s = (id: string, n = 2) => ({ id, n, total: 9, title: 'Fill the form' });
  it('is silent for the first step shown on a page and for the same step', () => {
    expect(stepAnnouncement(null, s('a'), false)).toBeNull();
    expect(stepAnnouncement('a', s('a'), false)).toBeNull();
  });
  it('announces a new step and the end', () => {
    expect(stepAnnouncement('a', s('b', 3), false)).toBe('Step 3 of 9: Fill the form');
    expect(stepAnnouncement('b', null, true)).toBe('All steps are finished.');
    expect(stepAnnouncement(null, null, true)).toBeNull();
  });
});
