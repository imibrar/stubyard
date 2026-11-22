import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderElementFrame, stripeJs } from '../src/payments/stripe/js.js';

/**
 * Contract tests of the fake Stripe.js v3 in happy-dom: Stripe(pk), elements() / create / mount / on, confirmPayment,
 * confirmCardPayment, the 3-D Secure modal, retrievePaymentIntent and initEmbeddedCheckout; messages only from and to
 * the stubyard origin; the TEST label inside each component; the element frame script (digits never posted).
 */

const STUB = 'http://stub.test';
const SHOP = 'http://shop.test';
const BASE = STUB + '/pay/p/stripe';
const PK = 'pk_test_abc';
const CS = 'pi_3abc_secret_xyz';
const TEST_EN = 'TEST · stubyard simulator · not a real payment, no money moves';

type Win = InstanceType<typeof Window> & Record<string, any>;
let wins: Win[] = [];

function load(html = '', fetchImpl?: (url: string, init?: any) => Promise<any>): Win {
  const w = new Window({ url: SHOP + '/checkout', settings: { disableIframePageLoading: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true, navigation: { disableChildFrameNavigation: true } } as any }) as Win;
  w.document.body.innerHTML = html;
  const f = fetchImpl ?? (() => Promise.reject(new Error('no network')));
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'location', 'fetch', 'self', 'setInterval', 'clearInterval', stripeJs({ base: BASE }))(w, w.document, w.location, f, w, w.setInterval.bind(w), w.clearInterval.bind(w));
  wins.push(w);
  return w;
}
const json = (v: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 402, json: () => Promise.resolve(v) });
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
const frameOf = (w: Win, sel = '[data-testid="stubyard-stripe-frame"]') => w.document.querySelector(sel) as any;
const srcOf = (f: any) => new URL(f.getAttribute('src'));
/** Mount an element and make its frame "ready". */
async function mounted(w: Win, type: string, opts: Record<string, unknown> = { clientSecret: CS }) {
  const stripe = w.Stripe(PK);
  const elements = stripe.elements(opts);
  const el = elements.create(type);
  const events: any[] = [];
  el.on('ready', (e: any) => events.push(['ready', e]));
  el.on('change', (e: any) => events.push(['change', e]));
  el.mount('#el');
  const f = frameOf(w);
  const sent = fakeWin(f);
  const ch = srcOf(f).searchParams.get('ch');
  fromFrame(w, f, { source: 'stubyard-stripe', ch, type: 'ready' });
  return { stripe, elements, el, f, sent, ch, events };
}
/** Answer the last request the page sent to the frame. */
function answerLast(w: Win, m: Awaited<ReturnType<typeof mounted>>, data: Record<string, unknown>) {
  const req = m.sent.filter(([x]) => x.id).pop()![0];
  fromFrame(w, m.f, { source: 'stubyard-stripe', ch: m.ch, type: 'answer', id: req.id, ...data });
  return req;
}

afterEach(async () => {
  for (const w of wins) await w.happyDOM.close();
  wins = [];
  vi.useRealTimers();
});

describe('fake Stripe.js: Stripe() and Elements', () => {
  it('Stripe(pk) with or without new; secret keys and unknown element types are IntegrationErrors', () => {
    const w = load('<div id="el"></div>');
    expect(typeof w.Stripe).toBe('function');
    expect(w.Stripe.stubyard).toBe(true);
    const s = w.Stripe(PK);
    expect(typeof s.elements).toBe('function');
    for (const fn of ['confirmPayment', 'confirmCardPayment', 'handleNextAction', 'retrievePaymentIntent', 'initEmbeddedCheckout', 'createPaymentMethod', 'createToken', 'paymentRequest', '_registerWrapper']) expect(typeof s[fn], fn).toBe('function');
    expect(new w.Stripe(PK)._key).toBe(PK);
    expect(() => w.Stripe('sk_test_123')).toThrow(/secret key/);
    expect(() => w.Stripe('')).toThrow(/publishable key/);
    const els = s.elements({ clientSecret: CS });
    expect(() => els.create('cardNumber')).toThrow(/cardNumber/);
    els.create('payment');
    expect(() => els.create('payment')).toThrow(/only create one/i);
    expect(els.getElement('payment')).toBeTruthy();
    expect(() => s.elements({ clientSecret: 'nope' })).toThrow(/clientSecret/);
    expect(() => s.elements({ mode: 'payment', currency: 'usd' })).toThrow(/amount/);
    expect(() => els.getElement('payment').mount('#missing')).toThrow(/applies to no DOM elements/);
  });

  it('mount: an SDK wrapper with the stubyard frame (origin + channel in the URL); TEST badge only for single-line elements', async () => {
    const w = load('<div id="el"></div><div id="el2"></div>');
    const m = await mounted(w, 'payment');
    const wrap = w.document.querySelector('#el .__PrivateStripeElement') as any;
    expect(wrap.getAttribute('data-type')).toBe('payment');
    expect(wrap.querySelector('[data-testid="stubyard-sdk-badge"]')).toBeNull();
    const u = srcOf(m.f);
    expect(u.origin + u.pathname).toBe(BASE + '/stripe-js/elements/payment');
    expect(u.searchParams.get('origin')).toBe(SHOP);
    expect(u.searchParams.get('ch')).toMatch(/^ch[0-9a-f]+$/);
    expect(m.events[0][0]).toBe('ready');
    const card = m.stripe.elements().create('card');
    card.mount('#el2');
    const badge = w.document.querySelector('#el2 .__PrivateStripeElement [data-testid="stubyard-sdk-badge"]') as any;
    expect(badge.textContent).toBe(TEST_EN);
  });

  it('change events only from the frame window on the stubyard origin and channel', async () => {
    const w = load('<div id="el"></div>');
    const m = await mounted(w, 'card', {});
    fromFrame(w, m.f, { source: 'stubyard-stripe', ch: m.ch, type: 'change', empty: false, complete: true, brand: 'visa' });
    fromFrame(w, m.f, { source: 'stubyard-stripe', ch: m.ch, type: 'change', complete: false }, 'http://evil.test');
    fromFrame(w, m.f, { source: 'stubyard-stripe', ch: 'other', type: 'change', complete: false });
    w.dispatchEvent(new w.MessageEvent('message', { data: { source: 'stubyard-stripe', ch: m.ch, type: 'change', complete: false }, origin: STUB, source: {} as any }));
    const changes = m.events.filter((e) => e[0] === 'change');
    expect(changes).toHaveLength(1);
    expect(changes[0][1]).toMatchObject({ elementType: 'card', complete: true, brand: 'visa' });
  });
});

describe('fake Stripe.js: confirming PaymentIntents', () => {
  it('confirmPayment needs return_url unless redirect if_required; the frame confirms and the result resolves', async () => {
    const w = load('<div id="el"></div>');
    const m = await mounted(w, 'payment');
    await expect(m.stripe.confirmPayment({ elements: m.elements })).rejects.toThrow(/return_url/);
    const p = m.stripe.confirmPayment({ elements: m.elements, redirect: 'if_required' });
    await flush();
    const req = answerLast(w, m, { paymentIntent: { id: 'pi_3abc', status: 'succeeded' } });
    expect(req).toMatchObject({ type: 'confirm', client_secret: CS, key: PK, source: 'stubyard-stripe-host', ch: m.ch });
    for (const [, o] of m.sent) expect(o).toBe(STUB);
    expect(await p).toEqual({ paymentIntent: { id: 'pi_3abc', status: 'succeeded' } });
  });

  it('confirmPayment with return_url sends the window there with payment_intent and redirect_status', async () => {
    const w = load('<div id="el"></div>');
    const assign = vi.fn();
    Object.defineProperty(w.location, 'assign', { configurable: true, value: assign });
    const m = await mounted(w, 'payment');
    m.stripe.confirmPayment({ elements: m.elements, confirmParams: { return_url: SHOP + '/done' } });
    await flush();
    answerLast(w, m, { paymentIntent: { id: 'pi_3abc', status: 'succeeded' } });
    await flush();
    expect(assign).toHaveBeenCalledTimes(1);
    const u = new URL(assign.mock.calls[0]![0]);
    expect(u.pathname).toBe('/done');
    expect(u.searchParams.get('payment_intent')).toBe('pi_3abc');
    expect(u.searchParams.get('payment_intent_client_secret')).toBe(CS);
    expect(u.searchParams.get('redirect_status')).toBe('succeeded');
  });

  it('a decline resolves { error } with the intent', async () => {
    const w = load('<div id="el"></div>');
    const m = await mounted(w, 'payment');
    const p = m.stripe.confirmPayment({ elements: m.elements, redirect: 'if_required' });
    await flush();
    answerLast(w, m, { error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } });
    expect((await p).error).toMatchObject({ type: 'card_error', code: 'card_declined' });
  });

  it('3-D Secure: requires_action opens the modal on the stubyard origin; 3ds-done retrieves the intent', async () => {
    const calls: string[] = [];
    const w = load('<div id="el"></div>', (url) => {
      calls.push(url);
      return json({ id: 'pi_3abc', status: 'succeeded' });
    });
    const m = await mounted(w, 'payment');
    const p = m.stripe.confirmPayment({ elements: m.elements, redirect: 'if_required' });
    await flush();
    answerLast(w, m, { paymentIntent: { id: 'pi_3abc', status: 'requires_action', next_action: { type: 'use_stripe_sdk', use_stripe_sdk: { type: 'three_d_secure_redirect', stripe_js: BASE + '/stripe-js/3ds/pi_3abc?client_secret=' + CS } } } });
    await flush();
    const ov = w.document.querySelector('[data-testid="stubyard-sdk-overlay"]') as any;
    expect(ov).toBeTruthy();
    const f = ov.querySelector('iframe');
    const u = srcOf(f);
    expect(u.pathname).toBe('/pay/p/stripe/stripe-js/3ds/pi_3abc');
    expect(u.searchParams.get('mode')).toBe('modal');
    expect(u.searchParams.get('origin')).toBe(SHOP);
    fakeWin(f);
    fromFrame(w, f, { source: 'stubyard-stripe-3ds', ch: u.searchParams.get('ch'), type: '3ds-done' }, 'http://evil.test');
    await flush();
    expect(w.document.querySelector('[data-testid="stubyard-sdk-overlay"]')).toBeTruthy();
    fromFrame(w, f, { source: 'stubyard-stripe-3ds', ch: u.searchParams.get('ch'), type: '3ds-done' });
    expect(await p).toEqual({ paymentIntent: { id: 'pi_3abc', status: 'succeeded' } });
    expect(w.document.querySelector('[data-testid="stubyard-sdk-overlay"]')).toBeNull();
    expect(calls[0]).toBe(BASE + '/v1/payment_intents/pi_3abc?key=' + PK + '&client_secret=' + CS);
  });

  it('deferred mode: confirmPayment before elements.submit() is an error; submit validates in the frame', async () => {
    const w = load('<div id="el"></div>');
    const m = await mounted(w, 'payment', { mode: 'payment', amount: 2000, currency: 'usd' });
    expect(srcOf(m.f).searchParams.get('amount')).toBe('2000');
    const early = await m.stripe.confirmPayment({ elements: m.elements, clientSecret: CS, redirect: 'if_required' });
    expect(early.error.code).toBe('elements_submit_required');
    const s = m.elements.submit();
    await flush();
    expect(answerLast(w, m, {}).type).toBe('validate');
    expect(await s).toEqual({});
    const p = m.stripe.confirmPayment({ elements: m.elements, clientSecret: CS, redirect: 'if_required' });
    await flush();
    answerLast(w, m, { paymentIntent: { id: 'pi_3abc', status: 'succeeded' } });
    expect((await p).paymentIntent.status).toBe('succeeded');
  });

  it('confirmCardPayment with a card Element or a payment method id; raw card objects are refused', async () => {
    const posts: [string, any][] = [];
    const w = load('<div id="el"></div>', (url, init) => {
      posts.push([url, init]);
      return json({ id: 'pi_3abc', status: 'succeeded' });
    });
    const m = await mounted(w, 'card', {});
    const p = m.stripe.confirmCardPayment(CS, { payment_method: { card: m.el, billing_details: { name: 'Jane' } } });
    await flush();
    expect(answerLast(w, m, { paymentIntent: { id: 'pi_3abc', status: 'succeeded' } }).params.billing_details).toEqual({ name: 'Jane' });
    expect((await p).paymentIntent.status).toBe('succeeded');
    const q = await m.stripe.confirmCardPayment(CS, { payment_method: 'pm_card_visa' });
    expect(q.paymentIntent.status).toBe('succeeded');
    expect(posts[0]![0]).toBe(BASE + '/v1/payment_intents/pi_3abc/confirm');
    expect(posts[0]![1].body).toContain('payment_method=pm_card_visa');
    await expect(m.stripe.confirmCardPayment(CS, { payment_method: { card: { number: '4242424242424242' } } })).rejects.toThrow(/card Element/);
    const ret = await m.stripe.retrievePaymentIntent(CS);
    expect(ret.paymentIntent.id).toBe('pi_3abc');
    expect((await m.stripe.confirmSetup({})).error.code).toBe('stubyard_not_simulated');
    expect(await m.stripe.paymentRequest({}).canMakePayment()).toBeNull();
  });
});

describe('fake Stripe.js: Embedded Checkout', () => {
  it('initEmbeddedCheckout → mount (the hosted page frame); complete calls onComplete or redirects; one at a time', async () => {
    const w = load('<div id="checkout"></div>');
    const assign = vi.fn();
    Object.defineProperty(w.location, 'assign', { configurable: true, value: assign });
    const s = w.Stripe(PK);
    const done = vi.fn();
    const ec = await s.initEmbeddedCheckout({ fetchClientSecret: () => Promise.resolve('cs_test_a1_secret_b2'), onComplete: done });
    await expect(s.initEmbeddedCheckout({ fetchClientSecret: () => Promise.resolve('cs_test_a1_secret_b2') })).rejects.toThrow(/multiple/);
    ec.mount('#checkout');
    const f = frameOf(w, '[data-testid="stubyard-stripe-checkout-frame"]');
    const u = srcOf(f);
    expect(u.pathname).toBe('/pay/p/stripe/c/pay/cs_test_a1');
    expect(u.searchParams.get('client_secret')).toBe('cs_test_a1_secret_b2');
    expect(u.searchParams.get('stubyard_origin')).toBe(SHOP);
    expect(u.searchParams.get('stubyard_mode')).toBe('embedded');
    const ch = u.searchParams.get('stubyard_sdk');
    fakeWin(f);
    fromFrame(w, f, { source: 'stubyard-stripe-checkout', ch, type: 'complete', redirect: null }, 'http://evil.test');
    expect(done).not.toHaveBeenCalled();
    fromFrame(w, f, { source: 'stubyard-stripe-checkout', ch, type: 'complete', redirect: null });
    expect(done).toHaveBeenCalledTimes(1);
    fromFrame(w, f, { source: 'stubyard-stripe-checkout', ch, type: 'complete', redirect: SHOP + '/ret?session_id=cs_test_a1' });
    expect(assign).toHaveBeenCalledWith(SHOP + '/ret?session_id=cs_test_a1');
    ec.destroy();
    expect(w.document.querySelector('[data-testid="stubyard-stripe-checkout-frame"]')).toBeNull();
    await expect(s.initEmbeddedCheckout({ fetchClientSecret: () => Promise.resolve('pi_3abc_secret_x') })).rejects.toThrow(/Checkout Session/);
    expect(await s.initEmbeddedCheckout({ clientSecret: 'cs_test_a2_secret_b3' })).toBeTruthy();
  });
});

describe('element frame script', () => {
  function frame(type: 'payment' | 'card') {
    const html = renderElementFrame({ type, locale: 'en', origin: SHOP, ch: 'chframe123456', amount: '20.00 USD' });
    const w = new Window({ url: BASE + '/stripe-js/elements/' + type, settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } as any }) as Win;
    w.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
    const posted: [any, string][] = [];
    const parent = { postMessage: (m: any, o: string) => posted.push([m, o]) };
    Object.defineProperty(w, 'parent', { configurable: true, get: () => parent });
    const fetches: [string, any][] = [];
    const f = (url: string, init: any) => {
      fetches.push([url, init]);
      return json({ paymentIntent: { id: 'pi_3abc', status: 'succeeded' } });
    };
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    // The element script is the last one (the banner script comes first).
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'location', 'fetch', 'self', scripts[scripts.length - 1]!)(w, w.document, w.location, f, w);
    wins.push(w);
    const send = (data: Record<string, unknown>) => w.dispatchEvent(new w.MessageEvent('message', { data: { source: 'stubyard-stripe-host', ch: 'chframe123456', ...data }, origin: SHOP, source: parent as any }));
    return { w, posted, fetches, send, html };
  }

  it('the payment frame has the TEST strip; the card frame has none (the page badge labels it)', () => {
    expect(frame('payment').html).toContain('data-testid="stubyard-test-banner"');
    expect(frame('card').html).not.toContain('data-testid="stubyard-test-banner"');
  });

  it('posts ready to the page origin only; a confirm sends card facts, never the digits', async () => {
    const fr = frame('payment');
    expect(fr.posted[0]).toEqual([expect.objectContaining({ type: 'ready', source: 'stubyard-stripe', ch: 'chframe123456' }), SHOP]);
    const d = fr.w.document;
    (d.getElementById('pan') as any).value = '4242 4242 4242 4242';
    (d.getElementById('exp') as any).value = '12 / 39';
    (d.getElementById('cvc') as any).value = '123';
    fr.send({ type: 'confirm', id: 'r1', key: PK, client_secret: CS, params: { return_url: SHOP + '/done' } });
    await flush();
    expect(fr.fetches).toHaveLength(1);
    expect(fr.fetches[0]![0]).toBe('../confirm');
    const body = JSON.parse(fr.fetches[0]![1].body);
    expect(body.card).toEqual({ brand: 'visa', last4: '4242', magicId: 'success', luhn: true, test: true });
    expect(fr.fetches[0]![1].body).not.toContain('424242424242');
    expect(fr.fetches[0]![1].body).not.toContain('"123"');
    const ans = fr.posted.find(([m]) => m.type === 'answer');
    expect(ans![0]).toMatchObject({ id: 'r1', paymentIntent: { status: 'succeeded' } });
    for (const [m, o] of fr.posted) {
      expect(o).toBe(SHOP);
      expect(JSON.stringify(m)).not.toContain('4242424242424242');
    }
  });

  it('an incomplete card answers a validation_error without calling stubyard; messages from other origins are ignored', async () => {
    const fr = frame('card');
    fr.send({ type: 'confirm', id: 'r2', key: PK, client_secret: CS });
    await flush();
    expect(fr.fetches).toHaveLength(0);
    expect(fr.posted.find(([m]) => m.type === 'answer')![0].error).toMatchObject({ type: 'validation_error', code: 'incomplete_number' });
    fr.w.dispatchEvent(new fr.w.MessageEvent('message', { data: { source: 'stubyard-stripe-host', ch: 'chframe123456', type: 'validate', id: 'x' }, origin: 'http://evil.test', source: (fr.w as any).parent }));
    await flush();
    expect(fr.posted.filter(([m]) => m.id === 'x')).toHaveLength(0);
  });
});
