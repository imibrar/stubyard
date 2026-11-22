import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { geideaCheckoutJs } from '../src/payments/geidea/sdk.js';
import { mpfJs } from '../src/payments/moyasar/form.js';
import { clientJs } from '../src/payments/paypal/sdk.js';
import { renderMpfFrame } from '../src/payments/moyasar/form.js';
import { renderWalletSheet } from '../src/payments/sdk/wallet.js';
import { renderCardFieldPage, renderClosePage } from '../src/payments/pages.js';

/**
 * Contract tests of the P2 fake SDKs in happy-dom: the real global / object / method / callback names, the TEST
 * notice, and the bridge (messages only from stubyard's origin, on the right channel; frames are told only that origin).
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

describe('Moyasar Form (window.Moyasar)', () => {
  const BASE = STUB + '/pay/p/moyasar';
  const js = mpfJs({ base: BASE, version: 'test' });
  const opts = (o: Record<string, unknown> = {}) => ({ element: '.mysr-form', amount: 1000, currency: 'SAR', description: 'Order', publishable_api_key: 'pk_test_abcdefghij', callback_url: SHOP + '/cb', methods: ['creditcard', 'stcpay', 'applepay'], ...o });

  it('exposes Moyasar.init and validates its options', () => {
    const w = load(js, '<div class="mysr-form"></div>');
    expect(typeof w.Moyasar.init).toBe('function');
    expect(w.Moyasar.stubyard).toBe(true);
    expect(() => w.Moyasar.init(opts({ publishable_api_key: '' }))).toThrow(/publishable_api_key/);
    expect(() => w.Moyasar.init(opts({ amount: 10.5 }))).toThrow(/amount/);
    expect(() => w.Moyasar.init(opts({ element: '#missing' }))).toThrow(/element/);
  });

  it('renders the stubyard frame with the page origin and a fresh channel', () => {
    const w = load(js, '<div class="mysr-form"></div>');
    w.Moyasar.init(opts({ language: 'ar' }));
    const f = w.document.querySelector('[data-testid="stubyard-moyasar-frame"]') as any;
    expect(f).toBeTruthy();
    const u = new URL(f.getAttribute('src'));
    expect(u.origin + u.pathname).toBe(BASE + '/mpf/form');
    expect(u.searchParams.get('origin')).toBe(SHOP);
    expect(u.searchParams.get('lang')).toBe('ar');
    expect(u.searchParams.get('methods')).toBe('creditcard,stcpay,applepay');
    expect(u.searchParams.get('ch')).toMatch(/^ch[0-9a-f]{24}$/);
  });

  it('runs on_initiating (override, false stops), on_completed, on_failure, on_redirect; ignores other origins and channels', async () => {
    const w = load(js, '<div class="mysr-form"></div>');
    const calls: string[] = [];
    const on_initiating = vi.fn(() => ({ amount: 2000, metadata: { order_id: 'o-1' } }));
    const on_completed = vi.fn(() => Promise.resolve());
    const on_failure = vi.fn((e: string) => calls.push('fail:' + e));
    const on_redirect = vi.fn((u: string) => calls.push('redirect:' + u));
    w.Moyasar.init(opts({ on_initiating, on_completed, on_failure, on_redirect }));
    const f = w.document.querySelector('iframe') as any;
    const ch = new URL(f.getAttribute('src')).searchParams.get('ch');
    const sent = fakeWin(f);
    const msg = (d: Record<string, unknown>) => ({ source: 'stubyard-moyasar', ch, ...d });

    fromFrame(w, f, msg({ type: 'ready' }));
    expect(sent[0][0]).toMatchObject({ type: 'config', source: 'stubyard-moyasar-host', ch, config: { amount: 1000, currency: 'SAR' } });
    expect(sent[0][1]).toBe(STUB);

    fromFrame(w, f, msg({ type: 'initiating' }), 'http://evil.test');
    fromFrame(w, f, { ...msg({ type: 'initiating' }), ch: 'chother000000' });
    w.dispatchEvent(new w.MessageEvent('message', { data: msg({ type: 'initiating' }), origin: STUB, source: null }));
    await flush();
    expect(on_initiating).not.toHaveBeenCalled();

    fromFrame(w, f, msg({ type: 'initiating' }));
    await flush();
    expect(on_initiating).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)![0]).toMatchObject({ type: 'initiating-result', ok: true, config: { amount: 2000, metadata: { order_id: 'o-1' } } });

    fromFrame(w, f, msg({ type: 'completed', payment: { id: 'pay_1', status: 'initiated' } }));
    await flush();
    expect(on_completed).toHaveBeenCalledWith({ id: 'pay_1', status: 'initiated' });
    expect(sent.at(-1)![0]).toMatchObject({ type: 'completed-ack', ok: true });

    fromFrame(w, f, msg({ type: 'redirect', url: STUB + '/acs' }));
    fromFrame(w, f, msg({ type: 'redirect', url: 'javascript:alert(1)' }));
    fromFrame(w, f, msg({ type: 'failure', error: 'Declined' }));
    expect(calls).toEqual(['redirect:' + STUB + '/acs', 'fail:Declined']);

    on_initiating.mockReturnValueOnce(false as any);
    fromFrame(w, f, msg({ type: 'initiating' }));
    await flush();
    expect(sent.at(-1)![0]).toMatchObject({ type: 'initiating-result', ok: false });
  });

  it('Apple Pay: opens the TEST wallet sheet and relays its answer to the form', async () => {
    const w = load(js, '<div class="mysr-form"></div>');
    w.Moyasar.init(opts({ apple_pay: { label: 'My Shop' } }));
    const f = w.document.querySelector('iframe') as any;
    const ch = new URL(f.getAttribute('src')).searchParams.get('ch');
    const sent = fakeWin(f);
    fromFrame(w, f, { source: 'stubyard-moyasar', ch, type: 'wallet', wallet: 'applepay', amount: '10.00 SAR' });
    const ov = w.document.querySelector('[data-testid="stubyard-sdk-overlay"]') as any;
    expect(ov).toBeTruthy();
    const sheet = ov.querySelector('iframe');
    fakeWin(sheet);
    const su = new URL(sheet.getAttribute('src'));
    expect(su.pathname).toBe('/pay/p/moyasar/stubyard-sdk/wallet');
    expect(su.searchParams.get('label')).toBe('My Shop');
    expect(su.searchParams.get('origin')).toBe(SHOP);
    fromFrame(w, sheet, { source: 'stubyard-wallet', ch: su.searchParams.get('ch'), type: 'wallet', result: 'authorized', card: { brand: 'visa', last4: '4242', magicId: 'success' } });
    expect(w.document.querySelector('[data-testid="stubyard-sdk-overlay"]')).toBeNull();
    expect(sent.at(-1)![0]).toMatchObject({ type: 'wallet-result', result: 'authorized', card: { last4: '4242' } });
    expect(sent.at(-1)![1]).toBe(STUB);
  });
});

describe('GeideaCheckout', () => {
  const BASE = STUB + '/pay/p/geidea';
  const popup = geideaCheckoutJs({ base: BASE, mode: 'popup' });
  const RESULT = (event: string, code: string) => ({ source: 'stubyard-geidea', type: 'result', event, data: { responseCode: code, responseMessage: 'x', detailedResponseCode: '000', detailedResponseMessage: 'x', orderId: 'o1', reference: 'r1' } });

  it('keeps the real constructor and method names', () => {
    const w = load(popup);
    const g = new w.GeideaCheckout(() => 0, () => 0, () => 0);
    expect(typeof g.startPayment).toBe('function');
    expect(w.GeideaCheckout.stubyard).toBe(true);
  });

  it('popup: exactly one callback (success on "000"); later results and other origins are ignored', async () => {
    const fetchSpy = vi.fn((_url: string) => json({ state: 'open', orderId: 'o1', language: 'en' }));
    const w = load(popup, '', fetchSpy as any);
    const ok = vi.fn(), err = vi.fn(), cancel = vi.fn();
    new w.GeideaCheckout(ok, err, cancel).startPayment('sid-1');
    await flush();
    expect(fetchSpy.mock.calls[0]![0]).toBe(BASE + '/hpp/sdk/sessions/sid-1');
    const f = w.document.querySelector('[data-testid="stubyard-geidea-frame"]') as any;
    expect(f).toBeTruthy();
    expect(w.document.querySelector('[data-testid="stubyard-sdk-overlay"]')).toBeTruthy();
    const u = new URL(f.getAttribute('src'));
    expect(u.pathname).toBe('/pay/p/geidea/hpp/checkout/');
    expect(u.search).toContain('sid-1&');
    expect(u.searchParams.get('stubyard_origin')).toBe(SHOP);
    expect(u.searchParams.get('stubyard_mode')).toBe('popup');
    const ch = u.searchParams.get('stubyard_sdk');
    fakeWin(f);
    fromFrame(w, f, { ...RESULT('success', '000'), ch }, 'http://evil.test');
    expect(ok).not.toHaveBeenCalled();
    fromFrame(w, f, { ...RESULT('success', '000'), ch });
    fromFrame(w, f, { ...RESULT('error', '999'), ch });
    expect(ok).toHaveBeenCalledTimes(1);
    expect(ok.mock.calls[0]![0]).toMatchObject({ responseCode: '000', orderId: 'o1' });
    expect(err).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(w.document.querySelector('[data-testid="stubyard-sdk-overlay"]')).toBeNull();
  });

  it('Close asks the frame to cancel and ends with onCancel even without an answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = load(popup, '', (() => json({ state: 'open', orderId: 'o2', language: 'ar' })) as any);
    const cancel = vi.fn(), err = vi.fn();
    new w.GeideaCheckout(() => 0, err, cancel).startPayment('sid-2');
    await vi.runAllTimersAsync();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const f = w.document.querySelector('[data-testid="stubyard-geidea-frame"]') as any;
    const sent = fakeWin(f);
    const close = w.document.querySelector('[data-testid="stubyard-sdk-close"]') as any;
    expect(close.textContent).toBe('إغلاق');
    close.click();
    expect(sent[0][0]).toMatchObject({ type: 'cancel', source: 'stubyard-geidea-host' });
    expect(sent[0][1]).toBe(STUB);
    await vi.advanceTimersByTimeAsync(5000);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0]![0]).toMatchObject({ responseCode: '010' });
    expect(err).not.toHaveBeenCalled();
  });

  it('drop-in renders into the container; an unusable session calls onError only', async () => {
    const w = load(popup, '<div id="pay-here"></div>', (() => json({ state: 'open', orderId: 'o3', language: 'en' })) as any);
    new w.GeideaCheckout(() => 0, () => 0, () => 0).startPayment('sid-3', null, 'pay-here');
    await flush();
    const f = w.document.querySelector('#pay-here iframe') as any;
    expect(f).toBeTruthy();
    expect(new URL(f.getAttribute('src')).searchParams.get('stubyard_mode')).toBe('dropin');

    const w2 = load(popup, '', (() => json({ state: 'expired', error: { responseCode: '999', responseMessage: 'Expired' } })) as any);
    const ok = vi.fn(), err = vi.fn(), cancel = vi.fn();
    new w2.GeideaCheckout(ok, err, cancel).startPayment('sid-4');
    await flush();
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]![0]).toMatchObject({ responseCode: '999' });
    expect(ok).not.toHaveBeenCalled();
    expect(w2.document.querySelector('iframe')).toBeNull();

    const w3 = load(popup);
    const e3 = vi.fn();
    new w3.GeideaCheckout(() => 0, e3, () => 0).startPayment('');
    expect(e3).toHaveBeenCalledTimes(1);
  });
});

describe('PayPal JS SDK (paypal.Buttons / paypal.CardFields)', () => {
  const BASE = STUB + '/pay/p/paypal';
  const js = (o: Record<string, unknown> = {}) => clientJs({ base: BASE, clientId: 'cid', components: ['buttons', 'card-fields'], intent: 'CAPTURE', currency: 'USD', vault: false, buttonsMode: 'inline', namespace: 'paypal', version: 'test', lang: 'en', ...o });

  it('Buttons: the stack PayPal / Pay Later / card with the TEST notice; fundingSource renders one', async () => {
    const w = load(js(), '<div id="pp"></div><div id="one"></div>');
    expect(w.paypal.FUNDING.PAYLATER).toBe('paylater');
    expect(w.paypal.getFundingSources()).toEqual(['paypal', 'paylater', 'card']);
    await w.paypal.Buttons({ createOrder: () => 'X' }).render('#pp');
    const host = w.document.querySelector('#pp') as any;
    expect(host.querySelector('[data-testid="stubyard-sdk-badge"]').textContent).toContain('TEST');
    expect([...host.querySelectorAll('button')].map((b: any) => b.getAttribute('data-funding-source'))).toEqual(['paypal', 'paylater', 'card']);
    await w.paypal.Buttons({ fundingSource: 'paylater', createOrder: () => 'X' }).render('#one');
    expect(w.document.querySelectorAll('#one button').length).toBe(1);
  });

  it('Buttons click: createOrder, then the overlay opens checkoutnow with the page origin and funding', async () => {
    const w = load(js({ lang: 'ar' }), '<div id="pp"></div>', (() => json({ id: 'ORDER1', state: 'open' })) as any);
    const createOrder = vi.fn(() => 'ORDER1');
    await w.paypal.Buttons({ createOrder }).render('#pp');
    (w.document.querySelector('[data-funding-source="paylater"]') as any).click();
    await flush();
    expect(createOrder).toHaveBeenCalledWith({ paymentSource: 'paylater' }, expect.anything());
    const ov = w.document.querySelector('[data-testid="stubyard-paypal-overlay"]') as any;
    const u = new URL(ov.querySelector('iframe').getAttribute('src'));
    expect(u.pathname).toBe('/pay/p/paypal/checkoutnow');
    expect(u.searchParams.get('origin')).toBe(SHOP);
    expect(u.searchParams.get('funding')).toBe('paylater');
    expect(u.searchParams.get('locale')).toBe('ar_SA');
  });

  it('Card Fields: frames get the page origin; host commands go only to stubyard; events only from stubyard', async () => {
    const w = load(js(), '<div id="n"></div>');
    const onChange = vi.fn();
    const cf = w.paypal.CardFields({ createOrder: () => 'O', inputEvents: { onChange } });
    const field = cf.NumberField();
    await field.render('#n');
    const f = w.document.querySelector('[data-testid="stubyard-cf-frame-number"]') as any;
    const u = new URL(f.getAttribute('src'));
    expect(u.searchParams.get('origin')).toBe(SHOP);
    const cfId = u.searchParams.get('cf');
    const sent = fakeWin(f);
    field.clear();
    expect(sent[0][1]).toBe(STUB);
    const ev = { source: 'stubyard-paypal-cf', cf: cfId, type: 'number', event: 'change', state: { isValid: true, isEmpty: false, isPotentiallyValid: true, isFocused: true }, card: { brand: 'visa', last4: '4242', test: true } };
    fromFrame(w, f, ev, 'http://evil.test');
    expect(onChange).not.toHaveBeenCalled();
    fromFrame(w, f, ev);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].cards[0].type).toBe('visa');
  });
});

describe('frame pages', () => {
  const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  it('every inline script parses, posts only to the given origin and never reads document.referrer', () => {
    const pages = [
      renderMpfFrame({ locale: 'en', origin: SHOP, ch: 'chabcdef123', key: 'pk_test_x', amount: 1000, currency: 'SAR', methods: ['creditcard', 'stcpay', 'applepay'], networks: ['visa', 'mada'] }),
      renderMpfFrame({ locale: 'ar', origin: SHOP, ch: 'chabcdef123', key: 'pk_test_x', amount: 1000, currency: 'SAR', methods: ['stcpay'], networks: [] }),
      renderWalletSheet({ wallet: 'applepay', amount: '10.00 SAR', label: 'Shop', locale: 'ar', origin: SHOP, ch: 'chabcdef123' } as any),
      renderCardFieldPage({ type: 'number', cf: 'abc', warnAction: STUB + '/w', targetOrigin: SHOP }),
      renderClosePage({ presetId: 'paypal', presetName: 'PayPal', amount: '1.00 USD', title: 'Payment approved', message: { source: 'stubyard-paypal', orderID: 'O', state: 'approved', targetOrigin: SHOP }, dashboardUrl: STUB }),
    ];
    for (const html of pages) {
      const list = scripts(html);
      expect(list.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-new-func
      for (const s of list) expect(() => new Function(s)).not.toThrow();
      expect(html).not.toMatch(/postMessage\([^)]*,\s*['"]\*['"]\)/);
      expect(html).not.toContain('document.referrer');
      expect(html).toContain(JSON.stringify(SHOP));
    }
    expect(pages[1]).toContain('dir="rtl"');
    expect(pages[2]).toContain('data-testid="stubyard-test-banner"');
  });
});

describe('Moyasar Form frame script (runs in happy-dom)', () => {
  it('validates the cardholder and card before anything is created; switches methods', async () => {
    const w = new Window({ url: STUB + '/pay/p/moyasar/mpf/form', settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableIframePageLoading: true } as any }) as Win;
    wins.push(w);
    const errors: unknown[] = [];
    w.addEventListener('error', (e: any) => errors.push(e.error ?? e.message));
    w.document.write(renderMpfFrame({ locale: 'en', origin: SHOP, ch: 'chabcdef123', key: 'pk_test_x', amount: 1000, currency: 'SAR', methods: ['creditcard', 'stcpay', 'applepay'], networks: ['visa', 'mada'] }));
    await flush();
    expect(errors).toEqual([]);
    const d = w.document;
    (d.getElementById('mf') as any).dispatchEvent(new w.Event('submit', { cancelable: true }));
    const err = d.querySelector('[data-testid="stubyard-form-error"]') as any;
    expect(err.classList.contains('hide')).toBe(false);
    expect(err.textContent.length).toBeGreaterThan(3);
    const stc = d.querySelector('input[name=method][value=stcpay]') as any;
    if (stc) {
      stc.checked = true;
      stc.dispatchEvent(new w.Event('change'));
      expect((d.querySelector('[data-for="stcpay"]') as any).classList.contains('hide')).toBe(false);
      expect((d.querySelector('[data-for="card"]') as any).classList.contains('hide')).toBe(true);
    }
  });
});
