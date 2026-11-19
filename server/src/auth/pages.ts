/**
 * Server-rendered pages of the fake login providers: the account picker, error page, Apple-style form_post and the
 * signed-out page. Standalone HTML (no JavaScript needed, except to auto-submit form_post) with the dashboard's
 * colour tokens, dark/light by prefers-color-scheme, responsive from phones up.
 */

export const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const CSS = `
:root{--bg:#f5f6f8;--panel:#fff;--panel-2:#f2f4f7;--panel-3:#e9ecf1;--border:#e2e5ea;--border-strong:#cfd4dc;--text:#15171c;--muted:#5d6471;--faint:#8f96a3;
--accent:#4f46e5;--accent-strong:#4338ca;--accent-soft:#eef0ff;--accent-text:#3730a3;--ok:#15803d;--ok-soft:#e7f6ec;--warn:#b45309;--warn-soft:#fdf3e3;--bad:#b91c1c;--bad-soft:#fdeceb;
--code-bg:#f6f7f9;--radius:8px;--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b0c10;--panel:#111318;--panel-2:#171a21;--panel-3:#1e222b;--border:#23272f;--border-strong:#323843;--text:#e7e9ee;--muted:#9ba2ae;--faint:#656c78;
--accent:#7c83ff;--accent-strong:#6a72ff;--accent-soft:rgba(124,131,255,.14);--accent-text:#b9bdff;--ok:#4ade80;--ok-soft:rgba(74,222,128,.12);--warn:#fbbf24;--warn-soft:rgba(251,191,36,.12);
--bad:#f87171;--bad-soft:rgba(248,113,113,.12);--code-bg:#0e1015;color-scheme:dark}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--text);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased;min-height:100vh;
display:flex;justify-content:center;align-items:flex-start;padding:32px 16px}
.wrap{width:100%;max-width:560px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.head{padding:18px 20px;border-bottom:1px solid var(--border);display:flex;gap:12px;align-items:center}
.logo{width:36px;height:36px;border-radius:9px;background:var(--accent-soft);color:var(--accent-text);display:grid;place-items:center;font-weight:700;flex:none}
h1{font-size:17px;margin:0;line-height:1.3}h1 small{display:block;font-size:12.5px;color:var(--muted);font-weight:400}
.sec{padding:14px 20px;border-bottom:1px solid var(--border)}
.meta{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12.5px}
.meta dt{color:var(--muted)}.meta dd{margin:0;font-family:var(--mono);word-break:break-all}
.chip{display:inline-block;background:var(--panel-3);border-radius:999px;padding:0 8px;margin:0 4px 4px 0;font-size:11.5px;font-family:var(--mono)}
.warn{background:var(--warn-soft);color:var(--warn);border:1px solid color-mix(in srgb,var(--warn) 30%,transparent);border-radius:var(--radius);padding:10px 12px;font-size:12.5px}
.warn b{display:block;margin-bottom:4px}.warn ul{margin:0;padding-left:18px}
.err{background:var(--bad-soft);color:var(--bad);border-radius:var(--radius);padding:10px 12px}
.label{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);margin:0 0 8px}
.users{display:flex;flex-direction:column;gap:6px}
button{font:inherit;color:inherit;cursor:pointer}
.user{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;min-height:52px}
.user:hover,.user:focus-visible{border-color:var(--accent);outline:none;background:var(--accent-soft)}
.av{width:34px;height:34px;border-radius:50%;background:var(--panel-3);display:grid;place-items:center;font-weight:600;font-size:12.5px;flex:none}
.who{min-width:0;flex:1}.who .n{font-weight:600;display:flex;flex-wrap:wrap;gap:6px;align-items:center}.who .e{color:var(--muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{font-size:10.5px;font-weight:600;border-radius:4px;padding:0 5px;background:var(--panel-3);color:var(--muted)}
.badge.warn{background:var(--warn-soft);color:var(--warn);border:0;padding:0 5px}.badge.bad{background:var(--bad-soft);color:var(--bad)}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.btn{background:var(--panel-2);border:1px solid var(--border-strong);border-radius:var(--radius);padding:8px 14px;min-height:38px}
.btn:hover{border-color:var(--accent)}.btn.danger{color:var(--bad)}.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
details summary{cursor:pointer;color:var(--muted);font-size:12.5px;padding:6px 0;list-style:none}details summary::-webkit-details-marker{display:none}
details summary::before{content:'▸ '}details[open] summary::before{content:'▾ '}
.outs{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:6px;margin-top:6px}
.outs .btn{font-family:var(--mono);font-size:12px;text-align:left}
.choice{display:flex;flex-direction:column;gap:6px}.choice label{display:flex;gap:8px;align-items:flex-start;background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;cursor:pointer}
.choice code{font-family:var(--mono);font-size:12px;color:var(--muted)}
.foot{padding:12px 20px;color:var(--faint);font-size:12px}
.foot a{color:var(--accent-text)}
.empty{color:var(--muted);font-size:13px}
@media (max-width:480px){body{padding:0}.card{border-radius:0;border-left:0;border-right:0}.head,.sec,.foot{padding-left:16px;padding-right:16px}.meta{grid-template-columns:1fr}.meta dt{margin-top:6px}}
`;

function page(title: string, body: string, extraHead = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style>${extraHead}</head><body><div class="wrap">${body}</div></body></html>`;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^\p{L}/u.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

export interface PickerUser {
  id: string;
  name: string;
  role: string;
  email: string | null;
  badges: { text: string; kind?: 'warn' | 'bad' }[];
}

export interface PickerInput {
  presetName: string;
  providerName: string;
  projectName: string;
  clientId: string;
  clientName?: string | null;
  redirectUri: string;
  scopes: string[];
  warnings: string[];
  users: PickerUser[];
  reqId: string;
  action: string;
  apple: boolean;
  outcomes: string[];
  dashboardUrl: string;
  notice?: string | null;
}

export function renderPicker(i: PickerInput): string {
  const users = i.users.length
    ? i.users
        .map(
          (u) => `<button type="submit" class="user" name="user" value="${esc(u.id)}" data-testid="devhub-user-${esc(u.id)}">
<span class="av" aria-hidden="true">${esc(initials(u.name))}</span>
<span class="who"><span class="n">${esc(u.name)} <span class="badge">${esc(u.role)}</span>${u.badges.map((b) => `<span class="badge ${b.kind ?? ''}">${esc(b.text)}</span>`).join('')}</span>
<span class="e">${u.email ? esc(u.email) : '<i>no email</i>'}</span></span></button>`,
        )
        .join('\n')
    : `<p class="empty">This project has no test users yet. Add some in the <a href="${esc(i.dashboardUrl)}">devhub dashboard</a>, then reload.</p>`;
  const warnings = i.warnings.length
    ? `<div class="sec"><div class="warn" role="alert" data-testid="devhub-warnings"><b>Would fail in production (devhub is lax by default):</b><ul>${i.warnings.map((w) => `<li>${esc(w.replace(/^Would fail in production: /, ''))}</li>`).join('')}</ul></div></div>`
    : '';
  const apple = i.apple
    ? `<div class="sec"><p class="label">Email to share with the app</p><div class="choice">
<label><input type="radio" name="apple_email" value="share" checked> <span>Share my email</span></label>
<label><input type="radio" name="apple_email" value="hide" data-testid="devhub-apple-hide"> <span>Hide my email <code>…@privaterelay.appleid.com</code></span></label></div></div>`
    : '';
  const body = `<form method="post" action="${esc(i.action)}" class="card">
<input type="hidden" name="req" value="${esc(i.reqId)}">
<div class="head"><div class="logo" aria-hidden="true">${esc(i.presetName.slice(0, 1))}</div>
<h1>Fake ${esc(i.presetName)} · ${esc(i.projectName)}<small>devhub login simulator — choose who signs in (${esc(i.providerName)})</small></h1></div>
${i.notice ? `<div class="sec"><div class="err">${esc(i.notice)}</div></div>` : ''}
<div class="sec"><dl class="meta">
<dt>Client</dt><dd data-testid="devhub-client">${esc(i.clientId)}${i.clientName ? ` (${esc(i.clientName)})` : ''}</dd>
<dt>Redirect URI</dt><dd>${esc(i.redirectUri)}</dd>
<dt>Scopes</dt><dd>${i.scopes.length ? i.scopes.map((s) => `<span class="chip">${esc(s)}</span>`).join('') : '<span class="chip">(none)</span>'}</dd>
</dl></div>
${warnings}${apple}
<div class="sec"><p class="label">Sign in as</p><div class="users">${users}</div></div>
<div class="sec"><div class="row"><button type="submit" class="btn danger" name="outcome" value="access_denied" data-testid="devhub-deny">Deny</button></div>
<details><summary>More outcomes</summary><div class="outs">${i.outcomes
    .map((o) => `<button type="submit" class="btn" name="outcome" value="${esc(o)}" data-testid="devhub-outcome-${esc(o)}">${esc(o)}</button>`)
    .join('')}</div></details></div>
<div class="foot">Nothing here talks to the real ${esc(i.presetName)}. <a href="${esc(i.dashboardUrl)}">Open devhub</a></div>
</form>`;
  return page(`Sign in – Fake ${i.presetName}`, body);
}

export function renderError(title: string, message: string, details: string[] = [], dashboardUrl?: string): string {
  return page(
    title,
    `<div class="card"><div class="head"><div class="logo" aria-hidden="true">!</div><h1>${esc(title)}<small>devhub login simulator</small></h1></div>
<div class="sec"><div class="err" data-testid="devhub-error">${esc(message)}</div>${details.length ? `<ul>${details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}</div>
${dashboardUrl ? `<div class="foot"><a href="${esc(dashboardUrl)}">Open devhub</a></div>` : ''}</div>`,
  );
}

/** response_mode=form_post: auto-submitting form (works without JS through the button). */
export function renderFormPost(action: string, fields: Record<string, string>): string {
  const inputs = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  return page(
    'Signing in…',
    `<form method="post" action="${esc(action)}" class="card" id="f">${inputs}<div class="head"><h1>Signing you in…<small>devhub login simulator</small></h1></div>
<div class="sec"><button type="submit" class="btn primary">Continue</button></div></form><script>document.getElementById('f').submit()</script>`,
  );
}

export function renderSignedOut(presetName: string): string {
  return page('Signed out', `<div class="card"><div class="head"><h1>You are signed out<small>Fake ${esc(presetName)} · devhub</small></h1></div><div class="sec">You can close this window.</div></div>`);
}

export function avatarSvg(name: string, seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" fill="hsl(${hue},55%,45%)"/><text x="48" y="58" font-family="system-ui,sans-serif" font-size="36" font-weight="600" fill="#fff" text-anchor="middle">${esc(initials(name))}</text></svg>`;
}
