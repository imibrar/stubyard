import fs from 'node:fs';
import path from 'node:path';
import { LEGACY_NAME } from './legacy.js';
import { adminPasswordHash } from './access/password.js';

/**
 * Reads an environment variable. STUBYARD_* is the primary name; the pre-rename DEVHUB_* name is still honoured as a
 * fallback (STUBYARD_HTTP_PORT, else DEVHUB_HTTP_PORT).
 */
export function envVar(name: string): string | undefined {
  const v = process.env[name];
  if (v !== undefined || !name.startsWith('STUBYARD_')) return v;
  return process.env[`${LEGACY_NAME.toUpperCase()}_${name.slice('STUBYARD_'.length)}`];
}

function int(name: string, fallback: number): number {
  const v = envVar(name);
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be an integer, got "${v}"`);
  return n;
}

function str(name: string, fallback: string): string {
  const v = envVar(name);
  return v === undefined || v === '' ? fallback : v;
}

function list(name: string, fallback: string[]): string[] {
  const v = envVar(name);
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Outbound allowlist default: only addresses that are obviously "a dev machine / container", never a public host.
 * Entries: exact host, "*.suffix", CIDR ("10.0.0.0/8"), "single-label" (docker service names such as "app"), "*" = off.
 */
export const DEFAULT_OUTBOUND_ALLOW = [
  'localhost',
  '*.localhost',
  '127.0.0.0/8',
  '::1',
  'host.docker.internal',
  'gateway.docker.internal',
  '*.local',
  '*.test',
  '*.internal',
  '*.lan',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
  'fe80::/10',
  'single-label',
];

/** True inside a Docker / Podman container (there 127.0.0.1 would make stubyard unreachable through published ports). */
export function inContainer(): boolean {
  try {
    return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
  } catch {
    return false;
  }
}

export interface Config {
  /**
   * Listen address. Default 127.0.0.1 (only this machine) when stubyard runs directly on a host, 0.0.0.0 inside a
   * container (the image sets STUBYARD_HOST=0.0.0.0): there, exposure is decided by the port publishing
   * (`-p 127.0.0.1:4000:4000`), and 127.0.0.1 would make stubyard unreachable from outside the container.
   */
  host: string;
  httpPort: number;
  httpsPort: number;
  /**
   * Host port that reaches httpPort (STUBYARD_HOST_HTTP_PORT), for the http://localhost:… addresses given to apps on
   * the host when the container is published on other ports (-p 5500:4000). Default: the port of an http://
   * STUBYARD_PUBLIC_URL that names one, else httpPort. Docker-network addresses (stubyard:<httpPort>) do not use it.
   */
  hostHttpPort: number;
  /**
   * Host port that reaches httpsPort (STUBYARD_HOST_HTTPS_PORT), for https://localhost:… addresses. Default: the port
   * of an https:// STUBYARD_PUBLIC_URL that names one, else httpsPort.
   */
  hostHttpsPort: number;
  smtpPort: number;
  dataDir: string;
  webDir: string;
  /** Public hostnames added to the HTTPS certificate in addition to the defaults. */
  tlsExtraNames: string[];
  /**
   * Hostnames allowed in the Host / Origin of dashboard API calls (/api, /mcp), on top of localhost, 127.0.0.1, ::1,
   * stubyard, host.docker.internal and the TLS names. "*" disables the check. Protects against DNS rebinding and
   * cross-site form posts from web pages open in your browser.
   */
  allowedHosts: string[];
  /**
   * Browser-extension origins whose mutating API calls are allowed (STUBYARD_EXTENSION_ORIGINS, comma-separated).
   * Default ["chrome-extension://*"] (any Chrome extension); "chrome-extension://<id>" pins one; '' turns it off.
   * The Host and JSON-only checks still apply; web pages cannot send a chrome-extension:// Origin.
   */
  extensionOrigins: string[];
  /** Max bytes of a request/response body stored per traffic log entry. */
  maxLogBodyBytes: number;
  /** Max size of an email accepted by the SMTP front. */
  maxEmailBytes: number;
  /** Largest WhatsApp media upload stubyard stores (POST /<version>/<phone-number-id>/media). */
  maxMediaBytes: number;
  /** Mailpit: either spawn the binary (mailpitBin) or use an external instance (mailpitUrl + mailpitSmtp). */
  mailpitBin: string;
  mailpitUrl: string;
  mailpitSmtpHost: string;
  mailpitSmtpPort: number;
  spawnMailpit: boolean;
  logLevel: string;
  /** Time until the final delivery report (delivered / failed) is sent; "sent" goes out at a third of it. */
  callbackDelayMs: number;
  /** How long a "timeout" rule holds a request before closing the connection. */
  timeoutHoldMs: number;
  /** Traffic logs older than this many days are deleted (0 = keep forever). Per project: settings.retentionDays. */
  logRetentionDays: number;
  /** When the database is larger than this (MB), the oldest traffic logs are deleted (0 = no limit). */
  maxDbMb: number;
  /** How often the retention / auto-reset pass runs (0 = never). */
  maintenanceIntervalMs: number;
  /** Hosts stubyard may call (status callbacks, inbound messages, event webhooks, webhook templates). ["*"] = any. */
  outboundAllow: string[];
  /**
   * Accept self-signed / untrusted certificates when calling the app over HTTPS: [] = never, ["*"] = always
   * (STUBYARD_OUTBOUND_INSECURE_TLS=1), or host patterns like the allowlist ("myapp.test,*.local").
   */
  outboundInsecureTls: string[];
  /** Export file(s) imported at boot when their project slug does not exist yet: a .json file or a directory. */
  seedPath: string | null;
  /** Markdown agent guide served at /api/agent-guide (default: docs/AGENT_GUIDE.md next to the server). */
  agentGuideFile: string | null;
  /**
   * Base URL the browser uses to reach stubyard (STUBYARD_PUBLIC_URL), e.g. for login-provider authorize pages.
   * null = https://localhost:<httpsPort> (http://localhost:<httpPort> when HTTPS is off).
   */
  publicUrl: string | null;
  /** File storage: total MB for all projects (STUBYARD_STORAGE_MAX_MB, 0 = no limit). */
  storageMaxMb: number;
  /** File storage: MB per project (STUBYARD_STORAGE_PROJECT_MB, 0 = no limit). */
  storageProjectMb: number;
  /** File storage: largest single object in MB (STUBYARD_STORAGE_MAX_OBJECT_MB, 0 = no limit). */
  storageMaxObjectMb: number;
  /** File storage: objects older than this many days are deleted (STUBYARD_STORAGE_RETENTION_DAYS, 0 = keep). */
  storageRetentionDays: number;
  /** Teams mode: audit log rows older than this many days are deleted by the maintenance job (STUBYARD_AUDIT_RETENTION_DAYS, default 365, 0 = keep). */
  auditRetentionDays: number;
  /** Virtual-hosted storage (STUBYARD_STORAGE_DOMAIN, e.g. s3.localhost): <bucket>.<instance>.<project>.<domain>. */
  storageDomain: string | null;
  /** Fake APNs HTTP/2 listener (STUBYARD_APNS_PORT, default 2197; 0 = off). TLS with the stubyard CA, h2c when TLS is off. */
  apnsPort: number;
  /**
   * Sign-in (docs/GUIDE.md "Sign-in (single admin)"). null = Open mode: no login, today's behaviour. Set by
   * STUBYARD_ADMIN_EMAIL plus STUBYARD_ADMIN_PASSWORD or STUBYARD_ADMIN_PASSWORD_HASH; the plain password is hashed at
   * start and never kept.
   */
  admin: AdminConfig | null;
  /** Lifetime of a dashboard session (STUBYARD_SESSION_TTL_HOURS, default 168 = 7 days). */
  sessionTtlHours: number;
  /** Session cookie with the Secure flag (STUBYARD_COOKIE_SECURE; default: on when STUBYARD_PUBLIC_URL is https). */
  cookieSecure: boolean;
  /**
   * STUBYARD_TRUST_PROXY, passed to Fastify's trustProxy: false (default: req.ip is the TCP peer), true (trust every
   * X-Forwarded-For hop), a hop count, or the proxies' addresses / CIDR ranges. Sign-in's limiter keys on req.ip, so
   * behind a TLS proxy set this, or every failed sign-in counts against the proxy's address.
   */
  trustProxy: boolean | number | string[];
  /**
   * Teams mode (docs/GUIDE.md "Teams"): STUBYARD_DATABASE_URL=postgres://… keeps users, project memberships, sessions,
   * API tokens, invites and the audit log in Postgres (schema "stubyard"). Needs the env admin. Never logged.
   */
  databaseUrl: string | null;
}

/** The single admin of Single admin mode. */
export interface AdminConfig {
  /** Lower-case e-mail address the admin signs in with. */
  email: string;
  /** scrypt hash in the format of access/password.ts ("scrypt:N:r:p:salt:hash"). */
  passwordHash: string;
}

function optPath(name: string): string | null {
  const v = envVar(name);
  return v ? path.resolve(v) : null;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(str('STUBYARD_DATA_DIR', path.resolve(process.cwd(), 'data')));
  const externalMailpit = envVar('STUBYARD_MAILPIT_URL');
  const cfg: Config = {
    host: str('STUBYARD_HOST', inContainer() ? '0.0.0.0' : '127.0.0.1'),
    httpPort: int('STUBYARD_HTTP_PORT', 4000),
    httpsPort: int('STUBYARD_HTTPS_PORT', 4443),
    hostHttpPort: 0, // resolved below, after the overrides
    hostHttpsPort: 0,
    smtpPort: int('STUBYARD_SMTP_PORT', 1025),
    dataDir,
    webDir: path.resolve(str('STUBYARD_WEB_DIR', path.resolve(process.cwd(), '../web/dist'))),
    tlsExtraNames: list('STUBYARD_TLS_NAMES', []),
    allowedHosts: list('STUBYARD_ALLOWED_HOSTS', []),
    extensionOrigins: extensionOriginList(),
    maxLogBodyBytes: int('STUBYARD_MAX_LOG_BODY_BYTES', 1024 * 1024),
    maxEmailBytes: int('STUBYARD_MAX_EMAIL_BYTES', 25 * 1024 * 1024),
    maxMediaBytes: int('STUBYARD_MAX_MEDIA_BYTES', 5 * 1024 * 1024),
    mailpitBin: str('STUBYARD_MAILPIT_BIN', '/usr/local/bin/mailpit'),
    mailpitUrl: str('STUBYARD_MAILPIT_URL', 'http://127.0.0.1:8025'),
    mailpitSmtpHost: str('STUBYARD_MAILPIT_SMTP_HOST', '127.0.0.1'),
    mailpitSmtpPort: int('STUBYARD_MAILPIT_SMTP_PORT', 1026),
    spawnMailpit: !externalMailpit,
    logLevel: str('STUBYARD_LOG_LEVEL', 'info'),
    callbackDelayMs: int('STUBYARD_CALLBACK_DELAY_MS', 1500),
    timeoutHoldMs: int('STUBYARD_TIMEOUT_HOLD_MS', 120_000),
    logRetentionDays: int('STUBYARD_LOG_RETENTION_DAYS', 7),
    maxDbMb: int('STUBYARD_MAX_DB_MB', 500),
    maintenanceIntervalMs: int('STUBYARD_MAINTENANCE_INTERVAL_MS', 10 * 60_000),
    outboundAllow: outboundAllowList(),
    outboundInsecureTls: insecureTlsList(),
    seedPath: optPath('STUBYARD_SEED'),
    agentGuideFile: optPath('STUBYARD_AGENT_GUIDE'),
    publicUrl: envVar('STUBYARD_PUBLIC_URL')?.replace(/\/+$/, '') || null,
    storageMaxMb: int('STUBYARD_STORAGE_MAX_MB', 5120),
    storageProjectMb: int('STUBYARD_STORAGE_PROJECT_MB', 2048),
    storageMaxObjectMb: int('STUBYARD_STORAGE_MAX_OBJECT_MB', 1024),
    storageRetentionDays: int('STUBYARD_STORAGE_RETENTION_DAYS', 0),
    auditRetentionDays: int('STUBYARD_AUDIT_RETENTION_DAYS', 365),
    storageDomain: envVar('STUBYARD_STORAGE_DOMAIN')?.trim().toLowerCase().replace(/^\.+/, '') || null,
    apnsPort: int('STUBYARD_APNS_PORT', 2197),
    admin: overrides.admin !== undefined ? overrides.admin : adminConfig(),
    sessionTtlHours: int('STUBYARD_SESSION_TTL_HOURS', 168),
    cookieSecure: false,
    trustProxy: trustProxyFromEnv(),
    databaseUrl: envVar('STUBYARD_DATABASE_URL')?.trim() || null,
    ...overrides,
  };
  if (cfg.databaseUrl) {
    if (!/^postgres(ql)?:\/\//i.test(cfg.databaseUrl)) throw new Error('STUBYARD_DATABASE_URL must be a postgres:// (or postgresql://) URL');
    if (!cfg.admin) throw new Error('STUBYARD_DATABASE_URL turns on Teams mode, which needs the instance admin: set STUBYARD_ADMIN_EMAIL and STUBYARD_ADMIN_PASSWORD (or STUBYARD_ADMIN_PASSWORD_HASH) too');
  }
  const publicPort = explicitPort(cfg.publicUrl);
  if (overrides.hostHttpPort === undefined) cfg.hostHttpPort = optPort('STUBYARD_HOST_HTTP_PORT') ?? (publicPort?.proto === 'http' ? publicPort.port : cfg.httpPort);
  if (overrides.hostHttpsPort === undefined) cfg.hostHttpsPort = optPort('STUBYARD_HOST_HTTPS_PORT') ?? (publicPort?.proto === 'https' ? publicPort.port : cfg.httpsPort);
  if (overrides.cookieSecure === undefined) cfg.cookieSecure = bool('STUBYARD_COOKIE_SECURE') ?? /^https:/i.test(cfg.publicUrl ?? '');
  if (!(cfg.sessionTtlHours > 0)) throw new Error('STUBYARD_SESSION_TTL_HOURS must be a positive number of hours');
  return cfg;
}

/** A port number from the environment, or undefined when unset / empty. */
function optPort(name: string): number | undefined {
  const v = envVar(name)?.trim();
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Environment variable ${name} must be a port number (1-65535), got "${v}"`);
  return n;
}

/** The port an http(s) URL names explicitly ("http://192.168.0.5:5500" → http 5500), or null when it names none. */
function explicitPort(url: string | null): { proto: 'http' | 'https'; port: number } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.port || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
    return { proto: u.protocol === 'http:' ? 'http' : 'https', port: Number(u.port) };
  } catch {
    return null;
  }
}

/** http://localhost:<hostHttpPort>: how an app on the host reaches stubyard over HTTP. */
export function hostHttpBase(c: Config): string {
  return `http://localhost:${c.hostHttpPort}`;
}

/** https://localhost:<hostHttpsPort>: how an app on the host reaches stubyard over HTTPS. */
export function hostHttpsBase(c: Config): string {
  return `https://localhost:${c.hostHttpsPort}`;
}

/** "1/true/yes/on" → true, "0/false/no/off" → false, unset or empty → undefined. */
/** STUBYARD_TRUST_PROXY: empty / 0 / false = off; true; a hop count (1, 2 …); or a comma list of IPs / CIDRs. */
function trustProxyFromEnv(): boolean | number | string[] {
  const v = envVar('STUBYARD_TRUST_PROXY')?.trim() ?? '';
  const low = v.toLowerCase();
  if (!v || ['0', 'false', 'no', 'off'].includes(low)) return false;
  if (['true', 'yes', 'on'].includes(low)) return true;
  if (/^\d+$/.test(v)) return Number(v);
  const items = v.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = items.filter((s) => !/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(s) && !['loopback', 'linklocal', 'uniquelocal'].includes(s));
  if (bad.length) throw new Error(`STUBYARD_TRUST_PROXY must be true, a hop count, or a comma list of IPs / CIDR ranges (or loopback, linklocal, uniquelocal); not "${bad.join(', ')}"`);
  return items;
}

function bool(name: string): boolean | undefined {
  const v = envVar(name)?.trim().toLowerCase();
  if (!v) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`Environment variable ${name} must be 1/0 (true/false), got "${v}"`);
}

/**
 * Single admin mode from STUBYARD_ADMIN_EMAIL + STUBYARD_ADMIN_PASSWORD (or STUBYARD_ADMIN_PASSWORD_HASH). Half a
 * configuration is an error, so a typo never leaves the dashboard open by accident.
 */
function adminConfig(): AdminConfig | null {
  const email = envVar('STUBYARD_ADMIN_EMAIL')?.trim().toLowerCase() ?? '';
  const password = envVar('STUBYARD_ADMIN_PASSWORD') ?? '';
  const hash = envVar('STUBYARD_ADMIN_PASSWORD_HASH')?.trim() ?? '';
  if (!email && !password && !hash) return null;
  if (!email) throw new Error('STUBYARD_ADMIN_PASSWORD(_HASH) is set but STUBYARD_ADMIN_EMAIL is not: set both to turn sign-in on, or neither');
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error(`STUBYARD_ADMIN_EMAIL must be an e-mail address, got "${email}"`);
  if (!password && !hash) throw new Error('STUBYARD_ADMIN_EMAIL is set but neither STUBYARD_ADMIN_PASSWORD nor STUBYARD_ADMIN_PASSWORD_HASH is');
  if (password && hash) throw new Error('Set STUBYARD_ADMIN_PASSWORD or STUBYARD_ADMIN_PASSWORD_HASH, not both');
  return { email, passwordHash: adminPasswordHash(email, password, hash) };
}

export const DEFAULT_EXTENSION_ORIGINS = ['chrome-extension://*'];

/** Unset = DEFAULT_EXTENSION_ORIGINS; set but empty = [] (exception off); entries lower-case, no trailing slash. */
function extensionOriginList(): string[] {
  const v = envVar('STUBYARD_EXTENSION_ORIGINS');
  if (v === undefined) return DEFAULT_EXTENSION_ORIGINS;
  return v
    .split(',')
    .map((x) => x.trim().toLowerCase().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** STUBYARD_OUTBOUND_ALLOW replaces the defaults; a leading "+" ("+staging.example.com,…") adds to them. */
function outboundAllowList(): string[] {
  const v = envVar('STUBYARD_OUTBOUND_ALLOW')?.trim();
  if (!v) return DEFAULT_OUTBOUND_ALLOW;
  const items = v.replace(/^\+/, '').split(',').map((x) => x.trim()).filter(Boolean);
  return v.startsWith('+') ? [...DEFAULT_OUTBOUND_ALLOW, ...items] : items;
}

function insecureTlsList(): string[] {
  const v = (envVar('STUBYARD_OUTBOUND_INSECURE_TLS') ?? '').trim();
  if (!v || ['0', 'false', 'no', 'off'].includes(v.toLowerCase())) return [];
  if (['1', 'true', 'yes', 'on', '*'].includes(v.toLowerCase())) return ['*'];
  return v.split(',').map((x) => x.trim()).filter(Boolean);
}
