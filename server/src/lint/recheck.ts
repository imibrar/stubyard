import type { Hub } from '../hub.js';
import type { Message } from '../repos/messages.js';
import type { Project } from '../repos/projects.js';
import { LINT_CHECKS, checkLinks, lintMessage, type LintChannel, type LintFinding } from './checks.js';

/** Most recent outbound messages a re-check looks at. */
export const RECHECK_LIMIT = 500;
const MAILPIT_TIMEOUT_MS = 3000;
const CONCURRENCY = 8;

export interface RecheckResult {
  checked: number;
  changed: number;
  /** Emails whose HTML / headers could not be read from Mailpit: findings that need them were kept as they were. */
  partial: number;
}

interface EmailContent {
  html: string | null;
  text: string | null;
  headers: Record<string, string[]> | null;
}

/**
 * Re-run the content checks over a project's recent outbound messages with the project's current settings
 * (lintDisabled, productionDomains) and store the new findings. Emails are re-read from Mailpit (HTML, headers);
 * when that is not possible the findings that depend on them are kept, disabled checks are still dropped and
 * link-production is recomputed from the stored links.
 * `reenabled`: checks that were off before and are on now (only these are added from partial content).
 */
export async function recheckLint(hub: Hub, project: Project, opts: { limit?: number; runId?: string | null; reenabled?: string[] } = {}): Promise<RecheckResult> {
  const limit = Math.max(1, Math.min(Number(opts.limit) || RECHECK_LIMIT, RECHECK_LIMIT));
  const ids = (
    opts.runId
      ? hub.db.prepare("SELECT id FROM messages WHERE project_id = ? AND run_id = ? AND direction = 'outbound' ORDER BY created_at DESC, id DESC LIMIT ?").all(project.id, opts.runId, limit)
      : hub.db.prepare("SELECT id FROM messages WHERE project_id = ? AND direction = 'outbound' ORDER BY created_at DESC, id DESC LIMIT ?").all(project.id, limit)
  ) as { id: string }[];
  const settings = project.settings;
  const disabled = Array.isArray(settings.lintDisabled) ? settings.lintDisabled.map(String) : [];
  const productionDomains = Array.isArray(settings.productionDomains) ? settings.productionDomains.map(String) : [];
  const reenabled = new Set(opts.reenabled ?? LINT_CHECKS.map((c) => c.id));
  const labels = new Map(hub.providers.list(project.id).map((p) => [p.id, p.labels ?? []]));
  const result: RecheckResult = { checked: 0, changed: 0, partial: 0 };
  const changedIds: string[] = [];

  const work = async (id: string) => {
    const m = hub.messages.get(id);
    if (!m) return;
    const email = m.channel === 'email' && m.mailpitId ? await readEmail(hub, m.mailpitId) : null;
    const complete = m.channel !== 'email' || (!!email && (!m.hasHtml || email.html !== null) && email.headers !== null);
    if (!complete) result.partial++;
    let next: LintFinding[];
    try {
      next = relint(m, { email, complete, disabled, productionDomains, labels: m.providerInstanceId ? (labels.get(m.providerInstanceId) ?? []) : [], reenabled });
    } catch (err) {
      next = [...m.lint.filter((f) => f.check !== 'internal'), { check: 'internal', severity: 'info', message: `Content checks failed: ${(err as Error).message}` }];
    }
    result.checked++;
    if (hub.messages.setLint(m.id, next)) {
      result.changed++;
      changedIds.push(m.id);
    }
  };
  for (let i = 0; i < ids.length; i += CONCURRENCY) await Promise.all(ids.slice(i, i + CONCURRENCY).map((r) => work(r.id)));
  if (changedIds.length) hub.bus.publish({ type: 'message.updated', projectId: project.id, data: { lintRechecked: changedIds.length, ids: changedIds.slice(0, 100) } });
  return result;
}

const sameList = (a: unknown, b: unknown) => JSON.stringify(Array.isArray(a) ? [...a].map(String).sort() : []) === JSON.stringify(Array.isArray(b) ? [...b].map(String).sort() : []);

/**
 * After a project PATCH: when lintDisabled or productionDomains changed, re-check recent messages in the background
 * (the PATCH answers at once; a message.updated event follows when findings changed).
 */
export function relintOnSettingsChange(hub: Hub, before: Project, after: Project, log?: { warn: (o: object, msg: string) => void }): Promise<RecheckResult> | null {
  const b = before.settings ?? {};
  const a = after.settings ?? {};
  if (sameList(b.lintDisabled, a.lintDisabled) && sameList(b.productionDomains, a.productionDomains)) return null;
  const wasOff = new Set((Array.isArray(b.lintDisabled) ? b.lintDisabled : []).map(String));
  const nowOff = new Set((Array.isArray(a.lintDisabled) ? a.lintDisabled : []).map(String));
  const reenabled = [...wasOff].filter((c) => !nowOff.has(c));
  if (!sameList(b.productionDomains, a.productionDomains)) reenabled.push('link-production');
  const p = recheckLint(hub, after, { reenabled });
  p.catch((err) => log?.warn({ err }, 'content re-check after settings change failed'));
  return p;
}

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 } as const;
const keyOf = (f: LintFinding) => [f.check, f.message, f.excerpt ?? '', f.where ?? ''].join('\n');

function relint(
  m: Message,
  o: { email: EmailContent | null; complete: boolean; disabled: string[]; productionDomains: string[]; labels: string[]; reenabled: Set<string> },
): LintFinding[] {
  const tpl = (m.metadata?.wa as { template?: { name?: string; params?: (string | null)[] } } | undefined)?.template;
  const headers = o.email?.headers ?? null;
  const fromHeader = headers ? (headerValue(headers, 'from') ?? '') : undefined;
  const contentType = headers ? (headerValue(headers, 'content-type') ?? '') : '';
  const html = o.email?.html ?? null;
  const fresh = lintMessage({
    channel: m.channel as LintChannel,
    subject: m.subject,
    text: o.email?.text ?? m.bodyText,
    html,
    headers: headers ? Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v.length === 1 ? v[0] : v])) : null,
    hasTextPart: html ? hasTextPart(contentType, o.email?.text ?? null) : undefined,
    fromName: fromHeader === undefined ? undefined : displayName(fromHeader),
    instanceLabels: o.labels,
    waTemplate: tpl && Array.isArray(tpl.params) ? { name: String(tpl.name ?? ''), params: tpl.params } : null,
    disabled: o.disabled,
    productionDomains: o.productionDomains,
  });
  if (o.complete) return fresh;
  // Partial content (email not readable from Mailpit): keep what needed the missing parts, drop disabled checks,
  // recompute production links from the stored links, add newly enabled checks from what we have.
  const off = new Set(o.disabled);
  const out = new Map<string, LintFinding>();
  for (const f of m.lint) if (!off.has(f.check) && f.check !== 'link-production' && f.check !== 'internal') out.set(keyOf(f), f);
  if (!off.has('link-production')) {
    const links = (m.links ?? []).map((url) => ({ url, source: 'href' as const }));
    for (const f of checkLinks(links, o.productionDomains, m.channel as LintChannel)) if (f.check === 'link-production') out.set(keyOf(f), f);
  }
  for (const f of fresh) if (o.reenabled.has(f.check) && !m.lint.some((x) => x.check === f.check)) out.set(keyOf(f), f);
  return [...out.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function headerValue(h: Record<string, string[]>, name: string): string | undefined {
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return v[0];
  return undefined;
}

/** "Shop <a@b.c>" → "Shop"; "a@b.c" → null. */
function displayName(from: string): string | null {
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]*>\s*$/.exec(from);
  const name = m ? m[1].trim() : '';
  return name || null;
}

/** text/html at the top level means no text part; multipart/alternative means there is one. */
function hasTextPart(contentType: string, text: string | null): boolean | undefined {
  const ct = contentType.toLowerCase();
  if (ct.startsWith('text/html')) return false;
  if (ct.startsWith('multipart/alternative')) return true;
  return text ? undefined : false;
}

async function readEmail(hub: Hub, mailpitId: string): Promise<EmailContent | null> {
  const base = hub.mailpit?.baseUrl;
  if (!base) return null;
  const get = async (p: string) => {
    const r = await fetch(`${base}/api/v1/message/${encodeURIComponent(mailpitId)}${p}`, { headers: hub.mailpit?.authHeaders() ?? {}, signal: AbortSignal.timeout(MAILPIT_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`Mailpit ${r.status}`);
    return r.json() as Promise<unknown>;
  };
  try {
    const [detail, headers] = await Promise.all([get(''), get('/headers').catch(() => null)]);
    const d = detail as { HTML?: string; Text?: string };
    return { html: d.HTML ? d.HTML : null, text: d.Text ?? null, headers: headers && typeof headers === 'object' ? (headers as Record<string, string[]>) : null };
  } catch {
    return null;
  }
}
