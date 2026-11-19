import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Hub } from '../../hub.js';
import { HttpError } from '../../util.js';

/**
 * GET /api/agent-guide — the agent guide (docs/AGENT_GUIDE.md, embedded in the image at /app/docs) as Markdown, with
 * the host and ports rewritten to the ones the caller used to reach devhub. Someone behind an SSH tunnel
 * (localhost:14000 → devhub:4000) gets localhost:14000 / 14443 / 11025 in every example.
 *
 * Ports: the guide's examples use 4000 / 4443 / 1025. The caller's port (from the Host header) and its offset from
 * devhub's own port are applied to all three (a tunnel usually shifts them all the same way); ?http_port=,
 * ?https_port=, ?smtp_port= and ?host= override that, ?raw=1 returns the file unchanged.
 */

const DOC = { http: 4000, https: 4443, smtp: 1025 };

export function guideCandidates(hub: Hub): string[] {
  return [
    ...(hub.config.agentGuideFile ? [hub.config.agentGuideFile] : []),
    // src/http/routes → repo root (dev) · dist/http/routes → /app (image: /app/docs/AGENT_GUIDE.md)
    fileURLToPath(new URL('../../../../docs/AGENT_GUIDE.md', import.meta.url)),
  ];
}

export interface GuideAddress {
  host: string;
  http: number;
  https: number;
  smtp: number;
  derived: boolean;
}

const port = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
};

export function guideAddress(hub: Hub, req: FastifyRequest): GuideAddress {
  const q = (req.query ?? {}) as Record<string, string | undefined>;
  const cfg = hub.config;
  const hostHeader = String(req.headers.host ?? '');
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader);
  let host = m ? m[1].toLowerCase() : 'localhost';
  if (host === '0.0.0.0') host = 'localhost';
  const secure = req.protocol === 'https';
  const reqPort = m?.[2] ? Number(m[2]) : null;
  let ports = { http: cfg.httpPort, https: cfg.httpsPort, smtp: cfg.smtpPort };
  let derived = false;
  if (reqPort) {
    const offset = reqPort - (secure ? cfg.httpsPort : cfg.httpPort);
    const shifted = { http: cfg.httpPort + offset, https: cfg.httpsPort + offset, smtp: cfg.smtpPort + offset };
    if (offset !== 0 && Object.values(shifted).every((p) => port(p))) {
      ports = shifted;
      derived = true;
    }
  }
  return {
    host: q.host ? String(q.host) : host,
    http: port(q.http_port) ?? ports.http,
    https: port(q.https_port) ?? ports.https,
    smtp: port(q.smtp_port) ?? ports.smtp,
    derived,
  };
}

export function renderGuide(markdown: string, a: GuideAddress, selfUrl: string): string {
  const map: Record<number, number> = { [DOC.http]: a.http, [DOC.https]: a.https, [DOC.smtp]: a.smtp };
  let out = markdown
    .replace(/\blocalhost:(4000|4443|1025)\b/g, (_m, p: string) => `${a.host}:${map[Number(p)]}`)
    // Port tables: | `4000` | … and "port **`1025`**"
    .replace(/`(4000|4443|1025)`/g, (_m, p: string) => `\`${map[Number(p)]}\``);
  const changed = a.host !== 'localhost' || a.http !== DOC.http || a.https !== DOC.https || a.smtp !== DOC.smtp;
  const note =
    `> Served by devhub at \`${selfUrl}\`. Addresses in this copy: API/dashboard \`http://${a.host}:${a.http}\`, ` +
    `HTTPS \`https://${a.host}:${a.https}\`, SMTP \`${a.host}:${a.smtp}\`` +
    (a.derived ? ' (HTTPS/SMTP ports derived from the port you used; override with `?https_port=…&smtp_port=…`)' : '') +
    '.' +
    (changed ? ' App containers on the `devhub` Docker network still use `devhub:4000` / `devhub:4443` / `devhub:1025`.' : '') +
    '\n';
  const firstBreak = out.indexOf('\n');
  out = firstBreak >= 0 && out.startsWith('# ') ? `${out.slice(0, firstBreak + 1)}\n${note}${out.slice(firstBreak + 1)}` : `${note}\n${out}`;
  return out;
}

export async function registerAgentGuideRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/agent-guide', async (req, reply) => {
    const file = guideCandidates(hub).find((f) => fs.existsSync(f));
    if (!file) throw new HttpError(404, 'Agent guide not found (set DEVHUB_AGENT_GUIDE to the path of AGENT_GUIDE.md)');
    const md = fs.readFileSync(file, 'utf8');
    const raw = ['1', 'true', 'yes'].includes(String(req.query.raw ?? ''));
    const a = guideAddress(hub, req);
    const self = `${req.protocol}://${req.headers.host ?? `localhost:${hub.config.httpPort}`}/api/agent-guide`;
    const text = raw ? md : renderGuide(md, a, self);
    reply.type('text/markdown; charset=utf-8');
    if (['1', 'true', 'yes'].includes(String(req.query.download ?? ''))) reply.header('content-disposition', 'attachment; filename="DEVHUB_AGENT_GUIDE.md"');
    return text;
  });
}
