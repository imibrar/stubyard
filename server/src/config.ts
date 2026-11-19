import fs from 'node:fs';
import path from 'node:path';

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be an integer, got "${v}"`);
  return n;
}

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function list(name: string, fallback: string[]): string[] {
  const v = process.env[name];
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

/** True inside a Docker / Podman container (there 127.0.0.1 would make devhub unreachable through published ports). */
export function inContainer(): boolean {
  try {
    return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
  } catch {
    return false;
  }
}

export interface Config {
  /**
   * Listen address. Default 127.0.0.1 (only this machine) when devhub runs directly on a host, 0.0.0.0 inside a
   * container (the image sets DEVHUB_HOST=0.0.0.0): there, exposure is decided by the port publishing
   * (`-p 127.0.0.1:4000:4000`), and 127.0.0.1 would make devhub unreachable from outside the container.
   */
  host: string;
  httpPort: number;
  httpsPort: number;
  smtpPort: number;
  dataDir: string;
  webDir: string;
  /** Public hostnames added to the HTTPS certificate in addition to the defaults. */
  tlsExtraNames: string[];
  /**
   * Hostnames allowed in the Host / Origin of dashboard API calls (/api, /mcp), on top of localhost, 127.0.0.1, ::1,
   * devhub, host.docker.internal and the TLS names. "*" disables the check. Protects against DNS rebinding and
   * cross-site form posts from web pages open in your browser.
   */
  allowedHosts: string[];
  /** Max bytes of a request/response body stored per traffic log entry. */
  maxLogBodyBytes: number;
  /** Max size of an email accepted by the SMTP front. */
  maxEmailBytes: number;
  /** Largest WhatsApp media upload devhub stores (POST /<version>/<phone-number-id>/media). */
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
  /** Hosts devhub may call (status callbacks, inbound messages, event webhooks, webhook templates). ["*"] = any. */
  outboundAllow: string[];
  /**
   * Accept self-signed / untrusted certificates when calling the app over HTTPS: [] = never, ["*"] = always
   * (DEVHUB_OUTBOUND_INSECURE_TLS=1), or host patterns like the allowlist ("myapp.test,*.local").
   */
  outboundInsecureTls: string[];
  /** Export file(s) imported at boot when their project slug does not exist yet: a .json file or a directory. */
  seedPath: string | null;
  /** Markdown agent guide served at /api/agent-guide (default: docs/AGENT_GUIDE.md next to the server). */
  agentGuideFile: string | null;
  /**
   * Base URL the browser uses to reach devhub (DEVHUB_PUBLIC_URL), e.g. for login-provider authorize pages.
   * null = https://localhost:<httpsPort> (http://localhost:<httpPort> when HTTPS is off).
   */
  publicUrl: string | null;
  /** File storage: total MB for all projects (DEVHUB_STORAGE_MAX_MB, 0 = no limit). */
  storageMaxMb: number;
  /** File storage: MB per project (DEVHUB_STORAGE_PROJECT_MB, 0 = no limit). */
  storageProjectMb: number;
  /** File storage: largest single object in MB (DEVHUB_STORAGE_MAX_OBJECT_MB, 0 = no limit). */
  storageMaxObjectMb: number;
  /** File storage: objects older than this many days are deleted (DEVHUB_STORAGE_RETENTION_DAYS, 0 = keep). */
  storageRetentionDays: number;
  /** Virtual-hosted storage (DEVHUB_STORAGE_DOMAIN, e.g. s3.localhost): <bucket>.<instance>.<project>.<domain>. */
  storageDomain: string | null;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(str('DEVHUB_DATA_DIR', path.resolve(process.cwd(), 'data')));
  const externalMailpit = process.env.DEVHUB_MAILPIT_URL;
  const cfg: Config = {
    host: str('DEVHUB_HOST', inContainer() ? '0.0.0.0' : '127.0.0.1'),
    httpPort: int('DEVHUB_HTTP_PORT', 4000),
    httpsPort: int('DEVHUB_HTTPS_PORT', 4443),
    smtpPort: int('DEVHUB_SMTP_PORT', 1025),
    dataDir,
    webDir: path.resolve(str('DEVHUB_WEB_DIR', path.resolve(process.cwd(), '../web/dist'))),
    tlsExtraNames: list('DEVHUB_TLS_NAMES', []),
    allowedHosts: list('DEVHUB_ALLOWED_HOSTS', []),
    maxLogBodyBytes: int('DEVHUB_MAX_LOG_BODY_BYTES', 1024 * 1024),
    maxEmailBytes: int('DEVHUB_MAX_EMAIL_BYTES', 25 * 1024 * 1024),
    maxMediaBytes: int('DEVHUB_MAX_MEDIA_BYTES', 5 * 1024 * 1024),
    mailpitBin: str('DEVHUB_MAILPIT_BIN', '/usr/local/bin/mailpit'),
    mailpitUrl: str('DEVHUB_MAILPIT_URL', 'http://127.0.0.1:8025'),
    mailpitSmtpHost: str('DEVHUB_MAILPIT_SMTP_HOST', '127.0.0.1'),
    mailpitSmtpPort: int('DEVHUB_MAILPIT_SMTP_PORT', 1026),
    spawnMailpit: !externalMailpit,
    logLevel: str('DEVHUB_LOG_LEVEL', 'info'),
    callbackDelayMs: int('DEVHUB_CALLBACK_DELAY_MS', 1500),
    timeoutHoldMs: int('DEVHUB_TIMEOUT_HOLD_MS', 120_000),
    logRetentionDays: int('DEVHUB_LOG_RETENTION_DAYS', 7),
    maxDbMb: int('DEVHUB_MAX_DB_MB', 500),
    maintenanceIntervalMs: int('DEVHUB_MAINTENANCE_INTERVAL_MS', 10 * 60_000),
    outboundAllow: outboundAllowList(),
    outboundInsecureTls: insecureTlsList(),
    seedPath: process.env.DEVHUB_SEED ? path.resolve(process.env.DEVHUB_SEED) : null,
    agentGuideFile: process.env.DEVHUB_AGENT_GUIDE ? path.resolve(process.env.DEVHUB_AGENT_GUIDE) : null,
    publicUrl: process.env.DEVHUB_PUBLIC_URL ? process.env.DEVHUB_PUBLIC_URL.replace(/\/+$/, '') : null,
    storageMaxMb: int('DEVHUB_STORAGE_MAX_MB', 5120),
    storageProjectMb: int('DEVHUB_STORAGE_PROJECT_MB', 2048),
    storageMaxObjectMb: int('DEVHUB_STORAGE_MAX_OBJECT_MB', 1024),
    storageRetentionDays: int('DEVHUB_STORAGE_RETENTION_DAYS', 0),
    storageDomain: process.env.DEVHUB_STORAGE_DOMAIN ? process.env.DEVHUB_STORAGE_DOMAIN.trim().toLowerCase().replace(/^\.+/, '') : null,
    ...overrides,
  };
  return cfg;
}

/** DEVHUB_OUTBOUND_ALLOW replaces the defaults; a leading "+" ("+staging.example.com,…") adds to them. */
function outboundAllowList(): string[] {
  const v = process.env.DEVHUB_OUTBOUND_ALLOW?.trim();
  if (!v) return DEFAULT_OUTBOUND_ALLOW;
  const items = v.replace(/^\+/, '').split(',').map((x) => x.trim()).filter(Boolean);
  return v.startsWith('+') ? [...DEFAULT_OUTBOUND_ALLOW, ...items] : items;
}

function insecureTlsList(): string[] {
  const v = (process.env.DEVHUB_OUTBOUND_INSECURE_TLS ?? '').trim();
  if (!v || ['0', 'false', 'no', 'off'].includes(v.toLowerCase())) return [];
  if (['1', 'true', 'yes', 'on', '*'].includes(v.toLowerCase())) return ['*'];
  return v.split(',').map((x) => x.trim()).filter(Boolean);
}
