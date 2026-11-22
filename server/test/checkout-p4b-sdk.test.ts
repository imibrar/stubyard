import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_NOTICE } from '../src/payments/kit/i18n.js';
import { apsMerchantDemo, renderApsMerchantPage } from '../src/payments/sdk/aps-merchant.js';
import { flowJs, renderFlowFrame } from '../src/payments/sdk/checkout-flow.js';
import { mfSessionReturnPage } from '../src/payments/sdk/myfatoorah-return.js';
import { mfSessionJs, renderMfSessionFrame } from '../src/payments/sdk/myfatoorah-session.js';
import { paylibJs } from '../src/payments/sdk/paytabs-paylib.js';
import { renderTapCardFrame, tapCardJs } from '../src/payments/sdk/tap-card.js';

/**
 * Contract tests of the P4b fake SDKs in happy-dom: Checkout.com Flow, Tap Card SDK v2, MyFatoorah session.js,
 * PayTabs paylib.js and the APS Merchant Page. The real global / method / callback names, the TEST notice, and the
 * bridge (messages only from stubyard's origin on the right channel; frames talk only to the page origin).
 */

const STUB = 'http://stub.test';
const SHOP = 'http://shop.test';

type Win = InstanceType<typeof Window> & Record<string, any>;
let wins: Win[] = [];

function load(script: string, html = '', fetchImpl?: (url: string, init?: any) => Promise<any>): Win {
  const w = new Window({ url: SHOP + '/checkout', settings: { disableIframePageLoading: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true, navigation: { disableChildFrameNavigation: true } } as any }) as Win;
  w.document.body.innerHTML = html;
  const f = fetchImpl ?? (() => Promise.reject(new Error('no network')));
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'location', 'fetch', 'self', 'HTMLFormElement', script)(w, w.document, w.location, f, w, w.HTMLFormElement);
  wins.push(w);
  return w;
}
const json = (v: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(v), text: () => Promise.resolve(JSON.stringify(v)) });
function fromFrame(w: Win, frame: any, data: unknown, origin = STUB) {
  w.dispatchEvent(new w.MessageEvent('message', { data, origin, source: frame.contentWindow }));
}
function fakeWin(frame: any): any[] {
  const sent: any[] = [];
  const win = { postMessage: (m: any, o: string) => sent.push([m, o]) };
  Object.defineProperty(frame, 'contentWindow', { configurable: true, get: () => win });
  return sent;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => {
  for (let i = 0; i < 8; i++) await tick();
};
const chOf = (f: any) => new URL(f.getAttribute('src')).searchParams.get('ch')!;
/** Scripts and pages never post to "*" nor read document.referrer. */
function expectNoWildcardPost(text: string) {
  expect(text).not.toMatch(/postMessage\([^)]*,\s*['"]\*['"]\)/);
  expect(text).not.toContain('document.referrer');
}

afterEach(async () => {
  for (const w of wins) await w.happyDOM.close();
  wins = [];
  vi.useRealTimers();
});

describe('Checkout.com Flow (CheckoutWebComponents)', () => {
  const BASE = STUB + '/pay/p/cko';
  const js = flowJs({ base: BASE, version: 'test' });
  const session = { id: 'ps_2abc', payment_session_secret: 'pss_secret', payment_session_token: 'tok' };
  const fetcher = (calls: any[], submit: unknown = { id: 'pay_1', status: 'Approved', type: 'card' }) => (url: string, init?: any) => {
    calls.push([url, init]);
    if (url.includes('/flow/payment-sessions/')) return json({ id: 'ps_2abc', amount: 1000, currency: 'SAR' });
    if (url.endsWith('/flow/submit')) return json(submit);
    return json({}, 404);
  };

  it('validates publicKey and paymentSession; resolves create()', async () => {
    const calls: any[] = [];
    const w = load(js, '<div id="flow"></div>', fetcher(calls));
    expect(typeof w.CheckoutWebComponents).toBe('function');
    const onError = vi.fn();
    await expect(w.CheckoutWebComponents({ publicKey: 'sk_bad', paymentSession: session, onError })).rejects.toMatchObject({ name: 'CheckoutError', code: 'public_key_invalid' });
    expect(onError).toHaveBeenCalled();
    await expect(w.CheckoutWebComponents({ publicKey: 'pk_sbox_x', paymentSession: { id: 'x' } })).rejects.toMatchObject({ code: 'payment_session_invalid' });
    const cko = await w.CheckoutWebComponents({ publicKey: 'pk_sbox_x', paymentSession: session });
    expect(typeof cko.create).toBe('function');
    expect(cko.paymentSession).toMatchObject({ id: 'ps_2abc', amount: 1000, currency: 'SAR' });
    expect(calls[0][0]).toBe(BASE + '/flow/payment-sessions/ps_2abc?key=pk_sbox_x');
    expect(() => cko.create('nope')).toThrow(/Unknown component/);
    const gp = cko.create('googlepay');
    expect(await gp.isAvailable()).toBe(false);
  });

  it('mounts the frame (origin, channel) and runs onReady / onChange / onPaymentCompleted; ignores other origins', async () => {
    const calls: any[] = [];
    const w = load(js, '<div id="flow"></div>', fetcher(calls));
    const onReady = vi.fn();
    const onChange = vi.fn();
    const onPaymentCompleted = vi.fn();
    const cko = await w.CheckoutWebComponents({ publicKey: 'pk_sbox_x', paymentSession: session, locale: 'ar', appearance: { colorAction: '#000' }, onReady, onChange, onPaymentCompleted });
    const comp = cko.create('flow').mount('#flow');
    const f = w.document.querySelector('[data-testid="stubyard-cko-flow-frame"]') as any;
    const u = new URL(f.getAttribute('src'));
    expect(u.origin + u.pathname).toBe(BASE + '/flow/frame');
    expect(u.searchParams.get('origin')).toBe(SHOP);
    expect(u.searchParams.get('lang')).toBe('ar');
    expect(u.searchParams.get('session')).toBe('ps_2abc');
    const ch = chOf(f);
    const sent = fakeWin(f);
    const msg = (d: Record<string, unknown>) => ({ source: 'stubyard-cko-flow', ch, ...d });
    fromFrame(w, f, msg({ type: 'ready' }), 'http://evil.test');
    fromFrame(w, f, { ...msg({ type: 'ready' }), ch: 'chother' });
    expect(onReady).not.toHaveBeenCalled();
    fromFrame(w, f, msg({ type: 'ready' }));
    expect(onReady).toHaveBeenCalledWith(comp);
    expect(sent[0]).toEqual([expect.objectContaining({ type: 'config', source: 'stubyard-cko-flow-host', ch, appearance: { colorAction: '#000' } }), STUB]);
    fromFrame(w, f, msg({ type: 'change', valid: true }));
    expect(onChange).toHaveBeenCalled();
    expect(comp.isValid()).toBe(true);
    comp.submit();
    expect(sent.at(-1)![0]).toMatchObject({ type: 'submit-request' });
    fromFrame(w, f, msg({ type: 'submit', session_data: 'sd_1' }));
    await flush();
    const sub = calls.find((c) => c[0].endsWith('/flow/submit'));
    expect(JSON.parse(sub[1].body)).toEqual({ payment_session_id: 'ps_2abc', payment_session_secret: 'pss_secret', session_data: 'sd_1' });
    expect(onPaymentCompleted).toHaveBeenCalledWith(comp, expect.objectContaining({ id: 'pay_1', status: 'Approved' }));
    for (const s of sent) expect(s[1]).toBe(STUB);
  });

  it('uses handleSubmit when given and reports a decline through onError (CheckoutError)', async () => {
    const w = load(js, '<div id="flow"></div>', fetcher([]));
    const onError = vi.fn();
    const handleSubmit = vi.fn(async () => ({ id: 'pay_2', status: 'Declined', response_code: '20051' }));
    const cko = await w.CheckoutWebComponents({ publicKey: 'pk_sbox_x', paymentSession: session, onError, handleSubmit });
    const comp = cko.create('card').mount('#flow');
    const f = w.document.querySelector('iframe') as any;
    fakeWin(f);
    fromFrame(w, f, { source: 'stubyard-cko-flow', ch: chOf(f), type: 'submit', session_data: 'sd_2' });
    await flush();
    expect(handleSubmit).toHaveBeenCalledWith(comp, { session_data: 'sd_2' });
    expect(onError.mock.calls[0][1]).toMatchObject({ name: 'CheckoutError', code: 'payment_declined' });
  });

  it('tokenize() resolves with the frame data; unmount removes the frame', async () => {
    const w = load(js, '<div id="flow"></div>', fetcher([]));
    const cko = await w.CheckoutWebComponents({ publicKey: 'pk_sbox_x', paymentSession: session });
    const comp = cko.create('card').mount('#flow');
    const f = w.document.querySelector('iframe') as any;
    const sent = fakeWin(f);
    const p = comp.tokenize();
    const req = sent.at(-1)![0];
    expect(req.type).toBe('tokenize');
    fromFrame(w, f, { source: 'stubyard-cko-flow', ch: chOf(f), type: 'tokenized', id: req.id, data: { token: 'tok_x' } });
    await expect(p).resolves.toEqual({ data: { token: 'tok_x' } });
    comp.unmount();
    expect(w.document.querySelector('iframe')).toBeNull();
  });

  it('the frame: TEST notice, the form, messages to the page origin only (EN and AR)', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderFlowFrame({ locale, origin: SHOP, ch: 'chtest', key: 'pk_sbox_x', session: 'ps_2abc', amountText: '10.00 SAR', component: 'flow', showPay: true, cardholder: true, testCards: [] });
      expect(html).toContain(TEST_NOTICE[locale]);
      expect(html).toContain('data-layout="checkout-flow"');
      expect(html).toContain('data-testid="stubyard-card"');
      expect(html).toContain(JSON.stringify(SHOP));
      if (locale === 'ar') expect(html).toContain('dir="rtl"');
      expectNoWildcardPost(html);
    }
    expectNoWildcardPost(js);
  });
});

describe('Tap Card SDK v2 (window.CardSDK)', () => {
  const BASE = STUB + '/pay/p/tap';
  const js = tapCardJs({ base: BASE, version: 'test' });
  const config = (o: Record<string, unknown> = {}) => ({ publicKey: 'pk_test_x', merchant: { id: 'm1' }, transaction: { amount: 12, currency: 'SAR' }, acceptance: { supportedBrands: ['VISA', 'MADA'] }, fields: { cardHolder: true }, addons: { saveCard: true, displayPaymentBrands: true }, interface: { locale: 'en', theme: 'light', edges: 'curved', direction: 'ltr' }, ...o });

  it('exposes the documented functions and constants', () => {
    const w = load(js, '<div id="card-sdk-id"></div>');
    for (const k of ['renderTapCard', 'tokenize', 'saveCard', 'resetCardInputs', 'updateTheme', 'updateCardConfiguration', 'loadSavedCard']) expect(typeof w.CardSDK[k], k).toBe('function');
    expect(w.CardSDK.Theme).toMatchObject({ LIGHT: 'light', DARK: 'dark', DYNAMIC: 'dynamic' });
    expect(w.CardSDK.Currencies.SAR).toBe('SAR');
    expect(w.CardSDK.Direction.RTL).toBe('rtl');
    expect(w.CardSDK.Edges.CURVED).toBe('curved');
    expect(w.CardSDK.Locale.AR).toBe('ar');
    const onError = vi.fn();
    expect(() => w.CardSDK.renderTapCard('card-sdk-id', config({ publicKey: 'sk_test_bad', onError }))).toThrow(/publicKey/);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_public_key' }));
  });

  it('renders the frame and maps every frame event to its callback; tokenize() → onSuccess(tok_)', () => {
    const w = load(js, '<div id="card-sdk-id"></div>');
    const cb = { onReady: vi.fn(), onFocus: vi.fn(), onBinIdentification: vi.fn(), onValidInput: vi.fn(), onInvalidInput: vi.fn(), onError: vi.fn(), onSuccess: vi.fn(), onChangeSaveCardLater: vi.fn() };
    const r = w.CardSDK.renderTapCard('card-sdk-id', config(cb));
    expect(typeof r.unmount).toBe('function');
    const f = w.document.querySelector('[data-testid="stubyard-tap-card-frame"]') as any;
    const u = new URL(f.getAttribute('src'));
    expect(u.origin + u.pathname).toBe(BASE + '/card-sdk/frame');
    expect(u.searchParams.get('origin')).toBe(SHOP);
    expect(u.searchParams.get('brands')).toBe('VISA,MADA');
    expect(u.searchParams.get('save')).toBe('1');
    const sent = fakeWin(f);
    const m = (d: Record<string, unknown>) => fromFrame(w, f, { source: 'stubyard-tap-card', ch: chOf(f), ...d });
    fromFrame(w, f, { source: 'stubyard-tap-card', ch: chOf(f), type: 'ready' }, 'http://evil.test');
    expect(cb.onReady).not.toHaveBeenCalled();
    m({ type: 'ready' });
    m({ type: 'focus' });
    m({ type: 'bin', data: { bin: '424242', card_brand: 'VISA' } });
    m({ type: 'valid', data: { valid: true } });
    m({ type: 'invalid', data: { valid: false } });
    m({ type: 'save-later', value: true });
    m({ type: 'error', error: { code: 'invalid_card' } });
    for (const k of Object.keys(cb).filter((k) => k !== 'onSuccess')) expect(cb[k as keyof typeof cb], k).toHaveBeenCalled();
    expect(cb.onBinIdentification).toHaveBeenCalledWith({ bin: '424242', card_brand: 'VISA' });
    expect(cb.onChangeSaveCardLater).toHaveBeenCalledWith(true);
    w.CardSDK.tokenize();
    expect(sent.at(-1)).toEqual([expect.objectContaining({ type: 'tokenize', source: 'stubyard-tap-card-host' }), STUB]);
    m({ type: 'success', data: { id: 'tok_123' } });
    expect(cb.onSuccess).toHaveBeenCalledWith({ id: 'tok_123' });
    w.CardSDK.resetCardInputs();
    expect(sent.at(-1)![0].type).toBe('reset');
    w.CardSDK.updateTheme(w.CardSDK.Theme.DARK);
    expect(sent.at(-1)![0]).toMatchObject({ type: 'theme', theme: 'dark' });
    w.CardSDK.loadSavedCard('card_1');
    expect(cb.onError).toHaveBeenLastCalledWith(expect.objectContaining({ code: 'not_simulated' }));
    r.unmount();
    expect(w.document.querySelector('iframe')).toBeNull();
  });

  it('the frame: TEST notice, cardholder, save card, page origin only (EN and AR)', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderTapCardFrame({ locale, origin: SHOP, ch: 'chtest', key: 'pk_test_x', brands: ['VISA'], holder: true, save: true, logos: true, theme: 'light', edges: 'curved', dir: 'dynamic', testCards: [], noThreeDs: [] });
      expect(html).toContain(TEST_NOTICE[locale]);
      expect(html).toContain('data-layout="tap-card-sdk"');
      expect(html).toContain('data-testid="stubyard-cardholder"');
      expect(html).toContain('data-testid="stubyard-tap-save"');
      expect(html).toContain(JSON.stringify(SHOP));
      expectNoWildcardPost(html);
    }
    expectNoWildcardPost(js);
  });
});

describe('MyFatoorah session.js (window.myfatoorah)', () => {
  const BASE = STUB + '/pay/p/mf';
  const js = mfSessionJs({ base: BASE, version: 'test' });
  const opts = (o: Record<string, unknown> = {}) => ({ sessionId: 'sess-1', countryCode: 'KWT', currencyCode: 'KWD', amount: '5.000', containerId: 'mf-form', paymentOptions: ['Card', 'ApplePay', 'GooglePay', 'STCPay', 'Bogus'], callback: () => {}, ...o });

  it('validates init and renders the frame with the options', () => {
    const w = load(js, '<div id="mf-form"></div>');
    expect(typeof w.myfatoorah.init).toBe('function');
    expect(() => w.myfatoorah.init(opts({ sessionId: '' }))).toThrow(/sessionId/);
    expect(() => w.myfatoorah.init(opts({ callback: null }))).toThrow(/callback/);
    expect(() => w.myfatoorah.init(opts({ containerId: 'missing' }))).toThrow(/containerId/);
    w.myfatoorah.init(opts());
    const f = w.document.querySelector('[data-testid="stubyard-mf-frame"]') as any;
    const u = new URL(f.getAttribute('src'));
    expect(u.origin + u.pathname).toBe(BASE + '/payment/v1/frame');
    expect(u.searchParams.get('origin')).toBe(SHOP);
    expect(u.searchParams.get('session')).toBe('sess-1');
    expect(u.searchParams.get('options')).toBe('Card,ApplePay,GooglePay,STCPay');
  });

  it('calls callback(response) from the frame only; submit() resolves with it; the wallet sheet answers the frame', async () => {
    const w = load(js, '<div id="mf-form"></div>');
    const callback = vi.fn();
    w.myfatoorah.init(opts({ callback }));
    const f = w.document.querySelector('iframe') as any;
    const sent = fakeWin(f);
    const response = { isSuccess: true, sessionId: 'sess-1', paymentType: 'Card', cardBrand: 'Visa' };
    fromFrame(w, f, { source: 'stubyard-mf', ch: chOf(f), type: 'callback', response }, 'http://evil.test');
    expect(callback).not.toHaveBeenCalled();
    const p = w.myfatoorah.submit();
    expect(sent.at(-1)).toEqual([expect.objectContaining({ type: 'submit', source: 'stubyard-mf-host' }), STUB]);
    fromFrame(w, f, { source: 'stubyard-mf', ch: chOf(f), type: 'callback', response });
    await expect(p).resolves.toEqual(response);
    expect(callback).toHaveBeenCalledWith(response);
    fromFrame(w, f, { source: 'stubyard-mf', ch: chOf(f), type: 'wallet', wallet: 'applepay', amount: '5.000 KWD' });
    const sheet = [...w.document.querySelectorAll('iframe')].find((x: any) => String(x.getAttribute('src')).includes('/stubyard-sdk/wallet')) as any;
    expect(sheet).toBeTruthy();
    const ws = new URL(sheet.getAttribute('src'));
    expect(ws.searchParams.get('origin')).toBe(SHOP);
    fakeWin(sheet);
    fromFrame(w, sheet, { source: 'stubyard-wallet', ch: ws.searchParams.get('ch'), type: 'wallet', result: 'approved' });
    expect(sent.at(-1)![0]).toMatchObject({ type: 'wallet-result', wallet: 'applepay', result: 'approved' });
  });

  it('the frame: TEST notice, method tiles, page origin only (EN and AR)', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderMfSessionFrame({ locale, origin: SHOP, ch: 'chtest', session: 'sess-1', amountText: '5.000 KWD', options: ['Card', 'ApplePay', 'GooglePay', 'STCPay'] });
      expect(html).toContain(TEST_NOTICE[locale]);
      expect(html).toContain(JSON.stringify(SHOP));
      expectNoWildcardPost(html);
    }
    expectNoWildcardPost(js);
  });

  it('the framed 3-D Secure return posts {sender: "MF-3DSecure", url} to the session origin only', () => {
    const r = (mfSession: unknown) =>
      mfSessionReturnPage({ payment: { providerData: { mfSession } }, kind: 'redirect', url: SHOP + '/cb?paymentId=1', view: { locale: 'en' }, host: 'stub.test', status: 'paid', result: { tone: 'ok', title: 'returning' } } as any);
    const html = r({ id: 's', origin: SHOP })!;
    expect(html).toContain("sender:'MF-3DSecure'");
    expect(html).toContain(JSON.stringify(SHOP));
    expect(html).toContain(TEST_NOTICE.en);
    expectNoWildcardPost(html);
    expect(r({ id: 's', origin: 'javascript:alert(1)' })).toContain('O=null');
    expect(mfSessionReturnPage({ payment: { providerData: {} }, kind: 'redirect' } as any)).toBeNull();
  });
});

describe('PayTabs managed form (window.paylib)', () => {
  const BASE = STUB + '/pay/p/pt';
  const js = paylibJs({ base: BASE, version: 'test' });
  const FORM = '<form id="payform" action="/pay" method="post"><span id="paymentErrors"></span><input type="text" data-paylib="number"><input data-paylib="expmonth"><input data-paylib="expyear"><input data-paylib="cvv"><button type="submit">Pay</button></form>';
  const fill = (w: Win, num: string, m = '12', y = String(new Date().getFullYear() + 2), cvv = '123') => {
    const q = (n: string) => w.document.querySelector('[data-paylib="' + n + '"]') as any;
    q('number').value = num;
    q('expmonth').value = m;
    q('expyear').value = y;
    q('cvv').value = cvv;
  };
  const submit = (w: Win) => w.document.getElementById('payform')!.dispatchEvent(new w.Event('submit', { cancelable: true }));

  it('needs a <form> with the four data-paylib inputs; adds the TEST notice to the form', () => {
    const w = load(js, FORM);
    expect(typeof w.paylib.inlineForm).toBe('function');
    expect(typeof w.paylib.handleError).toBe('function');
    expect(() => w.paylib.inlineForm({ key: 'CK1', form: w.document.body })).toThrow(/form/);
    w.paylib.inlineForm({ key: 'CK1', form: w.document.getElementById('payform'), callback: () => {} });
    expect(w.document.querySelector('#payform [data-testid="stubyard-sdk-badge"]')!.textContent).toBe(TEST_NOTICE.en);
    const w2 = load(js, '<form id="f"><input data-paylib="number"></form>');
    expect(() => w2.paylib.inlineForm({ key: 'CK1', form: 'f' })).toThrow(/data-paylib/);
  });

  it('tokenises card facts (never the digits), adds payment_token and submits', async () => {
    const calls: any[] = [];
    const w = load(js, FORM, (url, init) => {
      calls.push([url, init]);
      return json({ token: '2C4TOKEN' });
    });
    const submitted = vi.spyOn(w.HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    const callback = vi.fn();
    w.paylib.inlineForm({ key: 'CK1', form: w.document.getElementById('payform'), autoSubmit: true, callback });
    fill(w, '4111 1111 1111 1111');
    submit(w);
    await flush();
    expect(calls[0][0]).toBe(BASE + '/payment/js/token');
    const body = JSON.parse(calls[0][1].body);
    expect(body).toMatchObject({ key: 'CK1', first_six: '411111', card: { last4: '1111', test: true } });
    expect(calls[0][1].body).not.toContain('4111111111111111');
    expect((w.document.querySelector('input[name=payment_token]') as any).value).toBe('2C4TOKEN');
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ error: false, token: '2C4TOKEN' }));
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it('reports errors through callback / handleError and refuses a real card number without sending it', async () => {
    const calls: any[] = [];
    const w = load(js, FORM, (url, init) => {
      calls.push([url, init]);
      return json({}, 204);
    });
    const callback = vi.fn();
    w.paylib.inlineForm({ key: 'CK1', form: w.document.getElementById('payform'), callback });
    fill(w, '4111 1111 1111 1111', '13');
    submit(w);
    expect(callback.mock.calls[0][0]).toMatchObject({ error: true, errorCode: 'expiry_month' });
    w.paylib.handleError(w.document.getElementById('paymentErrors'), callback.mock.calls[0][0]);
    expect(w.document.getElementById('paymentErrors')!.textContent).toMatch(/month/);
    fill(w, '4539 1488 0343 6467');
    submit(w);
    await flush();
    expect(callback.mock.calls.at(-1)![0]).toMatchObject({ error: true, errorCode: 'card_number' });
    expect(calls.map((c) => c[0])).toEqual([BASE + '/payment/js/card-warning']);
    expect(String(calls[0][1].body)).not.toMatch(/\d{12}/);
    expect((w.document.querySelector('[data-paylib="number"]') as any).value).toBe('');
    expectNoWildcardPost(js);
  });
});

describe('APS Merchant Page (iframe)', () => {
  it('renders the card form with the TEST notice (EN and AR) and posts the facts to stubyard only', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderApsMerchantPage({ locale, session: 'sess', merchant: 'Shop', holder: 'A B' });
      expect(html).toContain(TEST_NOTICE[locale]);
      expect(html).toContain('data-layout="aps-merchant-page"');
      expect(html).toContain("fetch('merchantPage/token'");
      expect(html).not.toContain('postMessage');
      expect(html).not.toContain('document.referrer');
    }
    expect(typeof apsMerchantDemo).toBe('function');
  });
});
