import type { RunReport } from './report.js';
import { formatOffset } from '../clock/clock.js';

/**
 * A run report as one self-contained HTML page (inline CSS, no scripts, no external assets): readable offline,
 * printable, light / dark via prefers-color-scheme. Every value from the report is HTML-escaped.
 */
export interface ReportHtmlContext {
  project: { slug: string; name: string };
  version: string;
  generatedAt: string;
}

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '<span class="faint">–</span>' : esc(v));

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const time = (iso: string | null | undefined) => (iso ? `<time datetime="${esc(iso)}">${esc(iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z'))}</time>` : dash(null));

const PROBLEM_STATUS = new Set(['failed', 'rejected', 'bounced', 'timeout']);
const pill = (text: unknown, kind = '') => `<span class="pill${kind ? ` ${kind}` : ''}">${esc(text)}</span>`;
const levelKind = (l: string | null | undefined) => (l === 'error' ? 'bad' : l === 'warn' ? 'warn' : l === 'info' ? 'info' : '');

function counts(o: Record<string, number>, kindOf: (k: string) => string = () => ''): string {
  const e = Object.entries(o);
  if (!e.length) return '<span class="faint">none</span>';
  return e
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => pill(`${k} ${n}`, kindOf(k)))
    .join(' ');
}

function table(head: string[], rows: string[][], empty: string): string {
  if (!rows.length) return `<p class="faint">${esc(empty)}</p>`;
  return `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

const section = (id: string, title: string, count: number | null, body: string) =>
  `<section id="${id}"><h2>${esc(title)}${count !== null ? ` <span class="count">${count}</span>` : ''}</h2>${body}</section>`;

const CSS = `
:root{color-scheme:light dark;--bg:#f7f7f8;--card:#fff;--fg:#1d1d22;--muted:#5e6070;--faint:#8a8c99;--line:#e3e4ea;--accent:#3b5bdb;
--ok:#1b7f3b;--ok-bg:#e3f5e8;--bad:#b42318;--bad-bg:#fde8e6;--warn:#8a5a00;--warn-bg:#fff3d6;--info:#1d5fa8;--info-bg:#e5f0fb}
@media (prefers-color-scheme:dark){:root{--bg:#141418;--card:#1d1d23;--fg:#e8e8ee;--muted:#a8aab8;--faint:#7c7e8c;--line:#30313a;--accent:#8ea4ff;
--ok:#6fd38f;--ok-bg:#16301f;--bad:#ff8a80;--bad-bg:#3a1916;--warn:#ffc96b;--warn-bg:#352a12;--info:#8cc1ff;--info-bg:#15283d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:1600px;margin:0 auto;padding:24px clamp(12px,3vw,40px) 48px}
header.top{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;margin-bottom:8px}
h1{font-size:clamp(20px,3vw,28px);margin:0}
h1 code{font-size:inherit}
h2{font-size:17px;margin:0 0 10px}
.count{font-size:12px;font-weight:600;color:var(--muted);background:var(--line);border-radius:999px;padding:1px 8px;vertical-align:middle}
.sub{color:var(--muted);margin:0 0 16px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 16px;break-inside:avoid}
dl.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}
dl.kv dt{color:var(--muted)}dl.kv dd{margin:0;overflow-wrap:anywhere}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:0 0 16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.tile b{display:block;font-size:24px;line-height:1.2}
.tile span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.tile.bad b{color:var(--bad)}.tile.warn b{color:var(--warn)}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;min-width:560px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600;white-space:nowrap}
td{overflow-wrap:anywhere}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;background:var(--line);color:var(--fg);white-space:nowrap;margin:1px 0}
.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.bad{background:var(--bad-bg);color:var(--bad)}
.pill.warn{background:var(--warn-bg);color:var(--warn)}.pill.info{background:var(--info-bg);color:var(--info)}
.warnings{border-color:var(--warn);background:var(--warn-bg);color:var(--warn)}
.warnings ul{margin:0;padding-left:20px}
.faint{color:var(--faint)}.muted{color:var(--muted)}
.row{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px;align-items:center}
.findings{margin:4px 0 0;padding-left:18px}
footer{color:var(--faint);font-size:12px;text-align:center;margin-top:24px}
@media print{body{background:#fff;color:#000}section,.tile{border-color:#ccc;break-inside:avoid}.scroll{overflow:visible}table{min-width:0}main{max-width:none;padding:0}}
`;

/** The run report as a standalone HTML document. */
export function renderRunReportHtml(report: RunReport, ctx: ReportHtmlContext): string {
  const r = report.run;
  const problems = report.traffic.problems.length;
  const failedMsgs = report.messages.items.filter((m) => PROBLEM_STATUS.has(m.status)).length;
  const metaEntries = Object.entries(r.meta ?? {}).filter(([k]) => k !== 'timeOffsets');
  const offsets = (r.meta as { timeOffsets?: Record<string, number> } | undefined)?.timeOffsets;
  const parts: string[] = [];

  parts.push(`<header class="top"><h1>Run <code>${esc(r.key)}</code></h1>${pill(r.status, r.status === 'active' ? 'ok' : '')}</header>
<p class="sub">${r.label ? `${esc(r.label)} · ` : ''}${esc(ctx.project.name)} <span class="mono">(${esc(ctx.project.slug)})</span></p>`);

  parts.push(
    section(
      'run',
      'Run',
      null,
      `<dl class="kv"><dt>Key</dt><dd class="mono">${esc(r.key)}</dd><dt>Id</dt><dd class="mono">${esc(r.id)}</dd><dt>Status</dt><dd>${esc(r.status)}</dd>
<dt>Started</dt><dd>${time(r.startedAt)}</dd><dt>Stopped</dt><dd>${time(r.stoppedAt)}</dd><dt>Duration</dt><dd>${esc(duration(r.durationMs))}</dd>${
        offsets && Object.keys(offsets).length ? `<dt>Clock offsets</dt><dd class="mono">${Object.entries(offsets).map(([f, ms]) => esc(`${f} ${formatOffset(Number(ms))}`)).join(', ')}</dd>` : ''
      }${metaEntries.map(([k, v]) => `<dt>${esc(k)}</dt><dd class="mono">${esc(typeof v === 'string' ? v : JSON.stringify(v))}</dd>`).join('')}</dl>`,
    ),
  );

  if (report.warnings.length) parts.push(`<section id="warnings" class="warnings"><h2>Warnings</h2><ul>${report.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></section>`);

  const tile = (n: number, label: string, kind = '') => `<div class="tile${kind ? ` ${kind}` : ''}"><b>${n}</b><span>${esc(label)}</span></div>`;
  parts.push(
    `<div class="tiles">${[
      tile(report.users.length, 'Users'),
      tile(report.messages.total, 'Messages', failedMsgs ? 'warn' : ''),
      tile(report.traffic.total, 'Requests'),
      tile(problems, 'Problems', problems ? 'bad' : ''),
      tile(report.lint.error, 'Lint errors', report.lint.error ? 'bad' : ''),
      tile(report.lint.warn, 'Lint warnings', report.lint.warn ? 'warn' : ''),
    ].join('')}</div>`,
  );

  parts.push(
    section(
      'users',
      'Users',
      report.users.length,
      table(
        ['Name', 'Role', 'Email', 'Phone'],
        report.users.map((u) => [esc(u.name), esc(u.role), u.email ? `<span class="mono">${esc(u.email)}</span>` : dash(null), u.phone ? `<span class="mono">${esc(u.phone)}</span>` : dash(null)]),
        'No test users in this run.',
      ),
    ),
  );

  parts.push(
    section(
      'messages',
      'Messages',
      report.messages.total,
      `<div class="row"><span class="muted">By channel</span> ${counts(report.messages.byChannel)}</div>
<div class="row"><span class="muted">By status</span> ${counts(report.messages.byStatus, (k) => (PROBLEM_STATUS.has(k) ? 'bad' : k === 'delivered' || k === 'read' ? 'ok' : ''))}</div>${table(
        ['Channel', 'To', 'Subject', 'Status', 'OTP', 'Rule', 'Lint', 'Time'],
        report.messages.items.map((m) => [
          esc(m.channel),
          `<span class="mono">${esc(m.to)}</span>`,
          dash(m.subject),
          pill(m.status, PROBLEM_STATUS.has(m.status) ? 'bad' : m.status === 'delivered' || m.status === 'read' ? 'ok' : ''),
          m.otp ? `<code>${esc(m.otp)}</code>` : dash(null),
          dash(m.appliedRule),
          m.lint ? pill(m.lint, levelKind(m.lint)) : dash(null),
          time(m.createdAt),
        ]),
        'No messages were captured in this run.',
      )}`,
    ),
  );

  parts.push(
    section(
      'lint',
      'Content checks',
      report.lint.messages,
      `<div class="row"><span class="muted">By check</span> ${counts(report.lint.byCheck)}</div>${table(
        ['Level', 'Channel', 'To', 'Findings'],
        report.lint.items.map((i) => [
          pill(i.level, levelKind(i.level)),
          esc(i.channel),
          `<span class="mono">${esc(i.to)}</span>`,
          `<ul class="findings">${i.findings
            .map((f) => `<li>${pill(f.severity, levelKind(f.severity))} <code>${esc(f.check)}</code> ${esc(f.message)}${f.excerpt ? ` <span class="faint mono">${esc(f.excerpt)}</span>` : ''}</li>`)
            .join('')}</ul>`,
        ]),
        'No content findings.',
      )}`,
    ),
  );

  parts.push(
    section(
      'traffic',
      'Traffic',
      report.traffic.total,
      `<div class="row"><span class="muted">By outcome</span> ${counts(report.traffic.byOutcome, (k) => (k === 'ok' || k === 'delivered' ? 'ok' : k === 'pending' ? '' : 'bad'))}</div>
<h3 class="muted" style="font-size:14px;margin:12px 0 6px">Problems (${problems})</h3>${table(
        ['Method', 'URL', 'Status', 'Outcome', 'Error'],
        report.traffic.problems.map((p) => [dash(p.method), p.url ? `<span class="mono">${esc(p.url)}</span>` : dash(null), dash(p.resStatus), pill(p.outcome, 'bad'), dash(p.errorMessage)]),
        'No problem requests.',
      )}`,
    ),
  );

  parts.push(section('rules', 'Rules', report.rules.length, table(['Owner', 'Rule', 'Hits'], report.rules.map((x) => [`<span class="mono">${esc(x.owner)}</span>`, esc(x.description), esc(x.hits)]), 'No scenario rules were set in this run.')));
  parts.push(section('mocks', 'Mock overrides', report.mocks.length, table(['Mock', 'Scenario', 'Hits'], report.mocks.map((x) => [esc(x.mock), esc(x.scenario), esc(x.hits)]), 'No mock scenarios were overridden in this run.')));

  if (report.storage) {
    const st = report.storage;
    parts.push(
      section(
        'storage',
        'File storage',
        st.items.length,
        `<div class="row">${pill(`uploads ${st.uploads}`)} ${pill(`bytes ${st.bytes}`)} ${pill(`downloads ${st.downloads}`)} ${pill(`deletes ${st.deletes}`)}</div>${table(
          ['Op', 'Bucket', 'Key', 'Size', 'Type', 'Status'],
          st.items.map((i) => [esc(i.op), dash(i.bucket), i.key ? `<span class="mono">${esc(i.key)}</span>` : dash(null), dash(i.size), dash(i.contentType), i.status !== null ? pill(i.status, i.status < 300 ? 'ok' : 'bad') : dash(null)]),
          'No object operations.',
        )}${st.rules.length ? table(['Instance', 'Rule', 'Op', 'Hits'], st.rules.map((x) => [esc(x.instance), esc(x.label ?? x.action), esc(x.op), esc(x.hits)]), '') : ''}`,
      ),
    );
  }

  const title = `stubyard run ${r.key} · ${ctx.project.name}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="stubyard ${esc(ctx.version)}"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>
${parts.join('\n')}
<footer>Generated by stubyard ${esc(ctx.version)} on ${esc(ctx.generatedAt)} · project ${esc(ctx.project.slug)} · run ${esc(r.key)}</footer>
</main></body></html>
`;
}
