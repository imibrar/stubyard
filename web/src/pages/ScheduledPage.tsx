import { useState } from 'react';
import { api, type Overview } from '../api';
import { RunChip } from '../components/RunChip';
import { Badge, Empty, ErrorBox, Modal, fmtTime, timeAgo, useTick, useToast } from '../components/ui';
import { useGate } from '../auth';
import { useProject } from '../context';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import {
  ACTION_LABEL,
  STATUS_KIND,
  everyText,
  schBase,
  untilText,
  type FireResult,
  type Schedule,
  type ScheduleReference,
} from '../schedulesApi';
import { Page } from './ProjectPage';
import '../styles/scheduled.css';
import { Tabs } from '../components/layout';

/** /p/:slug/scheduled — scheduled actions (send later, repeat): run now, pause / resume, edit, cancel, flush. */

type Filter = 'active' | 'finished' | 'all';
interface Job {
  id: string;
  type: string;
  runAt: string;
  status: string;
  attempts: number;
  payload: Record<string, unknown>;
}

const preview = (v: unknown, max = 160) => {
  if (v === null || v === undefined) return '';
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

type Names = Map<string, string>;

/** Human target of a schedule: names of the template / sequence / user / mock where known. */
function targetText(s: Schedule, overview: Overview, names: Names): string {
  const seg = s.path.split('/').filter(Boolean).map(decodeURIComponent);
  const user = (ref: string) => overview.users.find((u) => u.id === ref)?.name ?? ref;
  const named = (ref: string) => names.get(ref) ?? ref;
  switch (s.action) {
    case 'webhook.send':
      return `template ${named(seg[1])}`;
    case 'webhook.sequence':
      return `sequence ${named(seg[1])}`;
    case 'user.reply':
      return `as ${user(seg[1])}`;
    case 'mock.scenario':
      return `mock ${named(seg[1])}${s.body && typeof s.body === 'object' && 'scenario' in s.body ? ` → ${String((s.body as { scenario: unknown }).scenario)}` : ''}`;
    case 'rule.set':
    case 'rule.clear':
      if (seg[0] === 'rules') return seg[1] === 'reset' ? 'all rules of the project' : `rule ${seg[1]}`;
      return `${seg[0] === 'users' ? user(seg[1]) : `instance ${seg[1]}`}${seg[3] === 'preset' ? ` · preset ${seg[4]}` : ''}`;
  }
  return s.path;
}

export default function ScheduledPage() {
  const { slug, overview } = useProject();
  const gate = useGate(slug)('project.providers');
  const toast = useToast();
  const base = schBase(slug);
  const [filter, setFilter] = useState<Filter>('active');
  const list = useFetch<Schedule[]>(`${base}${filter === 'all' ? '' : `?status=${filter}`}`, [slug, filter]);
  const counts = useFetch<Schedule[]>(`${base}?status=active`, [slug]);
  const jobs = useFetch<Job[]>(`/api/projects/${slug}/jobs`, [slug]);
  const templates = useFetch<{ id: string; name: string }[]>(`/api/projects/${slug}/webhook-templates`, [slug]);
  const sequences = useFetch<{ id: string; name: string }[]>(`/api/projects/${slug}/webhook-sequences`, [slug]);
  const mocks = useFetch<{ id: string; name: string }[]>(`/api/projects/${slug}/mocks`, [slug]);
  const names: Names = new Map([...(templates.data ?? []), ...(sequences.data ?? []), ...(mocks.data ?? [])].map((x) => [x.id, x.name]));
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastFlush, setLastFlush] = useState<{ fired: number; results: (FireResult & { label: string; action: string })[] } | null>(null);
  useTick(1000);
  const reload = useDebounced(() => {
    void list.reload();
    void counts.reload();
    void jobs.reload();
  }, 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'schedules.changed' || e.type === 'project.reset' || e.type === 'runs.changed') reload();
  });

  const act = async (id: string, what: 'run-now' | 'pause' | 'resume' | 'cancel') => {
    setBusy(id + what);
    try {
      if (what === 'cancel') await api.del(`${base}/${id}`);
      else {
        const r = await api.post<{ fire?: FireResult }>(`${base}/${id}/${what}`);
        if (r.fire) toast(r.fire.ok ? `Fired: HTTP ${r.fire.status}` : `Failed: ${r.fire.error}`);
      }
      reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const flush = async () => {
    setBusy('flush');
    try {
      const r = await api.post<{ fired: number; results: (FireResult & { label: string; action: string })[] }>(`${base}/flush`, {});
      setLastFlush(r);
      toast(r.fired ? `Fired ${r.fired} scheduled action${r.fired === 1 ? '' : 's'}` : 'Nothing pending');
      reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const active = counts.data?.length ?? 0;
  const internal = (jobs.data ?? []).filter((j) => j.type !== 'schedule.fire');
  const rows = list.data ?? [];

  return (
    <Page
      title="Scheduled"
      description="Actions stubyard does later: send a webhook, run a sequence, reply as a user, set or clear rules, switch a mock scenario. Use “Later” next to Send / Run, the API or the schedule_action MCP tool."
      actions={
        <>
          <button className="btn" onClick={() => setEditing('new')} {...gate}>
            New…
          </button>
          <button className="btn primary" disabled={busy === 'flush' || !active || gate.disabled} onClick={() => void flush()} title={gate.title ?? 'Fire every pending action once, now, in time order'}>
            Flush pending
          </button>
        </>
      }
    >
      <div className="row sch-filter">
        <Tabs
          variant="filter"
          label="Show"
          value={filter}
          onChange={(id) => setFilter(id as Filter)}
          items={(['active', 'finished', 'all'] as Filter[]).map((f) => ({ id: f, label: f === 'active' ? 'Pending & paused' : f === 'finished' ? 'Finished' : 'All', count: f === 'active' ? active : undefined, zero: f === 'active' }))}
        />
        <span className="spacer" />
        <span className="small faint">Finished ones are kept 24 h.</span>
      </div>
      <ErrorBox error={list.error} />
      {lastFlush && lastFlush.results.length > 0 && (
        <div className="info-box sch-flush">
          Flushed {lastFlush.fired}:{' '}
          {lastFlush.results.map((r) => (
            <span key={r.id} className={r.ok ? '' : 'sch-bad'}>
              {r.label || ACTION_LABEL[r.action as keyof typeof ACTION_LABEL] || r.action} → {r.ok ? r.status : r.error}
              {'; '}
            </span>
          ))}
          <button className="btn xs ghost" onClick={() => setLastFlush(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      {rows.length === 0 && !list.loading ? (
        <Empty title={filter === 'active' ? 'Nothing scheduled' : 'No scheduled actions here'}>
          Pick <b>Later ▾</b> next to “Send now” on a webhook template, “Run” on a sequence or “Send” in a user’s reply box, or POST /api/projects/{slug}/schedules.
        </Empty>
      ) : (
        <div className="card table-wrap sch-cq">
          <table className="sch-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Target</th>
                <th>Next run</th>
                <th>Status · last result</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const live = s.status === 'pending' || s.status === 'paused';
                return (
                  <tr key={s.id}>
                    <td>
                      <div className="sch-name">{s.label || ACTION_LABEL[s.action]}</div>
                      <div className="small faint mono ellipsis sch-path" title={`${s.method} ${s.url || s.path}`}>
                        <span className="method">{s.method}</span> {s.path}
                      </div>
                    </td>
                    <td className="sch-target">
                      <span>{targetText(s, overview, names)}</span>
                      {s.body !== null && s.body !== undefined && (
                        <div className="small faint mono ellipsis sch-body" title={preview(s.body, 2000)}>
                          {preview(s.body, 80)}
                        </div>
                      )}
                    </td>
                    <td className="nowrap">
                      {s.nextAt && live ? (
                        <>
                          <div>{untilText(s.nextAt)}</div>
                          <div className="small faint">{fmtTime(s.nextAt)}</div>
                        </>
                      ) : (
                        <span className="faint">{s.lastFiredAt ? `fired ${timeAgo(s.lastFiredAt)}` : '–'}</span>
                      )}
                      <div className="small faint">
                        {s.everyMs ? (
                          <span title={`Every ${everyText(s.everyMs)}, ${s.fired} of ${s.maxFires} fired`}>
                            ↻ every {everyText(s.everyMs)} · {s.fired}/{s.maxFires}
                          </span>
                        ) : (
                          'once'
                        )}
                      </div>
                      {s.missed > 0 && <div className="small sch-warn">{s.missed} missed</div>}
                    </td>
                    <td className="sch-last">
                      <div className="row sch-status">
                        <Badge kind={STATUS_KIND[s.status]}>{s.status}</Badge>
                        {s.run && <RunChip runKey={s.run} />}
                      </div>
                      {(s.lastStatus !== null || s.lastError) && (
                        <div className="sch-result">
                          {s.lastStatus !== null && <span className={`status s${String(s.lastStatus)[0]}`}>{s.lastStatus}</span>}{' '}
                          {s.lastError ? (
                            <span className="sch-bad small" title={s.lastError}>
                              {preview(s.lastError, 90)}
                            </span>
                          ) : (
                            <span className="small faint mono" title={preview(s.lastResult, 2000)}>
                              {preview(s.lastResult, 60)}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="row-actions sch-actions">
                        {live ? (
                          <>
                            <button className="btn sm" disabled={!!busy || gate.disabled} onClick={() => void act(s.id, 'run-now')} title={gate.title ?? 'Fire now (counts as one fire)'}>
                              ▶ Run now
                            </button>
                            {s.status === 'pending' ? (
                              <button className="btn sm sch-icon" disabled={!!busy || gate.disabled} onClick={() => void act(s.id, 'pause')} title={gate.title ?? 'Pause'} aria-label="Pause">
                                ❚❚
                              </button>
                            ) : (
                              <button className="btn sm" disabled={!!busy || gate.disabled} title={gate.title} onClick={() => void act(s.id, 'resume')}>
                                Resume
                              </button>
                            )}
                            <button className="btn sm sch-icon" onClick={() => setEditing(s)} disabled={gate.disabled} title={gate.title ?? 'Edit'} aria-label="Edit">
                              ✎
                            </button>
                            <button className="btn sm sch-icon danger" disabled={!!busy || gate.disabled} onClick={() => void act(s.id, 'cancel')} title={gate.title ?? 'Cancel'} aria-label="Cancel">
                              ✕
                            </button>
                          </>
                        ) : (
                          <button className="btn sm ghost" disabled={!!busy || gate.disabled} onClick={() => void act(s.id, 'cancel')} title={gate.title ?? 'Delete from the list'}>
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <details className="card sch-internal">
        <summary className="card-head">
          <span>
            Internal delayed jobs <span className="faint small">({internal.length})</span>
          </span>
          <span className="small faint">status callbacks, delayed deliveries, bounces — read-only</span>
        </summary>
        {internal.length === 0 ? (
          <div className="card-pad small faint">No internal jobs waiting.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Runs</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th className="col-sm">Payload</th>
                </tr>
              </thead>
              <tbody>
                {internal.map((j) => (
                  <tr key={j.id}>
                    <td className="mono">{j.type}</td>
                    <td className="nowrap">
                      {untilText(j.runAt)} <span className="small faint">{fmtTime(j.runAt)}</span>
                    </td>
                    <td>
                      <Badge>{j.status}</Badge>
                    </td>
                    <td>{j.attempts}</td>
                    <td className="col-sm small faint mono sch-body">{preview(j.payload, 120)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>

      {editing && <EditModal schedule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={reload} />}
    </Page>
  );
}

function EditModal({ schedule: s, onClose, onSaved }: { schedule: Schedule | null; onClose: () => void; onSaved: () => void }) {
  const { slug } = useProject();
  const gate = useGate(slug)('project.providers');
  const ref = useFetch<ScheduleReference>('/api/schedules/reference');
  const [method, setMethod] = useState(s?.method ?? 'POST');
  const [path, setPath] = useState(s?.path ?? '/webhook-templates/<template>/send');
  const [label, setLabel] = useState(s?.label ?? '');
  const [body, setBody] = useState(s?.body !== null && s?.body !== undefined ? JSON.stringify(s.body, null, 2) : '');
  const [delay, setDelay] = useState(s ? '' : '60');
  const [every, setEvery] = useState(s?.everyMs ? String(s.everyMs / 1000) : '');
  const [maxFires, setMaxFires] = useState(s ? String(s.maxFires) : '');
  const [run, setRun] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      let parsed: unknown = null;
      if (body.trim()) {
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          throw new Error(`Body is not valid JSON: ${(e as Error).message}`);
        }
      }
      const time = delay.trim() !== '' ? { delaySeconds: Number(delay) } : {};
      const repeat = every.trim() ? { everyMs: Math.round(Number(every) * 1000) } : s?.everyMs ? { everyMs: null } : {};
      const max = maxFires.trim() ? { maxFires: Number(maxFires) } : {};
      if (s) await api.patch(`${schBase(slug)}/${s.id}`, { label, body: parsed, ...time, ...repeat, ...max });
      else {
        if (!('delaySeconds' in time)) throw new Error('Enter when to fire (seconds from now)');
        await api.post(`${schBase(slug)}${run.trim() ? `?run=${encodeURIComponent(run.trim())}` : ''}`, { method, path, label, body: parsed ?? undefined, ...time, ...repeat, ...max });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={s ? 'Edit scheduled action' : 'New scheduled action'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || gate.disabled} title={gate.title} onClick={() => void save()}>
            {s ? 'Save' : 'Schedule'}
          </button>
        </>
      }
    >
      <form className="form" onSubmit={(e) => (e.preventDefault(), void save())}>
        <ErrorBox error={error} />
        {s ? (
          <div className="small muted">
            <span className="method">{s.method}</span> <span className="mono">{s.url}</span> · the action and target cannot change; cancel and create a new one instead.
          </div>
        ) : (
          <>
            <div className="form form-method">
              <label className="field">
                Method
                <select value={method} onChange={(e) => setMethod(e.target.value)}>
                  {['POST', 'PATCH', 'DELETE'].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                Path <span className="hint">after /api/projects/{slug}</span>
                <input className="mono" value={path} onChange={(e) => setPath(e.target.value)} />
              </label>
            </div>
            {ref.data && (
              <div className="sch-allowed small">
                {ref.data.allowed.map((a) => (
                  <button
                    type="button"
                    key={a.call}
                    className="chip"
                    title={a.call}
                    onClick={() => {
                      const [m, p] = a.call.split(' ');
                      setMethod(m);
                      setPath(p.replace(/,$/, ''));
                    }}
                  >
                    {ACTION_LABEL[a.action]} <span className="n">{a.call.split(' ')[1].replace(/,$/, '')}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <label className="field">
          Label <span className="hint">optional</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="field">
          Body <span className="hint">JSON the REST call takes, e.g. {'{"data": {…}}'} or {'{"channel":"sms","text":"STOP"}'}</span>
          <textarea className="mono" rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div className="form form-3">
          <label className="field">
            Fire in (seconds) <span className="hint">{s ? 'blank = keep' : ''}</span>
            <input type="number" min={0} inputMode="decimal" value={delay} onChange={(e) => setDelay(e.target.value)} placeholder={s?.nextAt ? fmtTime(s.nextAt) : ''} />
          </label>
          <label className="field">
            Repeat every (seconds) <span className="hint">blank = once</span>
            <input type="number" min={1} inputMode="decimal" value={every} onChange={(e) => setEvery(e.target.value)} />
          </label>
          <label className="field">
            Max fires <span className="hint">≤ 100</span>
            <input type="number" min={1} max={100} value={maxFires} onChange={(e) => setMaxFires(e.target.value)} placeholder={every ? '10' : '1'} />
          </label>
        </div>
        {!s && (
          <label className="field">
            Test run <span className="hint">optional run key: fires inside that run, cancelled when it stops</span>
            <input value={run} onChange={(e) => setRun(e.target.value)} placeholder="e.g. w1" />
          </label>
        )}
      </form>
    </Modal>
  );
}
