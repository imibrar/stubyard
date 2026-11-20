export type Channel = 'email' | 'sms' | 'whatsapp';

export interface ProjectSettings {
  otpRegex?: string;
  phonePrefix?: string;
  emailDomain?: string;
  defaultPassword?: string;
  roles?: string[];
  /** Traffic-log retention for this project (days); default from STUBYARD_LOG_RETENTION_DAYS. */
  retentionDays?: number;
  /** Remove captured data older than this many days automatically. */
  autoResetDays?: number;
  /** Content checks switched off (check ids from GET /api/lint/checks). */
  lintDisabled?: string[];
  /** Links to these domains in captured messages are flagged. */
  productionDomains?: string[];
}

export type LintSeverity = 'error' | 'warn' | 'info';
export interface LintFinding {
  check: string;
  severity: LintSeverity;
  message: string;
  excerpt?: string;
  where?: string;
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string;
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
  stats?: { users: number; messages: number; unread: number; logs: number; providers: number };
}

export type InboxCounts = Record<Channel, { unread: number; total: number }>;

export interface TestUser {
  id: string;
  projectId: string;
  name: string;
  role: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  marketingOptOut: boolean;
  notes: string;
  /** 0 = not pinned; otherwise the position in the pinned bar. */
  pinned: number;
  password: string | null;
  /** Ephemeral user of a test run. */
  runId?: string | null;
  createdAt: string;
  inbox?: InboxCounts;
  latest?: UserLatest | null;
  activeRules?: number;
}

export type RuleChannel = 'all' | Channel;

export interface Rule {
  id: string;
  scope: 'user' | 'instance';
  testUserId: string | null;
  providerInstanceId: string | null;
  channel: RuleChannel;
  position: number;
  action: string;
  errorCode: string | null;
  errorMessage: string | null;
  delayMs: number | null;
  failRate: number | null;
  remainingCount: number | null;
  skipCount: number;
  expiresAt: string | null;
  label: string | null;
  hits: number;
  enabled: boolean;
  active: boolean;
  description: string;
  createdAt: string;
}

export interface RulePreset {
  id: string;
  name: string;
  description: string;
  scope: 'user' | 'instance';
}

export interface ConfigField {
  key: string;
  label: string;
  hint?: string;
  placeholder?: string;
  secret?: boolean;
  multiline?: boolean;
}

/** Statuses where the user actually received the message. */
export const RECEIVED = ['delivered', 'complained', 'received'];

export interface UserLatest {
  at: string;
  otp: string | null;
  otpAt: string | null;
  otpChannel: Channel | null;
}

export interface ProviderInstance {
  id: string;
  projectId: string;
  channel: Channel;
  slug: string;
  name: string;
  preset: string;
  labels: string[];
  isDefault: boolean;
  config: Record<string, unknown>;
  defaultAction: string;
  enabled: boolean;
  createdAt: string;
}

export interface Preset {
  id: string;
  channel: Channel;
  name: string;
  description: string;
  available: boolean;
}

export interface Message {
  id: string;
  projectId: string;
  testUserId: string | null;
  providerInstanceId: string | null;
  channel: Channel;
  direction: 'outbound' | 'inbound';
  from: string | null;
  to: string;
  subject: string | null;
  bodyText: string | null;
  hasHtml: boolean;
  attachments: number;
  mailpitId: string | null;
  status: string;
  statusDetail: string | null;
  otp: string | null;
  links: string[];
  logId: string | null;
  providerMessageId?: string | null;
  duplicateOfId?: string | null;
  appliedRule?: { id: string | null; label: string; level: string; action: string } | null;
  metadata: Record<string, unknown>;
  /** Test run the message was attributed to. */
  runId?: string | null;
  /** Content-check findings (errors first). */
  lint?: LintFinding[];
  readAt: string | null;
  createdAt: string;
  mailpit?: { html: string; text: string; raw: string; detail: string; part: string } | null;
}

export interface LogSummary {
  id: string;
  projectId: string | null;
  direction: 'inbound' | 'outbound';
  protocol: 'http' | 'smtp';
  method: string | null;
  url: string | null;
  clientIp: string | null;
  reqBodySize: number | null;
  reqTruncated: boolean;
  resStatus: number | null;
  resBodySize: number | null;
  resTruncated: boolean;
  errorType: string | null;
  errorMessage: string | null;
  outcome: string;
  resolved: Record<string, unknown>;
  parentLogId: string | null;
  receivedAt: string;
  respondedAt: string | null;
  durationMs: number | null;
  /** Test run the request was attributed to (resolved.run holds its key). */
  runId?: string | null;
}

export interface LogDetail extends LogSummary {
  reqHeaders: Record<string, unknown> | null;
  reqBody: string | null;
  resHeaders: Record<string, unknown> | null;
  resBody: string | null;
  transcript: { at: string; command: string; response: string }[] | null;
}

export interface Authenticator {
  id: string;
  projectId: string;
  testUserId: string | null;
  label: string;
  issuer: string | null;
  account: string | null;
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: number;
  period: number;
  secretHint: string;
  createdAt: string;
}

export interface TotpCode {
  code: string;
  nextCode: string;
  period: number;
  remaining: number;
  validFrom: number;
  validUntil: number;
}

export interface AuthenticatorList {
  serverTime: number;
  items: (Authenticator & { current: TotpCode })[];
}

export interface Overview {
  project: Project;
  users: TestUser[];
  unassigned: InboxCounts;
  providers: ProviderInstance[];
  /** Instances per Providers-page tab (email, sms, whatsapp, login, payments, llm, push). */
  providerCounts?: Record<string, number>;
  authenticators: Authenticator[];
  stats: NonNullable<Project['stats']>;
}

export interface Snippet {
  title: string;
  language: string;
  code: string;
}

export interface SetupGuide {
  project: string;
  hosts: { id: string; label: string; host: string; http: string; https: string; smtpPort: number }[];
  sections: { id: string; title: string; description: string; instance?: string; snippets: Snippet[] }[];
  https: { downloadUrl: string; fingerprint: string | null; names: string[]; steps: Snippet[] };
}

export interface SystemInfo {
  name: string;
  version: string;
  ports: { http: number; https: number; smtp: number };
  tls: { names: string[]; caFingerprint: string; caCreatedAt: string } | null;
  mailpit: boolean;
  presets: Preset[];
  labels: string[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? data?.message ?? `HTTP ${res.status}`, data?.details);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  patch: <T>(p: string, b: unknown) => request<T>('PATCH', p, b),
  put: <T>(p: string, b: unknown) => request<T>('PUT', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
};

export function qs(params: Record<string, string | number | undefined | null | false>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== false && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

// ---------- Login providers (fake OAuth / OIDC) ----------
export interface LoginClient {
  clientId: string;
  clientSecret?: string | null;
  redirectUris?: string[];
  name?: string;
}

export interface LoginProviderConfig {
  strict?: boolean;
  issuerMode?: 'request-host' | 'fixed';
  issuer?: string | null;
  issOverride?: string | null;
  browserBaseUrl?: string | null;
  autoLogin?: string | null;
  clients?: LoginClient[];
  flavor?: string;
  [key: string]: unknown;
}

export interface LoginUrls {
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

export interface LoginRule {
  id: string;
  testUserId: string | null;
  stage: string;
  action: string;
  params: Record<string, unknown>;
  remainingCount: number | null;
  skipCount: number;
  expiresAt: string | null;
  label: string | null;
  hits: number;
  enabled: boolean;
  active: boolean;
}

export interface LoginProvider {
  id: string;
  slug: string;
  name: string;
  preset: string;
  presetName: string;
  protocol: 'oidc' | 'oauth2';
  enabled: boolean;
  config: LoginProviderConfig;
  urls: { browser: LoginUrls; backend: LoginUrls; backendLocal: LoginUrls };
  snippets: Snippet[];
  keys: { kid: string; alg: string; status: 'active' | 'retired'; createdAt: string; retiredAt: string | null }[];
  rules: LoginRule[];
}

export interface LoginPresets {
  presets: { id: string; name: string; protocol: 'oidc' | 'oauth2'; description: string; realBase: string; defaultScope: string; pkce: string }[];
  actions: Record<string, string[]>;
  stages: string[];
}
