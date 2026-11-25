/**
 * Login providers (fake OAuth 2.0 / OpenID Connect): per-preset shapes, issuer strategy, protocol rules
 * (code reuse, refresh rotation, prompt=none, lax vs strict), scenario rules, key rotation, Apple specifics,
 * export → import stability, control API and MCP tools.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';
import { decodeJwt, verifyJwt } from '../src/auth/jwt.js';

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
let dataDir: string;
let port: number;
const REDIRECT = 'http://app.test/callback';

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

/** Raw HTTP (no redirect following, Host header can be overridden). */
function req(method: string, p: string, o: { headers?: Record<string, string>; form?: Record<string, string>; json?: unknown; host?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    let body: string | undefined;
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.form) {
      body = new URLSearchParams(o.form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (o.json !== undefined) {
      body = JSON.stringify(o.json);
      headers['content-type'] = 'application/json';
    }
    headers.host = o.host ?? `127.0.0.1:${port}`;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let j: unknown = null;
        try {
          j = JSON.parse(t);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text: t, json: j });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const api = async (method: string, p: string, json?: unknown) => {
  const r = await req(method, p, { json });
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status}: ${r.text}`);
  return r.json;
};

const providers: Record<string, any> = {};
const pathOf = (u: string) => {
  const x = new URL(u);
  return x.pathname + x.search;
};
const urls = (slug: string) => providers[slug].urls.browser as Record<string, string>;

const verifier = () => crypto.randomBytes(32).toString('base64url');
const challenge = (v: string) => crypto.createHash('sha256').update(v).digest('base64url');

/** Start an authorization request and return the redirect (with code) — skipping the picker via login_hint. */
async function authorize(slug: string, q: Record<string, string>, headers: Record<string, string> = {}) {
  const u = new URL(urls(slug).authorize);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return req('GET', u.pathname + u.search, { headers });
}

function callback(r: Res): URLSearchParams {
  expect(r.status, r.text).toBe(302);
  const loc = new URL(String(r.headers.location));
  return loc.hash ? new URLSearchParams(loc.hash.slice(1)) : loc.searchParams;
}

async function codeFor(slug: string, user: string, extra: Record<string, string> = {}) {
  const v = verifier();
  const r = await authorize(slug, { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', scope: 'openid profile email', state: 'st-1', nonce: 'n-1', login_hint: user, code_challenge: challenge(v), code_challenge_method: 'S256', ...extra });
  const cb = callback(r);
  return { code: cb.get('code')!, state: cb.get('state'), verifier: v, cb };
}

async function exchange(slug: string, code: string, v: string | null, extra: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return req('POST', pathOf(urls(slug).token), {
    form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: 'app', client_secret: 'secret', ...(v ? { code_verifier: v } : {}), ...extra },
    headers,
  });
}

async function jwks(slug: string) {
  return (await req('GET', pathOf(urls(slug).jwks))).json.keys as Record<string, unknown>[];
}

async function verifyWith(slug: string, token: string) {
  const d = decodeJwt(token)!;
  const keys = await jwks(slug);
  const k = keys.find((x) => x.kid === d.header.kid);
  return k ? verifyJwt(token, k as never) : null;
}

describe.skipIf(!haveMailpit)('Login providers (fake OAuth / OIDC)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-auth-test-'));
    const [httpPort, httpsPort, smtpPort, mpHttp, mpSmtp] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    port = httpPort;
    running = await startHub(
      loadConfig({
        host: '127.0.0.1',
        httpPort,
        httpsPort,
        smtpPort,
        dataDir,
        webDir: path.join(dataDir, 'no-web'),
        mailpitBin: MAILPIT_BIN,
        mailpitUrl: `http://127.0.0.1:${mpHttp}`,
        mailpitSmtpHost: '127.0.0.1',
        mailpitSmtpPort: mpSmtp,
        spawnMailpit: true,
        logLevel: 'silent',
        timeoutHoldMs: 400,
        maintenanceIntervalMs: 0,
        publicUrl: `http://localhost:${httpPort}`,
      }),
      { logger: pino({ level: 'silent' }) },
    );
    await api('POST', '/api/projects', { name: 'QA', slug: 'qa', generateUsers: { admins: 1, customers: 3 } });
    for (const preset of ['google', 'microsoft', 'github', 'facebook', 'linkedin', 'apple', 'x', 'discord', 'gitlab', 'slack', 'oidc']) {
      providers[preset] = await api('POST', '/api/projects/qa/auth', { preset });
    }
    providers.keycloak = await api('POST', '/api/projects/qa/auth', { preset: 'keycloak' });
  }, 60_000);

  afterAll(async () => {
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists presets, rule actions and every provider with browser/backend URLs and snippets', async () => {
    const p = await api('GET', '/api/auth-presets');
    expect(p.presets.map((x: any) => x.id)).toEqual(['google', 'microsoft', 'github', 'facebook', 'linkedin', 'apple', 'x', 'discord', 'gitlab', 'slack', 'oidc']);
    expect(p.actions.transport).toContain('rate_limit');
    const list = await api('GET', '/api/projects/qa/auth');
    expect(list).toHaveLength(12);
    const g = list.find((x: any) => x.slug === 'google');
    expect(g.urls.browser.authorize).toBe(`http://localhost:${port}/auth/qa/google/o/oauth2/v2/auth`);
    expect(g.urls.backend.issuer).toMatch(/^https:\/\/stubyard:\d+\/auth\/qa\/google$/);
    expect(g.snippets.map((s: any) => s.title)).toEqual(expect.arrayContaining(['.env', 'openid-client (Node)', 'google-auth-library', 'Trust the stubyard CA (HTTPS issuers)']));
    expect(g.keys).toHaveLength(1);
    const kc = list.find((x: any) => x.slug === 'keycloak');
    expect(kc.preset).toBe('oidc');
    expect(kc.config.flavor).toBe('keycloak');
    const guide = await api('GET', '/api/projects/qa/setup');
    expect(guide.sections.some((s: any) => s.id === 'auth-google')).toBe(true);
  });

  it('discovery documents for every OIDC preset', async () => {
    const cases: [string, string, (b: string) => string][] = [
      ['google', '/.well-known/openid-configuration', (b) => b],
      ['linkedin', '/oauth/.well-known/openid-configuration', (b) => `${b}/oauth`],
      ['apple', '/.well-known/openid-configuration', (b) => b],
      ['gitlab', '/.well-known/openid-configuration', (b) => b],
      ['slack', '/.well-known/openid-configuration', (b) => b],
      ['oidc', '/.well-known/openid-configuration', (b) => b],
    ];
    for (const [slug, p, iss] of cases) {
      const base = `http://127.0.0.1:${port}/auth/qa/${slug}`;
      const r = await req('GET', `/auth/qa/${slug}${p}`);
      expect(r.status, slug).toBe(200);
      expect(r.headers['access-control-allow-origin']).toBe('*');
      expect(r.json.issuer, slug).toBe(iss(base));
      expect(r.json.authorization_endpoint.startsWith(`http://localhost:${port}/auth/qa/${slug}/`), slug).toBe(true);
      expect(r.json.token_endpoint.startsWith(base), slug).toBe(true);
      expect(r.json.jwks_uri.startsWith(base), slug).toBe(true);
      expect(r.json.authorization_response_iss_parameter_supported).toBe(false);
    }
    // Microsoft: tenant-specific issuer; "common" advertises the {tenantid} template.
    const tid = decodeJwt((await api('POST', '/api/projects/qa/auth/microsoft/token', { user: 'admin' })).id_token)!.payload.tid as string;
    const ms = await req('GET', `/auth/qa/microsoft/${tid}/v2.0/.well-known/openid-configuration`);
    expect(ms.json.issuer).toBe(`http://127.0.0.1:${port}/auth/qa/microsoft/${tid}/v2.0`);
    expect(ms.json.token_endpoint).toBe(`http://127.0.0.1:${port}/auth/qa/microsoft/${tid}/oauth2/v2.0/token`);
    const common = await req('GET', '/auth/qa/microsoft/common/v2.0/.well-known/openid-configuration');
    expect(common.json.issuer).toBe(`http://127.0.0.1:${port}/auth/qa/microsoft/{tenantid}/v2.0`);
    // Keycloak flavour uses its own paths.
    const kc = await req('GET', '/auth/qa/keycloak/.well-known/openid-configuration');
    expect(kc.json.token_endpoint).toMatch(/\/protocol\/openid-connect\/token$/);
    expect(kc.json.jwks_uri).toMatch(/\/protocol\/openid-connect\/certs$/);
  });

  it('google: picker, code + PKCE, id_token claims, userinfo, tokeninfo, refresh only with access_type=offline', async () => {
    const v = verifier();
    const r = await authorize('google', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', scope: 'openid email profile', state: 'abc', nonce: 'n1', code_challenge: challenge(v), code_challenge_method: 'S256' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.text).toContain('Fake Google · QA');
    expect(r.text).toContain('data-testid="stubyard-deny"');
    const users = (await api('GET', '/api/projects/qa/users')) as any[];
    const admin = users.find((u) => u.role === 'admin');
    expect(r.text).toContain(`data-testid="stubyard-user-${admin.id}"`);
    const reqId = /name="req" value="([^"]+)"/.exec(r.text)![1];
    const action = /<form method="post" action="([^"]+)"/.exec(r.text)![1];
    const cont = await req('POST', action, { form: { req: reqId, user: admin.id } });
    const cb = callback(cont);
    expect(cb.get('state')).toBe('abc');
    expect(cont.headers['set-cookie']?.[0]).toMatch(/^stubyard_sso_/);
    const t = await exchange('google', cb.get('code')!, v);
    expect(t.status, t.text).toBe(200);
    expect(t.json.access_token).toMatch(/^ya29\./);
    expect(t.json.token_type).toBe('Bearer');
    expect(t.json.expires_in).toBe(3599);
    expect(t.json.refresh_token).toBeUndefined();
    expect(t.json.scope).toContain('https://www.googleapis.com/auth/userinfo.email');
    const idt = await verifyWith('google', t.json.id_token);
    expect(idt).toBeTruthy();
    const c = idt!.payload;
    expect(c.iss).toBe(`http://127.0.0.1:${port}/auth/qa/google`);
    expect(c.aud).toBe('app');
    expect(c.azp).toBe('app');
    expect(String(c.sub)).toMatch(/^\d{21}$/);
    expect(c.email).toBe(admin.email);
    expect(c.email_verified).toBe(true);
    expect(c.nonce).toBe('n1');
    expect(c.at_hash).toBeTruthy();
    expect(c.given_name).toBeTruthy();
    const ui = await req('GET', pathOf(providers.google.urls.backendLocal.userinfo), { headers: { authorization: `Bearer ${t.json.access_token}` } });
    expect(ui.json).toMatchObject({ sub: c.sub, email: admin.email, email_verified: true });
    const legacy = await req('GET', '/auth/qa/google/oauth2/v2/userinfo', { headers: { authorization: `Bearer ${t.json.access_token}` } });
    expect(legacy.json).toMatchObject({ id: c.sub, verified_email: true });
    const ti = await req('GET', `/auth/qa/google/tokeninfo?id_token=${t.json.id_token}`);
    expect(ti.json.email_verified).toBe('true');
    const bad = await req('GET', '/auth/qa/google/v1/userinfo', { headers: { authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
    expect(bad.json.error_description).toBe('Invalid Credentials');
    // PEM certs map for google-auth-library
    const pem = await req('GET', '/auth/qa/google/oauth2/v1/certs');
    expect(Object.values(pem.json)[0]).toMatch(/BEGIN CERTIFICATE/);
    // access_type=offline → refresh token; refresh does not rotate
    const off = await codeFor('google', 'admin', { access_type: 'offline', scope: 'openid email' });
    const t2 = await exchange('google', off.code, off.verifier);
    expect(t2.json.refresh_token).toMatch(/^1\/\//);
    const rr = await req('POST', '/auth/qa/google/token', { form: { grant_type: 'refresh_token', refresh_token: t2.json.refresh_token, client_id: 'app', client_secret: 'secret' } });
    expect(rr.status).toBe(200);
    expect(rr.json.refresh_token).toBeUndefined();
    expect(rr.json.id_token).toBeTruthy();
    // revoke
    expect((await req('POST', '/auth/qa/google/revoke', { form: { token: rr.json.access_token } })).status).toBe(200);
    expect((await req('GET', '/auth/qa/google/v1/userinfo', { headers: { authorization: `Bearer ${rr.json.access_token}` } })).status).toBe(401);
    // SSO session cookie skips the picker; prompt=login forces it again
    const cookie = String(cont.headers['set-cookie']![0]).split(';')[0];
    const again = await authorize('google', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 's' }, { cookie });
    expect(again.status).toBe(302);
    const forced = await authorize('google', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 's', prompt: 'login' }, { cookie });
    expect(forced.status).toBe(200);
  });

  it('issuer strategy: request-host (backend Host stubyard, browser localhost) and fixed', async () => {
    const host = `stubyard:${port}`;
    const d = await req('GET', '/auth/qa/oidc/.well-known/openid-configuration', { host });
    expect(d.json.issuer).toBe(`http://stubyard:${port}/auth/qa/oidc`);
    expect(d.json.token_endpoint).toBe(`http://stubyard:${port}/auth/qa/oidc/token`);
    expect(d.json.authorization_endpoint).toBe(`http://localhost:${port}/auth/qa/oidc/authorize`);
    const { code, verifier: v } = await codeFor('oidc', 'customer1');
    const t = await req('POST', '/auth/qa/oidc/token', { host, form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: 'app', client_secret: 's', code_verifier: v } });
    expect(decodeJwt(t.json.id_token)!.payload.iss).toBe(d.json.issuer);

    const fixed = await api('POST', '/api/projects/qa/auth', { preset: 'oidc', slug: 'fixed', config: { issuerMode: 'fixed', issuer: 'https://host.docker.internal:4443' } });
    expect(fixed.urls.browser.issuer).toBe('https://host.docker.internal:4443/auth/qa/fixed');
    const fd = await req('GET', '/auth/qa/fixed/.well-known/openid-configuration', { host: 'whatever:1' });
    expect(fd.json.issuer).toBe('https://host.docker.internal:4443/auth/qa/fixed');
    expect(fd.json.authorization_endpoint).toBe('https://host.docker.internal:4443/auth/qa/fixed/authorize');
    // issOverride: literal iss
    await api('PATCH', '/api/projects/qa/auth/fixed', { config: { issOverride: 'https://accounts.google.com' } });
    const tok = await api('POST', '/api/projects/qa/auth/fixed/token', { user: 'admin' });
    expect(decodeJwt(tok.id_token)!.payload.iss).toBe('https://accounts.google.com');
    await api('DELETE', '/api/projects/qa/auth/fixed');
  });

  it('protocol: code reuse revokes tokens, PKCE / redirect / expiry are always enforced', async () => {
    const { code, verifier: v } = await codeFor('oidc', 'customer2');
    const t = await exchange('oidc', code, v);
    expect(t.status).toBe(200);
    const ok = await req('GET', '/auth/qa/oidc/userinfo', { headers: { authorization: `Bearer ${t.json.access_token}` } });
    expect(ok.status).toBe(200);
    const again = await exchange('oidc', code, v);
    expect(again.status).toBe(400);
    expect(again.json.error).toBe('invalid_grant');
    expect((await req('GET', '/auth/qa/oidc/userinfo', { headers: { authorization: `Bearer ${t.json.access_token}` } })).status).toBe(401);

    const c2 = await codeFor('oidc', 'customer2');
    expect((await exchange('oidc', c2.code, 'wrong-verifier')).json.error).toBe('invalid_grant');
    const c3 = await codeFor('oidc', 'customer2');
    expect((await exchange('oidc', c3.code, c3.verifier, { redirect_uri: 'http://evil.test/cb' })).json.error_description).toMatch(/redirect_uri/);
    // expiry: 1 s code lifetime
    await api('PATCH', '/api/projects/qa/auth/oidc', { config: { codeTtlSeconds: 1 } });
    const c4 = await codeFor('oidc', 'customer2');
    await new Promise((r) => setTimeout(r, 1100));
    expect((await exchange('oidc', c4.code, c4.verifier)).json.error_description).toMatch(/expired/);
    await api('PATCH', '/api/projects/qa/auth/oidc', { config: { codeTtlSeconds: null } });
  });

  it('protocol: refresh rotation; reusing a rotated refresh token revokes the family', async () => {
    const { code, verifier: v } = await codeFor('gitlab', 'customer1', { scope: 'openid profile email read_user' });
    const t = await exchange('gitlab', code, v);
    expect(t.json.refresh_token).toBeTruthy();
    expect(t.json.created_at).toBeTypeOf('number');
    const r1 = await req('POST', '/auth/qa/gitlab/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: t.json.refresh_token, client_id: 'app', client_secret: 's' } });
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).not.toBe(t.json.refresh_token);
    const reuse = await req('POST', '/auth/qa/gitlab/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: t.json.refresh_token, client_id: 'app', client_secret: 's' } });
    expect(reuse.json.error).toBe('invalid_grant');
    const r2 = await req('POST', '/auth/qa/gitlab/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: r1.json.refresh_token, client_id: 'app', client_secret: 's' } });
    expect(r2.json.error).toBe('invalid_grant');
    expect((await req('GET', '/auth/qa/gitlab/api/v4/user', { headers: { authorization: `Bearer ${r1.json.access_token}` } })).status).toBe(401);
  });

  it('protocol: prompt=none with and without a hint; stubyard_login_as cookie and autoLogin skip the picker', async () => {
    const none = await authorize('oidc', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 'x', prompt: 'none' });
    const cb = callback(none);
    expect(cb.get('error')).toBe('login_required');
    expect(cb.get('state')).toBe('x');
    const hinted = await authorize('oidc', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 'x', prompt: 'none', login_hint: 'admin' });
    expect(callback(hinted).get('code')).toBeTruthy();
    const cookie = await authorize('oidc', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 'x' }, { cookie: 'stubyard_login_as=customer3' });
    expect(callback(cookie).get('code')).toBeTruthy();
    await api('PATCH', '/api/projects/qa/auth/discord', { config: { autoLogin: 'customer1' } });
    const auto = await authorize('discord', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 'x', scope: 'identify email' });
    expect(callback(auto).get('code')).toBeTruthy();
    await api('PATCH', '/api/projects/qa/auth/discord', { config: { autoLogin: null } });
  });

  it('lax warnings vs strict errors', async () => {
    providers.strictp = await api('POST', '/api/projects/qa/auth', { preset: 'oidc', slug: 'strictp', config: { clients: [{ clientId: 'web', clientSecret: 'shh', redirectUris: [REDIRECT] }] } });
    // lax: unknown client + unregistered redirect → picker with warnings
    const lax = await req('GET', `/auth/qa/strictp/authorize?client_id=other&redirect_uri=${encodeURIComponent('http://x.test/cb')}&response_type=code&scope=openid`);
    expect(lax.status).toBe(200);
    expect(lax.text).toContain('stubyard-warnings');
    expect(lax.text).toMatch(/unknown client_id/);
    expect(lax.text).toMatch(/no state parameter/);
    // lax token: wrong secret accepted, recorded as warning
    const c = await (async () => {
      const r = await req('GET', `/auth/qa/strictp/authorize?client_id=web&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=openid&state=s&nonce=n&login_hint=admin`);
      return callback(r).get('code')!;
    })();
    const t = await req('POST', '/auth/qa/strictp/token', { form: { grant_type: 'authorization_code', code: c, redirect_uri: REDIRECT, client_id: 'web', client_secret: 'WRONG' } });
    expect(t.status).toBe(200);
    const w = await api('GET', '/api/projects/qa/auth/strictp/warnings');
    expect(w.some((x: any) => x.warnings.some((m: string) => /wrong client_secret/.test(m)))).toBe(true);
    // strict: same requests fail with the real error shapes
    await api('PATCH', '/api/projects/qa/auth/strictp', { config: { strict: true } });
    const s1 = await req('GET', `/auth/qa/strictp/authorize?client_id=other&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=openid&state=s&nonce=n`);
    expect(s1.status).toBe(400);
    expect(s1.text).toContain('Unknown client');
    const s2 = await authorize('strictp', { client_id: 'web', redirect_uri: REDIRECT, response_type: 'code', scope: 'openid', login_hint: 'admin' });
    expect(callback(s2).get('error')).toBe('invalid_request');
    const r3 = await req('GET', `/auth/qa/strictp/authorize?client_id=web&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=openid&state=s&nonce=n&login_hint=admin`);
    const c3 = callback(r3).get('code')!;
    const s3 = await req('POST', '/auth/qa/strictp/token', { form: { grant_type: 'authorization_code', code: c3, redirect_uri: REDIRECT, client_id: 'web', client_secret: 'WRONG' } });
    expect(s3.status).toBe(401);
    expect(s3.json.error).toBe('invalid_client');
    await api('DELETE', '/api/projects/qa/auth/strictp');
  });

  it('scenario rules: authorize actions (count semantics), header/query precedence', async () => {
    for (const action of ['access_denied', 'login_required', 'interaction_required', 'consent_required', 'mfa_required', 'server_error', 'temporarily_unavailable']) {
      await api('POST', '/api/projects/qa/auth/oidc/rules', { action, count: 1 });
      const r = await authorize('oidc', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 'st', login_hint: 'admin' });
      const cb = callback(r);
      expect(cb.get('error'), action).toBe(action === 'mfa_required' ? 'interaction_required' : action);
      expect(cb.get('state')).toBe('st');
      // count used up → next login works
      expect(callback(await authorize('oidc', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 'st', login_hint: 'admin' })).get('code'), action).toBeTruthy();
    }
    await api('POST', '/api/projects/qa/auth/oidc/users/admin/rules', { action: 'state_mismatch', count: 1 });
    const sm = callback(await authorize('oidc', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 'orig', login_hint: 'admin' }));
    expect(sm.get('code')).toBeTruthy();
    expect(sm.get('state')).not.toBe('orig');
    // user rule only hits that user
    await api('POST', '/api/projects/qa/auth/oidc/users/customer1/rules', { action: 'access_denied' });
    expect(callback(await authorize('oidc', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 's', login_hint: 'customer2' })).get('code')).toBeTruthy();
    expect(callback(await authorize('oidc', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 's', login_hint: 'customer1' })).get('error')).toBe('access_denied');
    // hub_scenario overrides the rule
    expect(callback(await authorize('oidc', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 's', login_hint: 'customer1', hub_scenario: 'server_error' })).get('error')).toBe('server_error');
    await api('DELETE', '/api/projects/qa/auth/oidc/users/customer1/rules');
    // after (skip) + expiry
    await api('POST', '/api/projects/qa/auth/oidc/rules', { action: 'access_denied', after: 1, count: 1 });
    expect(callback(await authorize('oidc', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 's', login_hint: 'admin' })).get('code')).toBeTruthy();
    expect(callback(await authorize('oidc', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 's', login_hint: 'admin' })).get('error')).toBe('access_denied');
    await api('POST', '/api/projects/qa/auth/oidc/rules', { action: 'access_denied', until: new Date(Date.now() - 1000).toISOString() });
    expect(callback(await authorize('oidc', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 's', login_hint: 'admin' })).get('code')).toBeTruthy();
    const rules = await api('GET', '/api/projects/qa/auth/oidc/rules');
    expect(rules.every((r: any) => !r.active)).toBe(true);
    await api('DELETE', '/api/projects/qa/auth/oidc/all-rules');
  });

  it('scenario rules: token, claim and token-defect actions', async () => {
    const run = async (action: string, extra: Record<string, unknown> = {}) => {
      await api('POST', '/api/projects/qa/auth/oidc/rules', { action, count: 1, stage: 'token', ...extra });
      const { code, verifier: v } = await codeFor('oidc', 'admin', { scope: 'openid profile email offline_access' });
      return exchange('oidc', code, v);
    };
    expect((await run('invalid_grant')).json.error).toBe('invalid_grant');
    expect((await run('expired_code')).json.error_description).toMatch(/expired/);
    const ic = await run('invalid_client');
    expect(ic.status).toBe(401);
    expect(ic.json.error).toBe('invalid_client');
    expect((await run('no_refresh_token')).json.refresh_token).toBeUndefined();
    const sl = await run('short_lived', { ttl: 1 });
    expect(sl.json.expires_in).toBe(1);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await req('GET', '/auth/qa/oidc/userinfo', { headers: { authorization: `Bearer ${sl.json.access_token}` } })).status).toBe(401);

    const ne = await run('no_email');
    expect(decodeJwt(ne.json.id_token)!.payload.email).toBeUndefined();
    const ui = await req('GET', '/auth/qa/oidc/userinfo', { headers: { authorization: `Bearer ${ne.json.access_token}` } });
    expect(ui.json.email).toBeUndefined();
    expect(decodeJwt((await run('email_unverified')).json.id_token)!.payload.email_verified).toBe(false);

    const bs = await run('bad_signature');
    expect(await verifyWith('oidc', bs.json.id_token)).toBeNull();
    expect(decodeJwt((await run('wrong_aud')).json.id_token)!.payload.aud).toBe('wrong-audience.stubyard.invalid');
    expect(decodeJwt((await run('wrong_iss')).json.id_token)!.payload.iss).toBe('https://wrong-issuer.stubyard.invalid');
    expect(decodeJwt((await run('wrong_nonce')).json.id_token)!.payload.nonce).not.toBe('n-1');
    const ex = decodeJwt((await run('expired_id_token')).json.id_token)!.payload;
    expect(Number(ex.exp)).toBeLessThan(Date.now() / 1000);
    const uk = await run('unknown_kid');
    const kids = (await jwks('oidc')).map((k) => k.kid);
    expect(kids).not.toContain(decodeJwt(uk.json.id_token)!.header.kid);

    // X-Hub-Scenario header at the token endpoint
    const { code, verifier: v } = await codeFor('oidc', 'admin');
    const hdr = await exchange('oidc', code, v, {}, { 'x-hub-scenario': 'wrong_aud,no_email' });
    const hc = decodeJwt(hdr.json.id_token)!.payload;
    expect(hc.aud).toBe('wrong-audience.stubyard.invalid');
    expect(hc.email).toBeUndefined();
    // private_email: GitHub hides the public email, Apple hands out a relay address
    await api('POST', '/api/projects/qa/auth/github/rules', { action: 'private_email', count: 1, stage: 'token' });
    const gh = await codeFor('github', 'admin', { scope: 'read:user user:email' });
    const ght = await req('POST', '/auth/qa/github/login/oauth/access_token', { form: { code: gh.code, client_id: 'app', client_secret: 's', code_verifier: gh.verifier }, headers: { accept: 'application/json' } });
    const ghu = await req('GET', '/auth/qa/github/user', { headers: { authorization: `token ${ght.json.access_token}` } });
    expect(ghu.json.email).toBeNull();
    const emails = await req('GET', '/auth/qa/github/user/emails', { headers: { authorization: `Bearer ${ght.json.access_token}` } });
    expect(emails.json[0]).toMatchObject({ primary: true, visibility: 'private' });
  });

  it('scenario rules: transport actions slow / timeout / down / rate_limit', async () => {
    await api('POST', '/api/projects/qa/auth/oidc/rules', { action: 'slow', delayMs: 300, count: 1, stage: 'jwks' });
    const t0 = Date.now();
    expect((await req('GET', '/auth/qa/oidc/jwks')).status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    await api('POST', '/api/projects/qa/auth/oidc/rules', { action: 'down', count: 1, stage: 'jwks' });
    expect((await req('GET', '/auth/qa/oidc/jwks')).status).toBe(503);
    await api('POST', '/api/projects/qa/auth/oidc/rules', { action: 'rate_limit', count: 1 });
    const rl = await req('GET', '/auth/qa/oidc/jwks');
    expect(rl.status).toBe(429);
    expect(rl.headers['retry-after']).toBe('60');
    await api('POST', '/api/projects/qa/auth/oidc/rules', { action: 'timeout', count: 1, stage: 'token' });
    const { code, verifier: v } = await codeFor('oidc', 'admin');
    await expect(exchange('oidc', code, v)).rejects.toThrow();
    // the code was not consumed by the timeout
    expect((await exchange('oidc', code, v)).status).toBe(200);
  });

  it('keys: rotation keeps the old key in JWKS unless dropOld', async () => {
    const before = await api('POST', '/api/projects/qa/auth/oidc/token', { user: 'admin' });
    const r = await api('POST', '/api/projects/qa/auth/oidc/keys/rotate', {});
    expect(r.keys).toHaveLength(2);
    expect(await verifyWith('oidc', before.id_token)).toBeTruthy();
    const after = await api('POST', '/api/projects/qa/auth/oidc/token', { user: 'admin' });
    expect(decodeJwt(after.id_token)!.header.kid).toBe(r.kid);
    await api('POST', '/api/projects/qa/auth/oidc/keys/rotate', { dropOld: true });
    expect(await jwks('oidc')).toHaveLength(1);
    expect(await verifyWith('oidc', before.id_token)).toBeNull();
  });

  it('apple: form_post, user JSON only on the first authorization, hide-my-email, client_secret JWT checks', async () => {
    const q = { client_id: 'com.example.web', redirect_uri: REDIRECT, response_type: 'code id_token', response_mode: 'form_post', scope: 'name email', state: 'as', nonce: 'an' };
    const picker = await authorize('apple', q);
    expect(picker.text).toContain('data-testid="stubyard-apple-hide"');
    const reqId = /name="req" value="([^"]+)"/.exec(picker.text)![1];
    const users = (await api('GET', '/api/projects/qa/users')) as any[];
    const c1 = users.find((u) => u.name && u.role !== 'admin');
    const first = await req('POST', '/auth/qa/apple/__hub/continue', { form: { req: reqId, user: c1.id, apple_email: 'hide' } });
    expect(first.status).toBe(200);
    expect(first.text).toContain(`action="${REDIRECT}"`);
    const field = (html: string, name: string) => /value="([^"]*)"/.exec(html.split(`name="${name}"`)[1] ?? '')?.[1]?.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const user = JSON.parse(field(first.text, 'user')!);
    expect(user.name.firstName).toBeTruthy();
    expect(user.email).toMatch(/@privaterelay\.appleid\.com$/);
    const idt = decodeJwt(field(first.text, 'id_token')!)!.payload;
    expect(String(idt.sub)).toMatch(/^\d{6}\.[0-9a-f]{32}\.\d{4}$/);
    expect(idt.is_private_email).toBe(true);
    expect(idt.nonce).toBe('an');
    // second authorization: no user field
    const again = await authorize('apple', { ...q, login_hint: c1.id });
    expect(again.text).not.toContain('name="user"');
    // reset consent → user again
    await api('PATCH', `/api/projects/qa/auth/apple/identities/${c1.id}`, { consented: false, claims: { hideEmail: false } });
    const third = await authorize('apple', { ...q, login_hint: c1.id });
    expect(JSON.parse(field(third.text, 'user')!).email).toBe(c1.email);
    // token: plain-string client_secret is a warning (lax)
    const code = field(third.text, 'code')!;
    const t = await req('POST', '/auth/qa/apple/auth/token', { form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: 'com.example.web', client_secret: 'not-a-jwt' } });
    expect(t.status).toBe(200);
    expect(t.json.refresh_token).toBeTruthy();
    expect(t.json.scope).toBeUndefined();
    const w = await api('GET', '/api/projects/qa/auth/apple/warnings');
    expect(w[0].warnings.join(' ')).toMatch(/client_secret must be a JWT/);
  });

  it('github: form-encoded and JSON token responses, 200 errors, /user and /user/emails', async () => {
    const { code, verifier: v } = await codeFor('github', 'admin', { scope: 'read:user,user:email' });
    const t = await req('POST', '/auth/qa/github/login/oauth/access_token', { form: { code, client_id: 'app', client_secret: 's', code_verifier: v } });
    expect(t.status).toBe(200);
    expect(t.headers['content-type']).toMatch(/application\/x-www-form-urlencoded/);
    const p = new URLSearchParams(t.text);
    expect(p.get('access_token')).toMatch(/^gho_/);
    expect(p.get('token_type')).toBe('bearer');
    expect(p.get('scope')).toBe('read:user,user:email');
    const u = await req('GET', '/auth/qa/github/user', { headers: { authorization: `token ${p.get('access_token')}` } });
    expect(u.json).toMatchObject({ type: 'User', site_admin: false });
    expect(typeof u.json.id).toBe('number');
    expect(u.json.login).toBeTruthy();
    expect(u.headers['x-oauth-scopes']).toBe('read:user, user:email');
    const e = await req('GET', '/auth/qa/github/api/v3/user/emails', { headers: { authorization: `Bearer ${p.get('access_token')}` } });
    expect(e.json[0]).toMatchObject({ primary: true, verified: true, visibility: 'public' });
    expect(e.json[1].email).toMatch(/@users\.noreply\.github\.com$/);
    expect((await req('GET', '/auth/qa/github/user', { headers: { authorization: 'token nope' } })).json.message).toBe('Bad credentials');
    const err = await req('POST', '/auth/qa/github/login/oauth/access_token', { form: { code, client_id: 'app', client_secret: 's' }, headers: { accept: 'application/json' } });
    expect(err.status).toBe(200);
    expect(err.json.error).toBe('bad_verification_code');
  });

  it('facebook: GET token exchange, /me?fields=, OAuthException errors, debug_token', async () => {
    const r = await authorize('facebook', { client_id: '1234', redirect_uri: REDIRECT, state: 'f', scope: 'public_profile,email', login_hint: 'admin' });
    const code = callback(r).get('code')!;
    const t = await req('GET', `/auth/qa/facebook/v19.0/oauth/access_token?client_id=1234&client_secret=s&redirect_uri=${encodeURIComponent(REDIRECT)}&code=${code}`);
    expect(t.json).toMatchObject({ token_type: 'bearer', expires_in: 5183944 });
    expect(t.json.access_token).toMatch(/^EAA/);
    const me = await req('GET', `/auth/qa/facebook/v19.0/me?fields=id,name,email,picture.type(large)&access_token=${t.json.access_token}`);
    expect(me.json.id).toMatch(/^\d{17}$/);
    expect(me.json.email).toBeTruthy();
    expect(me.json.picture.data.url).toBeTruthy();
    const def = await req('GET', '/auth/qa/facebook/me', { headers: { authorization: `Bearer ${t.json.access_token}` } });
    expect(Object.keys(def.json).sort()).toEqual(['id', 'name']);
    const reuse = await req('GET', `/auth/qa/facebook/oauth/access_token?client_id=1234&client_secret=s&redirect_uri=${encodeURIComponent(REDIRECT)}&code=${code}`);
    expect(reuse.status).toBe(400);
    expect(reuse.json.error).toMatchObject({ type: 'OAuthException', code: 100 });
    expect(reuse.json.error.fbtrace_id).toBeTruthy();
    const dbg = await req('GET', `/auth/qa/facebook/debug_token?input_token=${t.json.access_token}&access_token=1234|s`);
    expect(dbg.json.data).toMatchObject({ app_id: '1234', type: 'USER', is_valid: false });
    const bad = await req('GET', '/auth/qa/facebook/me?access_token=nope');
    expect(bad.json.error.code).toBe(190);
  });

  it('microsoft optionalClaims: email and xms_edov (#6)', async () => {
    const mint = async () => decodeJwt((await api('POST', '/api/projects/qa/auth/microsoft/token', { user: 'admin' })).id_token)!.payload;
    expect(await mint()).not.toHaveProperty('xms_edov');
    await api('PATCH', '/api/projects/qa/auth/microsoft', { config: { optionalClaims: ['email', 'xms_edov'] } });
    const on = await mint();
    expect(on.email).toBeTruthy();
    expect(on.xms_edov).toBe(true);
    const ident = await api('GET', '/api/projects/qa/auth/microsoft/identities/admin');
    await api('PATCH', '/api/projects/qa/auth/microsoft/identities/admin', { claims: { ...(ident.claims ?? {}), email_verified: false } });
    expect((await mint()).xms_edov).toBe(false);
    await api('PATCH', '/api/projects/qa/auth/microsoft/identities/admin', { claims: ident.claims ?? {} });
    await api('PATCH', '/api/projects/qa/auth/microsoft', { config: { optionalClaims: null } });
  });

  it('linkedin, microsoft, x, discord, slack and keycloak golden shapes', async () => {
    // LinkedIn
    const li = await codeFor('linkedin', 'admin', { scope: 'openid profile email' });
    const lt = await req('POST', '/auth/qa/linkedin/oauth/v2/accessToken', { form: { grant_type: 'authorization_code', code: li.code, redirect_uri: REDIRECT, client_id: 'app', client_secret: 's', code_verifier: li.verifier } });
    expect(lt.json.scope).toBe('openid,profile,email');
    expect(lt.json.refresh_token).toBeUndefined();
    expect(decodeJwt(lt.json.id_token)!.payload.iss).toBe(`http://127.0.0.1:${port}/auth/qa/linkedin/oauth`);
    const lu = await req('GET', '/auth/qa/linkedin/v2/userinfo', { headers: { authorization: `Bearer ${lt.json.access_token}` } });
    expect(lu.json.locale).toEqual({ country: 'US', language: 'en' });
    // basic auth is a warning for LinkedIn (client_secret_post only)
    // Microsoft
    const mr = await authorize('microsoft', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', scope: 'openid profile offline_access User.Read', state: 's', nonce: 'n', login_hint: 'admin' });
    const mcode = callback(mr).get('code')!;
    const mt = await req('POST', pathOf(urls('microsoft').token), { form: { grant_type: 'authorization_code', code: mcode, redirect_uri: REDIRECT, client_id: 'app', client_secret: 's', scope: 'openid profile offline_access User.Read' } });
    expect(mt.json.client_info).toBeTruthy();
    expect(mt.json.ext_expires_in).toBe(3600);
    expect(mt.json.refresh_token).toBeTruthy();
    const mid = decodeJwt(mt.json.id_token)!.payload;
    expect(mid).toMatchObject({ ver: '2.0' });
    expect(mid.tid).toMatch(/^[0-9a-f-]{36}$/);
    expect(decodeJwt(mt.json.access_token)!.payload.scp).toBe('User.Read');
    const me = await req('GET', '/auth/qa/microsoft/graph/v1.0/me', { headers: { authorization: `Bearer ${mt.json.access_token}` } });
    expect(me.json['@odata.context']).toMatch(/graph\.microsoft\.com/);
    expect(me.json.id).toBe(mid.oid);
    // Real Graph paths (one base URL for both hosts) answer like the /graph/... ones (#5)
    const bearer = { headers: { authorization: `Bearer ${mt.json.access_token}` } };
    const me2 = await req('GET', '/auth/qa/microsoft/v1.0/me', bearer);
    expect(me2.status).toBe(200);
    expect(me2.json).toEqual(me.json);
    const ui = await req('GET', '/auth/qa/microsoft/graph/oidc/userinfo', bearer);
    const ui2 = await req('GET', '/auth/qa/microsoft/oidc/userinfo', bearer);
    expect(ui2.status).toBe(200);
    expect(ui2.json).toEqual(ui.json);
    expect(ui2.json.sub).toBe(mid.sub);
    for (const path of ['/v1.0/me', '/oidc/userinfo']) {
      const bad = await req('GET', `/auth/qa/microsoft${path}`, { headers: { authorization: 'Bearer nope' } });
      expect(bad.status).toBe(401);
    }
    const merr = await req('POST', pathOf(urls('microsoft').token), { form: { grant_type: 'authorization_code', code: mcode, redirect_uri: REDIRECT, client_id: 'app', client_secret: 's' } });
    expect(merr.json.error_codes).toEqual([54005]);
    expect(merr.json.error_description).toMatch(/^AADSTS54005/);
    // X: PKCE required (lax warning without), Basic auth, /2/users/me
    const xr = await authorize('x', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', scope: 'tweet.read users.read offline.access', state: 's', login_hint: 'admin' });
    const xcode = callback(xr).get('code')!;
    const xt = await req('POST', '/auth/qa/x/2/oauth2/token', { form: { grant_type: 'authorization_code', code: xcode, redirect_uri: REDIRECT }, headers: { authorization: 'Basic ' + Buffer.from('app:s').toString('base64') } });
    expect(xt.json).toMatchObject({ token_type: 'bearer', expires_in: 7200 });
    expect(xt.json.refresh_token).toBeTruthy();
    const xu = await req('GET', '/auth/qa/x/2/users/me?user.fields=profile_image_url', { headers: { authorization: `Bearer ${xt.json.access_token}` } });
    expect(Object.keys(xu.json.data).sort()).toEqual(['id', 'name', 'profile_image_url', 'username']);
    const xw = await api('GET', '/api/projects/qa/auth/x/warnings');
    expect(xw.some((x: any) => x.warnings.some((m: string) => /requires PKCE/.test(m)))).toBe(true);
    // Discord
    const dr = await codeFor('discord', 'admin', { scope: 'identify email' });
    const dt = await req('POST', '/auth/qa/discord/api/oauth2/token', { form: { grant_type: 'authorization_code', code: dr.code, redirect_uri: REDIRECT, client_id: 'app', client_secret: 's', code_verifier: dr.verifier } });
    expect(dt.json).toMatchObject({ token_type: 'Bearer', expires_in: 604800, scope: 'identify email' });
    const du = await req('GET', '/auth/qa/discord/api/v10/users/@me', { headers: { authorization: `Bearer ${dt.json.access_token}` } });
    expect(du.json.id).toMatch(/^\d{18}$/);
    expect(du.json).toMatchObject({ discriminator: '0', verified: true });
    // Slack
    const sr = await codeFor('slack', 'admin', { scope: 'openid profile email' });
    const st = await req('POST', '/auth/qa/slack/api/openid.connect.token', { form: { code: sr.code, redirect_uri: REDIRECT, client_id: 'app', client_secret: 's', code_verifier: sr.verifier } });
    expect(st.json.ok).toBe(true);
    expect(st.json.access_token).toMatch(/^xoxp-/);
    const sid = decodeJwt(st.json.id_token)!.payload;
    expect(String(sid.sub)).toMatch(/^U[A-Z0-9]{10}$/);
    expect(sid['https://slack.com/team_id']).toMatch(/^T/);
    const su = await req('POST', '/auth/qa/slack/api/openid.connect.userInfo', { headers: { authorization: `Bearer ${st.json.access_token}` } });
    expect(su.json.ok).toBe(true);
    const serr = await req('POST', '/auth/qa/slack/api/openid.connect.token', { form: { code: sr.code, client_id: 'app', client_secret: 's' } });
    expect(serr.status).toBe(200);
    expect(serr.json).toMatchObject({ ok: false, error: 'invalid_code' });
    // Keycloak flavour: realm_access roles, client_credentials, introspection
    const kc = await codeFor('keycloak', 'admin', { scope: 'openid profile email' });
    const kt = await req('POST', '/auth/qa/keycloak/protocol/openid-connect/token', { form: { grant_type: 'authorization_code', code: kc.code, redirect_uri: REDIRECT, client_id: 'app', client_secret: 's', code_verifier: kc.verifier } });
    expect(decodeJwt(kt.json.access_token)!.payload.realm_access).toEqual({ roles: ['admin'] });
    expect(String(decodeJwt(kt.json.id_token)!.payload.sub)).toMatch(/^[0-9a-f-]{36}$/);
    const cc = await req('POST', '/auth/qa/keycloak/protocol/openid-connect/token', { form: { grant_type: 'client_credentials', client_id: 'svc', client_secret: 's' } });
    expect(decodeJwt(cc.json.access_token)!.payload.sub).toBe('svc');
    const intro = await req('POST', '/auth/qa/keycloak/protocol/openid-connect/token/introspect', { form: { token: kt.json.access_token } });
    expect(intro.json.active).toBe(true);
  });

  it('records auth traffic with resolved fields', async () => {
    const logs = await api('GET', '/api/logs?project=qa&q=/auth/qa/discord&limit=20');
    expect(logs.length).toBeGreaterThan(0);
    const detail = await api('GET', `/api/logs/${logs.find((l: any) => l.method === 'POST').id}`);
    expect(detail.resolved).toMatchObject({ kind: 'auth', project: 'qa', provider: 'discord', preset: 'discord', endpoint: 'token', clientId: 'app' });
    expect(detail.resolved.testUserIds).toHaveLength(1);
  });

  it('control API: token and code without a browser', async () => {
    const t = await api('POST', '/api/projects/qa/auth/google/token', { user: 'admin', clientId: 'cli', nonce: 'nn', claims: { custom: 1 } });
    expect(t.claims).toMatchObject({ aud: 'cli', nonce: 'nn', custom: 1 });
    expect(t.refresh_token).toBeTruthy();
    const c = await api('POST', '/api/projects/qa/auth/oidc/code', { user: 'customer1', clientId: 'app', redirectUri: REDIRECT, state: 'zz' });
    expect(c.redirectTo).toBe(`${REDIRECT}?code=${encodeURIComponent(c.code)}&state=zz`);
    const tok = await exchange('oidc', c.code, null);
    expect(tok.status).toBe(200);
    const ident = await api('GET', '/api/projects/qa/auth/oidc/identities/customer1');
    expect(ident.sub).toBe(decodeJwt(tok.json.id_token)!.payload.sub);
  });

  it('sign-out: Google /Logout, GitHub /logout, /__hub/logout and the control API end SSO sessions (#7)', async () => {
    const q = { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 's' };
    const signIn = async (slug: string) => {
      const r = await authorize(slug, { ...q, login_hint: 'admin' });
      expect(r.status, r.text).toBe(302);
      const c = ([] as string[]).concat(r.headers['set-cookie'] ?? []).find((x) => x.startsWith('stubyard_sso_'));
      expect(c).toBeTruthy();
      return c!.split(';')[0];
    };
    const skipsPicker = async (slug: string, cookie: string) => (await authorize(slug, q, { cookie })).status === 302;
    const cleared = (r: Res) => expect(([] as string[]).concat(r.headers['set-cookie'] ?? []).some((x) => /^stubyard_sso_[^=]+=;.*Max-Age=0/.test(x))).toBe(true);

    // every provider lists a sign-out URL; Google's discovery still has no end_session_endpoint
    const view = (await api('GET', '/api/projects/qa/auth')) as any[];
    const bySlug = Object.fromEntries(view.map((p) => [p.slug, p]));
    expect(bySlug.google.urls.browser.logout).toMatch(/\/auth\/qa\/google\/__hub\/logout$/);
    expect(bySlug.github.urls.browser.logout).toMatch(/\/auth\/qa\/github\/logout$/);
    expect(bySlug.microsoft.urls.browser.logout).toMatch(/\/oauth2\/v2\.0\/logout$/);
    for (const p of view) expect(p.urls.browser.logout).toBeTruthy();
    expect((await req('GET', '/auth/qa/google/.well-known/openid-configuration')).json).not.toHaveProperty('end_session_endpoint');

    // Google: real accounts.google.com/Logout with continue=
    let cookie = await signIn('google');
    expect(await skipsPicker('google', cookie)).toBe(true);
    const g = await req('GET', `/auth/qa/google/Logout?continue=${encodeURIComponent('http://app.test/signed-out')}`, { headers: { cookie } });
    expect(g.status).toBe(302);
    expect(g.headers.location).toBe('http://app.test/signed-out');
    cleared(g);
    expect(await skipsPicker('google', cookie)).toBe(false);

    // GitHub: github.com/logout without a target shows the Signed-out page
    cookie = await signIn('github');
    expect(await skipsPicker('github', cookie)).toBe(true);
    const gh = await req('GET', '/auth/qa/github/logout', { headers: { cookie } });
    expect(gh.status).toBe(200);
    expect(gh.headers['content-type']).toMatch(/text\/html/);
    cleared(gh);
    expect(await skipsPicker('github', cookie)).toBe(false);

    // Any preset answers /__hub/logout (GET and POST)
    cookie = await signIn('facebook');
    const fb = await req('POST', '/auth/qa/facebook/__hub/logout', { headers: { cookie }, form: { post_logout_redirect_uri: 'http://app.test/bye', state: 'x' } });
    expect(fb.status).toBe(302);
    expect(fb.headers.location).toBe('http://app.test/bye?state=x');
    cleared(fb);
    expect(await skipsPicker('facebook', cookie)).toBe(false);
    cookie = await signIn('slack');
    expect((await req('GET', '/auth/qa/slack/__hub/logout', { headers: { cookie } })).status).toBe(200);
    expect(await skipsPicker('slack', cookie)).toBe(false);

    // Control API: server-side revoke; the old cookie (still sent) no longer skips the picker
    const gc = await signIn('google');
    const lc = await signIn('linkedin');
    const all = await api('DELETE', '/api/projects/qa/auth/sessions');
    expect(all.revoked).toBeGreaterThanOrEqual(2);
    expect(await skipsPicker('google', gc)).toBe(false);
    expect(await skipsPicker('linkedin', lc)).toBe(false);
    expect((await api('DELETE', '/api/projects/qa/auth/sessions')).revoked).toBe(0);

    // per provider: only that provider's sessions end
    const gc2 = await signIn('google');
    const xc = await signIn('x');
    expect((await api('DELETE', '/api/projects/qa/auth/google/sessions')).revoked).toBe(1);
    expect(await skipsPicker('google', gc2)).toBe(false);
    expect(await skipsPicker('x', xc)).toBe(true);
    expect((await req('DELETE', '/api/projects/qa/auth/nope/sessions')).status).toBe(404);
    // the authorize that skipped the picker reused the browser's session instead of adding one
    expect((await api('DELETE', '/api/projects/qa/auth/x/sessions')).revoked).toBe(1);
  });

  it('signed-in users: list one provider sessions and sign out one test user', async () => {
    const q = { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 's' };
    const signIn = async (user: string) => {
      const r = await authorize('discord', { ...q, login_hint: user });
      expect(r.status, r.text).toBe(302);
      return ([] as string[]).concat(r.headers['set-cookie'] ?? []).find((x) => x.startsWith('stubyard_sso_'))!.split(';')[0];
    };
    const skipsPicker = async (cookie: string) => (await authorize('discord', q, { cookie })).status === 302;
    const listed = async () => (await api('GET', '/api/projects/qa/auth/discord/sessions')) as any[];
    await api('DELETE', '/api/projects/qa/auth/discord/sessions');
    expect(await listed()).toEqual([]);

    const ac = await signIn('admin');
    const cc = await signIn('customer2');
    const users = (await api('GET', '/api/projects/qa/users')) as any[];
    const admin = users.find((u) => u.role === 'admin');
    let rows = await listed();
    expect(rows).toHaveLength(2);
    // newest first, names / emails from the test users
    const c2 = rows[0];
    const customer2 = users.find((u) => u.id === c2.userId);
    expect(customer2.email.split('@')[0]).toBe('customer2');
    expect(c2).toMatchObject({ name: customer2.name, email: customer2.email, role: customer2.role, sessions: 1 });
    expect(c2.expiresAt > c2.signedInAt).toBe(true);
    expect(rows[1]).toMatchObject({ userId: admin.id, name: admin.name, email: admin.email });
    expect(((await api('GET', '/api/projects/qa/auth')) as any[]).find((p) => p.slug === 'discord').signedIn).toBe(2);

    // a picker-less re-authorize reuses the browser's session; a second browser adds one
    expect(await skipsPicker(ac)).toBe(true);
    rows = await listed();
    expect(rows.find((r) => r.userId === admin.id).sessions).toBe(1);
    await signIn('admin');
    rows = await listed();
    expect(rows.map((r) => r.userId)).toEqual([admin.id, c2.userId]);
    expect(rows[0].sessions).toBe(2);

    // sign out one user (by email here): the other stays signed in
    const del = await api('DELETE', `/api/projects/qa/auth/discord/sessions/${encodeURIComponent(admin.email)}`);
    expect(del.revoked).toBe(2);
    rows = await listed();
    expect(rows.map((r) => r.userId)).toEqual([c2.userId]);
    expect(await skipsPicker(ac)).toBe(false);
    expect(await skipsPicker(cc)).toBe(true);
    expect((await api('DELETE', `/api/projects/qa/auth/discord/sessions/${c2.userId}`)).revoked).toBe(1);
    expect(await listed()).toEqual([]);
    expect((await req('DELETE', '/api/projects/qa/auth/discord/sessions/nobody-here')).status).toBe(404);
  });

  it('repeat sign-ins reuse the SSO session; switching user replaces it', async () => {
    const q = { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', state: 's' };
    const ssoCookie = (r: Res) => ([] as string[]).concat(r.headers['set-cookie'] ?? []).find((x) => x.startsWith('stubyard_sso_'))?.split(';')[0];
    const listed = async () => (await api('GET', '/api/projects/qa/auth/discord/sessions')) as any[];
    const signedIn = async () => ((await api('GET', '/api/projects/qa/auth')) as any[]).find((p) => p.slug === 'discord').signedIn;
    await api('DELETE', '/api/projects/qa/auth/discord/sessions');
    const users = (await api('GET', '/api/projects/qa/users')) as any[];
    const admin = users.find((u) => u.role === 'admin');

    const first = await authorize('discord', { ...q, login_hint: 'admin' });
    expect(first.status, first.text).toBe(302);
    const cookie = ssoCookie(first)!;
    // same user again with the cookie (login_hint and session paths): same cookie value, still one session
    for (const extra of [{ login_hint: 'admin' }, {}] as Record<string, string>[]) {
      const again = await authorize('discord', { ...q, ...extra }, { cookie });
      expect(again.status, again.text).toBe(302);
      expect(ssoCookie(again)).toBe(cookie);
    }
    let rows = await listed();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: admin.id, sessions: 1 });
    expect(await signedIn()).toBe(1);

    // another user with the same cookie: the old session ends, a new cookie replaces it
    const other = await authorize('discord', { ...q, login_hint: 'customer2' }, { cookie });
    expect(other.status, other.text).toBe(302);
    const cookie2 = ssoCookie(other)!;
    expect(cookie2).not.toBe(cookie);
    rows = await listed();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).not.toBe(admin.id);
    expect(rows[0].sessions).toBe(1);
    expect(await signedIn()).toBe(1);
    expect((await authorize('discord', q, { cookie })).status).not.toBe(302);
    expect((await api('DELETE', '/api/projects/qa/auth/discord/sessions')).revoked).toBe(1);
  });

  it('sub stays the same after export → import', async () => {
    const before = await api('GET', '/api/projects/qa/auth/google/identities');
    const exp = await api('GET', '/api/projects/qa/export?secrets=1');
    expect(exp.authProviders.length).toBeGreaterThan(5);
    expect(exp.authKeys.length).toBeGreaterThan(5);
    const noSecrets = await api('GET', '/api/projects/qa/export');
    expect(noSecrets.authKeys).toBeUndefined();
    await api('POST', '/api/projects/import', { json: exp, slug: 'qa2', mode: 'create' });
    const after = await api('GET', '/api/projects/qa2/auth/google/identities');
    const byEmail = (l: any[]) => Object.fromEntries(l.map((i) => [i.user.email, i.sub]));
    expect(byEmail(after)).toEqual(byEmail(before));
    // same signing key (secrets were included)
    const k1 = (await api('GET', '/api/projects/qa/auth/google')).keys.map((k: any) => k.kid);
    const k2 = (await api('GET', '/api/projects/qa2/auth/google')).keys.map((k: any) => k.kid);
    expect(k2).toEqual(k1);
  });

  it('MCP tools: list, create, login_as, scenarios', async () => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await req('POST', '/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
      return r.json.result;
    };
    const tools = (await req('POST', '/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json.result.tools.map((t: any) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['list_login_providers', 'create_login_provider', 'login_as', 'set_login_scenario', 'reset_login_scenarios', 'sign_out_login_sessions', 'list_login_sessions']));
    const list = await call('list_login_providers', { project: 'qa' });
    expect(list.structuredContent.providers.some((p: any) => p.slug === 'google')).toBe(true);
    const tok = await call('login_as', { project: 'qa', provider: 'google', user: 'admin' });
    expect(tok.structuredContent.id_token).toBeTruthy();
    const cb = await call('login_as', { project: 'qa', provider: 'google', user: 'admin', redirect_uri: REDIRECT, state: 'm' });
    expect(cb.structuredContent.redirectTo).toContain('state=m');
    const sc = await call('set_login_scenario', { project: 'qa', provider: 'google', action: 'access_denied', user: 'admin', count: 1 });
    expect(sc.isError).toBeUndefined();
    const rs = await call('reset_login_scenarios', { project: 'qa', provider: 'google' });
    expect(rs.structuredContent.deleted).toBe(1);
    expect(typeof (await call('sign_out_login_sessions', { project: 'qa' })).structuredContent.revoked).toBe('number');
    await authorize('google', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', login_hint: 'admin' });
    await authorize('google', { client_id: 'app', redirect_uri: REDIRECT, response_type: 'code', login_hint: 'customer2' });
    const ls = await call('list_login_sessions', { project: 'qa', provider: 'google' });
    expect(ls.structuredContent.signedIn).toHaveLength(2);
    expect((await call('sign_out_login_sessions', { project: 'qa', provider: 'google', user: 'customer2' })).structuredContent.revoked).toBe(1);
    expect((await call('sign_out_login_sessions', { project: 'qa', user: 'admin' })).isError).toBe(true);
    expect((await call('sign_out_login_sessions', { project: 'qa', provider: 'google' })).structuredContent.revoked).toBe(1);
    const created = await call('create_login_provider', { project: 'qa', preset: 'auth0' });
    expect(created.structuredContent.config.flavor).toBe('auth0');
  });

  it('retention purges expired grants; unknown routes give helpful 404s', async () => {
    const purged = running.hub.auth.purgeExpired(Date.now() + 365 * 86_400_000);
    expect(purged).toBeGreaterThan(0);
    const r = await req('GET', '/auth/qa/google/nope');
    expect(r.status).toBe(404);
    expect(r.json.endpoints.length).toBeGreaterThan(3);
    const np = await req('GET', '/auth/qa/missing/x');
    expect(np.json.hint).toMatch(/POST \/api\/projects\/qa\/auth/);
    const pre = await req('OPTIONS', '/auth/qa/google/token', { headers: { origin: 'http://spa.test', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
  });
});
