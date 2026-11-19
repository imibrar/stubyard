import { useState } from 'react';
import { api } from '../api';
import { Icon } from '../components/people';
import { LogDrawer, StatusCode } from '../components/TrafficLog';
import { Badge, Empty, ErrorBox, Modal, OUTCOME_KIND, timeAgo, useCopy, useTick, useToast } from '../components/ui';
import { useProject } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { Page } from './ProjectPage';

// Types live here (not in api.ts) to keep this feature self-contained.
export type MockBehaviour = 'respond' | 'timeout' | 'drop';

export interface MockScenario {
  name: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  delayMs: number;
  behaviour: MockBehaviour;
}

export interface MockMatch {
  query?: Record<string, string>;
  headers?: Record<string, string>;
  bodyContains?: string | null;
  bodyJson?: Record<string, unknown>;
}

export interface ApiMock {
  id: string;
  name: string;
  description: string;
  method: string;
  path: string;
  match: MockMatch;
  scenarios: MockScenario[];
  activeScenario: string;
  position: number;
  enabled: boolean;
  hits: number;
  lastHitAt: string | null;
}

interface MockHit {
  id: string;
  method: string | null;
  url: string | null;
  resStatus: number | null;
  outcome: string;
  scenario: string | null;
  scenarioSource: string | null;
  receivedAt: string;
  durationMs: number | null;
}

const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** /p/:slug/mocks — rule-based API mocks with live scenario switching. */
export default function MocksPage() {
  const { slug } = useProject();
  const mocks = useFetch<ApiMock[]>(`/api/projects/${slug}/mocks`, [slug]);
  const reload = useDebounced(() => void mocks.reload(), 250);
  useHubEvents(slug, (e) => {
    if (e.type === 'mocks.changed' || e.type === 'log.created' || e.type === 'project.reset') reload();
  });
  useTick(15_000);
  const copy = useCopy();
  const [editing, setEditing] = useState<ApiMock | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const baseUrl = `${window.location.origin}/mock/${slug}/api`;
  const list = mocks.data ?? [];

  return (
    <Page
      title="API mocks"
      description={
        <>
          Fake any HTTP API your app calls. Requests to <code>{baseUrl}/…</code> are matched against the mocks below, top to bottom; the first match answers
          with its active scenario. Switch scenarios live, or send <code>X-Hub-Scenario: &lt;name&gt;</code> for one request.
        </>
      }
      actions={
        <>
          <button className="btn" onClick={() => copy(baseUrl, 'Base URL copied')}>
            <Icon name="copy" size={14} /> Copy base URL
          </button>
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> New mock
          </button>
        </>
      }
    >
      <ErrorBox error={mocks.error} />
      {list.length === 0 && !mocks.loading ? (
        <div className="card">
          <Empty title="No API mocks yet">
            <p className="muted">
              Add a mock such as <code>GET /users/:id</code> and point your app at <code>{baseUrl}</code>. Unmatched calls are answered with 404 and appear
              in the traffic log.
            </p>
            <button className="btn primary" onClick={() => setEditing('new')}>
              New mock
            </button>
          </Empty>
        </div>
      ) : (
        <div className="card">
          {list.map((m) => (
            <MockRow key={m.id} slug={slug} m={m} baseUrl={baseUrl} reload={() => void mocks.reload()} open={open === m.id} onToggle={() => setOpen(open === m.id ? null : m.id)} onEdit={() => setEditing(m)} />
          ))}
        </div>
      )}
      {editing && <MockEditor slug={slug} mock={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => void mocks.reload()} />}
    </Page>
  );
}

function MockRow({ slug, m, baseUrl, reload, open, onToggle, onEdit }: { slug: string; m: ApiMock; baseUrl: string; reload: () => void; open: boolean; onToggle: () => void; onEdit: () => void }) {
  const toast = useToast();
  const copy = useCopy();
  const ref = encodeURIComponent(m.id);
  const url = baseUrl + m.path.replace(/^\/$/, '');
  const run = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn();
      if (msg) toast(msg);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const active = m.scenarios.find((s) => s.name === m.activeScenario);
  return (
    <div style={{ borderBottom: '1px solid var(--border)', opacity: m.enabled ? 1 : 0.6 }}>
      <div className="row nowrap list-row" style={{ padding: '10px 14px' }}>
        <button className="btn xs ghost" onClick={onToggle} aria-expanded={open} aria-label="Recent hits">
          {open ? '▾' : '▸'}
        </button>
        <span className="faint mono small" title="Priority (checked top to bottom)">
          #{m.position}
        </span>
        <div className="grow" style={{ minWidth: 200 }}>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <span className="method">{m.method}</span>
            <span className="mono ellipsis">{m.path}</span>
            {!m.enabled && <Badge kind="warn">disabled</Badge>}
            {matchSummary(m.match) && <Badge title={matchSummary(m.match)!}>+ conditions</Badge>}
          </div>
          <div className="small muted ellipsis">
            {m.name}
            {m.description && ` · ${m.description}`}
          </div>
        </div>
        <label className="row small" style={{ gap: 4 }} title="Scenario every request gets (switch live)">
          <select
            value={m.activeScenario}
            onChange={(e) => run(() => api.patch(`/api/projects/${slug}/mocks/${ref}/active-scenario`, { scenario: e.target.value }), `Scenario: ${e.target.value}`)}
            style={{ width: 'auto', padding: '3px 6px', fontSize: 12.5 }}
          >
            {m.scenarios.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name} · {scenarioText(s)}
              </option>
            ))}
          </select>
        </label>
        {active && <Badge kind={active.behaviour !== 'respond' || active.status >= 400 ? 'accent' : 'ok'}>{scenarioText(active)}</Badge>}
        <span className="small faint" style={{ minWidth: 70, textAlign: 'right' }} title={m.lastHitAt ?? undefined}>
          {m.hits} hit{m.hits === 1 ? '' : 's'}
          {m.lastHitAt && <div>{timeAgo(m.lastHitAt)}</div>}
        </span>
        <div className="row-actions">
        <button className="btn sm ghost" onClick={() => copy(url, 'Mock URL copied')} title={url} aria-label="Copy mock URL">
          <Icon name="copy" size={12} />
        </button>
        <button className="btn sm ghost" onClick={() => run(() => api.patch(`/api/projects/${slug}/mocks/${ref}`, { enabled: !m.enabled }))}>
          {m.enabled ? 'Disable' : 'Enable'}
        </button>
        <button className="btn sm ghost" onClick={onEdit}>
          Edit
        </button>
        <button className="btn sm ghost danger" onClick={() => confirm(`Delete mock "${m.name}"?`) && run(() => api.del(`/api/projects/${slug}/mocks/${ref}`), 'Mock deleted')}>
          Delete
        </button>
        </div>
      </div>
      {open && <RecentHits slug={slug} m={m} />}
    </div>
  );
}

function RecentHits({ slug, m }: { slug: string; m: ApiMock }) {
  const hits = useFetch<MockHit[]>(`/api/projects/${slug}/mocks/${encodeURIComponent(m.id)}/hits?limit=20`, [m.id, m.hits]);
  const [logId, setLogId] = useState<string | null>(null);
  return (
    <div className="row-detail">
      <ErrorBox error={hits.error} />
      {(hits.data ?? []).length === 0 ? (
        <p className="small faint" style={{ margin: 0 }}>
          No calls yet (or they were removed by a reset / retention).
        </p>
      ) : (
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Request</th>
              <th>Scenario</th>
              <th>Status</th>
              <th>Outcome</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {hits.data!.map((h) => (
              <tr key={h.id} className="clickable" onClick={() => setLogId(h.id)}>
                <td className="small faint" title={h.receivedAt}>
                  {timeAgo(h.receivedAt)}
                </td>
                <td className="mono small ellipsis cell-fill">
                  <span className="method">{h.method}</span> {h.url}
                </td>
                <td className="small">
                  {h.scenario}
                  {h.scenarioSource === 'header' && <span className="faint"> (header)</span>}
                </td>
                <td>
                  <StatusCode code={h.resStatus} />
                </td>
                <td>
                  <Badge kind={OUTCOME_KIND[h.outcome]}>{h.outcome.replace('_', ' ')}</Badge>
                </td>
                <td className="small faint">{h.durationMs !== null ? `${h.durationMs} ms` : '…'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {logId && <LogDrawer id={logId} onClose={() => setLogId(null)} />}
    </div>
  );
}

function scenarioText(s: MockScenario): string {
  if (s.behaviour === 'timeout') return 'timeout';
  if (s.behaviour === 'drop') return 'drop connection';
  return `${s.status}${s.delayMs ? ` after ${s.delayMs >= 1000 ? `${s.delayMs / 1000}s` : `${s.delayMs}ms`}` : ''}`;
}

function matchSummary(m: MockMatch): string | null {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(m.query ?? {})) parts.push(`?${k}=${v}`);
  for (const [k, v] of Object.entries(m.headers ?? {})) parts.push(`${k}: ${v}`);
  if (m.bodyContains) parts.push(`body contains "${m.bodyContains}"`);
  for (const [k, v] of Object.entries(m.bodyJson ?? {})) parts.push(`body.${k} = ${JSON.stringify(v)}`);
  return parts.length ? parts.join(' · ') : null;
}

// ---------------- editor ----------------

const toLines = (o: Record<string, string> | undefined, sep: string) =>
  Object.entries(o ?? {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n');

function fromLines(text: string, sep: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = sep.exec(t);
    if (!m) out[t] = '*';
    else out[t.slice(0, m.index).trim()] = t.slice(m.index + m[0].length).trim();
  }
  return out;
}

interface ScenarioForm {
  name: string;
  status: string;
  behaviour: MockBehaviour;
  delayMs: string;
  headers: string;
  body: string;
}

const blankScenario = (name: string, status = '200', body = '{\n  "ok": true\n}'): ScenarioForm => ({ name, status, behaviour: 'respond', delayMs: '', headers: '', body });

function MockEditor({ slug, mock, onClose, onSaved }: { slug: string; mock: ApiMock | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: mock?.name ?? '',
    description: mock?.description ?? '',
    method: mock?.method ?? 'GET',
    path: mock?.path ?? '/',
    query: toLines(mock?.match.query, '='),
    headers: toLines(mock?.match.headers, ': '),
    bodyContains: mock?.match.bodyContains ?? '',
    bodyJson: mock?.match.bodyJson ? JSON.stringify(mock.match.bodyJson, null, 2) : '',
  });
  const [scenarios, setScenarios] = useState<ScenarioForm[]>(
    mock?.scenarios.map((s) => ({ name: s.name, status: String(s.status), behaviour: s.behaviour, delayMs: s.delayMs ? String(s.delayMs) : '', headers: toLines(s.headers, ': '), body: s.body })) ?? [
      blankScenario('OK', '200', '{\n  "id": "{{params.id}}",\n  "requestId": "{{uuid}}",\n  "at": "{{now}}"\n}'),
      blankScenario('Server error', '500', '{\n  "error": "Internal error"\n}'),
    ],
  );
  const [active, setActive] = useState(mock?.activeScenario ?? 'OK');
  const [error, setError] = useState<string | null>(null);
  const setScenario = (i: number, patch: Partial<ScenarioForm>) => {
    const next = scenarios.map((s, j) => (j === i ? { ...s, ...patch } : s));
    if (patch.name !== undefined && scenarios[i].name === active) setActive(patch.name);
    setScenarios(next);
  };

  const save = async () => {
    setError(null);
    let bodyJson: Record<string, unknown> | undefined;
    if (form.bodyJson.trim()) {
      try {
        bodyJson = JSON.parse(form.bodyJson);
      } catch {
        return setError('"Body JSON fields" must be a JSON object, e.g. { "user.email": "a@b.c" }');
      }
    }
    const payload = {
      name: form.name || undefined,
      description: form.description,
      method: form.method,
      path: form.path,
      match: {
        query: fromLines(form.query, /=/),
        headers: fromLines(form.headers, /:/),
        bodyContains: form.bodyContains || null,
        bodyJson: bodyJson ?? {},
      },
      scenarios: scenarios.map((s) => ({
        name: s.name,
        status: Number(s.status) || 200,
        behaviour: s.behaviour,
        delayMs: Number(s.delayMs) || 0,
        headers: fromLines(s.headers, /:/),
        body: s.body,
      })),
      activeScenario: active,
    };
    try {
      if (mock) await api.put(`/api/projects/${slug}/mocks/${encodeURIComponent(mock.id)}`, payload);
      else await api.post(`/api/projects/${slug}/mocks`, payload);
      toast(mock ? 'Mock saved' : 'Mock created');
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      title={mock ? `Edit "${mock.name}"` : 'New API mock'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            {mock ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={error} />
        <div className="form" style={{ gridTemplateColumns: '120px 1fr' }}>
          <label className="field">
            Method
            <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              {METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Path <span className="hint">below /mock/{slug}/api — :param, * = rest of the path</span>
            <input className="mono" value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} placeholder="/payments/:id" />
          </label>
        </div>
        <div className="form form-2">
          <label className="field">
            Name <span className="hint">Unique; defaults to "METHOD /path"</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Payment API" />
          </label>
          <label className="field">
            Description
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
        </div>
        <details>
          <summary className="small muted" style={{ cursor: 'pointer' }}>
            Match conditions (optional){matchSummary({ query: fromLines(form.query, /=/), headers: fromLines(form.headers, /:/), bodyContains: form.bodyContains }) ? ' · set' : ''}
          </summary>
          <div className="form form-2" style={{ marginTop: 8 }}>
            <label className="field">
              Query <span className="hint">one per line: key=value (value * = present)</span>
              <textarea className="mono" rows={3} value={form.query} onChange={(e) => setForm({ ...form, query: e.target.value })} placeholder="mode=test" />
            </label>
            <label className="field">
              Headers <span className="hint">one per line: Name: value</span>
              <textarea className="mono" rows={3} value={form.headers} onChange={(e) => setForm({ ...form, headers: e.target.value })} placeholder="X-Tenant: acme" />
            </label>
            <label className="field">
              Body contains
              <input className="mono" value={form.bodyContains} onChange={(e) => setForm({ ...form, bodyContains: e.target.value })} />
            </label>
            <label className="field">
              Body JSON fields <span className="hint">{'{ "user.email": "a@b.c", "items.0.qty": 2 }'}</span>
              <textarea className="mono" rows={3} value={form.bodyJson} onChange={(e) => setForm({ ...form, bodyJson: e.target.value })} />
            </label>
          </div>
        </details>
        <div className="row">
          <h3 className="grow" style={{ margin: 0 }}>
            Scenarios
          </h3>
          <button className="btn sm" onClick={() => setScenarios([...scenarios, blankScenario(`Scenario ${scenarios.length + 1}`)])}>
            <Icon name="plus" size={12} /> Add scenario
          </button>
        </div>
        <p className="small faint" style={{ margin: 0 }}>
          Templates: <code>{'{{params.id}}'}</code> <code>{'{{query.x}}'}</code> <code>{'{{headers.x}}'}</code> <code>{'{{body.a.b}}'}</code> <code>{'{{uuid}}'}</code>{' '}
          <code>{'{{now}}'}</code> <code>{'{{timestamp}}'}</code>
        </p>
        {scenarios.map((s, i) => (
          <div key={i} className="card card-pad form" style={{ background: 'var(--panel-2)' }}>
            <div className="row nowrap wrap-sm">
              <label className="row small" style={{ gap: 4 }} title="Active scenario">
                <input type="radio" name="active" checked={active === s.name} onChange={() => setActive(s.name)} /> active
              </label>
              <input className="grow" value={s.name} onChange={(e) => setScenario(i, { name: e.target.value })} aria-label="Scenario name" />
              <select value={s.behaviour} onChange={(e) => setScenario(i, { behaviour: e.target.value as MockBehaviour })} style={{ width: 'auto' }} aria-label="Behaviour">
                <option value="respond">Respond</option>
                <option value="timeout">Timeout (no answer)</option>
                <option value="drop">Drop connection</option>
              </select>
              {s.behaviour === 'respond' && (
                <>
                  <input style={{ width: 70 }} value={s.status} onChange={(e) => setScenario(i, { status: e.target.value })} aria-label="Status" placeholder="200" />
                  <input style={{ width: 90 }} value={s.delayMs} onChange={(e) => setScenario(i, { delayMs: e.target.value })} aria-label="Delay ms" placeholder="delay ms" />
                </>
              )}
              <button className="btn sm ghost danger" disabled={scenarios.length === 1} onClick={() => setScenarios(scenarios.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
            {s.behaviour === 'respond' && (
              <div className="form form-1-2">
                <label className="field">
                  Headers <span className="hint">Name: value</span>
                  <textarea className="mono" rows={4} value={s.headers} onChange={(e) => setScenario(i, { headers: e.target.value })} placeholder="Retry-After: 30" />
                </label>
                <label className="field">
                  Body
                  <textarea className="mono" rows={4} value={s.body} onChange={(e) => setScenario(i, { body: e.target.value })} />
                </label>
              </div>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
