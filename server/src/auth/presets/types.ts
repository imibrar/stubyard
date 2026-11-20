import type { FastifyRequest } from 'fastify';
import type { Hub } from '../../hub.js';
import type { AuthGrant, AuthIdentity, AuthProvider, AuthProviderConfig } from '../../repos/auth.js';
import type { Project } from '../../repos/projects.js';
import type { TestUser } from '../../repos/users.js';

export type Endpoint =
  | 'discovery'
  | 'authorize'
  | 'token'
  | 'userinfo'
  | 'jwks'
  | 'certs_pem'
  | 'revoke'
  | 'introspect'
  | 'tokeninfo'
  | 'logout'
  | 'emails'
  | 'debug_token'
  | 'instance_discovery';

export interface PresetRoute {
  method: 'GET' | 'POST' | 'ANY';
  /** Matched against the path below the provider base (starts with "/"). Named groups become ctx.params. */
  path: RegExp;
  endpoint: Endpoint;
  /** Distinguishes endpoints of the same kind (e.g. Google /oauth2/v3/userinfo vs /v1/userinfo). */
  variant?: string;
  /** Handled by the preset's `extra` handler. */
  extra?: boolean;
}

/** A response a preset hands back to the service. */
export interface Out {
  status?: number;
  body?: unknown;
  /** Content type; default application/json. */
  type?: string;
  headers?: Record<string, string>;
}

/** Everything known about one request to a login provider. */
export interface Ctx {
  hub: Hub;
  project: Project;
  provider: AuthProvider;
  preset: PresetDef;
  cfg: AuthProviderConfig;
  req: FastifyRequest;
  endpoint: Endpoint | 'continue' | 'avatar';
  variant?: string;
  /** Named groups from the route regex (tenant, …). */
  params: Record<string, string>;
  /** Base URL (no trailing slash) for backend endpoints: token, userinfo, JWKS… */
  backend: string;
  /** Base URL for browser endpoints: authorize, logout. */
  browser: string;
  warnings: string[];
  strict: boolean;
}

/** Normalised identity a preset maps to its own claim / profile shapes. */
export interface Profile {
  sub: string;
  user: TestUser;
  identity: AuthIdentity;
  email: string | null;
  emailVerified: boolean;
  /** GitHub: public profile email hidden; Apple: relay address in use. */
  privateEmail: boolean;
  name: string;
  givenName: string;
  familyName: string;
  picture: string;
  locale: string;
  login: string;
  hd: string | null;
  /** Numeric id derived from sub where the preset needs one (GitHub, GitLab…). */
  numericId: number;
  createdAt: string;
}

export interface Issued {
  access_token: string;
  token_type: string;
  expires_in: number | null;
  scope: string;
  refresh_token?: string;
  id_token?: string;
  sub: string;
  claims: Record<string, unknown> | null;
  profile: Profile | null;
  clientId: string;
  /** Request kind: code exchange, refresh, client credentials, control API. */
  grantType: string;
}

export interface TokenContext {
  profile: Profile | null;
  clientId: string;
  scopes: string[];
  issuer: string;
  expiresIn: number | null;
  audience: string | null;
  /** jti / opaque token value chosen by the service. */
  random: string;
  /** Issue time in seconds on stubyard's "auth" clock (time offsets applied); use instead of the real clock. */
  nowSec: number;
}

export interface PresetDef {
  id: string;
  name: string;
  protocol: 'oidc' | 'oauth2';
  description: string;
  /** Real-world host the paths mirror (for docs). */
  realBase: string;
  routes: PresetRoute[];
  /** Paths below the base, for discovery and the URLs shown in the dashboard. */
  paths(c: Ctx | null): { discovery?: string; authorize: string; token: string; userinfo?: string; jwks?: string; revoke?: string; introspect?: string; logout?: string };
  /** Appended to the base to form the issuer (LinkedIn "/oauth", Microsoft "/<tid>/v2.0"). */
  issuerSuffix?(c: Ctx): string;
  defaultScope: string;
  /** Known scopes (null = accept anything). Unknown scopes are a warning (lax) or invalid_scope (strict). */
  scopes: string[] | null;
  /** Any of these scopes grants the email (null = always). */
  emailScopes: string[] | null;
  pkce: 'required' | 'optional';
  /** `auto` refresh policy. */
  refresh(scopes: string[], authParams: Record<string, unknown>): boolean;
  rotateRefresh: boolean;
  /** null = token never expires (GitHub OAuth apps). */
  accessTokenTtl: number | null;
  responseModes: string[];
  /** Grant types the token endpoint accepts. */
  grantTypes: string[];
  sub(hash: Buffer, provider: AuthProvider): string;
  /** Opaque access token format; JWT presets override accessToken. */
  opaquePrefix?: string;
  accessToken?(c: Ctx, t: TokenContext, sign: (claims: Record<string, unknown>) => string): string;
  /** Preset claims merged into the id_token (OIDC presets). */
  idTokenClaims?(c: Ctx, p: Profile, t: TokenContext): Record<string, unknown>;
  tokenResponse(c: Ctx, issued: Issued): Out;
  /**
   * `reason` says what went wrong in stubyard terms (code_reused, code_expired, code_unknown, redirect_mismatch, pkce,
   * client_secret, client_unknown, refresh_reused, scenario…) so presets can map it to their own codes.
   */
  tokenError(c: Ctx, error: string, description: string, status: number, reason?: string): Out;
  /** How clients authenticate at the token endpoint (first = preferred). */
  tokenAuthMethods: string[];
  /** Authorize parameter that pre-selects the account (GitHub: "login"). Default login_hint. */
  loginHintParam?: string;
  /** Apple: post `user` (name + email JSON) on the first authorization of a client. */
  formPostUser?: boolean;
  /** Apple: inspect the client_secret JWT; returns problems found. */
  verifyClientSecret?(c: Ctx, clientId: string, secret: string | null): string[];
  /** Response of the revocation endpoint (default 200 {}). */
  revokeResponse?(c: Ctx, found: boolean): Out;
  /** Extra authorize-request checks (Apple form_post rule, …); return warnings. */
  checkAuthorize?(c: Ctx, params: Record<string, string>, scopes: string[]): { warnings: string[]; responseMode?: string };
  /** 401 for a missing / invalid / expired access token at a resource endpoint. */
  unauthorized(c: Ctx, description: string): Out;
  userinfo(c: Ctx, p: Profile, grant: AuthGrant | null): Out;
  discovery?(c: Ctx, base: Record<string, unknown>): Record<string, unknown>;
  /** Preset-only endpoints (GitHub /user/emails, Facebook /debug_token, Google /tokeninfo…). */
  extra?(c: Ctx, helpers: ExtraHelpers): Promise<Out> | Out;
  /** Defaults merged under the provider config on create. */
  defaultConfig?: Partial<AuthProviderConfig>;
  /** Description of what the snippet / docs should say about repointing the app's library. */
  snippets?(urls: ProviderUrls, c: { clientId: string; provider: AuthProvider }): { title: string; language: string; code: string }[];
}

export interface ExtraHelpers {
  /** Resolve the access token of the request (header / query / body) to its grant and profile. */
  bearer(): { grant: AuthGrant; profile: Profile } | { error: Out };
  /** Look up any token (access or refresh) by value. */
  lookup(token: string): { grant: AuthGrant; profile: Profile | null } | null;
  issuer(): string;
}

export interface ProviderUrls {
  base: string;
  issuer: string;
  discovery: string | null;
  authorize: string;
  token: string;
  userinfo: string | null;
  jwks: string | null;
  revoke: string | null;
  logout: string | null;
}
