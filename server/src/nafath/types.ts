import crypto from 'node:crypto';
import { HttpError } from '../util.js';

/** Fake Nafath (B5): the Saudi national SSO's MFA API (types, config normaliser, reference tables). */

export type NafathStatus = 'WAITING' | 'COMPLETED' | 'REJECTED' | 'EXPIRED';
export const NAFATH_STATUSES: NafathStatus[] = ['WAITING', 'COMPLETED', 'REJECTED', 'EXPIRED'];
export type AutoDecision = 'none' | 'approve' | 'reject' | 'wrong_number' | 'expire';
export const AUTO_DECISIONS: AutoDecision[] = ['none', 'approve', 'reject', 'wrong_number', 'expire'];

export interface NafathConfig {
  /** Where COMPLETED / REJECTED callbacks go (null: no callback). */
  callbackUrl: string | null;
  /** Transaction lifetime on the auth clock (real Nafath: 200 s). */
  ttlSeconds: number;
  /** What the fake "Nafath app" does by itself after autoDelayMs (default none: a person decides). */
  autoDecision: AutoDecision;
  autoDelayMs: number;
  /** Allowed `service` values (empty: any). Checked in strict mode only; lax notes a warning. */
  services: string[];
  /** Callback body: default {transId, requestId, status, token}; compat adds transactionId. */
  callbackFields: 'default' | 'compat';
  /** Send a callback for EXPIRED too (off: no callback, as real Nafath). */
  callbackOnExpired: boolean;
  /** After a wrong number, a new request for the same ID within this many seconds gets 400-034-050. */
  wrongNumberCooldownSeconds: number;
  /** /status keeps answering WAITING this long after the decision (laravel-nafath notes a 20-30 s lag). */
  statusLagMs: number;
}

export interface NafathKey {
  kid: string;
  privatePem: string;
  /** {kty:'RSA', use:'sig', alg:'RS256', kid, n, e} as served at /api/v1/mfa/jwk. */
  publicJwk: Record<string, unknown>;
  /** active: signs new tokens; retired: still listed in the JWK set until rotated with dropOld. */
  status: 'active' | 'retired';
  createdAt: string;
}

export interface NafathInstance {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  preset: 'nafath';
  /** APP-ID header value, unique across the hub (host mode finds the instance by it). */
  appId: string;
  appKey: string;
  config: NafathConfig;
  keys: NafathKey[];
  /** Strict: wrong credentials, unknown IDs and services outside config.services are errors (lax: warnings). */
  strict: boolean;
  enabled: boolean;
  createdAt: string;
}

/** One callback delivery attempt (filled by the callbacks slice). */
export interface NafathCallbackAttempt {
  at: string;
  url: string;
  /** HTTP status of the app's answer (null: network error / timeout). */
  status: number | null;
  error?: string | null;
  duplicate?: boolean;
}

export interface NafathRequest {
  id: string;
  projectId: string;
  instanceId: string;
  /** null: an unknown national ID accepted in lax mode (shown as unassigned). */
  testUserId: string | null;
  runId: string | null;
  transId: string;
  /** The 2-digit number the app shows; the person picks it among `choices`. */
  random: string;
  choices: string[];
  nationalId: string;
  service: string | null;
  locale: string | null;
  requestId: string | null;
  status: NafathStatus;
  /** rejected | wrong_number | expired (with decidedBy telling who: a person, rule:<id>, auto, …). */
  reason: string | null;
  decidedBy: string | null;
  chosen: string | null;
  /** Signed JWT of a COMPLETED / REJECTED request. */
  token: string | null;
  callback: NafathCallbackAttempt[];
  logId: string | null;
  polls: number;
  createdAt: string;
  /** On the project's auth clock. */
  expiresAt: string;
  /** On the project's auth clock. */
  decidedAt: string | null;
}

export interface NafathRule {
  id: string;
  projectId: string;
  runId: string | null;
  instanceId: string | null;
  /** user: test user id. */
  match: { user?: string; nationalId?: string; service?: string };
  fault: string;
  remaining: number | null;
  hits: number;
  createdAt: string;
}

/** Error answers of the fake API (body {code, message, reference}). */
export const NAFATH_ERRORS = {
  alreadyActive: { status: 400, code: '400-034-050', message: 'There is an active transaction for this national ID' },
  expired: { status: 400, code: '400-034-051', message: 'The transaction has expired' },
  notFound: { status: 400, code: '400-034-053', message: 'Transaction or national ID not found' },
  notApproved: { status: 401, code: '401-033-024', message: 'The request has not been approved yet' },
  invalidRequest: { status: 400, code: '400', message: 'Invalid request' },
  invalidCredentials: { status: 403, code: '403', message: 'Invalid APP-ID or APP-KEY' },
  rateLimit: { status: 429, code: '429', message: 'Too many requests' },
  down: { status: 503, code: '503', message: 'Service Unavailable' },
} as const;

/** An app-facing error: the routes answer `status` with {code, message, reference}. */
export class NafathError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** timeout fault: hold the request, then close the connection without an answer. */
    public hold = false,
  ) {
    super(message);
  }
  static of(e: { status: number; code: string; message: string }, message?: string): NafathError {
    return new NafathError(e.status, e.code, message ?? e.message);
  }
  body(): { code: string; message: string; reference: string } {
    return { code: this.code, message: this.message, reference: crypto.randomUUID() };
  }
}

export const NAFATH_DEFAULTS: NafathConfig = {
  callbackUrl: null,
  ttlSeconds: 200,
  autoDecision: 'none',
  autoDelayMs: 3000,
  services: [],
  callbackFields: 'default',
  callbackOnExpired: false,
  wrongNumberCooldownSeconds: 0,
  statusLagMs: 0,
};

type J = Record<string, unknown>;

/** Merge a partial config into `prev` (or the defaults), checking every value given (400 on a bad one). */
export function nafathConfig(partial: unknown, prev: NafathConfig | null): NafathConfig {
  if (partial !== undefined && partial !== null && (typeof partial !== 'object' || Array.isArray(partial))) throw new HttpError(400, 'config must be a JSON object');
  const c = (partial ?? {}) as J;
  const base = { ...NAFATH_DEFAULTS, ...(prev ?? {}) };
  const given = (k: string) => c[k] !== undefined;
  const int = (k: string, min: number, max: number): number => {
    if (!given(k)) return base[k as keyof NafathConfig] as number;
    const n = Number(c[k]);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `config.${k} must be a whole number from ${min} to ${max}`);
    return n;
  };
  const bool = (k: string): boolean => {
    if (!given(k)) return base[k as keyof NafathConfig] as boolean;
    if (typeof c[k] !== 'boolean') throw new HttpError(400, `config.${k} must be true or false`);
    return c[k] as boolean;
  };

  let callbackUrl = base.callbackUrl;
  if (given('callbackUrl')) {
    const s = c.callbackUrl === null ? '' : String(c.callbackUrl).trim();
    if (!s) callbackUrl = null;
    else {
      let u: URL;
      try {
        u = new URL(s);
      } catch {
        throw new HttpError(400, `config.callbackUrl "${s}" is not a URL`);
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'config.callbackUrl must be an http(s) URL');
      callbackUrl = s;
    }
  }

  let autoDecision = base.autoDecision;
  if (given('autoDecision')) {
    const s = String(c.autoDecision ?? 'none') || 'none';
    if (!(AUTO_DECISIONS as string[]).includes(s)) throw new HttpError(400, `config.autoDecision must be one of: ${AUTO_DECISIONS.join(', ')}`);
    autoDecision = s as AutoDecision;
  }

  let services = base.services;
  if (given('services')) {
    const raw = c.services === null ? [] : Array.isArray(c.services) ? c.services : String(c.services).split(',');
    services = [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))];
    if (services.length > 50 || services.some((s) => s.length > 120)) throw new HttpError(400, 'config.services: at most 50 names of up to 120 characters');
  }

  let callbackFields = base.callbackFields;
  if (given('callbackFields')) {
    if (c.callbackFields !== 'default' && c.callbackFields !== 'compat') throw new HttpError(400, 'config.callbackFields must be "default" or "compat"');
    callbackFields = c.callbackFields;
  }

  return {
    callbackUrl,
    ttlSeconds: int('ttlSeconds', 1, 86_400),
    autoDecision,
    autoDelayMs: int('autoDelayMs', 0, 3_600_000),
    services,
    callbackFields,
    callbackOnExpired: bool('callbackOnExpired'),
    wrongNumberCooldownSeconds: int('wrongNumberCooldownSeconds', 0, 86_400),
    statusLagMs: int('statusLagMs', 0, 600_000),
  };
}
