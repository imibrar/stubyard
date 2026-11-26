import type { Hub } from '../hub.js';
import { HttpError } from '../util.js';

/**
 * Per-feature time offsets ("time travel"): a signed offset added to stubyard's own clock for one feature of a project
 * (or of one test run). Only stubyard's clock moves; the app's clock is never touched.
 *  - totp: authenticator codes (GET …/authenticators, …/code)
 *  - auth: login providers: token iat/exp/auth_time, code / refresh / access-token expiry checks
 *  - verify: Twilio Verify / Vonage Verify expiry when a code is checked
 *  - webhooks: the signed timestamp of outgoing webhooks (templates, sequences, replays)
 *  - mocks: {{now}} / {{timestamp}} in API mock responses
 *  - einvoice: fake ZATCA: OTP expiry, CSID validity and the BR-KSA-04 issue-date check
 * Not shifted: message timestamps, storage presigned URLs, the job scheduler, retention.
 */
export const TIME_FEATURES = ['totp', 'auth', 'verify', 'webhooks', 'mocks', 'einvoice'] as const;
export type TimeFeature = (typeof TIME_FEATURES)[number];
export type TimeOffsets = Partial<Record<TimeFeature, number>>;

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const UNITS: Record<string, number> = { ms: 1, s: SEC, sec: SEC, m: MIN, min: MIN, h: HOUR, hr: HOUR, d: DAY, w: 7 * DAY, y: 365 * DAY };
/** Largest offset either way: 10 years. */
export const MAX_OFFSET_MS = 3650 * DAY;

export const isTimeFeature = (f: unknown): f is TimeFeature => typeof f === 'string' && (TIME_FEATURES as readonly string[]).includes(f);

/**
 * "+2h", "-90s", "1d", "1h30m", "-2d 3h", "500ms" or a number of milliseconds → milliseconds.
 * null / "" / 0 → 0 (clears). Limited to ±10 years; anything else is a 400.
 */
export function parseOffset(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  let ms: number;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new HttpError(400, 'Offset must be a finite number of milliseconds');
    ms = Math.round(v);
  } else if (typeof v === 'string') {
    const s = v.trim().toLowerCase().replace(/\s+/g, '');
    if (s === '0' || s === '+0' || s === '-0') return 0;
    const m = /^([+-])?((?:\d+(?:\.\d+)?(?:ms|sec|min|hr|s|m|h|d|w|y))+)$/.exec(s);
    if (!m) throw new HttpError(400, `Cannot read offset "${v}": use e.g. "+2h", "-90s", "1d", "1h30m" or a number of milliseconds`);
    ms = 0;
    for (const part of m[2].matchAll(/(\d+(?:\.\d+)?)(ms|sec|min|hr|s|m|h|d|w|y)/g)) ms += Number(part[1]) * UNITS[part[2]];
    ms = Math.round(m[1] === '-' ? -ms : ms);
  } else throw new HttpError(400, 'Offset must be a string like "+2h" or a number of milliseconds');
  if (Math.abs(ms) > MAX_OFFSET_MS) throw new HttpError(400, 'Offset is limited to ±10 years');
  return ms;
}

/** 7_200_000 → "+2h", -90_000 → "-1m30s", 0 → "0". */
export function formatOffset(ms: number): string {
  if (!ms) return '0';
  let rest = Math.abs(Math.round(ms));
  let out = '';
  for (const [u, n] of [['d', DAY], ['h', HOUR], ['m', MIN], ['s', SEC]] as const) {
    if (rest >= n) {
      out += `${Math.floor(rest / n)}${u}`;
      rest %= n;
    }
  }
  if (rest) out += `${rest}ms`;
  return (ms < 0 ? '-' : '+') + out;
}

/** Only the known features with non-zero finite numbers. */
export function cleanOffsets(v: unknown): TimeOffsets {
  const out: TimeOffsets = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (isTimeFeature(k) && typeof n === 'number' && Number.isFinite(n) && n !== 0) out[k] = n;
  return out;
}

/** stubyard's clock per project / run / feature. Resolution: active run override > project setting > 0. */
export class Clock {
  constructor(private hub: Hub) {}

  /** Offsets stored on the project (settings.timeOffsets). */
  projectOffsets(projectId: string | null | undefined): TimeOffsets {
    if (!projectId) return {};
    try {
      return cleanOffsets(this.hub.projects.get(projectId)?.settings.timeOffsets);
    } catch {
      return {};
    }
  }

  /** Overrides stored on an active run (run.meta.timeOffsets); a stopped run has none. */
  runOffsets(projectId: string | null | undefined, runId: string | null | undefined): TimeOffsets {
    if (!runId) return {};
    try {
      const r = this.hub.runs?.repo.get(runId);
      if (!r || r.status !== 'active' || (projectId && r.projectId !== projectId)) return {};
      return cleanOffsets(r.meta?.timeOffsets);
    } catch {
      return {};
    }
  }

  /** Effective offsets for every feature (run overrides win). */
  effective(projectId: string | null | undefined, runId?: string | null): Record<TimeFeature, number> {
    const p = this.projectOffsets(projectId);
    const r = this.runOffsets(projectId, runId);
    const out = {} as Record<TimeFeature, number>;
    for (const f of TIME_FEATURES) out[f] = r[f] ?? p[f] ?? 0;
    return out;
  }

  offsetMs(projectId: string | null | undefined, feature: TimeFeature, runId?: string | null): number {
    const r = this.runOffsets(projectId, runId)[feature];
    if (r !== undefined) return r;
    return this.projectOffsets(projectId)[feature] ?? 0;
  }

  now(projectId: string | null | undefined, feature: TimeFeature, runId?: string | null): number {
    return Date.now() + this.offsetMs(projectId, feature, runId);
  }

  nowSec(projectId: string | null | undefined, feature: TimeFeature, runId?: string | null): number {
    return Math.floor(this.now(projectId, feature, runId) / 1000);
  }

  nowIso(projectId: string | null | undefined, feature: TimeFeature, runId?: string | null): string {
    return new Date(this.now(projectId, feature, runId)).toISOString();
  }

  /** "auth +2h, totp -30s" for the non-zero effective offsets, or '' when none. */
  describe(projectId: string | null | undefined, runId?: string | null): string {
    const e = this.effective(projectId, runId);
    return TIME_FEATURES.filter((f) => e[f])
      .map((f) => `${f} ${formatOffset(e[f])}`)
      .join(', ');
  }
}
