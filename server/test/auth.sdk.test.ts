/**
 * Login providers × real client libraries, over HTTPS with stubyard's CA trusted (like NODE_EXTRA_CA_CERTS):
 *  - openid-client v6: discovery, authorization code + PKCE callback, userinfo, refresh — for every OIDC preset
 *  - jose: id_token verification against the remote JWKS (also across a key rotation)
 *  - google-auth-library: generateAuthUrl / getToken / verifyIdToken against /oauth2/v1/certs (custom endpoints + issuers)
 *  - @azure/msal-node: getAuthCodeUrl + acquireTokenByCode with protocolMode OIDC
 *  - a raw GitHub form-encoded code exchange
 *  - the @stubyard/client helpers (loginAs cookie, getTokens)
 *
 * Skip with STUBYARD_SDK_TESTS=0.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as client from 'openid-client';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { OAuth2Client } from 'google-auth-library';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';

const MAILPIT_BIN = process.env.STUBYARD_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
const setCa = (tls as unknown as { setDefaultCACertificates?: (c: string[]) => void }).setDefaultCACertificates;
const enabled = fs.existsSync(MAILPIT_BIN) && process.env.STUBYARD_SDK_TESTS !== '0' && !!setCa;

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
let api: string;
let httpsBase: string;
let restoreCa: (() => void) | null = null;
const REDIRECT = 'http://localhost:3000/callback';

async function j<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await fetch(api + p, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status}: ${t}`);
  return (t ? JSON.parse(t) : null) as T;
}

/** Follow the browser leg: GET the authorize URL (stubyard skips the picker via login_hint / cookie) → callback URL. */
async function browse(url: string | URL, cookie?: string): Promise<URL> {
  const r = await fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  if (r.status !== 302) throw new Error(`authorize → ${r.status}: ${await r.text()}`);
  return new URL(r.headers.get('location')!);
}

describe.skipIf(!enabled)('Login providers × client libraries (openid-client, jose, google-auth-library, msal-node)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-auth-sdk-'));
    const [httpPort, httpsPort, smtpPort, mpHttp, mpSmtp] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
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
        maintenanceIntervalMs: 0,
        publicUrl: `https://localhost:${httpsPort}`,
      }),
      { logger: pino({ level: 'silent' }) },
    );
    const before = tls.getCACertificates('default');
    setCa!([...before, running.hub.tls!.caCertPem]);
    restoreCa = () => setCa!(before);
    api = `http://127.0.0.1:${httpPort}`;
    httpsBase = `https://localhost:${httpsPort}`;
    await j('POST', '/api/projects', { name: 'SDK', slug: 'sdk', generateUsers: { admins: 1, customers: 2 } });
    for (const preset of ['oidc', 'google', 'gitlab', 'linkedin', 'slack', 'microsoft', 'github', 'keycloak', 'auth0']) {
      await j('POST', '/api/projects/sdk/auth', { preset, config: { clients: [{ clientId: 'app', clientSecret: 'secret', redirectUris: [REDIRECT] }] } });
    }
  }, 60_000);

  afterAll(async () => {
    restoreCa?.();
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const issuerOf = async (slug: string) => (await j('GET', `/api/projects/sdk/auth/${slug}`)).urls.browser.issuer as string;

  for (const slug of ['oidc', 'google', 'gitlab', 'linkedin', 'slack', 'microsoft', 'keycloak', 'auth0']) {
    it(`openid-client: discovery, code + PKCE, userinfo${['linkedin', 'slack'].includes(slug) ? '' : ', refresh'} (${slug})`, async () => {
      const issuer = await issuerOf(slug);
      const config = await client.discovery(new URL(issuer), 'app', 'secret');
      expect(config.serverMetadata().issuer).toBe(issuer);
      const verifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      const scope = slug === 'microsoft' ? 'openid profile email offline_access User.Read' : slug === 'linkedin' || slug === 'slack' ? 'openid profile email' : 'openid profile email offline_access';
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: REDIRECT,
        scope: slug === 'google' ? 'openid profile email' : scope,
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        state,
        nonce,
        login_hint: 'admin',
        ...(slug === 'google' ? { access_type: 'offline' } : {}),
      });
      expect(url.origin).toBe(httpsBase);
      const cb = await browse(url);
      const tokens = await client.authorizationCodeGrant(config, cb, { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce });
      const claims = tokens.claims()!;
      expect(claims.iss).toBe(issuer);
      expect(claims.aud).toBe('app');
      const info = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
      expect(info.sub).toBe(claims.sub);
      if (!['linkedin', 'slack'].includes(slug)) {
        expect(tokens.refresh_token).toBeTruthy();
        const refreshed = await client.refreshTokenGrant(config, tokens.refresh_token!);
        expect(refreshed.access_token).not.toBe(tokens.access_token);
        expect(refreshed.claims()?.sub).toBe(claims.sub);
      }
    });
  }

  it('jose: verifies id_tokens against the remote JWKS, before and after a key rotation', async () => {
    const issuer = await issuerOf('google');
    const { jwks_uri } = (await (await fetch(`${issuer}/.well-known/openid-configuration`)).json()) as { jwks_uri: string };
    const before = await j('POST', '/api/projects/sdk/auth/google/token', { user: 'admin', clientId: 'app', baseUrl: httpsBase });
    const JWKS = createRemoteJWKSet(new URL(jwks_uri));
    const { payload } = await jwtVerify(before.id_token, JWKS, { issuer, audience: 'app' });
    expect(payload.email).toBeTruthy();
    await j('POST', '/api/projects/sdk/auth/google/keys/rotate', {});
    const after = await j('POST', '/api/projects/sdk/auth/google/token', { user: 'admin', clientId: 'app', baseUrl: httpsBase });
    const fresh = createRemoteJWKSet(new URL(jwks_uri));
    await expect(jwtVerify(after.id_token, fresh, { issuer, audience: 'app' })).resolves.toBeTruthy();
    await expect(jwtVerify(before.id_token, fresh, { issuer, audience: 'app' })).resolves.toBeTruthy();
    // defects are caught by a real verifier
    const bad = await j('POST', '/api/projects/sdk/auth/google/token', { user: 'admin', clientId: 'app', baseUrl: httpsBase, scenario: 'bad_signature' });
    await expect(jwtVerify(bad.id_token, fresh, { issuer, audience: 'app' })).rejects.toThrow(/signature/);
    const aud = await j('POST', '/api/projects/sdk/auth/google/token', { user: 'admin', clientId: 'app', baseUrl: httpsBase, scenario: 'wrong_aud' });
    await expect(jwtVerify(aud.id_token, fresh, { issuer, audience: 'app' })).rejects.toThrow(/aud/);
  });

  it('google-auth-library: generateAuthUrl → getToken → verifyIdToken (PEM certs)', async () => {
    const b = `${httpsBase}/auth/sdk/google`;
    const oauth = new OAuth2Client({
      clientId: 'app',
      clientSecret: 'secret',
      redirectUri: REDIRECT,
      endpoints: {
        oauth2AuthBaseUrl: `${b}/o/oauth2/v2/auth`,
        oauth2TokenUrl: `${b}/token`,
        oauth2RevokeUrl: `${b}/revoke`,
        oauth2FederatedSignonPemCertsUrl: `${b}/oauth2/v1/certs`,
        oauth2FederatedSignonJwkCertsUrl: `${b}/oauth2/v3/certs`,
        tokenInfoUrl: `${b}/tokeninfo`,
      },
      issuers: [b],
    });
    const url = oauth.generateAuthUrl({ access_type: 'offline', scope: ['openid', 'email', 'profile'], login_hint: 'customer1', state: 'g' });
    const cb = await browse(url);
    const { tokens } = await oauth.getToken(cb.searchParams.get('code')!);
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.access_token).toMatch(/^ya29\./);
    const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token!, audience: 'app' });
    const payload = ticket.getPayload()!;
    const users = await j<any[]>('GET', '/api/projects/sdk/users');
    expect(payload.email).toBe(users.find((u) => u.role !== 'admin').email);
    expect(payload.iss).toBe(b);
    const info = await oauth.getTokenInfo(tokens.access_token!);
    expect(info.aud).toBe('app');
  });

  it('@azure/msal-node: acquireTokenByCode with protocolMode OIDC', async () => {
    const issuer = await issuerOf('microsoft');
    const host = new URL(issuer).host;
    const msal = new ConfidentialClientApplication({
      auth: { clientId: 'app', clientSecret: 'secret', authority: issuer, knownAuthorities: [host] },
      system: { protocolMode: 'OIDC' as never },
    });
    const url = await msal.getAuthCodeUrl({ scopes: ['User.Read'], redirectUri: REDIRECT, loginHint: 'admin', state: 'm' });
    const cb = await browse(url);
    const result = await msal.acquireTokenByCode({ code: cb.searchParams.get('code')!, scopes: ['User.Read'], redirectUri: REDIRECT });
    expect(result.accessToken).toBeTruthy();
    expect(result.idTokenClaims).toMatchObject({ ver: '2.0', aud: 'app' });
    expect(result.account?.username).toBeTruthy();
    const me = await fetch(`${httpsBase}/auth/sdk/microsoft/graph/v1.0/me`, { headers: { authorization: `Bearer ${result.accessToken}` } });
    expect((await me.json()).displayName).toBeTruthy();
  });

  it('raw GitHub: form-encoded code exchange and /user', async () => {
    const b = `${httpsBase}/auth/sdk/github`;
    const cb = await browse(`${b}/login/oauth/authorize?client_id=app&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=read:user%20user:email&state=gh&login=admin`);
    expect(cb.searchParams.get('state')).toBe('gh');
    const res = await fetch(`${b}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: 'app', client_secret: 'secret', code: cb.searchParams.get('code')!, redirect_uri: REDIRECT }),
    });
    const form = new URLSearchParams(await res.text());
    expect(form.get('token_type')).toBe('bearer');
    const user = await (await fetch(`${b}/user`, { headers: { authorization: `token ${form.get('access_token')}`, accept: 'application/vnd.github+json' } })).json();
    expect(user.login).toBe('admin');
  });

  it('@stubyard/client: loginAs sets the cookie that skips the picker; getTokens', async () => {
    // Dynamic import: the helper lives in the packages/client workspace (outside this tsconfig's rootDir).
    const helperPath: string = new URL('../../packages/client/src/auth.ts', import.meta.url).pathname;
    const mod = (await import(helperPath)) as any;
    const jar: { name: string; value: string; domain?: string; path?: string }[] = [];
    await mod.loginAs({ addCookies: async (c: typeof jar) => void jar.push(...c) }, { baseUrl: httpsBase, project: 'sdk', provider: 'oidc', user: 'customer2' });
    expect(jar[0]).toMatchObject({ name: 'stubyard_login_as', domain: 'localhost', path: '/auth/sdk/oidc' });
    const issuer = await issuerOf('oidc');
    const cb = await browse(`${issuer}/authorize?client_id=app&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=openid&state=c`, `${jar[0].name}=${jar[0].value}`);
    expect(cb.searchParams.get('code')).toBeTruthy();
    const t = await mod.getTokens({ apiUrl: api, project: 'sdk', provider: 'oidc', user: 'customer2', clientId: 'app' });
    expect(t.id_token).toBeTruthy();
    const c = await mod.getAuthorizationCode({ apiUrl: api, project: 'sdk', provider: 'oidc', user: 'customer2', redirectUri: REDIRECT, state: 's' });
    expect(c.redirectTo).toContain('state=s');
  });
});
