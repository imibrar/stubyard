import { useEffect, useState } from 'react';
import { api, type LogSummary, type TestUser } from '../api';
import { Icon } from '../components/people';
import { SendLater } from '../components/SendLater';
import { LogDrawer, StatusCode } from '../components/TrafficLog';
import { Badge, CodeBlock, Empty, ErrorBox, Modal, OUTCOME_KIND, fmtTime, timeAgo, useCopy, useTick, useToast } from '../components/ui';
import { useProject } from '../context';
import { useDebounced, useFetch, useHubEvents, useNewAction } from '../hooks';
import { useSearchParams } from 'react-router-dom';
import { Page } from './ProjectPage';
import '../styles/lint.css';
import { Tabs } from '../components/layout';
import { WEBHOOK_TABS } from '../nav';

// ---------- types (webhook API) ----------
interface SchemaError {
  path: string;
  message: string;
}
interface EndpointResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  delayMs: number;
  rejectInvalid: boolean;
}
interface Endpoint {
  id: string;
  name: string;
  path: string;
  method: string;
  schema: unknown;
  response: EndpointResponse;
  enabled: boolean;
  urls: { http: string; https: string };
  stats: { hits: number; invalid: number; lastHitAt: string | null };
}
interface Signing {
  preset: 'none' | 'hmac' | 'stripe' | 'basic' | 'paytabs' | 'paypal';
  secret?: string;
  header?: string;
  prefix?: string;
  encoding?: 'hex' | 'base64';
  timestampHeader?: string;
  username?: string;
  password?: string;
  privateKey?: string;
  webhookId?: string;
  certUrl?: string;
}
interface Template {
  id: string;
  name: string;
  description: string;
  targetUrl: string;
  method: string;
  headers: Record<string, string>;
  bodyTemplate: string;
  signing: Signing;
}
interface Step {
  templateId: string;
  delayMs: number;
  repeat: number;
}
interface Sequence {
  id: string;
  name: string;
  description: string;
  steps: Step[];
}
interface Reference {
  methods: string[];
  signing: { id: string; name: string; description: string }[];
  variables: { name: string; description: string }[];
}
interface SendResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  logId: string;
  missing: string[];
  warnings: string[];
}

// ---------- helpers ----------
const headersToText = (h: Record<string, string>) =>
  Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
function textToHeaders(t: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of t.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
function parseJsonField(text: string, label: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${(e as Error).message}`);
  }
}
const pretty = (v: unknown) => (v === null || v === undefined ? '' : JSON.stringify(v, null, 2));

function useWebhookData<T>(path: string) {
  const { slug } = useProject();
  const res = useFetch<T>(path, [path]);
  const reload = useDebounced(() => void res.reload(), 250);
  useHubEvents(slug, (e) => {
    if (e.type === 'webhooks.changed' || e.type === 'project.reset' || e.type === 'log.created' || e.type === 'log.updated') reload();
  });
  return res;
}

/** Webhooks: receive (endpoints + schema validation) and send (templates, signing, sequences). */
export default function WebhooksPage() {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get('tab');
  const [tab, setTab] = useState<'receive' | 'send'>(() => {
    // ?tab=receive|send (links, palette) wins over the remembered choice.
    if (fromUrl === 'receive' || fromUrl === 'send') return fromUrl;
    try {
      return (localStorage.getItem('stubyard.webhooks.tab') as 'receive' | 'send') || 'receive';
    } catch {
      return 'receive';
    }
  });
  useEffect(() => {
    if ((fromUrl === 'receive' || fromUrl === 'send') && fromUrl !== tab) setTab(fromUrl);
  }, [fromUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (t: 'receive' | 'send') => {
    setTab(t);
    if (params.get('tab'))
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          n.set('tab', t);
          return n;
        },
        { replace: true },
      );
    try {
      localStorage.setItem('stubyard.webhooks.tab', t);
    } catch {
      /* ignore */
    }
  };
  return (
    <Page
      title="Webhooks"
      description="Receive webhooks on stubyard URLs with JSON Schema checks, and send signed webhooks (single, sequences, as a test user) to your app. Everything lands in the traffic log."
    >
      <Tabs label="Webhooks" value={tab} onChange={(id) => choose(id as 'receive' | 'send')} items={WEBHOOK_TABS.map((t) => ({ id: t.id, label: t.id === 'receive' ? '← Receive' : '→ Send', text: t.label }))} />
      {tab === 'receive' ? <ReceiveSection /> : <SendSection />}
    </Page>
  );
}

// =============================== Receive ===============================

function ReceiveSection() {
  const { slug } = useProject();
  const endpoints = useWebhookData<Endpoint[]>(`/api/projects/${slug}/webhook-endpoints`);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useNewAction({ endpoint: () => setAdding(true) });
  const list = endpoints.data ?? [];
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h3>Endpoints</h3>
          <button className="btn sm primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} /> New endpoint
          </button>
        </div>
        <ErrorBox error={endpoints.error} />
        {list.length === 0 && !endpoints.loading ? (
          <Empty title="No endpoints yet">
            Add one (e.g. <code>stripe</code> or <code>orders/:id</code>) and point the sender at <code>/hook/{slug}/&lt;path&gt;</code>. Requests to unknown paths are still
            logged as 404s.
          </Empty>
        ) : (
          list.map((e) => <EndpointItem key={e.id} e={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} reload={endpoints.reload} />)
        )}
      </div>
      {adding && (
        <NewEndpointModal
          onClose={() => setAdding(false)}
          onDone={(id) => {
            void endpoints.reload();
            setOpen(id);
          }}
        />
      )}
    </div>
  );
}

function NewEndpointModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { slug } = useProject();
  const [path, setPath] = useState('');
  const [method, setMethod] = useState('POST');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      const e = await api.post<Endpoint>(`/api/projects/${slug}/webhook-endpoints`, { path, method, name: name || undefined });
      onDone(e.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal
      title="New webhook endpoint"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Create
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={error} />
        <div className="form form-2">
          <label className="field">
            Method
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {['ANY', 'POST', 'PUT', 'PATCH', 'GET', 'DELETE'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Name <span className="hint">Optional</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Stripe events" />
          </label>
        </div>
        <label className="field">
          Path <span className="hint">After /hook/{slug}/ — :params match one segment, a trailing * matches the rest</span>
          <input className="mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="payments/:id" autoFocus />
        </label>
      </div>
    </Modal>
  );
}

function EndpointItem({ e, open, onToggle, reload }: { e: Endpoint; open: boolean; onToggle: () => void; reload: () => void }) {
  const { slug } = useProject();
  const copy = useCopy();
  const toast = useToast();
  useTick(30_000);
  const toggle = async () => {
    await api.patch(`/api/projects/${slug}/webhook-endpoints/${e.id}`, { enabled: !e.enabled });
    reload();
  };
  const remove = async () => {
    if (!confirm(`Delete endpoint ${e.method} /${e.path}?`)) return;
    await api.del(`/api/projects/${slug}/webhook-endpoints/${e.id}`);
    toast('Endpoint deleted');
    reload();
  };
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="row nowrap list-row" style={{ padding: '10px 14px' }}>
        <button className="btn xs ghost" onClick={onToggle} aria-expanded={open} aria-label="Details">
          {open ? '▾' : '▸'}
        </button>
        <span className="method">{e.method}</span>
        <div style={{ minWidth: 160 }}>
          <div style={{ fontWeight: 600 }}>{e.name}</div>
          <code className="faint">/{e.path}</code>
        </div>
        <div className="row grow row-meta">
          <button className="cred" style={{ cursor: 'copy' }} onClick={() => copy(e.urls.https, 'URL copied')} title="Copy HTTPS URL">
            <span className="ellipsis" style={{ maxWidth: 380 }}>{e.urls.https}</span>
            <Icon name="copy" size={12} />
          </button>
          <button className="btn xs ghost" onClick={() => copy(e.urls.http, 'HTTP URL copied')} title={e.urls.http}>
            http
          </button>
          {e.schema ? <Badge kind="accent">schema</Badge> : <Badge>no schema</Badge>}
          <Badge>{e.stats.hits} hits</Badge>
          {e.stats.invalid > 0 && <Badge kind="warn">{e.stats.invalid} invalid</Badge>}
          {e.stats.lastHitAt && <span className="small faint">last {timeAgo(e.stats.lastHitAt)}</span>}
          {!e.enabled && <Badge kind="bad">disabled (404)</Badge>}
        </div>
        <div className="row-actions">
          <button className="btn sm ghost" onClick={toggle}>
            {e.enabled ? 'Disable' : 'Enable'}
          </button>
          <button className="btn sm ghost danger" onClick={remove}>
            Delete
          </button>
        </div>
      </div>
      {open && (
        <div className="panel-pair">
          <EndpointEditor e={e} reload={reload} />
          <RecentHits path={`/api/projects/${slug}/webhook-endpoints/${e.id}/hits`} title="Recent hits" empty="Nothing received yet. Send a request to the URL above." />
        </div>
      )}
    </div>
  );
}

function EndpointEditor({ e, reload }: { e: Endpoint; reload: () => void }) {
  const { slug } = useProject();
  const toast = useToast();
  const [f, setF] = useState({
    name: e.name,
    path: e.path,
    method: e.method,
    schema: pretty(e.schema),
    status: String(e.response.status),
    delayMs: String(e.response.delayMs),
    headers: headersToText(e.response.headers),
    body: e.response.body,
    rejectInvalid: e.response.rejectInvalid,
  });
  const [sample, setSample] = useState('');
  const [showInfer, setShowInfer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });

  const save = async () => {
    setError(null);
    try {
      const schema = f.schema.trim() ? parseJsonField(f.schema, 'Schema') : null;
      await api.patch(`/api/projects/${slug}/webhook-endpoints/${e.id}`, {
        name: f.name,
        path: f.path,
        method: f.method,
        schema,
        response: { status: Number(f.status), delayMs: Number(f.delayMs) || 0, headers: textToHeaders(f.headers), body: f.body, rejectInvalid: f.rejectInvalid },
      });
      toast('Endpoint saved');
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const infer = async () => {
    setError(null);
    try {
      const parsed = parseJsonField(sample, 'Sample');
      const s = await api.post<unknown>(`/api/projects/${slug}/schemas/infer`, { sample: parsed });
      set({ schema: pretty(s) });
      setShowInfer(false);
      toast('Schema generated — review and save');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Configuration</h3>
        <button className="btn sm primary" onClick={save}>
          Save
        </button>
      </div>
      <div className="card-pad form">
        <ErrorBox error={error} />
        <div className="form form-method-2">
          <label className="field">
            Method
            <select value={f.method} onChange={(ev) => set({ method: ev.target.value })}>
              {['ANY', 'POST', 'PUT', 'PATCH', 'GET', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Path
            <input className="mono" value={f.path} onChange={(ev) => set({ path: ev.target.value })} />
          </label>
          <label className="field">
            Name
            <input value={f.name} onChange={(ev) => set({ name: ev.target.value })} />
          </label>
        </div>
        <label className="field">
          <span className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              JSON Schema <span className="hint" style={{ fontWeight: 400, color: 'var(--faint)' }}>Empty = accept anything</span>
            </span>
            <button type="button" className="btn xs" onClick={() => setShowInfer(!showInfer)}>
              Infer from sample
            </button>
          </span>
          {showInfer && (
            <div className="stack" style={{ gap: 6 }}>
              <textarea className="mono" rows={6} value={sample} onChange={(ev) => setSample(ev.target.value)} placeholder='Paste an example payload, e.g. {"id":"evt_1","amount":1000}' />
              <div className="row">
                <button type="button" className="btn sm primary" onClick={infer}>
                  Generate schema
                </button>
                <span className="small faint">Replaces the schema below; all keys become required.</span>
              </div>
            </div>
          )}
          <textarea className="mono" rows={8} value={f.schema} onChange={(ev) => set({ schema: ev.target.value })} placeholder='{"type":"object","required":["id"]}' />
        </label>
        <div className="section-title">Response</div>
        <div className="form form-2">
          <label className="field">
            Status
            <input type="number" value={f.status} onChange={(ev) => set({ status: ev.target.value })} />
          </label>
          <label className="field">
            Delay (ms)
            <input type="number" value={f.delayMs} onChange={(ev) => set({ delayMs: ev.target.value })} />
          </label>
        </div>
        <label className="field">
          Headers <span className="hint">One per line, "Name: value"</span>
          <textarea className="mono" rows={2} value={f.headers} onChange={(ev) => set({ headers: ev.target.value })} />
        </label>
        <label className="field">
          Body <span className="hint">Variables: {'{{body.x}} {{params.id}} {{query.x}} {{request.id}} {{uuid}} {{now}}'}</span>
          <textarea className="mono" rows={4} value={f.body} onChange={(ev) => set({ body: ev.target.value })} />
        </label>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={f.rejectInvalid} onChange={(ev) => set({ rejectInvalid: ev.target.checked })} />
          Answer <code>400</code> with the errors when the schema check fails (otherwise answer normally and only mark it invalid)
        </label>
      </div>
    </div>
  );
}

function RecentHits({ path, title, empty }: { path: string; title: string; empty: string }) {
  const hits = useWebhookData<LogSummary[]>(path);
  const [openId, setOpenId] = useState<string | null>(null);
  useTick(15_000);
  const list = hits.data ?? [];
  return (
    <div className="card">
      <div className="card-head">
        <h3>{title}</h3>
        <span className="small faint">{list.length ? `${list.length} shown` : ''}</span>
      </div>
      <ErrorBox error={hits.error} />
      {list.length === 0 ? (
        <p className="muted small" style={{ padding: '12px 16px', margin: 0 }}>
          {empty}
        </p>
      ) : (
        <div style={{ maxHeight: 520, overflowY: 'auto' }}>
          {list.map((l) => (
            <HitRow key={l.id} l={l} onOpen={() => setOpenId(l.id)} />
          ))}
        </div>
      )}
      {openId && <LogDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function HitRow({ l, onOpen }: { l: LogSummary; onOpen: () => void }) {
  const r = l.resolved as Record<string, unknown>;
  const errors = (Array.isArray(r.errors) ? r.errors : []) as SchemaError[];
  const inbound = l.direction === 'inbound';
  return (
    <div className="clickable" style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }} onClick={onOpen}>
      <div className="row nowrap">
        <span className="mono faint small" title={l.receivedAt}>
          {fmtTime(l.receivedAt)}
        </span>
        {inbound ? (
          r.valid === false ? <Badge kind="warn">fail</Badge> : r.schema ? <Badge kind="ok">pass</Badge> : <Badge>received</Badge>
        ) : (
          <Badge kind={OUTCOME_KIND[l.outcome]}>{l.outcome.replace('_', ' ')}</Badge>
        )}
        <StatusCode code={l.resStatus} />
        <span className="mono small ellipsis grow">{inbound ? l.url : `${l.method} ${l.url}`}</span>
        {!inbound && typeof r.step === 'number' && <Badge>step {String(r.step)}{r.repeat ? ` · ${String(r.repeat)}` : ''}</Badge>}
        {typeof r.replayOf === 'string' && <Badge kind="accent">replay</Badge>}
        {typeof r.securityCheck === 'string' && <Badge>security · {r.securityCheck}</Badge>}
        {l.durationMs !== null && <span className="small faint">{l.durationMs} ms</span>}
      </div>
      {errors.length > 0 && (
        <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18, color: 'var(--warn)' }}>
          {errors.slice(0, 6).map((er, i) => (
            <li key={i}>
              <code>{er.path || '/'}</code> {er.message}
            </li>
          ))}
          {errors.length > 6 && <li className="faint">…and {errors.length - 6} more</li>}
        </ul>
      )}
      {l.errorMessage && <div className="small" style={{ color: 'var(--bad)' }}>{l.errorMessage}</div>}
    </div>
  );
}

// =============================== Send ===============================

function SendSection() {
  const { slug } = useProject();
  const templates = useWebhookData<Template[]>(`/api/projects/${slug}/webhook-templates`);
  const ref = useFetch<Reference>('/api/webhooks/reference');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const list = templates.data ?? [];
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h3>Templates</h3>
          <button className="btn sm primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} /> New template
          </button>
        </div>
        <ErrorBox error={templates.error} />
        {list.length === 0 && !templates.loading ? (
          <Empty title="No templates yet">A template is one event your app receives, e.g. payment_intent.succeeded, with a target URL, body and signature.</Empty>
        ) : (
          list.map((t) => (
            <TemplateItem key={t.id} t={t} ref_={ref.data} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} reload={templates.reload} />
          ))
        )}
      </div>
      <SequencesCard templates={list} />
      <VariablesHelp ref_={ref.data} />
      {adding && (
        <NewTemplateModal
          onClose={() => setAdding(false)}
          onDone={(id) => {
            void templates.reload();
            setOpen(id);
          }}
        />
      )}
    </div>
  );
}

const STARTER_BODY = `{
  "id": "evt_{{uuid}}",
  "type": "payment.succeeded",
  "created": {{timestamp}},
  "data": {
    "amount": {{faker.amount}},
    "customer": { "name": "{{user.name}}", "email": "{{user.email}}" }
  }
}`;

function NewTemplateModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { slug } = useProject();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('http://host.docker.internal:3000/webhooks');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      const t = await api.post<Template>(`/api/projects/${slug}/webhook-templates`, { name, targetUrl: url, bodyTemplate: STARTER_BODY });
      onDone(t.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal
      title="New webhook template"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Create
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={error} />
        <label className="field">
          Name <span className="hint">Usually the event type</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="payment.succeeded" autoFocus />
        </label>
        <label className="field">
          Target URL <span className="hint">Your app's webhook URL, as reachable from the stubyard container</span>
          <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

function TemplateItem({ t, ref_, open, onToggle, reload }: { t: Template; ref_: Reference | null; open: boolean; onToggle: () => void; reload: () => void }) {
  const { slug } = useProject();
  const toast = useToast();
  const [secRun, setSecRun] = useState(0);
  const securityCheck = () => {
    if (!open) onToggle();
    setSecRun((n) => n + 1);
  };
  const remove = async () => {
    if (!confirm(`Delete template "${t.name}"?`)) return;
    try {
      await api.del(`/api/projects/${slug}/webhook-templates/${t.id}`);
      toast('Template deleted');
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="row nowrap list-row" style={{ padding: '10px 14px' }}>
        <button className="btn xs ghost" onClick={onToggle} aria-expanded={open} aria-label="Details">
          {open ? '▾' : '▸'}
        </button>
        <div style={{ minWidth: 180 }}>
          <div style={{ fontWeight: 600 }}>{t.name}</div>
          {t.description && <div className="small faint">{t.description}</div>}
        </div>
        <div className="row grow nowrap row-meta" style={{ minWidth: 0 }}>
          <span className="method">{t.method}</span>
          <span className="mono small ellipsis">{t.targetUrl}</span>
          {t.signing.preset !== 'none' && <Badge kind="accent">{ref_?.signing.find((s) => s.id === t.signing.preset)?.name ?? t.signing.preset}</Badge>}
        </div>
        <div className="row-actions">
          <QuickSend t={t} />
          <button className="btn sm" onClick={securityCheck} title="Send bad signatures, stale timestamps, replays… and see what your app wrongly accepts">
            Security check
          </button>
          <button className="btn sm ghost danger" onClick={remove}>
            Delete
          </button>
        </div>
      </div>
      {open && (
        <div className="panel-pair">
          <TemplateEditor t={t} ref_={ref_} reload={reload} />
          <div className="stack">
            <SendPanel t={t} />
            <RecentHits path={`/api/projects/${slug}/webhook-templates/${t.id}/results`} title="Last results" empty="Not sent yet." />
          </div>
          <SecurityCheckPanel t={t} runSignal={secRun} />
        </div>
      )}
    </div>
  );
}

function QuickSend({ t }: { t: Template }) {
  const { slug } = useProject();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.post<SendResult>(`/api/projects/${slug}/webhook-templates/${t.id}/send`, {});
      toast(r.ok ? `${t.name}: ${r.status}` : `${t.name} failed: ${r.error ?? r.status}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn sm" disabled={busy} onClick={send}>
      Send
    </button>
  );
}

function TemplateEditor({ t, ref_, reload }: { t: Template; ref_: Reference | null; reload: () => void }) {
  const { slug } = useProject();
  const toast = useToast();
  const [f, setF] = useState({
    name: t.name,
    description: t.description,
    method: t.method,
    targetUrl: t.targetUrl,
    headers: headersToText(t.headers),
    body: t.bodyTemplate,
  });
  const [sig, setSig] = useState<Signing>(t.signing);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const setS = (patch: Partial<Signing>) => setSig({ ...sig, ...patch });
  const save = async () => {
    setError(null);
    try {
      await api.patch(`/api/projects/${slug}/webhook-templates/${t.id}`, {
        name: f.name,
        description: f.description,
        method: f.method,
        targetUrl: f.targetUrl,
        headers: textToHeaders(f.headers),
        bodyTemplate: f.body,
        signing: sig,
      });
      toast('Template saved');
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3>Template</h3>
        <button className="btn sm primary" onClick={save}>
          Save
        </button>
      </div>
      <div className="card-pad form">
        <ErrorBox error={error} />
        <div className="form form-2">
          <label className="field">
            Name
            <input value={f.name} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="field">
            Description
            <input value={f.description} onChange={(e) => set({ description: e.target.value })} />
          </label>
        </div>
        <div className="form form-method">
          <label className="field">
            Method
            <select value={f.method} onChange={(e) => set({ method: e.target.value })}>
              {['POST', 'PUT', 'PATCH', 'DELETE', 'GET'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Target URL
            <input className="mono" value={f.targetUrl} onChange={(e) => set({ targetUrl: e.target.value })} />
          </label>
        </div>
        <label className="field">
          Headers <span className="hint">One per line, "Name: value"; variables allowed</span>
          <textarea className="mono" rows={2} value={f.headers} onChange={(e) => set({ headers: e.target.value })} />
        </label>
        <label className="field">
          Body template
          <textarea className="mono" rows={10} value={f.body} onChange={(e) => set({ body: e.target.value })} />
        </label>
        <div className="section-title">Signing</div>
        <label className="field">
          Preset
          <select value={sig.preset} onChange={(e) => setS({ preset: e.target.value as Signing['preset'] })}>
            {(ref_?.signing ?? [{ id: 'none', name: 'None', description: '' }]).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <span className="hint">{ref_?.signing.find((s) => s.id === sig.preset)?.description}</span>
        </label>
        {(sig.preset === 'hmac' || sig.preset === 'stripe' || sig.preset === 'paytabs') && (
          <label className="field">
            {sig.preset === 'paytabs' ? 'Server key' : 'Secret'}
            <input className="mono" value={sig.secret ?? ''} onChange={(e) => setS({ secret: e.target.value })} placeholder={sig.preset === 'stripe' ? 'whsec_…' : sig.preset === 'paytabs' ? 'S…-…' : 'shared secret'} />
          </label>
        )}
        {sig.preset === 'hmac' && (
          <div className="form form-2">
            <label className="field">
              Header
              <input className="mono" value={sig.header ?? 'X-Signature'} onChange={(e) => setS({ header: e.target.value })} />
            </label>
            <label className="field">
              Prefix
              <input className="mono" value={sig.prefix ?? 'sha256='} onChange={(e) => setS({ prefix: e.target.value })} />
            </label>
            <label className="field">
              Encoding
              <select value={sig.encoding ?? 'hex'} onChange={(e) => setS({ encoding: e.target.value as 'hex' | 'base64' })}>
                <option value="hex">hex</option>
                <option value="base64">base64</option>
              </select>
            </label>
            <label className="field">
              Timestamp header <span className="hint">Optional; then "&lt;ts&gt;.&lt;body&gt;" is signed</span>
              <input className="mono" value={sig.timestampHeader ?? ''} onChange={(e) => setS({ timestampHeader: e.target.value || undefined })} placeholder="X-Timestamp" />
            </label>
          </div>
        )}
        {sig.preset === 'paypal' && (
          <div className="form">
            <label className="field">
              Webhook id
              <input className="mono" value={sig.webhookId ?? ''} onChange={(e) => setS({ webhookId: e.target.value })} placeholder="WH-…" />
            </label>
            <label className="field">
              Private key <span className="hint">PEM (RSA); the public cert is what your app would fetch from PAYPAL-CERT-URL</span>
              <textarea className="mono" rows={4} value={sig.privateKey ?? ''} onChange={(e) => setS({ privateKey: e.target.value })} placeholder="-----BEGIN PRIVATE KEY-----" />
            </label>
            <label className="field">
              Cert URL <span className="hint">Optional; sent as PAYPAL-CERT-URL</span>
              <input className="mono" value={sig.certUrl ?? ''} onChange={(e) => setS({ certUrl: e.target.value || undefined })} />
            </label>
          </div>
        )}
        {sig.preset === 'basic' && (
          <div className="form form-2">
            <label className="field">
              Username
              <input value={sig.username ?? ''} onChange={(e) => setS({ username: e.target.value })} />
            </label>
            <label className="field">
              Password
              <input value={sig.password ?? ''} onChange={(e) => setS({ password: e.target.value })} />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

function UserPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { overview } = useProject();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">No test user</option>
      {overview.users.map((u: TestUser) => (
        <option key={u.id} value={u.id}>
          {u.name} ({u.role}){u.email ? ` · ${u.email}` : ''}
        </option>
      ))}
    </select>
  );
}

function SendPanel({ t }: { t: Template }) {
  const { slug } = useProject();
  const [user, setUser] = useState('');
  const [data, setData] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);
  const [preview, setPreview] = useState<{ method: string; url: string; headers: Record<string, string>; body: string; missing: string[]; warnings: string[] } | null>(null);
  const payload = () => ({ asUser: user || undefined, data: parseJsonField(data, 'Data') ?? {} });
  const run = async (kind: 'send' | 'preview') => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'send') {
        setResult(await api.post<SendResult>(`/api/projects/${slug}/webhook-templates/${t.id}/send`, payload()));
      } else {
        setPreview(await api.post(`/api/projects/${slug}/webhook-templates/${t.id}/preview`, payload()));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3>Send</h3>
        <div className="row">
          <button className="btn sm" disabled={busy} onClick={() => run('preview')}>
            Preview
          </button>
          <button className="btn sm primary" disabled={busy} onClick={() => run('send')}>
            Send now
          </button>
          <SendLater request={() => ({ method: 'POST', path: `/webhook-templates/${t.id}/send`, body: payload() })} label={`Send ${t.name}`} />
        </div>
      </div>
      <div className="card-pad form">
        <ErrorBox error={error} />
        <label className="field">
          Send as test user <span className="hint">Fills {'{{user.*}}'}</span>
          <UserPicker value={user} onChange={setUser} />
        </label>
        <label className="field">
          Data <span className="hint">JSON for {'{{data.*}}'}, e.g. a captured event</span>
          <textarea className="mono" rows={3} value={data} onChange={(e) => setData(e.target.value)} placeholder='{"order": {"id": "ord_1"}}' />
        </label>
        {result && (
          <div className={result.ok ? 'info-box' : 'error-box'}>
            {result.ok ? `Your app answered ${result.status}` : `Failed: ${result.error ?? `HTTP ${result.status}`}`} · log <code>{result.logId}</code>
            {result.missing.length > 0 && <div>Empty variables: {result.missing.join(', ')}</div>}
            {result.warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        )}
        {preview && (
          <>
            {(preview.missing.length > 0 || preview.warnings.length > 0) && (
              <div className="error-box">
                {preview.missing.length > 0 && <div>Empty variables: {preview.missing.join(', ')}</div>}
                {preview.warnings.map((w) => (
                  <div key={w}>{w}</div>
                ))}
              </div>
            )}
            <CodeBlock
              title="Preview (signature computed now)"
              code={`${preview.method} ${preview.url}\n${headersToText(preview.headers)}\n\n${preview.body}`}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------- security check ----------------

interface SecVariant {
  id: string;
  label: string;
  description: string;
  expected: 'accept' | 'reject' | 'info';
  status: number | null;
  verdict: 'pass' | 'fail' | 'warn' | 'info' | 'skipped' | 'error';
  note: string;
  logId: string | null;
  extraLogIds?: string[];
  durationMs: number | null;
}
interface SecResult {
  id: string;
  template: string;
  targetUrl: string;
  signing: string;
  finishedAt: string;
  baselineFailed: boolean;
  summary: Record<SecVariant['verdict'], number>;
  variants: SecVariant[];
  notes: string[];
}

const VERDICT: Record<SecVariant['verdict'], { icon: string; kind: string; label: string }> = {
  pass: { icon: '✅', kind: 'ok', label: 'pass' },
  fail: { icon: '❌', kind: 'bad', label: 'fail' },
  warn: { icon: '⚠️', kind: 'warn', label: 'warn' },
  info: { icon: 'ℹ️', kind: 'accent', label: 'info' },
  skipped: { icon: '–', kind: '', label: 'skipped' },
  error: { icon: '⛔', kind: 'bad', label: 'error' },
};
const EXPECTED: Record<SecVariant['expected'], string> = { accept: '2xx', reject: '4xx', info: 'any' };

function SecurityCheckPanel({ t, runSignal }: { t: Template; runSignal: number }) {
  const { slug } = useProject();
  const url = `/api/projects/${slug}/webhook-templates/${t.id}/security-check`;
  const latest = useFetch<SecResult>(url, [url]);
  const [result, setResult] = useState<SecResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState('');
  const [openLog, setOpenLog] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.post<SecResult>(url, { asUser: user || undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (runSignal > 0) void run();
  }, [runSignal]);
  const r = result ?? latest.data;
  const order: SecVariant['verdict'][] = ['fail', 'warn', 'error', 'pass', 'info', 'skipped'];
  return (
    <div className="card span-all">
      <div className="card-head">
        <h3>Security check</h3>
        <span className="small faint grow">{r ? `last run ${timeAgo(r.finishedAt)}` : 'Not run yet'}</span>
        <UserPicker value={user} onChange={setUser} />
        <button className="btn sm primary" disabled={busy} onClick={run}>
          {busy ? 'Running…' : r ? 'Run again' : 'Run security check'}
        </button>
      </div>
      <div className="card-pad stack" style={{ gap: 10 }}>
        <p className="muted small" style={{ margin: 0 }}>
          Sends a valid baseline, then variants a correct webhook handler rejects: bad / missing signature, wrong secret, body changed after signing,
          stale or future timestamps, an exact replay, out-of-order events, a 1 MB body, malformed JSON and a wrong content-type. ❌ = your app
          accepted (2xx) something it should have rejected.
        </p>
        <ErrorBox error={error} />
        {r && (
          <>
            <div className="sec-summary">
              {r.baselineFailed ? (
                <Badge kind="bad">baseline failed</Badge>
              ) : (
                order.filter((v) => r.summary[v] > 0).map((v) => (
                  <Badge key={v} kind={VERDICT[v].kind}>
                    {r.summary[v]} {VERDICT[v].label}
                  </Badge>
                ))
              )}
              <span className="small faint mono ellipsis">{r.targetUrl}</span>
            </div>
            {r.notes.length > 0 && (
              <div className={r.baselineFailed ? 'error-box' : 'info-box'}>
                {r.notes.map((n) => (
                  <div key={n}>{n}</div>
                ))}
              </div>
            )}
            <div className="table-wrap">
              <table className="sec-table">
                <thead>
                  <tr>
                    <th>Variant</th>
                    <th className="col-sm">Expected</th>
                    <th>Status</th>
                    <th>Verdict</th>
                    <th>Note</th>
                    <th>Log</th>
                  </tr>
                </thead>
                <tbody>
                  {r.variants.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <div style={{ fontWeight: 600 }} className="nowrap">
                          {v.label}
                        </div>
                        <div className="small faint">{v.description}</div>
                      </td>
                      <td className="col-sm small nowrap">{EXPECTED[v.expected]}</td>
                      <td>{v.status !== null ? <StatusCode code={v.status} /> : <span className="faint">—</span>}</td>
                      <td className="nowrap">
                        <span className="sec-verdict" aria-hidden>
                          {VERDICT[v.verdict].icon}
                        </span>{' '}
                        <Badge kind={VERDICT[v.verdict].kind}>{VERDICT[v.verdict].label}</Badge>
                      </td>
                      <td className="small sec-note cell-fill">{v.note}</td>
                      <td className="nowrap">
                        {[v.logId, ...(v.extraLogIds ?? [])].filter((x): x is string => !!x).map((id, i) => (
                          <button key={id} className="btn xs ghost" onClick={() => setOpenLog(id)}>
                            {i ? `log ${i + 1}` : 'log'}
                          </button>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {openLog && <LogDrawer id={openLog} onClose={() => setOpenLog(null)} />}
    </div>
  );
}

// ---------------- sequences ----------------

function SequencesCard({ templates }: { templates: Template[] }) {
  const { slug } = useProject();
  const seqs = useWebhookData<Sequence[]>(`/api/projects/${slug}/webhook-sequences`);
  const [editing, setEditing] = useState<Sequence | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const list = seqs.data ?? [];
  const name = (id: string) => templates.find((t) => t.id === id)?.name ?? '(deleted)';
  return (
    <div className="card">
      <div className="card-head">
        <h3>Sequences</h3>
        <button className="btn sm" disabled={templates.length === 0} onClick={() => setEditing('new')} title={templates.length ? '' : 'Create a template first'}>
          <Icon name="plus" size={13} /> New sequence
        </button>
      </div>
      <ErrorBox error={seqs.error} />
      {list.length === 0 ? (
        <p className="muted small" style={{ padding: '12px 16px', margin: 0 }}>
          Chain templates with delays, e.g. payment.pending → wait 2 s → payment.success, or send the same event twice (repeat) to test idempotency. Runs survive a stubyard restart.
        </p>
      ) : (
        list.map((q) => (
          <div key={q.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="row nowrap list-row" style={{ padding: '10px 14px' }}>
              <button className="btn xs ghost" onClick={() => setOpen(open === q.id ? null : q.id)} aria-expanded={open === q.id} aria-label="Details">
                {open === q.id ? '▾' : '▸'}
              </button>
              <div style={{ fontWeight: 600, minWidth: 140 }}>{q.name}</div>
              <div className="row grow small row-meta">
                {q.steps.map((s, i) => (
                  <span key={i} className="row" style={{ gap: 4 }}>
                    {i > 0 && <span className="faint">→</span>}
                    {s.delayMs > 0 && <span className="faint">wait {fmtDelay(s.delayMs)} →</span>}
                    <Badge>
                      {name(s.templateId)}
                      {s.repeat > 1 ? ` ×${s.repeat}` : ''}
                    </Badge>
                  </span>
                ))}
              </div>
              <div className="row-actions">
                <RunSequence q={q} />
                <button className="btn sm ghost" onClick={() => setEditing(q)}>
                  Edit
                </button>
              </div>
            </div>
            {open === q.id && (
              <div style={{ padding: '0 14px 14px' }}>
                <RecentHits path={`/api/projects/${slug}/webhook-sequences/${q.id}/results`} title="Last results" empty="Not run yet." />
              </div>
            )}
          </div>
        ))
      )}
      {editing && <SequenceModal seq={editing === 'new' ? null : editing} templates={templates} onClose={() => setEditing(null)} onDone={seqs.reload} />}
    </div>
  );
}

function fmtDelay(ms: number): string {
  return ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`;
}

function RunSequence({ q }: { q: Sequence }) {
  const { slug } = useProject();
  const toast = useToast();
  const [user, setUser] = useState('');
  return (
    <div className="row nowrap">
      <div className="run-user">
        <UserPicker value={user} onChange={setUser} />
      </div>
      <button
        className="btn sm primary"
        onClick={async () => {
          try {
            const r = await api.post<{ runId: string; steps: unknown[] }>(`/api/projects/${slug}/webhook-sequences/${q.id}/run`, { asUser: user || undefined });
            toast(`Started ${q.name} (${r.steps.length} steps)`);
          } catch (e) {
            toast((e as Error).message);
          }
        }}
      >
        Run
      </button>
      <SendLater request={() => ({ method: 'POST', path: `/webhook-sequences/${q.id}/run`, body: { asUser: user || undefined } })} label={`Run ${q.name}`} />
    </div>
  );
}

function SequenceModal({ seq, templates, onClose, onDone }: { seq: Sequence | null; templates: Template[]; onClose: () => void; onDone: () => void }) {
  const { slug } = useProject();
  const [name, setName] = useState(seq?.name ?? '');
  const [steps, setSteps] = useState<Step[]>(seq?.steps ?? [{ templateId: templates[0]?.id ?? '', delayMs: 0, repeat: 1 }]);
  const [error, setError] = useState<string | null>(null);
  const setStep = (i: number, patch: Partial<Step>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const save = async () => {
    try {
      if (seq) await api.patch(`/api/projects/${slug}/webhook-sequences/${seq.id}`, { name, steps });
      else await api.post(`/api/projects/${slug}/webhook-sequences`, { name, steps });
      onDone();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async () => {
    if (!seq || !confirm(`Delete sequence "${seq.name}"?`)) return;
    await api.del(`/api/projects/${slug}/webhook-sequences/${seq.id}`);
    onDone();
    onClose();
  };
  return (
    <Modal
      title={seq ? `Edit sequence` : 'New sequence'}
      onClose={onClose}
      footer={
        <>
          {seq && (
            <button className="btn danger" onClick={remove} style={{ marginRight: 'auto' }}>
              Delete
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={error} />
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Payment flow" autoFocus />
        </label>
        <div className="field" style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 550 }}>
          Steps <span className="hint" style={{ fontWeight: 400, color: 'var(--faint)' }}>Wait is measured from the previous step; repeat sends the identical payload again</span>
        </div>
        {steps.map((s, i) => (
          <div key={i} className="row nowrap wrap-sm">
            <span className="faint small" style={{ width: 18 }}>
              {i + 1}.
            </span>
            <label className="small faint" style={{ whiteSpace: 'nowrap' }}>
              wait
            </label>
            <input type="number" min={0} step={100} value={s.delayMs} onChange={(e) => setStep(i, { delayMs: Number(e.target.value) || 0 })} style={{ width: 100 }} aria-label="Delay ms" />
            <span className="small faint">ms, then send</span>
            <select value={s.templateId} onChange={(e) => setStep(i, { templateId: e.target.value })}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <span className="small faint">×</span>
            <input type="number" min={1} max={20} value={s.repeat} onChange={(e) => setStep(i, { repeat: Math.max(1, Number(e.target.value) || 1) })} style={{ width: 64 }} aria-label="Repeat" />
            <button className="btn xs ghost danger" disabled={steps.length === 1} onClick={() => setSteps(steps.filter((_, j) => j !== i))} aria-label="Remove step">
              ✕
            </button>
          </div>
        ))}
        <div>
          <button className="btn sm" onClick={() => setSteps([...steps, { templateId: templates[0]?.id ?? '', delayMs: 2000, repeat: 1 }])}>
            <Icon name="plus" size={13} /> Step
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------- help ----------------

function VariablesHelp({ ref_ }: { ref_: Reference | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <div className="card-head" style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <h3>Template variables &amp; signatures</h3>
        <span className="faint">{open ? '▾' : '▸'}</span>
      </div>
      {open && ref_ && (
        <div className="card-pad stack">
          <table>
            <tbody>
              {ref_.variables.map((v) => (
                <tr key={v.name}>
                  <td className="cell-key">
                    <code>{`{{${v.name}}}`}</code>
                  </td>
                  <td className="small muted">{v.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ margin: 0 }}>
            In JSON bodies, string values are escaped automatically and objects (e.g. <code>{'{{data.order}}'}</code>) are inserted as JSON. Unknown variables render empty and are
            reported after sending.
          </p>
          <table>
            <tbody>
              {ref_.signing.map((s) => (
                <tr key={s.id}>
                  <td className="cell-key">{s.name}</td>
                  <td className="small muted">{s.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
