import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientJs } from '../src/payments/paypal/sdk.js';
import { tabbyPromoJs } from '../src/payments/tabby/promo.js';
import { tamaraWidgetJs } from '../src/payments/tamara/widget.js';
import { renderPromoInfo } from '../src/payments/sdk/promo.js';

/**
 * Contract tests of the P3 promo widgets in happy-dom: TabbyPromo / TabbyCard, <tamara-widget> with
 * window.tamaraWidgetConfig and paypal.Messages: the documented globals, elements and options, the TEST label inside
 * the widget, "Learn more" opening the stubyard info popup, and re-rendering.
 */

const STUB = 'http://stub.test';
const SHOP = 'http://shop.test';

type Win = InstanceType<typeof Window> & Record<string, any>;
let wins: Win[] = [];

function load(script: string, html = '', fetchImpl?: (url: string, init?: any) => Promise<any>): Win {
  const w = new Window({ url: SHOP + '/checkout', settings: { disableIframePageLoading: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true, navigation: { disableChildFrameNavigation: true } } as any }) as Win;
  w.document.body.innerHTML = html;
  const f = fetchImpl ?? (() => Promise.reject(new Error('no network')));
  // Run the script with the page's globals (happy-dom's own script evaluation is off by default).
  // eslint-disable-next-line no-new-func
  // Intervals (the PayPal state poll) belong to the page, so closing the window stops them.
  new Function('window', 'document', 'location', 'fetch', 'self', 'setInterval', 'clearInterval', script)(w, w.document, w.location, f, w, w.setInterval.bind(w), w.clearInterval.bind(w));
  wins.push(w);
  return w;
}
const json = (v: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(v), text: () => Promise.resolve(JSON.stringify(v)) });
/** A message from a frame as the browser would deliver it. */
function fromFrame(w: Win, frame: any, data: unknown, origin = STUB) {
  const ev = new w.MessageEvent('message', { data, origin, source: frame.contentWindow });
  w.dispatchEvent(ev);
}
/** Give a frame a stand-in window (happy-dom does not load frame pages here) and collect what the page posts to it. */
function fakeWin(frame: any): any[] {
  const sent: any[] = [];
  const win = { postMessage: (m: any, o: string) => sent.push([m, o]) };
  Object.defineProperty(frame, 'contentWindow', { configurable: true, get: () => win });
  return sent;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

afterEach(async () => {
  for (const w of wins) await w.happyDOM.close();
  wins = [];
  vi.useRealTimers();
});

const TEST_EN = 'TEST · stubyard simulator · not a real payment, no money moves';
const badgeIn = (el: any) => el.querySelector('[data-testid="stubyard-sdk-badge"]');
const overlaySrc = (w: Win) => new URL((w.document.querySelector('[data-testid="stubyard-sdk-overlay"] iframe') as any).getAttribute('src'));

describe('Tabby promo (TabbyPromo / TabbyCard)', () => {
  const BASE = STUB + '/pay/p/tabby';
  const js = tabbyPromoJs({ base: BASE, publicKey: 'pk_test_abc', merchantCode: 'shop' });
  const opts = (o: Record<string, unknown> = {}) => ({ selector: '#TabbyPromo', currency: 'AED', price: '2000.00', lang: 'en', source: 'product', publicKey: 'pk_test_abc', merchantCode: 'shop', ...o });

  it('new TabbyPromo renders "4 interest-free payments" with the TEST label inside and Learn more', () => {
    const w = load(js, '<div id="TabbyPromo"></div>');
    expect(typeof w.TabbyPromo).toBe('function');
    expect(typeof w.TabbyCard).toBe('function');
    new w.TabbyPromo(opts());
    const box = w.document.querySelector('#TabbyPromo [data-testid="stubyard-tabby-promo"]') as any;
    expect(box).toBeTruthy();
    expect(badgeIn(box).textContent).toBe(TEST_EN);
    expect(box.textContent).toContain('4 interest-free payments of AED 500.00. No fees.');
    expect(box.style.color).toContain('--snippetTextColor');
    expect(box.querySelector('[data-testid="stubyard-promo-more"]').style.color).toContain('--snippetLinkTextColor');
    expect(box.style.minWidth).toContain('320px');
  });

  it('Learn more opens the info popup (stubyard page, Arabic for lang ar); Close removes it', () => {
    const w = load(js, '<div id="TabbyPromo"></div>');
    new w.TabbyPromo(opts({ lang: 'ar', currency: 'SAR' }));
    const box = w.document.querySelector('[data-testid="stubyard-tabby-promo"]') as any;
    expect(box.getAttribute('dir')).toBe('rtl');
    expect(box.textContent).toContain('500.00 SAR');
    (box.querySelector('[data-testid="stubyard-promo-more"]') as any).click();
    const u = overlaySrc(w);
    expect(u.origin + u.pathname).toBe(BASE + '/promos/learn-more');
    expect(u.searchParams.get('lang')).toBe('ar');
    expect(u.searchParams.get('price')).toBe('2000.00');
    (w.document.querySelector('[data-testid="stubyard-sdk-close"]') as any).click();
    expect(w.document.querySelector('[data-testid="stubyard-sdk-overlay"]')).toBeNull();
  });

  it('a new instance re-renders the same element; shouldInheritBg; warnings for bad options; a missing selector is ignored', () => {
    const w = load(js, '<div id="TabbyPromo"></div>');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new w.TabbyPromo(opts());
    new w.TabbyPromo(opts({ price: '400.00', shouldInheritBg: true, publicKey: 'pk_test_other', currency: 'USD' }));
    const boxes = w.document.querySelectorAll('[data-testid="stubyard-tabby-promo"]');
    expect(boxes.length).toBe(1);
    expect((boxes[0] as any).textContent).toContain('USD 100.00');
    expect((boxes[0] as any).style.background).toBe('transparent');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/publicKey does not match[\s\S]*currency must be AED, SAR or KWD/);
    expect(new w.TabbyPromo(opts({ selector: '#nope' })).el).toBeNull();
    warn.mockRestore();
  });

  it('new TabbyCard shows the 4-payment schedule (no callbacks, as documented)', () => {
    const w = load(js, '<div id="tabbyCard"></div>');
    const c = new w.TabbyCard({ selector: '#tabbyCard', currency: 'SAR', price: '1000.00', lang: 'en', publicKey: 'pk_test_abc', merchantCode: 'shop' });
    expect(c.el).toBeTruthy();
    const card = w.document.querySelector('[data-testid="stubyard-tabby-card"]') as any;
    expect(badgeIn(card)).toBeTruthy();
    const items = card.querySelectorAll('[data-testid="stubyard-tabby-card-plan"] li');
    expect(items.length).toBe(4);
    expect(items[0].textContent).toBe('Today · SAR 250.00');
  });
});

describe('Tamara widget (<tamara-widget>, window.tamaraWidgetConfig)', () => {
  const BASE = STUB + '/pay/p/tamara';
  const js = tamaraWidgetJs({ base: BASE, publicKey: 'pub-1' });
  const cfg = (w: Win, o: Record<string, unknown> = {}) => (w.tamaraWidgetConfig = { lang: 'en', country: 'SA', publicKey: 'pub-1', ...o });

  it('renders the summary line with the TEST label; More options opens the popup', () => {
    const w = new Window({ url: SHOP + '/p' }) as Win;
    wins.push(w);
    cfg(w);
    w.document.body.innerHTML = '<tamara-widget type="tamara-summary" amount="2500" inline-type="2" config=\'{"badgePosition":"left"}\'></tamara-widget>';
    new Function('window', 'document', 'location', 'fetch', 'self', 'setInterval', 'clearInterval', js)(w, w.document, w.location, () => Promise.reject(new Error('no')), w, w.setInterval.bind(w), w.clearInterval.bind(w));
    const box = w.document.querySelector('tamara-widget [data-testid="stubyard-tamara-widget"]') as any;
    expect(box).toBeTruthy();
    expect(badgeIn(box).textContent).toBe(TEST_EN);
    expect(box.getAttribute('data-inline-type')).toBe('2');
    expect(box.textContent).toContain('Pay SAR 208/mo or in 4 payments. Sharia-compliant.');
    const p = box.querySelector('[data-testid="stubyard-promo-text"]');
    expect(p.firstChild.getAttribute('data-testid')).toBe('stubyard-tamara-badge');
    (box.querySelector('[data-testid="stubyard-promo-more"]') as any).click();
    const u = overlaySrc(w);
    expect(u.origin + u.pathname).toBe(BASE + '/widget-v2/popup');
    expect(u.searchParams.get('amount')).toBe('2500');
    expect(u.searchParams.get('country')).toBe('SA');
  });

  it('an element added later and a changed amount re-render; Arabic and UAE from the config; TamaraWidgetV2.refresh()', () => {
    const w = load(js);
    cfg(w, { lang: 'ar', country: 'AE' });
    const el = w.document.createElement('tamara-widget');
    el.setAttribute('amount', '1200');
    w.document.body.appendChild(el);
    let box = el.querySelector('[data-testid="stubyard-tamara-widget"]') as any;
    expect(box.getAttribute('dir')).toBe('rtl');
    expect(box.textContent).toContain('ادفع AED 100/شهريًا أو على 4 دفعات');
    el.setAttribute('amount', '2400');
    box = el.querySelector('[data-testid="stubyard-tamara-widget"]') as any;
    expect(box.textContent).toContain('AED 200');
    expect(el.querySelectorAll('[data-testid="stubyard-tamara-widget"]').length).toBe(1);
    cfg(w, { lang: 'en', country: 'KW' });
    w.TamaraWidgetV2.refresh();
    expect(el.textContent).toContain('Pay KWD 200/mo');
    expect(w.TamaraWidgetV2.stubyard).toBe(true);
  });
});

describe('PayPal Pay Later messages (components=messages)', () => {
  const BASE = STUB + '/pay/p/paypal';
  const cfgOf = (components: string[], lang = 'en') => ({ base: BASE, clientId: 'cid', components, intent: 'CAPTURE', currency: 'USD', vault: false, buttonsMode: 'popup', namespace: 'paypal', version: 'test', lang });

  it('paypal.Messages({amount, placement, style}).render(selector) with onRender; Learn more calls onClick and opens the popup', async () => {
    const w = load(clientJs(cfgOf(['buttons', 'messages'])), '<div id="msg"></div>');
    expect(typeof w.paypal.Messages).toBe('function');
    const onRender = vi.fn();
    const onClick = vi.fn();
    await w.paypal.Messages({ amount: 120, placement: 'product', style: { layout: 'flex', color: 'black' }, onRender, onClick }).render('#msg');
    const m = w.document.querySelector('#msg [data-testid="stubyard-pp-message"]') as any;
    expect(m).toBeTruthy();
    expect(badgeIn(m).textContent).toBe(TEST_EN);
    expect(m.getAttribute('data-placement')).toBe('product');
    expect(m.getAttribute('data-layout')).toBe('flex');
    expect(m.textContent).toContain('Pay in 4 interest-free payments of $30.00.');
    expect(onRender).toHaveBeenCalledTimes(1);
    (m.querySelector('[data-testid="stubyard-promo-more"]') as any).click();
    expect(onClick).toHaveBeenCalledTimes(1);
    const u = overlaySrc(w);
    expect(u.origin + u.pathname).toBe(BASE + '/sdk/messages/learn-more');
    expect(u.searchParams.get('amount')).toBe('120');
    await expect(w.paypal.Messages({ amount: 1 }).render('#none')).rejects.toThrow(/no element/);
  });

  it('auto-renders [data-pp-message] elements; Arabic with locale ar; absent without the component', () => {
    const html = '<div data-pp-message data-pp-amount="200" data-pp-placement="cart" data-pp-style-layout="text"></div>';
    const w = load(clientJs(cfgOf(['messages'], 'ar')), html);
    const m = w.document.querySelector('[data-pp-message] [data-testid="stubyard-pp-message"]') as any;
    expect(m).toBeTruthy();
    expect(m.getAttribute('data-placement')).toBe('cart');
    expect(m.getAttribute('dir')).toBe('rtl');
    expect(m.textContent).toContain('ادفع على 4 دفعات بدون فوائد بقيمة $50.00');
    const w2 = load(clientJs(cfgOf(['buttons'])), html);
    expect(w2.paypal.Messages).toBeUndefined();
    expect(w2.document.querySelector('[data-testid="stubyard-pp-message"]')).toBeNull();
  });
});

describe('info popup page', () => {
  it('has the TEST strip, no scripts or forms', () => {
    const html = renderPromoInfo({ provider: 'Tabby', lang: 'en', title: 'Pay in 4 with Tabby', plan: [['Today', 'AED 1.00']], sections: [{ heading: 'How it works', items: ['a'] }] });
    expect(html).toContain('data-testid="stubyard-test-banner"');
    expect(html).toContain('<title>[TEST] ');
    expect(html).not.toContain('<form');
  });
});
