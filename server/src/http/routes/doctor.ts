import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import { inContainer } from '../../config.js';
import type { Hub } from '../../hub.js';
import type { Project } from '../../repos/projects.js';
import { checkOutboundUrl, hostMatches, outboundPolicy } from '../../traffic/outbound.js';

/**
 * "Doctor": checks, from where stubyard runs (usually inside its container), that every URL stubyard will call for a
 * project is reachable — status callbacks, inbound-message URLs, email event webhooks, webhook templates — plus
 * Mailpit and the HTTPS certificate names. Each failure comes with a plain explanation of the usual cause.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorStep {
  step: 'allowlist' | 'dns' | 'tcp' | 'http';
  status: CheckStatus;
  detail: string;
}

export interface DoctorCheck {
  kind: 'url' | 'mailpit' | 'tls' | 'network';
  label: string;
  url?: string;
  source?: string;
  status: CheckStatus;
  message: string;
  hint?: string;
  steps?: DoctorStep[];
}

export interface DoctorReport {
  project: string;
  ok: boolean;
  summary: Record<CheckStatus, number>;
  environment: { inContainer: boolean; listen: string; outboundAllow: string[]; insecureTls: string[] };
  checks: DoctorCheck[];
  checkedAt: string;
}

interface Target {
  label: string;
  url: string;
  source: string;
}

const TIMEOUT_MS = 2500;
const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

function isLoopback(host: string): boolean {
  return LOOPBACK.includes(host) || host.startsWith('127.') || host.endsWith('.localhost');
}

/** Every URL stubyard would call for this project. */
export function projectTargets(hub: Hub, project: Project): Target[] {
  const out: Target[] = [];
  for (const inst of hub.providers.list(project.id)) {
    for (const [key, v] of Object.entries(inst.config ?? {})) {
      if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) {
        out.push({ label: `${inst.name || inst.slug} · ${key}`, url: v.trim(), source: `provider ${inst.slug} (${inst.preset}) config.${key}` });
      }
    }
  }
  for (const t of hub.webhooks.listTemplates(project.id)) {
    let url = t.targetUrl;
    if (url.includes('{{')) {
      try {
        url = hub.webhookService.prepare(t, {}).url;
      } catch {
        /* keep the raw URL */
      }
    }
    out.push({ label: `Webhook template "${t.name}"`, url, source: `webhook template ${t.name}` });
  }
  return out;
}

function tcpConnect(host: string, port: number): Promise<{ ok: true; ms: number } | { ok: false; code: string; message: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    const done = (r: { ok: true; ms: number } | { ok: false; code: string; message: string }) => {
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(TIMEOUT_MS, () => done({ ok: false, code: 'ETIMEDOUT', message: `no answer within ${TIMEOUT_MS / 1000}s` }));
    sock.once('connect', () => done({ ok: true, ms: Date.now() - started }));
    sock.once('error', (e: Error & { code?: string }) => done({ ok: false, code: e.code ?? 'ERROR', message: e.message }));
  });
}

function httpProbe(url: URL, insecure: boolean): Promise<{ ok: true; status: number } | { ok: false; code: string; message: string }> {
  return new Promise((resolve) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'HEAD', timeout: TIMEOUT_MS, rejectUnauthorized: !insecure, headers: { 'user-agent': 'stubyard doctor' } }, (res) => {
      res.resume();
      resolve({ ok: true, status: res.statusCode ?? 0 });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`no HTTP answer within ${TIMEOUT_MS / 1000}s`), { code: 'ETIMEDOUT' })));
    req.on('error', (e: Error & { code?: string }) => resolve({ ok: false, code: e.code ?? 'ERROR', message: e.message }));
    req.end();
  });
}

function explainConnect(code: string, host: string, port: number, container: boolean): string {
  const hp = `${host}:${port}`;
  if (code === 'ECONNREFUSED') {
    if (isLoopback(host) && container) {
      return `ECONNREFUSED to ${hp}: inside stubyard's container, "${host}" is stubyard itself, not your machine. Use http://host.docker.internal:${port} for an app running on your machine, or the service name (e.g. http://app:${port}) for an app container on the "stubyard" network.`;
    }
    if (host === 'host.docker.internal' || host === 'gateway.docker.internal') {
      return `ECONNREFUSED to ${hp}: is your app listening on 0.0.0.0? An app bound to 127.0.0.1 is unreachable from containers (Linux). Start it with --host 0.0.0.0 (or HOST=0.0.0.0), or run stubyard with host networking (deploy/docker-compose.host-network.yml). Also check that it really listens on port ${port}.`;
    }
    return `ECONNREFUSED to ${hp}: nothing is listening there. Is your app running, on port ${port}, and listening on 0.0.0.0 (not only 127.0.0.1)?`;
  }
  if (code === 'ETIMEDOUT') {
    return `No answer from ${hp} within ${TIMEOUT_MS / 1000}s: a firewall (ufw / firewalld / Windows Defender) probably drops traffic from the Docker network to that port, or the host is down.`;
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `${hp} is unreachable from stubyard (no route). Is the address right, and is that network reachable from the container?`;
  return `${code} connecting to ${hp}.`;
}

function explainDns(code: string, host: string, container: boolean): string {
  if (host === 'host.docker.internal') {
    return `stubyard cannot resolve host.docker.internal. On Linux add it to the container: --add-host=host.docker.internal:host-gateway (docker run) or extra_hosts: ["host.docker.internal:host-gateway"] (compose; deploy/docker-compose.yml already has it).`;
  }
  if (!host.includes('.')) {
    return `stubyard cannot resolve "${host}" (${code}). A docker service name only resolves when that container is on the same network as stubyard: add "networks: [stubyard]" to it (see deploy/docker-compose.app-example.yml) and make sure it is running.`;
  }
  return `stubyard cannot resolve "${host}" (${code}).${container ? ' Names from your machine\'s /etc/hosts are not visible inside the container: use host.docker.internal or add extra_hosts.' : ''}`;
}

async function checkUrl(t: Target, container: boolean): Promise<DoctorCheck> {
  const steps: DoctorStep[] = [];
  const fail = (message: string, hint?: string): DoctorCheck => ({ kind: 'url', label: t.label, url: t.url, source: t.source, status: 'fail', message, hint, steps });
  let url: URL;
  try {
    url = new URL(t.url);
  } catch {
    return fail(`"${t.url}" is not a valid URL.`);
  }
  if (t.url.includes('{{')) steps.push({ step: 'allowlist', status: 'warn', detail: 'URL still contains {{placeholders}} after rendering with empty data' });

  // 1. allowlist
  const allow = await checkOutboundUrl(t.url);
  steps.push({ step: 'allowlist', status: allow.allowed ? 'ok' : 'fail', detail: allow.reason });
  if (!allow.allowed) return fail(`Blocked by the outbound allowlist: stubyard will not call ${allow.host}.`, allow.reason);

  // 2. DNS
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  let address = host;
  if (!net.isIP(host)) {
    try {
      const addrs = await dns.lookup(host, { all: true });
      address = addrs[0].address;
      steps.push({ step: 'dns', status: 'ok', detail: `${host} → ${addrs.map((a) => a.address).join(', ')}` });
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'ENOTFOUND';
      steps.push({ step: 'dns', status: 'fail', detail: `${code}` });
      return fail(`DNS: cannot resolve ${host}.`, explainDns(code, host, container));
    }
  } else steps.push({ step: 'dns', status: 'skip', detail: 'IP address, no lookup needed' });

  // 3. TCP
  const tcp = await tcpConnect(address, port);
  if (!tcp.ok) {
    steps.push({ step: 'tcp', status: 'fail', detail: `${tcp.code}: ${tcp.message}` });
    return fail(`Cannot connect to ${host}:${port} (${tcp.code}).`, explainConnect(tcp.code, host, port, container));
  }
  steps.push({ step: 'tcp', status: 'ok', detail: `connected to ${address}:${port} in ${tcp.ms} ms` });

  // 4. HTTP
  const insecure = url.protocol === 'https:' && hostMatches(host.toLowerCase(), outboundPolicy().insecureTls);
  const res = await httpProbe(url, insecure);
  if (!res.ok) {
    steps.push({ step: 'http', status: 'fail', detail: `${res.code}: ${res.message}` });
    const tls = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|SSL|EPROTO/i.test(`${res.code} ${res.message}`);
    return fail(
      tls ? `TLS: ${res.code} talking HTTPS to ${host}:${port}.` : `TCP works but HTTP failed (${res.code}).`,
      tls
        ? `Your app uses a certificate stubyard does not trust (self-signed?). Set STUBYARD_OUTBOUND_INSECURE_TLS=1 (or =${host}), or call it over plain http. If the port speaks plain HTTP, use http:// instead of https://.`
        : `Something answers on ${host}:${port} but not with HTTP${url.protocol === 'https:' ? 'S' : ''}: wrong port or scheme?`,
    );
  }
  const st = res.status;
  const note =
    st >= 500
      ? `the app answered ${st} to a HEAD probe: reachable, but it errors (check the app's logs)`
      : st === 404 || st === 405
        ? `the app answered ${st} to a HEAD probe: reachable (callback routes usually accept POST only, so this is normal; double-check the path if real callbacks also get ${st})`
        : `the app answered ${st}`;
  steps.push({ step: 'http', status: st >= 500 ? 'warn' : 'ok', detail: note });
  const loopNote = isLoopback(host) && container ? ' Note: inside a container this reaches stubyard itself, not your machine.' : '';
  return {
    kind: 'url',
    label: t.label,
    url: t.url,
    source: t.source,
    status: st >= 500 || loopNote ? 'warn' : 'ok',
    message: `Reachable: ${note}.${loopNote}`,
    steps,
  };
}

async function checkMailpit(hub: Hub): Promise<DoctorCheck> {
  if (!hub.mailpit) return { kind: 'mailpit', label: 'Mailpit (email storage)', status: 'skip', message: 'Mailpit is disabled in this process.' };
  try {
    const r = await fetch(`${hub.mailpit.baseUrl}/api/v1/info`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const info = (await r.json()) as { Version?: string; Messages?: number };
    return { kind: 'mailpit', label: 'Mailpit (email storage)', status: 'ok', message: `Mailpit ${info.Version ?? ''} is up${info.Messages !== undefined ? `, ${info.Messages} stored emails` : ''}.` };
  } catch (err) {
    return {
      kind: 'mailpit',
      label: 'Mailpit (email storage)',
      status: 'fail',
      message: `Mailpit does not answer at ${hub.mailpit.baseUrl}: ${(err as Error).message}.`,
      hint: 'Emails cannot be stored or shown. Restart stubyard; if it persists, check the container logs (docker compose logs stubyard).',
    };
  }
}

function checkTls(hub: Hub, requestHost: string | null): DoctorCheck {
  if (!hub.tls) return { kind: 'tls', label: 'HTTPS certificate', status: 'skip', message: 'HTTPS is disabled.' };
  const names = hub.tls.names;
  const host = requestHost?.toLowerCase() ?? null;
  const covered = !host || names.map((n) => n.toLowerCase()).includes(host);
  return {
    kind: 'tls',
    label: 'HTTPS certificate',
    status: covered ? 'ok' : 'warn',
    message: `Certificate names: ${names.join(', ')}.`,
    hint: covered
      ? 'Apps must trust the stubyard CA (HTTPS setup page) and use one of these names in the URL.'
      : `You reached stubyard as "${host}", which is not in the certificate: HTTPS calls to https://${host}:${hub.config.httpsPort} will fail verification. Add it with STUBYARD_TLS_NAMES=${host} and restart (the certificate is re-issued).`,
  };
}

function checkNetwork(hub: Hub, container: boolean): DoctorCheck {
  const policy = outboundPolicy();
  const open = policy.allow.includes('*');
  return {
    kind: 'network',
    label: 'Outbound calls',
    status: open ? 'warn' : 'ok',
    message: open
      ? 'The outbound allowlist is disabled (STUBYARD_OUTBOUND_ALLOW=*): stubyard will call any URL, including production ones from imported configs.'
      : `stubyard only calls: ${policy.allow.join(', ')}.`,
    hint: `${container ? 'stubyard runs in a container: "localhost" in a callback URL means stubyard itself; use host.docker.internal or a service name. ' : ''}Self-signed HTTPS accepted for: ${policy.insecureTls.length ? policy.insecureTls.join(', ') : 'none (STUBYARD_OUTBOUND_INSECURE_TLS)'}.`,
  };
}

export async function runDoctor(hub: Hub, project: Project, opts: { requestHost?: string | null } = {}): Promise<DoctorReport> {
  const container = inContainer();
  const targets = projectTargets(hub, project);
  // Same URL configured twice (e.g. one callback for SMS and WhatsApp): probe once.
  const seen = new Map<string, Promise<DoctorCheck>>();
  const urlChecks = await Promise.all(
    targets.map(async (t) => {
      if (!seen.has(t.url)) seen.set(t.url, checkUrl(t, container));
      const c = await seen.get(t.url)!;
      return { ...c, label: t.label, source: t.source };
    }),
  );
  const checks: DoctorCheck[] = [checkNetwork(hub, container), await checkMailpit(hub), checkTls(hub, opts.requestHost ?? null), ...urlChecks];
  if (!targets.length) {
    checks.push({
      kind: 'url',
      label: 'App URLs',
      status: 'skip',
      message: 'No callback / inbound / event webhook / webhook template URLs are configured for this project yet.',
      hint: 'Set them in Providers (status callback URL, inbound URL, event webhook URL) or Webhooks → templates.',
    });
  }
  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status]++;
  const p = outboundPolicy();
  return {
    project: project.slug,
    ok: summary.fail === 0,
    summary,
    environment: { inContainer: container, listen: hub.config.host, outboundAllow: p.allow, insecureTls: p.insecureTls },
    checks,
    checkedAt: new Date().toISOString(),
  };
}

export async function registerDoctorRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  app.get<{ Params: { slug: string } }>('/api/projects/:slug/doctor', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const h = String(req.headers.host ?? '');
    const host = h ? (h.startsWith('[') ? h.slice(1, h.indexOf(']')) : h.split(':')[0]) : null;
    return runDoctor(hub, p, { requestHost: host });
  });
}
