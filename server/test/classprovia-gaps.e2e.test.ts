import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Hub } from '../src/hub.js';
import { startHub, type RunningHub } from '../src/index.js';
import { cardBrand, describeCard } from '../src/payments/engine.js';

/**
 * Problems found while testing Class PROvia with storyboards (docs/stubyard/STUBYARD-GAPS.md in that app):
 * 1. email steps: `since` (look back to an earlier step's start: two mails sent by one action);
 * 2. {{vars.x}} rendered in target / capture / assert selectors and validated there;
 * 3. Moyasar invoice decline: Try again + Back to the merchant (back_url ?? success_url, status=failed);
 * 4. mada test cards (4201 32…) are "mada" on the page and on the payment;
 * 5. the payment page preselects the test user of the active walkthrough.
 */

const MAILPIT_BIN = process.env.STUBYARD_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
const haveMailpit = fs.existsSync(MAILPIT_BIN);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

let running: RunningHub;
let hub: Hub;
let base: string;
let dataDir: string;
let smtpPort: number;

async function call<T = any>(method: string, p: string, o: { json?: unknown; form?: Record<string, string> } = {}): Promise<{ status: number; body: T; text: string; headers: Headers }> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (o.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(o.json);
  } else if (o.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(o.form).toString();
  }
  const r = await fetch(base + p, { method, headers, body, redirect: 'manual' });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: r.status, body: parsed as T, text, headers: r.headers };
}
const ok = async <T = any>(method: string, p: string, json?: unknown, status = 200): Promise<T> => {
  const r = await call<T>(method, p, json === undefined ? {} : { json });
  expect(r.status, `${method} ${p}: ${r.text.slice(0, 400)}`).toBe(status);
  return r.body;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const unesc = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
/** href of the element with data-testid=… in a page. */
const hrefOf = (html: string, testid: string): string | null => {
  const m = new RegExp(`<a [^>]*href="([^"]*)"[^>]*data-testid="${testid}"`).exec(html);
  return m ? unesc(m[1]!) : null;
};
const selectedUser = (html: string): string | null => /<select [^>]*name="user"[^>]*>[\s\S]*?<\/select>/.exec(html)?.[0].match(/<option value="([^"]*)" selected/)?.[1] ?? null;

const P = 'gaps';
const PB = `/api/projects/${P}`;
const W = `${PB}/walkthroughs`;
const ORIGIN = 'http://app.test:3183';
const OTHER_ORIGIN = 'http://other.test:5000';
const M = `/pay/${P}/moyasar`;
let moy: { secretKey: string };
const basic = () => ({ authorization: 'Basic ' + Buffer.from(moy.secretKey + ':').toString('base64') });
const invoice = async (extra: Record<string, unknown> = {}) => {
  const r = await fetch(base + M + '/v1/invoices', { method: 'POST', headers: { 'content-type': 'application/json', ...basic() }, body: JSON.stringify({ amount: 5000, currency: 'SAR', description: 'Registration HCE27', ...extra }) });
  const body = (await r.json()) as any;
  expect(r.status, JSON.stringify(body)).toBe(201);
  const p = await ok('GET', `${PB}/payments/${encodeURIComponent(body.id)}`);
  return { inv: body, p };
};
const declineCard = { method: 'card', card_brand: 'visa', card_last4: '0109', card_magic: 'decline', card_luhn: '1', card_test: '1' };
const madaCard = { method: 'card', card_brand: 'mada', card_last4: '1010', card_magic: 'success', card_luhn: '1', card_test: '1' };

describe.skipIf(!haveMailpit)('Class PROvia gaps', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-gaps-'));
    const [httpPort, httpsPort, smtp, mpHttp, mpSmtp] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    smtpPort = smtp;
    const config = loadConfig({
      host: '127.0.0.1',
      httpPort,
      httpsPort,
      smtpPort,
      apnsPort: 0,
      dataDir,
      webDir: path.join(dataDir, 'no-web'),
      mailpitBin: MAILPIT_BIN,
      mailpitUrl: `http://127.0.0.1:${mpHttp}`,
      mailpitSmtpHost: '127.0.0.1',
      mailpitSmtpPort: mpSmtp,
      spawnMailpit: true,
      logLevel: 'silent',
      maintenanceIntervalMs: 0,
    });
    running = await startHub(config, { logger: pino({ level: 'silent' }) });
    hub = running.hub;
    base = `http://127.0.0.1:${httpPort}`;
    await ok('POST', '/api/projects', { name: 'Gaps', slug: P, generateUsers: { admins: 1, customers: 1 } }, 201);
    await ok('PATCH', PB, { settings: { appOrigins: [ORIGIN, OTHER_ORIGIN] } });
    await ok('POST', `${PB}/payment-instances`, { preset: 'moyasar', config: { webhookDelayMs: 0 } }, 201);
    moy = (await ok('GET', `${PB}/payment-instances/moyasar?secrets=1`)).config;
  });

  afterAll(async () => {
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------------------------------------ 1. email since
  describe('email step since', () => {
    const MAILS = {
      name: 'Pay and get two mails',
      actors: [{ key: 'participant', role: 'participant', fresh: true }],
      steps: [
        { id: 'open', kind: 'open', title: 'Open', intent: 'Open the payments page', url: '/payments' },
        { id: 'pay', kind: 'instruction', title: 'Pay', intent: 'Pay with the mada card' },
        { id: 'paid-mail', kind: 'email', actor: 'participant', title: 'Payment received', intent: 'The receipt', match: { subject: 'Payment received' }, open: 'none' },
        { id: 'confirmed-mail', kind: 'email', actor: 'participant', title: 'Confirmed', intent: 'The confirmation', match: { subject: 'Registration confirmed' }, open: 'none', since: 'pay' },
        { id: 'late-mail', kind: 'email', actor: 'participant', title: 'No since', intent: 'Default window', match: { subject: 'Registration confirmed' }, open: 'none' },
      ],
    };

    it('validates since: unknown id and a step that is not earlier are invalid_since errors', async () => {
      const bad = (since: string) => ({ ...MAILS, steps: MAILS.steps.map((s) => (s.id === 'confirmed-mail' ? { ...s, since } : s)) });
      const unknown = await ok('POST', `${PB}/storyboards/validate`, { storyboard: { slug: 'x', ...bad('nope') } });
      expect(unknown.ok).toBe(false);
      expect(unknown.errors).toEqual([expect.objectContaining({ path: 'steps[3].since', code: 'invalid_since', expected: ['open', 'pay', 'paid-mail'] })]);
      const later = await ok('POST', `${PB}/storyboards/validate`, { storyboard: { slug: 'x', ...bad('late-mail') } });
      expect(later.errors).toEqual([expect.objectContaining({ path: 'steps[3].since', code: 'invalid_since' })]);
      const self = await ok('POST', `${PB}/storyboards/validate`, { storyboard: { slug: 'x', ...bad('confirmed-mail') } });
      expect(self.errors.map((e: any) => e.code)).toEqual(['invalid_since']);
      const schema = await ok('POST', `${PB}/storyboards/validate`, { storyboard: { slug: 'x', ...bad('Not An Id') } });
      expect(schema.errors[0]).toMatchObject({ code: 'schema', path: 'steps[3].since' });
      const good = await ok('POST', `${PB}/storyboards/validate`, { storyboard: { slug: 'x', ...MAILS } });
      expect(good.errors).toEqual([]);
    });

    it('a second email step with since sees the mail that arrived with the first one', async () => {
      await ok('PUT', `${PB}/storyboards/two-mails`, { slug: 'two-mails', ...MAILS }, 201);
      const v = await ok('POST', W, { storyboard: 'two-mails', origin: ORIGIN }, 201);
      const R = (step: string) => ok('POST', `${W}/${v.id}/steps/${step}/resolve`, {});
      const done = (step: string) => ok('PATCH', `${W}/${v.id}/steps/${step}`, { status: 'done' });
      const to = v.actors.participant.email as string;
      await R('open');
      await done('open');
      await R('pay');
      await sleep(30);
      // One action, two mails at the same moment.
      const mailer = nodemailer.createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true });
      await mailer.sendMail({ from: 'noreply@app.test', to, subject: 'Payment received', text: 'Thanks.' });
      await mailer.sendMail({ from: 'noreply@app.test', to, subject: 'Your registration is confirmed', text: 'See you there.' });
      const user = v.actors.participant.userId as string;
      for (let i = 0; i < 100; i++) {
        const list = await ok('GET', `${PB}/messages?user=${user}&channel=email`);
        if (list.length >= 2) break;
        await sleep(50);
      }
      await done('pay');
      await sleep(30);
      const first = await R('paid-mail');
      expect(first.waitPath).toContain('since=');
      expect((await ok('GET', first.waitPath.replace('/messages/wait', '/messages'))).map((m: any) => m.subject)).toContain('Payment received');
      await done('paid-mail');
      await sleep(30);

      const view = await ok('GET', `${W}/${v.id}`);
      const payStarted = view.steps.find((s: any) => s.id === 'pay').startedAt as string;
      const second = await R('confirmed-mail');
      expect(new URL(second.waitPath, base).searchParams.get('since')).toBe(payStarted);
      const seen = (await ok('GET', second.waitPath.replace('/messages/wait', '/messages'))).map((m: any) => m.subject);
      expect(seen).toContain('Your registration is confirmed');
      // Stable across re-resolves.
      expect((await R('confirmed-mail')).waitPath).toBe(second.waitPath);
      await done('confirmed-mail');

      // Without since, the window opens at the previous step (after both mails): nothing is seen.
      await sleep(30);
      const late = await R('late-mail');
      expect(new URL(late.waitPath, base).searchParams.get('since')).not.toBe(payStarted);
      expect(await ok('GET', late.waitPath.replace('/messages/wait', '/messages'))).toEqual([]);
    });
  });

  // ------------------------------------------------------------------------------------------------ 2. selector vars
  describe('{{vars.x}} in selectors', () => {
    const SB = {
      name: 'Pay one registration',
      actors: [{ key: 'participant', role: 'participant', fresh: true }],
      steps: [
        { id: 'reg', kind: 'capture', title: 'Registration number', intent: 'Note it', var: 'regNo', textPattern: 'Registration number: (\\S+)' },
        { id: 'pay-bank', kind: 'instruction', title: 'Pay by bank transfer', intent: 'Choose bank transfer', target: { selector: '[data-testid="pay-bank-{{vars.regNo}}"]', text: 'Pay {{vars.regNo}}' } },
        { id: 'row', kind: 'capture', title: 'Amount', intent: 'Read the amount', var: 'amount', selector: '#row-{{vars.regNo}} .amount' },
        { id: 'paid', kind: 'check', title: 'Paid', intent: 'Paid', expect: 'The card says paid', target: { selector: '[data-testid="card-{{vars.regNo}}"]' }, assert: { selector: '[data-testid="paid-{{vars.regNo}}"]', urlMatches: '/payments/{{vars.regNo}}', textPresent: '{{vars.regNo}}' } },
      ],
    };

    it('renders target.selector / target.text, capture selector and assert selector / urlMatches', async () => {
      await ok('PUT', `${PB}/storyboards/pay-one`, { slug: 'pay-one', ...SB }, 201);
      const v = await ok('POST', W, { storyboard: 'pay-one', origin: ORIGIN }, 201);
      const R = (step: string) => ok('POST', `${W}/${v.id}/steps/${step}/resolve`, {});
      const reg = await R('reg');
      expect(reg.target).toBeNull();
      await ok('PATCH', `${W}/${v.id}/steps/reg`, { status: 'done', value: 'HCE27-R-00436' });
      const bank = await R('pay-bank');
      expect(bank.target).toEqual({ selector: '[data-testid="pay-bank-HCE27-R-00436"]', text: 'Pay HCE27-R-00436' });
      expect(bank.warnings).toEqual([]);
      // The stored step stays as written.
      expect(bank.step.target.selector).toBe('[data-testid="pay-bank-{{vars.regNo}}"]');
      expect((await R('row')).selector).toBe('#row-HCE27-R-00436 .amount');
      const paid = await R('paid');
      expect(paid.target).toEqual({ selector: '[data-testid="card-HCE27-R-00436"]', text: null });
      expect(paid.assert).toEqual({ textPresent: 'HCE27-R-00436', selector: '[data-testid="paid-HCE27-R-00436"]', urlMatches: '/payments/HCE27-R-00436' });
    });

    it('unknown or not yet captured variables in selectors are validation errors', async () => {
      const sb = {
        slug: 'bad-vars',
        name: 'Bad vars',
        actors: [{ key: 'participant', role: 'participant', fresh: true }],
        steps: [
          { id: 'a', kind: 'instruction', title: 'A', intent: 'A', target: { selector: '[data-x="{{vars.regNo}}"]' } },
          { id: 'reg', kind: 'capture', title: 'Reg', intent: 'Reg', var: 'regNo', textPattern: '(\\d+)' },
          { id: 'b', kind: 'instruction', title: 'B', intent: 'B', target: { text: 'Pay {{vars.nope}}' } },
          { id: 'c', kind: 'check', title: 'C', intent: 'C', expect: 'x', assert: { selector: '#{{bogus}}', urlMatches: '/r/{{vars.other}}' } },
          { id: 'd', kind: 'capture', title: 'D', intent: 'D', var: 'd', selector: '#x-{{vars.missing}}' },
        ],
      };
      const r = await ok('POST', `${PB}/storyboards/validate`, { storyboard: sb });
      expect(r.ok).toBe(false);
      const got = r.errors.map((e: any) => [e.path, e.code]);
      expect(got).toEqual(
        expect.arrayContaining([
          ['steps[0].target.selector', 'var_used_before_capture'],
          ['steps[2].target.text', 'var_not_captured'],
          ['steps[3].assert.selector', 'unknown_variable'],
          ['steps[3].assert.urlMatches', 'var_not_captured'],
          ['steps[4].selector', 'var_not_captured'],
        ]),
      );
      expect(got).toHaveLength(5);
      // A save is refused the same way.
      expect((await call('PUT', `${PB}/storyboards/bad-vars`, { json: sb })).status).toBe(400);
    });
  });

  // ------------------------------------------------------------------------------------------------ 3. Moyasar decline
  describe('Moyasar invoice decline', () => {
    it('declined card: stays on the invoice with Try again and Back to the merchant (back_url, status=failed); a retry pays', async () => {
      const { inv, p } = await invoice({ success_url: `${ORIGIN}/payments/online-return?payment=77`, back_url: `${ORIGIN}/payments/online-return?payment=77&cancelled=1` });
      // Classic complete route (the form's fallback) and the kit pay step both keep the page.
      const dec = await call('POST', `${M}/page/${p.id}/complete`, { form: { outcome: 'decline', ...declineCard } });
      expect(dec.status).toBe(402);
      expect(dec.text).toContain('data-testid="stubyard-error"');
      expect(dec.text).toContain('data-testid="stubyard-try-again"');
      expect(dec.text).not.toContain('stubyard-no-return');
      const back = new URL(hrefOf(dec.text, 'stubyard-back-merchant')!);
      expect(back.origin + back.pathname).toBe(`${ORIGIN}/payments/online-return`);
      expect(Object.fromEntries(back.searchParams)).toMatchObject({ payment: '77', cancelled: '1', id: inv.id, status: 'failed' });
      expect(back.searchParams.get('message')).toMatch(/Declined/);

      // Reloading the invoice page after the decline shows the same choices.
      const again = await call('GET', `${M}/page/${p.id}`);
      expect(again.status).toBe(200);
      expect(hrefOf(again.text, 'stubyard-back-merchant')).toBe(back.toString());

      // Kit pay step: the same page (200), then Try again with an approved mada card → success_url.
      const dec2 = await call('POST', `${M}/page/${p.id}/x/pay`, { form: { outcome: 'decline', ...declineCard } });
      expect(dec2.status).toBe(200);
      expect(hrefOf(dec2.text, 'stubyard-back-merchant')).toContain('status=failed');
      const paid = await call('POST', `${M}/page/${p.id}/x/pay`, { form: { outcome: 'success', ...madaCard } });
      expect(paid.status).toBe(303);
      const loc = new URL(paid.headers.get('location')!);
      expect(loc.pathname).toBe('/payments/online-return');
      expect(Object.fromEntries(loc.searchParams)).toMatchObject({ payment: '77', id: inv.id, status: 'paid' });
      const got = await (await fetch(base + M + '/v1/invoices/' + inv.id, { headers: basic() })).json() as any;
      expect(got.status).toBe('paid');
      expect(got.payments.at(-1).source.company).toBe('mada');
    });

    it('no back_url: Back to the merchant goes to success_url with status=failed; API payments stay final', async () => {
      const { inv, p } = await invoice({ success_url: `${ORIGIN}/done` });
      const dec = await call('POST', `${M}/page/${p.id}/x/pay`, { form: { outcome: 'decline', ...declineCard } });
      const back = new URL(hrefOf(dec.text, 'stubyard-back-merchant')!);
      expect(back.pathname).toBe('/done');
      expect(back.searchParams.get('id')).toBe(inv.id);
      expect(back.searchParams.get('status')).toBe('failed');

      // Neither URL: no link, the page still offers the form again.
      const bare = await invoice({});
      const d3 = await call('POST', `${M}/page/${bare.p.id}/x/pay`, { form: { outcome: 'decline', ...declineCard } });
      expect(d3.status).toBe(200);
      expect(d3.text).not.toContain('stubyard-back-merchant');
      expect(d3.text).toContain('data-testid="stubyard-pay"');

      // A payment created with source creditcard is final after a decline (no retry).
      const r = await fetch(base + M + '/v1/payments', { method: 'POST', headers: { 'content-type': 'application/json', ...basic() }, body: JSON.stringify({ amount: 1000, currency: 'SAR', callback_url: ORIGIN + '/cb', source: { type: 'creditcard', name: 'T B', number: '4123120001090109', month: 12, year: 2030, cvc: '123', '3ds': false } }) });
      expect(((await r.json()) as any).status).toBe('failed');
    });
  });

  // ------------------------------------------------------------------------------------------------ 4. mada
  describe('mada test cards', () => {
    it('4201 32… is mada by BIN, by the test-card list on the page, and on the payment', async () => {
      expect(cardBrand('4201320111111010')).toBe('mada');
      expect(cardBrand('4201321234411220')).toBe('mada');
      expect(describeCard('4201320111111010').brand).toBe('mada');
      expect(cardBrand('4111111111111111')).toBe('visa');
      const { p } = await invoice({ success_url: `${ORIGIN}/ok` });
      const page = await call('GET', `${M}/page/${p.id}`);
      // The kit form script: the test card's own brand first, then the BINs (with Moyasar's 420132).
      expect(page.text).toContain('if(tc&&tc.b)return tc.b');
      expect(page.text).toContain('"420132"');
      expect(page.text).toMatch(/\{"n":"4201320111111010","id":"success","b":"mada"\}/);
      // The hint line keeps its height (the Pay button does not move when it fills in).
      expect(page.text).toContain('#card-info{line-height:1.5;min-height:1.5em}');
      // API: a mada test card number → source.company mada.
      const r = await fetch(base + M + '/v1/payments', { method: 'POST', headers: { 'content-type': 'application/json', ...basic() }, body: JSON.stringify({ amount: 1000, currency: 'SAR', callback_url: ORIGIN + '/cb', source: { type: 'creditcard', name: 'T B', number: '4201320111111010', month: 12, year: 2030, cvc: '123', '3ds': false } }) });
      const body = (await r.json()) as any;
      expect(body.source.company).toBe('mada');
      // Hub complete API with the number: brand mada too.
      const q = await invoice({ success_url: `${ORIGIN}/ok` });
      const done = await ok('POST', `${PB}/payments/${q.p.id}/complete`, { outcome: 'success', method: 'card', card: '4201320111111010' });
      expect(done.payment).toMatchObject({ cardBrand: 'mada', cardLast4: '1010' });
    });
  });

  // ------------------------------------------------------------------------------------------------ 5. user preselect
  describe('payment page test user', () => {
    const SB = {
      name: 'Register and pay',
      actors: [
        { key: 'participant', role: 'participant', fresh: true },
        { key: 'admin', role: 'admin' },
      ],
      steps: [
        { id: 'open', kind: 'open', title: 'Open', intent: 'Open', url: '/payments' },
        { id: 'pay', kind: 'instruction', title: 'Pay', intent: 'Pay online' },
        { id: 'approve', kind: 'instruction', actor: 'admin', title: 'Approve', intent: 'Approve' },
      ],
    };

    it('preselects the current step actor of the matching active walkthrough; a manual choice stays', async () => {
      await ok('PUT', `${PB}/storyboards/pay-flow`, { slug: 'pay-flow', ...SB }, 201);
      // No walkthrough for this origin yet... (other storyboards above ran on ORIGIN; abandon them)
      for (const w of await ok('GET', `${W}?status=active&mode=all`)) await ok('DELETE', `${W}/${w.id}?force=1`);
      const none = await invoice({ success_url: `${ORIGIN}/ok` });
      expect(selectedUser((await call('GET', `${M}/page/${none.p.id}`)).text)).toBeNull();

      const mine = await ok('POST', W, { storyboard: 'pay-flow', origin: ORIGIN }, 201);
      await ok('POST', `${W}/${mine.id}/steps/pay/resolve`, {});
      const other = await ok('POST', W, { storyboard: 'pay-flow', origin: OTHER_ORIGIN }, 201);
      await ok('POST', `${W}/${other.id}/steps/approve/resolve`, {});
      const participant = mine.actors.participant.userId as string;

      // The payment returns to ORIGIN: the ORIGIN walkthrough (not the newer one), its current step's actor.
      const { p } = await invoice({ success_url: `${ORIGIN}/payments/online-return?payment=1` });
      expect(p.testUserId).toBeNull();
      const page = await call('GET', `${M}/page/${p.id}`);
      expect(selectedUser(page.text)).toBe(participant);

      // The other origin: that walkthrough's current step (approve) → admin.
      const o = await invoice({ success_url: `${OTHER_ORIGIN}/ok` });
      expect(selectedUser((await call('GET', `${M}/page/${o.p.id}`)).text)).toBe(other.actors.admin.userId);

      // metadata.stubyard_walkthrough names the run.
      const named = await invoice({ success_url: `${OTHER_ORIGIN}/ok`, metadata: { stubyard_walkthrough: mine.key } });
      expect(selectedUser((await call('GET', `${M}/page/${named.p.id}`)).text)).toBe(participant);

      // A manual choice (another user) is kept after a decline.
      const admin = await ok('GET', `${PB}/users/admin`);
      const dec = await call('POST', `${M}/page/${p.id}/x/pay`, { form: { outcome: 'decline', user: admin.id, ...declineCard } });
      expect(selectedUser(dec.text)).toBe(admin.id);

      // The kit pay step's own render (after a decline) and the classic route agree.
      const reload = await call('GET', `${M}/page/${p.id}`);
      expect(selectedUser(reload.text)).toBe(admin.id);
    });
  });
});
