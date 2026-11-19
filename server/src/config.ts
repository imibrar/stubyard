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

export interface Config {
  host: string;
  httpPort: number;
  httpsPort: number;
  smtpPort: number;
  dataDir: string;
  webDir: string;
  /** Public hostnames added to the HTTPS certificate in addition to the defaults. */
  tlsExtraNames: string[];
  /** Max bytes of a request/response body stored per traffic log entry. */
  maxLogBodyBytes: number;
  /** Max size of an email accepted by the SMTP front. */
  maxEmailBytes: number;
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
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(str('DEVHUB_DATA_DIR', path.resolve(process.cwd(), 'data')));
  const externalMailpit = process.env.DEVHUB_MAILPIT_URL;
  const cfg: Config = {
    host: str('DEVHUB_HOST', '0.0.0.0'),
    httpPort: int('DEVHUB_HTTP_PORT', 4000),
    httpsPort: int('DEVHUB_HTTPS_PORT', 4443),
    smtpPort: int('DEVHUB_SMTP_PORT', 1025),
    dataDir,
    webDir: path.resolve(str('DEVHUB_WEB_DIR', path.resolve(process.cwd(), '../web/dist'))),
    tlsExtraNames: list('DEVHUB_TLS_NAMES', []),
    maxLogBodyBytes: int('DEVHUB_MAX_LOG_BODY_BYTES', 1024 * 1024),
    maxEmailBytes: int('DEVHUB_MAX_EMAIL_BYTES', 25 * 1024 * 1024),
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
    ...overrides,
  };
  return cfg;
}
