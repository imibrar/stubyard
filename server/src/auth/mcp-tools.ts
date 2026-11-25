import { AUTH_ACTIONS, AUTH_STAGES } from '../repos/auth.js';
import { PRESET_LIST } from './presets/index.js';

/** MCP tools for login providers (appended to the TOOLS list in http/routes/mcp.ts). */
type Json = Record<string, unknown>;
interface AuthTool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  call?: (a: Json) => [string, string, unknown?];
  run?: (a: Json, ctx: { api: (method: string, url: string, body?: unknown) => Promise<any> }) => Promise<unknown>;
}

const s = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra });
const n = (description: string) => ({ type: 'number', description });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const enc = encodeURIComponent;
const PROJECT = s('stubyard project slug, e.g. "hyper"');
const PROVIDER = s('Login provider slug, e.g. "google" (see list_login_providers)');
const USER = s('Test user: id, email, name or role');
const base = (a: Json) => `/api/projects/${enc(String(a.project))}/auth`;

export const AUTH_MCP_TOOLS: AuthTool[] = [
  {
    name: 'list_login_providers',
    description: 'Fake login providers (Google, Microsoft, GitHub, Facebook, LinkedIn, Apple, X, Discord, GitLab, Slack, generic OIDC) of a project with their issuer / authorize / token URLs (browser and backend), clients and strict mode.',
    inputSchema: obj({ project: PROJECT }, ['project']),
    annotations: { readOnlyHint: true },
    run: async (a, { api }) => {
      const list = (await api('GET', base(a))) as Json[];
      return {
        providers: list.map((p) => ({
          slug: p.slug,
          preset: p.preset,
          name: p.name,
          enabled: p.enabled,
          strict: (p.config as Json)?.strict === true,
          clients: (p.config as Json)?.clients ?? [],
          urls: { browser: (p.urls as Json).browser, backend: (p.urls as Json).backend },
        })),
      };
    },
  },
  {
    name: 'create_login_provider',
    description:
      `Add a fake login provider to a project. preset: ${PRESET_LIST.map((p) => p.id).join(', ')} (auth0 / okta / keycloak / cognito = oidc with that flavor). ` +
      'config (optional): { clients:[{clientId, clientSecret, redirectUris}], strict, autoLogin, issuerMode:"request-host"|"fixed", issuer, issOverride, browserBaseUrl, flavor, extraClaims, audience, accessTokenFormat }.',
    inputSchema: obj({ project: PROJECT, preset: s('Preset id'), slug: s('URL slug (default: the preset id)'), name: s('Display name'), config: { type: 'object', description: 'Provider config' } }, ['project', 'preset']),
    call: (a) => ['POST', base(a), { preset: a.preset, slug: a.slug, name: a.name, config: a.config }],
  },
  {
    name: 'login_as',
    description:
      'Sign a test user in at a login provider without a browser. Without redirect_uri: returns tokens (access_token, id_token, refresh_token, claims) like the token endpoint would. ' +
      'With redirect_uri: returns an authorization code and the callback URL to open (redirectTo), so the app does the real code exchange.',
    inputSchema: obj(
      {
        project: PROJECT,
        provider: PROVIDER,
        user: USER,
        client_id: s('client_id (default: the first registered client)'),
        scope: s('Scopes (default: the preset default)'),
        nonce: s('nonce to put in the id_token'),
        redirect_uri: s('App callback URL: return a code + redirectTo instead of tokens'),
        state: s('state for the callback URL'),
        code_challenge: s('PKCE S256 challenge the app will verify with its code_verifier'),
        scenario: s('Scenario effects, e.g. "no_email", "wrong_aud", "short_lived=5"'),
      },
      ['project', 'provider', 'user'],
    ),
    run: async (a, { api }) => {
      const url = `${base(a)}/${enc(String(a.provider))}`;
      if (a.redirect_uri) {
        return api('POST', `${url}/code`, { user: a.user, clientId: a.client_id, redirectUri: a.redirect_uri, state: a.state, nonce: a.nonce, codeChallenge: a.code_challenge, scope: a.scope, scenario: a.scenario });
      }
      return api('POST', `${url}/token`, { user: a.user, clientId: a.client_id, scope: a.scope, nonce: a.nonce, scenario: a.scenario });
    },
  },
  {
    name: 'set_login_scenario',
    description:
      'Make the next login(s) at a provider fail or behave differently. With user: only that test user; without: everyone. count = next N times only, minutes = for a while. ' +
      `Actions: ${AUTH_ACTIONS.join(', ')}. stage: ${AUTH_STAGES.join(', ')} (default any).`,
    inputSchema: obj(
      {
        project: PROJECT,
        provider: PROVIDER,
        action: s('Scenario action', { enum: AUTH_ACTIONS }),
        user: USER,
        stage: s('Where it applies', { enum: [...AUTH_STAGES] }),
        count: n('Only the next N matching requests'),
        minutes: n('Only for this many minutes'),
        delay_ms: n('For slow'),
        ttl: n('For short_lived: access token lifetime in seconds'),
        label: s('Label shown in the dashboard'),
      },
      ['project', 'provider', 'action'],
    ),
    call: (a) => [
      'POST',
      a.user ? `${base(a)}/${enc(String(a.provider))}/users/${enc(String(a.user))}/rules` : `${base(a)}/${enc(String(a.provider))}/rules`,
      { action: a.action, stage: a.stage, count: a.count, minutes: a.minutes, delayMs: a.delay_ms, ttl: a.ttl, label: a.label },
    ],
  },
  {
    name: 'reset_login_scenarios',
    description: 'Remove login scenario rules: of one test user (user given) or all rules of the provider (provider-wide and every user).',
    inputSchema: obj({ project: PROJECT, provider: PROVIDER, user: USER }, ['project', 'provider']),
    call: (a) => ['DELETE', a.user ? `${base(a)}/${enc(String(a.provider))}/users/${enc(String(a.user))}/rules` : `${base(a)}/${enc(String(a.provider))}/all-rules`],
  },
  {
    name: 'list_login_sessions',
    description: 'Test users currently signed in at a login provider (live SSO sessions that skip the account picker), newest first: {signedIn:[{userId, name, email, sessions, signedInAt, expiresAt}]}.',
    inputSchema: obj({ project: PROJECT, provider: PROVIDER }, ['project', 'provider']),
    annotations: { readOnlyHint: true },
    run: async (a, { api }) => ({ signedIn: await api('GET', `${base(a)}/${enc(String(a.provider))}/sessions`) }),
  },
  {
    name: 'sign_out_login_sessions',
    description:
      'Sign test users out of the fake login providers server-side: revokes the SSO sessions (stubyard_sso_<provider> cookies) of one provider, or of every provider in the project when provider is omitted, so the next sign-in shows the account picker again. ' +
      'With user (needs provider): only that test user. Returns {revoked}.',
    inputSchema: obj({ project: PROJECT, provider: s('Login provider slug; omit to sign out of every provider in the project'), user: USER }, ['project']),
    run: async (a, { api }) => {
      if (a.user && !a.provider) throw new Error('"user" needs "provider"');
      const url = a.provider ? `${base(a)}/${enc(String(a.provider))}/sessions` : `${base(a)}/sessions`;
      return api('DELETE', a.user ? `${url}/${enc(String(a.user))}` : url);
    },
  },
];
