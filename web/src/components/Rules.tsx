import { useState } from 'react';
import { useGate } from '../auth';
import { api, type ProviderInstance, type Rule, type RuleChannel, type RulePreset } from '../api';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { Icon } from './people';
import { Badge, ErrorBox, useToast } from './ui';

const ACTIONS: Record<string, { label: string; hint: string; scope: ('user' | 'instance')[]; email?: boolean; fields?: ('code' | 'delay' | 'rate')[] }> = {
  fail: { label: 'Fail', hint: 'Accepted, then a failed delivery report (email: bounce DSN)', scope: ['user', 'instance'], fields: ['code'] },
  reject: { label: 'Reject at send', hint: 'The API call itself returns a 4xx error', scope: ['user', 'instance'], fields: ['code'] },
  rate_limit: { label: 'Rate limit (429)', hint: 'Too many requests', scope: ['user', 'instance'] },
  delay: { label: 'Delay delivery', hint: 'Accepted now, arrives later', scope: ['user'], fields: ['delay'] },
  timeout: { label: 'Time out', hint: 'No response at all; the client times out', scope: ['user', 'instance'] },
  drop: { label: 'Drop silently', hint: 'Accepted, never delivered, no report', scope: ['user', 'instance'] },
  blocked: { label: 'Blocked', hint: 'The user cannot receive on this channel', scope: ['user'], fields: ['code'] },
  fail_rate: { label: 'Random failures', hint: 'X % of messages fail', scope: ['user', 'instance'], fields: ['rate', 'code'] },
  deliver: { label: 'Deliver', hint: 'Normal delivery (use to let N messages through first)', scope: ['user'] },
  down: { label: 'Provider down (503)', hint: 'Every call fails with 503', scope: ['instance'] },
  slow: { label: 'Slow responses', hint: 'Every call waits before answering', scope: ['instance'], fields: ['delay'] },
  bounce_hard: { label: 'Email: hard bounce (550)', hint: 'Rejected at RCPT TO', scope: ['user'], email: true },
  bounce_soft: { label: 'Email: soft bounce (452)', hint: 'Mailbox full', scope: ['user'], email: true },
  defer: { label: 'Email: defer (450)', hint: 'Try again later (greylisting)', scope: ['user'], email: true },
  complaint: { label: 'Email: spam complaint', hint: 'Delivered, then marked as spam', scope: ['user'], email: true },
  bounce_delayed: { label: 'Email: bounce later (DSN)', hint: 'Delivered, then a bounce email arrives', scope: ['user'], email: true, fields: ['delay'] },
};

function duration(r: Rule): string {
  const parts: string[] = [];
  if (r.skipCount > 0) parts.push(`after ${r.skipCount} more OK`);
  if (r.remainingCount !== null) parts.push(r.remainingCount > 0 ? `next ${r.remainingCount}` : 'used up');
  if (r.expiresAt) parts.push(new Date(r.expiresAt) > new Date() ? `until ${new Date(r.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'expired');
  return parts.join(' · ') || 'always';
}

/** Scenario rules for a test user or a provider instance, with presets. */
export function RulesPanel({ slug, scope, ownerRef, providers, title }: { slug: string; scope: 'user' | 'instance'; ownerRef: string; providers: ProviderInstance[]; title?: string }) {
  const base = `/api/projects/${slug}/${scope === 'user' ? 'users' : 'providers'}/${ownerRef}/rules`;
  const rules = useFetch<Rule[]>(base, [base]);
  const presets = useFetch<RulePreset[]>('/api/rule-presets');
  const reload = useDebounced(() => void rules.reload(), 150);
  useHubEvents(slug, (e) => {
    if (e.type === 'rules.changed' || e.type === 'message.created') reload();
  });
  const toast = useToast();
  const gate = useGate(slug);
  const g = gate(scope === 'user' ? 'walkthroughs.run' : 'project.providers');
  const gr = gate('walkthroughs.run');
  const [adding, setAdding] = useState(false);
  const [channel, setChannel] = useState<RuleChannel>('all');
  const list = rules.data ?? [];
  const active = list.filter((r) => r.active).length;

  const call = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn();
      if (msg) toast(msg);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3 className="row">
          <Icon name="settings" size={14} /> {title ?? 'Scenario rules'}
          {active > 0 ? <Badge kind="warn">{active} active</Badge> : <Badge kind="ok">normal</Badge>}
        </h3>
        <div className="row">
          <button className="btn sm" onClick={() => setAdding(!adding)} {...g}>
            <Icon name="plus" size={13} /> Rule
          </button>
          {list.length > 0 && (
            <button className="btn sm ghost" onClick={() => call(() => api.del(base), 'Back to normal')} {...g}>
              Reset
            </button>
          )}
        </div>
      </div>
      <div className="card-pad stack" style={{ gap: 10 }}>
        <div className="row small">
          <span className="faint">Quick:</span>
          {scope === 'user' && (
            <select value={channel} onChange={(e) => setChannel(e.target.value as RuleChannel)} style={{ width: 'auto', padding: '2px 6px', fontSize: 12 }} aria-label="Channel for presets">
              <option value="all">all channels</option>
              <option value="email">email</option>
              <option value="sms">SMS</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          )}
          {(presets.data ?? [])
            .filter((p) => p.scope === scope)
            .map((p) => (
              <button key={p.id} className="chip" title={p.description} onClick={() => call(() => api.post(`${base}/preset/${p.id}`, { channel }), `Added "${p.name}"`)} {...g}>
                {p.name}
              </button>
            ))}
        </div>
        {adding && <AddRule base={base} scope={scope} providers={providers} onDone={() => (setAdding(false), reload())} />}
        <ErrorBox error={rules.error} />
        {list.length === 0 ? (
          <p className="small faint" style={{ margin: 0 }}>
            {scope === 'user'
              ? 'No rules: everything is delivered normally. Rules apply top to bottom; the first match wins and counts down.'
              : 'No rules: this provider behaves normally for everyone.'}
          </p>
        ) : (
          <div className="stack" style={{ gap: 4 }}>
            {list.map((r, i) => (
              <div key={r.id} className="rule-row" style={{ opacity: r.active ? 1 : 0.5 }}>
                <span className="mono faint">{i + 1}</span>
                <Badge kind={r.channel === 'all' ? '' : r.channel}>{r.channel}</Badge>
                <span className="grow ellipsis" title={r.description}>
                  {r.description.replace(/^#\d+ /, '')}
                  {scope === 'user' && r.providerInstanceId && <span className="faint"> · via {providers.find((p) => p.id === r.providerInstanceId)?.slug}</span>}
                </span>
                <span className="small faint" style={{ whiteSpace: 'nowrap' }}>
                  {duration(r)}
                  {r.hits > 0 && ` · ${r.hits} hit${r.hits === 1 ? '' : 's'}`}
                </span>
                <button className="btn xs ghost" disabled={i === 0 || !!gr.disabled} onClick={() => call(() => api.patch(`/api/projects/${slug}/rules/${r.id}`, { position: i }))} title={gr.title ?? 'Move up'}>
                  ↑
                </button>
                <button className="btn xs ghost" onClick={() => call(() => api.patch(`/api/projects/${slug}/rules/${r.id}`, { enabled: !r.enabled }))} {...gr}>
                  {r.enabled ? 'Pause' : 'Resume'}
                </button>
                <button className="btn xs ghost danger" onClick={() => call(() => api.del(`/api/projects/${slug}/rules/${r.id}`))} aria-label="Delete rule" {...gr}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AddRule({ base, scope, providers, onDone }: { base: string; scope: 'user' | 'instance'; providers: ProviderInstance[]; onDone: () => void }) {
  const [f, setF] = useState({ action: 'fail', channel: 'all' as RuleChannel, errorCode: '', errorMessage: '', delayMs: '5000', failRate: '30', mode: 'always', count: '1', minutes: '10', after: '0', instance: '' });
  const [error, setError] = useState<string | null>(null);
  const meta = ACTIONS[f.action];
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setError(null);
    try {
      await api.post(base, {
        action: f.action,
        channel: meta.email ? 'email' : f.channel,
        errorCode: meta.fields?.includes('code') ? f.errorCode || undefined : undefined,
        errorMessage: meta.fields?.includes('code') ? f.errorMessage || undefined : undefined,
        delayMs: meta.fields?.includes('delay') ? Number(f.delayMs) : undefined,
        failRate: meta.fields?.includes('rate') ? Number(f.failRate) : undefined,
        count: f.mode === 'count' ? Number(f.count) : undefined,
        minutes: f.mode === 'minutes' ? Number(f.minutes) : undefined,
        after: Number(f.after) || undefined,
        instance: f.instance || undefined,
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="card card-pad form" style={{ background: 'var(--panel-2)' }}>
      <ErrorBox error={error} />
      <div className="form form-2">
        <label className="field">
          Action
          <select value={f.action} onChange={set('action')}>
            {Object.entries(ACTIONS)
              .filter(([, a]) => a.scope.includes(scope))
              .map(([k, a]) => (
                <option key={k} value={k}>
                  {a.label}
                </option>
              ))}
          </select>
          <span className="hint">{meta.hint}</span>
        </label>
        {scope === 'user' && !meta.email && (
          <label className="field">
            Channel
            <select value={f.channel} onChange={set('channel')}>
              <option value="all">All channels</option>
              <option value="email">Email</option>
              <option value="sms">SMS</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </label>
        )}
      </div>
      {meta.fields?.includes('code') && (
        <div className="form form-2">
          <label className="field">
            Error code <span className="hint">Empty = the provider's usual code</span>
            <input value={f.errorCode} onChange={set('errorCode')} placeholder="30003" />
          </label>
          <label className="field">
            Error message
            <input value={f.errorMessage} onChange={set('errorMessage')} placeholder="Unreachable destination handset" />
          </label>
        </div>
      )}
      <div className="form form-2">
        {meta.fields?.includes('delay') && (
          <label className="field">
            Delay (ms)
            <input type="number" min={0} value={f.delayMs} onChange={set('delayMs')} />
          </label>
        )}
        {meta.fields?.includes('rate') && (
          <label className="field">
            Failure rate (%)
            <input type="number" min={1} max={100} value={f.failRate} onChange={set('failRate')} />
          </label>
        )}
      </div>
      <div className="form form-2">
        <label className="field">
          Duration
          <div className="row nowrap">
            <select value={f.mode} onChange={set('mode')} style={{ width: 'auto' }}>
              <option value="always">Always</option>
              <option value="count">Next N messages</option>
              <option value="minutes">For X minutes</option>
            </select>
            {f.mode === 'count' && <input type="number" min={1} value={f.count} onChange={set('count')} style={{ width: 80 }} aria-label="Count" />}
            {f.mode === 'minutes' && <input type="number" min={1} value={f.minutes} onChange={set('minutes')} style={{ width: 80 }} aria-label="Minutes" />}
          </div>
        </label>
        <label className="field">
          Start after <span className="hint">N messages go through normally first</span>
          <input type="number" min={0} value={f.after} onChange={set('after')} />
        </label>
      </div>
      {scope === 'user' && providers.length > 1 && (
        <label className="field">
          Only via provider instance
          <select value={f.instance} onChange={set('instance')}>
            <option value="">Any instance</option>
            {providers.map((p) => (
              <option key={p.id} value={p.slug}>
                {p.slug} ({p.channel})
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="row">
        <button className="btn primary sm" onClick={save}>
          Add rule
        </button>
        <button className="btn sm ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
