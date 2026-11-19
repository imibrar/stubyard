import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import type { TestUser } from '../repos/users.js';
import type { WebhookTemplate } from '../repos/webhooks.js';
import { sendOutbound, type OutboundResult } from '../traffic/outbound.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { sign, signatureHeaders, type SigningConfig } from './signing.js';
import type { PreparedRequest } from './service.js';

/**
 * Webhook security suite: sends a battery of variants of one template to the app and reports which ones the app
 * accepted (2xx) although a correct handler rejects them (bad / missing signature, stale timestamp, tampered body…).
 */

export type Expectation = 'accept' | 'reject' | 'info';
export type Verdict = 'pass' | 'fail' | 'warn' | 'info' | 'skipped' | 'error';

export interface VariantResult {
  id: string;
  label: string;
  description: string;
  expected: Expectation;
  status: number | null;
  verdict: Verdict;
  note: string;
  logId: string | null;
  /** Further requests of the same variant (out-of-order sends two). */
  extraLogIds?: string[];
  durationMs: number | null;
}

export interface SecurityCheckResult {
  id: string;
  templateId: string;
  template: string;
  targetUrl: string;
  signing: string;
  startedAt: string;
  finishedAt: string;
  baselineFailed: boolean;
  summary: Record<Verdict, number>;
  variants: VariantResult[];
  notes: string[];
}

export const OVERSIZED_BYTES = 1024 * 1024;

interface Req {
  headers: Record<string, string>;
  body: string;
  /** Another template's request (out-of-order). */
  method?: string;
  url?: string;
}

const lower = (h: Record<string, string>, names: string[]) => {
  const drop = new Set(names.map((n) => n.toLowerCase()));
  return Object.fromEntries(Object.entries(h).filter(([k]) => !drop.has(k.toLowerCase())));
};
const isJsonCt = (h: Record<string, string>) => /json/i.test(Object.entries(h).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '');
const hasTimestamp = (cfg: SigningConfig) => cfg.preset === 'stripe' || (cfg.preset === 'hmac' && !!cfg.timestampHeader);
const sigHeader = (cfg: SigningConfig) => (cfg.preset === 'stripe' ? 'Stripe-Signature' : cfg.preset === 'basic' ? 'Authorization' : (cfg.header ?? 'X-Signature'));

/** Body with one value changed after signing (JSON: a field added; otherwise one character appended). */
export function tamper(body: string): string {
  try {
    const v = JSON.parse(body) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return JSON.stringify({ ...(v as Record<string, unknown>), devhub_tampered: true });
  } catch {
    /* not JSON */
  }
  return `${body}x`;
}

/** Valid JSON padded to about `bytes` (non-JSON: padded text). */
export function oversized(body: string, bytes = OVERSIZED_BYTES): string {
  const pad = 'x'.repeat(bytes);
  try {
    const v = JSON.parse(body) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return JSON.stringify({ ...(v as Record<string, unknown>), devhub_padding: pad });
  } catch {
    /* not JSON */
  }
  return `${body}${pad}`;
}

/** Truncated JSON (still starts like the real payload). */
export function malformed(body: string): string {
  const cut = Math.max(1, Math.floor(body.length / 2));
  return `${body.slice(0, cut).replace(/\s+$/, '')}`.replace(/[}\]]+$/, '') + ',"';
}

const KIND_NOTES = {
  security: { accepted: 'Accepted although it must be rejected: the handler does not verify this properly' },
  input: { accepted: 'Accepted malformed input: the handler may process garbage' },
  size: { accepted: 'Accepted a 1 MB body: consider a body size limit for webhooks' },
  contentType: { accepted: 'Accepted with text/plain: fine if the handler verifies the raw body; otherwise check the content-type' },
} as const;

/** Verdict for a variant a correct handler rejects with a 4xx. */
export function judgeReject(kind: keyof typeof KIND_NOTES, res: Pick<OutboundResult, 'status' | 'error'>): { verdict: Verdict; note: string } {
  const st = res.status;
  if (st === null) return { verdict: 'error', note: `No answer: ${res.error ?? 'network error'}` };
  if (st >= 200 && st < 300) {
    const verdict: Verdict = kind === 'security' || kind === 'input' ? 'fail' : kind === 'size' ? 'warn' : 'info';
    return { verdict, note: KIND_NOTES[kind].accepted };
  }
  if (st >= 500) return { verdict: 'warn', note: 'Rejected, but with a 5xx: the app crashed on bad input (providers retry 5xx); answer 4xx instead' };
  if (st >= 300 && st < 400) return { verdict: 'warn', note: `Redirect (${st}): webhook senders do not follow redirects` };
  return { verdict: 'pass', note: 'Rejected' };
}

function summary(variants: VariantResult[]): Record<Verdict, number> {
  const s: Record<Verdict, number> = { pass: 0, fail: 0, warn: 0, info: 0, skipped: 0, error: 0 };
  for (const v of variants) s[v.verdict]++;
  return s;
}

/** Runs and stores security checks (latest result per template). */
export class WebhookSecurity {
  private running = new Set<string>();

  constructor(private hub: Hub) {}

  latest(templateId: string): SecurityCheckResult | null {
    const r = this.hub.db.prepare('SELECT result FROM webhook_security_checks WHERE template_id = ?').get(templateId) as { result: string } | undefined;
    return r ? parseJson<SecurityCheckResult | null>(r.result, null) : null;
  }

  private save(projectId: string, r: SecurityCheckResult): void {
    this.hub.db
      .prepare('INSERT INTO webhook_security_checks (template_id, project_id, result, created_at) VALUES (?,?,?,?) ON CONFLICT(template_id) DO UPDATE SET result = excluded.result, created_at = excluded.created_at')
      .run(r.templateId, projectId, JSON.stringify(r), r.finishedAt);
  }

  async run(project: Project, tpl: WebhookTemplate, opts: { user?: TestUser | null; data?: unknown; gapMs?: number } = {}): Promise<SecurityCheckResult> {
    if (this.running.has(tpl.id)) throw new HttpError(409, `A security check of "${tpl.name}" is already running`);
    this.running.add(tpl.id);
    try {
      const r = await this.execute(project, tpl, opts);
      this.save(project.id, r);
      this.hub.bus.publish({ type: 'webhooks.changed', projectId: project.id, data: { template: tpl.id, securityCheck: r.id } });
      return r;
    } finally {
      this.running.delete(tpl.id);
    }
  }

  private async execute(project: Project, tpl: WebhookTemplate, opts: { user?: TestUser | null; data?: unknown; gapMs?: number }): Promise<SecurityCheckResult> {
    const hub = this.hub;
    const svc = hub.webhookService;
    const cfg = tpl.signing;
    const checkId = randomUUID();
    const startedAt = nowIso();
    const gapMs = Math.min(Math.max(opts.gapMs ?? 150, 0), 2000);
    const runId = hub.runs.resolver.activeById(opts.user?.runId)?.id ?? null;
    const variants: VariantResult[] = [];
    const notes: string[] = [];
    const seqRun = randomUUID();
    const prepare = (t: WebhookTemplate = tpl): PreparedRequest => svc.prepare(t, { user: opts.user, data: opts.data, runId: seqRun });
    const base = prepare();
    const method = base.method;
    const url = base.url;
    if (method === 'GET') notes.push('The template uses GET: body checks are not meaningful');
    const unsigned = (p: PreparedRequest) => lower(p.headers, signatureHeaders(cfg));
    const signed = (p: PreparedRequest, ts?: number): Req => ({ headers: { ...unsigned(p), ...sign(cfg, p.body, ts) }, body: p.body });

    let first = true;
    const send = async (id: string, label: string, r: Req, t: WebhookTemplate = tpl): Promise<OutboundResult & { durationMs: number }> => {
      if (!first && gapMs) await sleep(gapMs);
      first = false;
      const started = Date.now();
      const res = await sendOutbound(hub.traffic, {
        projectId: project.id,
        runId,
        method: r.method ?? method,
        url: r.url ?? url,
        headers: r.headers,
        body: (r.method ?? method) === 'GET' ? null : r.body,
        purpose: `webhook security check "${tpl.name}": ${label}`,
        resolved: {
          project: project.slug,
          template: t.name,
          templateId: t.id,
          signing: cfg.preset,
          securityCheck: id,
          securityCheckId: checkId,
          ...(opts.user ? { user: opts.user.name, userId: opts.user.id } : {}),
        },
      });
      return { ...res, durationMs: Date.now() - started };
    };
    const record = (v: Omit<VariantResult, 'durationMs' | 'logId' | 'status'> & { res?: OutboundResult & { durationMs: number } }) => {
      const { res, ...rest } = v;
      variants.push({ ...rest, status: res?.status ?? null, logId: res?.logId ?? null, durationMs: res?.durationMs ?? null });
    };
    const skip = (id: string, label: string, description: string, expected: Expectation, note: string) => record({ id, label, description, expected, verdict: 'skipped', note });
    const reject = async (id: string, label: string, description: string, kind: keyof typeof KIND_NOTES, r: Req) => {
      const res = await send(id, label, r);
      record({ id, label, description, expected: 'reject', ...judgeReject(kind, res), res });
    };

    // 1. Baseline
    const baseReq = signed(base);
    const b = await send('baseline', 'valid baseline', baseReq);
    const baseOk = b.status !== null && b.status >= 200 && b.status < 300;
    record({
      id: 'baseline',
      label: 'Valid baseline',
      description: 'Correctly rendered and signed: the app must accept it',
      expected: 'accept',
      verdict: baseOk ? 'pass' : b.status === null ? 'error' : 'fail',
      note: baseOk ? 'Accepted' : b.blocked ? `Not sent: ${b.error}` : b.status === null ? `No answer: ${b.error ?? 'network error'}` : `The app answered ${b.status} to a valid request`,
      res: b,
    });
    if (!baseOk) {
      notes.push('Baseline failed: the app did not accept a valid request, so the other variants would say nothing. Fix the template / app first (URL, secret, signing preset).');
      return this.finish(checkId, tpl, url, startedAt, true, variants, notes);
    }

    // 2. Signatures
    const sigSkip = 'Template is not signed (signing preset "none")';
    if (cfg.preset === 'none') {
      notes.push('The template is unsigned, so devhub cannot test signature verification. Set the signing preset your app verifies (Stripe, HMAC, Basic).');
      for (const [id, label] of [['bad-signature', 'Bad signature'], ['wrong-secret', 'Wrong secret'], ['missing-signature', 'Missing signature'], ['tampered-body', 'Body changed after signing']]) {
        skip(id, label, 'Signature check', 'reject', sigSkip);
      }
    } else if (cfg.preset === 'basic') {
      const auth = (u: string, p: string) => ({ Authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` });
      const p1 = prepare();
      await reject('bad-signature', 'Wrong password', 'Basic auth with the right user and a wrong password', 'security', { headers: { ...unsigned(p1), ...auth(cfg.username ?? '', `${cfg.password ?? ''}-wrong`) }, body: p1.body });
      const p2 = prepare();
      await reject('wrong-secret', 'Wrong credentials', 'Basic auth with another user and password', 'security', { headers: { ...unsigned(p2), ...auth('devhub-attacker', 'not-the-password') }, body: p2.body });
      const p3 = prepare();
      await reject('missing-signature', 'Missing Authorization', 'No Authorization header', 'security', { headers: unsigned(p3), body: p3.body });
      skip('tampered-body', 'Body changed after signing', 'Signature over a different body', 'reject', 'Basic auth does not cover the body (use an HMAC signature to detect tampering)');
    } else {
      const p1 = prepare();
      const good = signed(p1);
      // Well-formed but wrong: HMAC over a different payload.
      const wrong = sign(cfg, `${p1.body}#devhub`);
      await reject('bad-signature', 'Bad signature', 'Well-formed signature that does not match the body', 'security', { headers: { ...good.headers, ...wrong }, body: p1.body });
      const p2 = prepare();
      await reject('wrong-secret', 'Wrong secret', 'Signed with another secret', 'security', { headers: { ...unsigned(p2), ...sign({ ...cfg, secret: `${cfg.secret ?? ''}_wrong` }, p2.body) }, body: p2.body });
      const p3 = prepare();
      await reject('missing-signature', 'Missing signature', `No ${sigHeader(cfg)} header`, 'security', { headers: lower(signed(p3).headers, [sigHeader(cfg)]), body: p3.body });
      const p4 = prepare();
      await reject('tampered-body', 'Body changed after signing', 'Signed over the original body, sent with one value changed', 'security', { headers: signed(p4).headers, body: tamper(p4.body) });
    }

    // 3. Timestamps
    const now = Math.floor(Date.now() / 1000);
    const tsVariants: [string, string, string, number][] = [
      ['stale-10m', 'Timestamp 10 min old', 'Valid signature, timestamp 10 minutes in the past (Stripe tolerance: 5 min)', now - 600],
      ['stale-1h', 'Timestamp 1 h old', 'Valid signature, timestamp 1 hour in the past', now - 3600],
      ['future-10m', 'Timestamp 10 min ahead', 'Valid signature, timestamp 10 minutes in the future', now + 600],
    ];
    for (const [id, label, description, ts] of tsVariants) {
      if (!hasTimestamp(cfg)) {
        skip(id, label, description, 'reject', cfg.preset === 'hmac' ? 'HMAC preset without timestampHeader: replays cannot be detected by age' : 'Preset has no signed timestamp');
        continue;
      }
      await reject(id, label, description, 'security', signed(prepare(), ts));
    }
    if (cfg.preset === 'hmac' && !cfg.timestampHeader) notes.push('The HMAC preset signs no timestamp: a captured request can be replayed forever. Consider a timestamp header.');

    // 4. Replay (exact duplicate of the baseline: same event id, same signature)
    {
      const res = await send('replay', 'exact replay of the baseline', baseReq);
      const same = res.status === b.status && (res.body ?? '').slice(0, 2048) === (b.body ?? '').slice(0, 2048);
      const crashed = res.status !== null && res.status >= 500;
      record({
        id: 'replay',
        label: 'Replay (duplicate)',
        description: 'The baseline again, byte for byte (same event id and signature)',
        expected: 'info',
        verdict: crashed ? 'warn' : res.status === null ? 'error' : 'info',
        note:
          res.status === null
            ? `No answer: ${res.error ?? 'network error'}`
            : crashed
              ? `Duplicate made the app fail (${res.status}); providers retry, so duplicates are normal`
              : res.status >= 200 && res.status < 300
                ? `Idempotency: the app accepted a duplicate; make sure it does not process it twice${same ? '' : ` (answer differs from the first delivery: ${b.status} → ${res.status})`}`
                : `The app rejected the duplicate (${res.status}); fine if intended, but providers treat non-2xx as "retry later"`,
        res,
      });
    }

    // 5. Out of order (only when the template is part of a sequence)
    {
      const seq = hub.webhooks.listSequences(project.id).find((q) => q.steps.some((s) => s.templateId === tpl.id) && new Set(q.steps.map((s) => s.templateId)).size > 1);
      const label = 'Out of order';
      const description = 'A later event of the sequence arrives before an earlier one';
      if (!seq) skip('out-of-order', label, description, 'info', 'The template is not part of a sequence with other templates');
      else {
        const i = seq.steps.findIndex((s) => s.templateId === tpl.id);
        const otherStep = i > 0 ? seq.steps.slice(0, i).reverse().find((s) => s.templateId !== tpl.id) : seq.steps.slice(i + 1).find((s) => s.templateId !== tpl.id);
        const other = otherStep ? hub.webhooks.getTemplateById(otherStep.templateId) : null;
        if (!other) skip('out-of-order', label, description, 'info', `Sequence "${seq.name}" has no other template`);
        else {
          const [later, earlier] = i > 0 && seq.steps.indexOf(otherStep!) < i ? [tpl, other] : [other, tpl];
          const signFor = (t: WebhookTemplate) => {
            const p = prepare(t);
            return { headers: { ...lower(p.headers, signatureHeaders(t.signing)), ...sign(t.signing, p.body) }, body: p.body, method: p.method, url: p.url };
          };
          const r1 = await send('out-of-order', `"${later.name}" first`, signFor(later), later);
          const r2 = await send('out-of-order', `then "${earlier.name}"`, signFor(earlier), earlier);
          const crashed = [r1, r2].some((r) => r.status !== null && r.status >= 500);
          variants.push({
            id: 'out-of-order',
            label,
            description: `${description} (sequence "${seq.name}": "${later.name}" before "${earlier.name}")`,
            expected: 'info',
            status: r2.status,
            verdict: crashed ? 'warn' : r1.status === null || r2.status === null ? 'error' : 'info',
            note: `"${later.name}" → ${r1.status ?? r1.error}, then "${earlier.name}" → ${r2.status ?? r2.error}. Check that the app does not move the state backwards (e.g. "paid" back to "pending").${crashed ? ' The app crashed (5xx).' : ''}`,
            logId: r1.logId,
            extraLogIds: [r2.logId],
            durationMs: r1.durationMs + r2.durationMs,
          });
        }
      }
    }

    // 6. Bad input (validly signed, so the parser behind the signature check is tested)
    const signedBody = (body: string, headers: Record<string, string>): Req => ({ headers: { ...lower(headers, signatureHeaders(cfg)), ...sign(cfg, body) }, body });
    if (method === 'GET') {
      for (const [id, label] of [['oversized', 'Oversized body (1 MB)'], ['malformed-json', 'Malformed JSON'], ['wrong-content-type', 'Wrong content-type']]) skip(id, label, 'Bad input', 'reject', 'GET requests have no body');
    } else {
      const p1 = prepare();
      await reject('oversized', 'Oversized body (1 MB)', 'A validly signed 1 MB body', 'size', signedBody(oversized(p1.body), p1.headers));
      const p2 = prepare();
      if (isJsonCt(p2.headers)) await reject('malformed-json', 'Malformed JSON', 'Validly signed, truncated JSON', 'input', signedBody(malformed(p2.body), p2.headers));
      else skip('malformed-json', 'Malformed JSON', 'Validly signed, truncated JSON', 'reject', 'The template does not send JSON');
      const p3 = prepare();
      const ct = { ...lower(p3.headers, ['content-type']), 'content-type': 'text/plain' };
      await reject('wrong-content-type', 'Wrong content-type', 'The normal body, validly signed, sent as text/plain', 'contentType', signedBody(p3.body, ct));
    }

    return this.finish(checkId, tpl, url, startedAt, false, variants, notes);
  }

  private finish(id: string, tpl: WebhookTemplate, url: string, startedAt: string, baselineFailed: boolean, variants: VariantResult[], notes: string[]): SecurityCheckResult {
    return { id, templateId: tpl.id, template: tpl.name, targetUrl: url, signing: tpl.signing.preset, startedAt, finishedAt: nowIso(), baselineFailed, summary: summary(variants), variants, notes };
  }
}
