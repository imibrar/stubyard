import { useState } from 'react';
import { api } from '../api';
import { useGate } from '../auth';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { storageBase, type SimulateRow, type StorageInstance, type StoragePresets, type StorageRule } from '../storageApi';
import { Badge, useToast } from './ui';

function describe(r: StorageRule): string {
  const p = r.params;
  const arg = p.maxBytes ? ` > ${p.maxBytes} B` : p.bytesPerSec ? ` ${p.bytesPerSec} B/s` : p.delayMs ? ` ${p.delayMs} ms` : p.afterBytes ? ` after ${p.afterBytes} B` : '';
  return `${r.action.replace(/_/g, ' ')}${arg}`;
}

/** How often a toggled error fires: every request, the next N, or a share of requests. */
const FREQUENCIES: { id: string; label: string; rule: { count?: number; failRate?: number } }[] = [
  { id: 'always', label: 'Every time', rule: {} },
  { id: 'next1', label: 'Next 1', rule: { count: 1 } },
  { id: 'next3', label: 'Next 3', rule: { count: 3 } },
  { id: 'third', label: '1 in 3 (33%)', rule: { failRate: 0.33 } },
  { id: 'half', label: 'Half (50%)', rule: { failRate: 0.5 } },
];
const MB = 1024 * 1024;
const SIZES = [1, 5, 10, 100];

/** What a non-error row does (slow / reset / corrupt have no error response of their own). */
const EFFECT_TEXT: Record<string, string> = {
  'slow-upload': 'uploads at 64 KiB/s',
  'slow-download': 'downloads at 64 KiB/s',
  reset: 'connection drops after 64 KiB',
  corrupt: 'body altered: checksum fails',
};

function nativeText(row: SimulateRow): { short: string; full: string } {
  if (!row.error) return { short: EFFECT_TEXT[row.id] ?? '', full: EFFECT_TEXT[row.id] ?? '' };
  const { status, code, message } = row.error;
  const full = [status, code, message].filter(Boolean).join(' ');
  if (code) return { short: `${status} ${code}`, full };
  const m = message ?? '';
  return { short: `${status} ${m.length > 24 ? `${m.slice(0, 22)}…` : m}`, full };
}

/** Rules made by a toggle row (instance-wide, not bound to a run or bucket). */
const rowOf = (r: StorageRule) => (!r.runId && !r.bucketId && typeof r.params.simulate === 'string' ? r.params.simulate : null);

/** "Simulate errors": one toggle per common error of this provider; the full rule form stays under Advanced. */
export function StorageRules({ slug, instance, presets }: { slug: string; instance: StorageInstance; presets: StoragePresets | null }) {
  const base = `${storageBase(slug, instance.slug)}/rules`;
  const rules = useFetch<StorageRule[]>(`${base}?all=1`, [base]);
  const reload = useDebounced(() => void rules.reload(), 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'storage.changed') reload();
  });
  const toast = useToast();
  const g = useGate(slug)('project.providers');
  const [busy, setBusy] = useState<string | null>(null);
  const call = async (fn: () => Promise<unknown>, msg: string | null, id: string | null = null) => {
    setBusy(id);
    try {
      await fn();
      if (msg) toast(msg);
      reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const list = rules.data ?? [];
  const byRow = new Map<string, StorageRule>();
  for (const r of list) {
    const id = rowOf(r);
    if (id && !byRow.has(id)) byRow.set(id, r);
  }
  const custom = list.filter((r) => !rowOf(r));
  const rows = instance.simulate ?? [];

  /** Turn a row on (or change its frequency / size): any old rule of the row goes, a fresh one is made. */
  const setRow = (row: SimulateRow, freq: string, sizeMb: number | null, on: boolean) =>
    call(
      async () => {
        const old = byRow.get(row.id);
        if (old) await api.del(`${base}/${old.id}`);
        if (!on) return;
        const f = FREQUENCIES.find((x) => x.id === freq) ?? FREQUENCIES[0];
        const params: Record<string, unknown> = { ...(row.params ?? {}), simulate: row.id, freq: f.id };
        if (row.sizes && sizeMb) params.maxBytes = sizeMb * MB;
        await api.post(base, { action: row.action, op: row.op, label: row.label, params, ...f.rule });
      },
      on ? `On: ${row.label}` : `Off: ${row.label}`,
      row.id,
    );

  return (
    <div className="card">
      <div className="card-head">
        <h3>Simulate errors — {instance.name}</h3>
        {list.length > 0 && (
          <button className="btn sm ghost" onClick={() => void call(() => api.del(`${base}?all=1`), 'All errors off')} {...g}>
            Turn all off
          </button>
        )}
      </div>
      <div className="card-pad stack">
        <p className="small faint" style={{ margin: 0 }}>
          Each switch makes new requests fail the way {instance.presetName} does. When two errors are on, the one higher in this list wins for each request ("Next N" and the percentages let them take turns).
        </p>
        <div className="sim-list" role="list">
          {rows.map((row) => {
            const rule = byRow.get(row.id);
            const on = !!rule && rule.active;
            const freq = String(rule?.params.freq ?? 'always');
            const sizeMb = Number(rule?.params.maxBytes ?? row.params?.maxBytes ?? MB) / MB;
            const t = nativeText(row);
            const off = g.disabled || busy === row.id;
            return (
              <div key={row.id} className={`sim-row${on ? ' on' : ''}`} role="listitem">
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={row.label}
                  className="sim-switch"
                  disabled={off}
                  title={g.title}
                  onClick={() => void setRow(row, freq, row.sizes ? sizeMb : null, !on)}
                />
                <div className="sim-text">
                  <span className="sim-label">{row.label}</span>
                  <span className="sim-err" title={t.full}>
                    {t.short}
                  </span>
                </div>
                <div className="sim-controls">
                  {row.sizes && (
                    <select
                      className="sim-select"
                      aria-label={`${row.label}: size limit`}
                      value={SIZES.includes(sizeMb) ? sizeMb : 1}
                      disabled={off}
                      onChange={(e) => void setRow(row, freq, Number(e.target.value), true)}
                    >
                      {SIZES.map((s) => (
                        <option key={s} value={s}>
                          over {s} MB
                        </option>
                      ))}
                    </select>
                  )}
                  <select className="sim-select" aria-label={`${row.label}: how often`} value={freq} disabled={off} onChange={(e) => void setRow(row, e.target.value, row.sizes ? sizeMb : null, true)}>
                    {FREQUENCIES.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  {rule && (rule.hits > 0 || !rule.active) && <Badge kind={rule.active ? 'accent' : undefined}>{rule.active ? `${rule.hits} hit${rule.hits === 1 ? '' : 's'}` : `done · ${rule.hits}`}</Badge>}
                </div>
              </div>
            );
          })}
        </div>
        <AdvancedRule base={base} presets={presets} g={g} call={call} />
        {custom.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <div className="small muted">Custom rules (Advanced, API or MCP) — checked after the switches above, first in the list wins</div>
            {custom.map((r) => (
              <div key={r.id} className="row nowrap list-row">
                <div className="grow">
                  <span style={{ fontWeight: 600 }}>{r.label ?? describe(r)}</span>
                </div>
                <div className="row row-meta small">
                  <Badge>{r.op}</Badge>
                  {r.keyPrefix && <Badge>{r.keyPrefix}*</Badge>}
                  {r.bucketId && <Badge>bucket</Badge>}
                  {r.runId && <Badge kind="accent">run</Badge>}
                  {r.remainingCount !== null && <Badge>{r.remainingCount} left</Badge>}
                  {r.failRate !== null && <Badge>{Math.round(r.failRate * 100)}%</Badge>}
                  {!r.active && <Badge kind="warn">inactive</Badge>}
                  <span className="faint">{r.hits} hits</span>
                </div>
                <div className="row-actions">
                  <button className="btn xs ghost" onClick={() => void call(() => api.patch(`${base}/${r.id}`, { enabled: !r.enabled }), r.enabled ? 'Rule paused' : 'Rule enabled')} {...g}>
                    {r.enabled ? 'Pause' : 'Enable'}
                  </button>
                  <button className="btn xs ghost danger" onClick={() => void call(() => api.del(`${base}/${r.id}`), 'Rule deleted')} {...g}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The full rule form (bucket, key prefix, after N, minutes, custom params), folded away. */
function AdvancedRule({ base, presets, g, call }: { base: string; presets: StoragePresets | null; g: { disabled?: boolean; title?: string }; call: (fn: () => Promise<unknown>, msg: string | null) => Promise<void> }) {
  const [action, setAction] = useState('access_denied');
  const [op, setOp] = useState('any');
  const [bucket, setBucket] = useState('');
  const [keyPrefix, setKeyPrefix] = useState('');
  const [count, setCount] = useState('');
  const [after, setAfter] = useState('');
  const [minutes, setMinutes] = useState('');
  const [params, setParams] = useState('');
  const add = () =>
    call(async () => {
      let p: Record<string, unknown> | undefined;
      if (params.trim()) {
        try {
          p = JSON.parse(params) as Record<string, unknown>;
        } catch {
          throw new Error('Params must be JSON, e.g. {"maxBytes": 1048576}');
        }
      }
      const num = (s: string) => (s.trim() ? Number(s) : undefined);
      await api.post(base, { action, op, bucket: bucket || undefined, keyPrefix: keyPrefix || undefined, count: num(count), after: num(after), minutes: num(minutes), params: p });
    }, 'Rule added');
  return (
    <details className="sim-advanced">
      <summary className="small">Advanced rule</summary>
      <div className="stack" style={{ marginTop: 10 }}>
        <div className="sim-adv-grid">
          <label className="small">
            Action
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              {(presets?.actions ?? []).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label className="small">
            Operation
            <select value={op} onChange={(e) => setOp(e.target.value)}>
              {(presets?.ops ?? ['any']).map((o) => (
                <option key={o} value={o}>
                  {o === 'any' ? 'any operation' : o}
                </option>
              ))}
            </select>
          </label>
          <label className="small">
            Bucket
            <input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="any bucket" />
          </label>
          <label className="small">
            Key prefix
            <input value={keyPrefix} onChange={(e) => setKeyPrefix(e.target.value)} placeholder="any key" />
          </label>
          <label className="small">
            Count
            <input type="number" min={1} value={count} onChange={(e) => setCount(e.target.value)} placeholder="always" />
          </label>
          <label className="small">
            After N requests
            <input type="number" min={0} value={after} onChange={(e) => setAfter(e.target.value)} placeholder="0" />
          </label>
          <label className="small">
            For minutes
            <input type="number" min={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="no end" />
          </label>
          <label className="small">
            Params (JSON)
            <input value={params} onChange={(e) => setParams(e.target.value)} placeholder='{"delayMs": 2000}' />
          </label>
        </div>
        <div className="row">
          <button className="btn sm primary" onClick={() => void add()} {...g}>
            Add rule
          </button>
        </div>
        <p className="small faint" style={{ margin: 0 }}>
          Most SDKs retry 5xx and throttling, so a count of 1 is usually invisible to the app. Per request: <code>X-Hub-Scenario: slow_down</code> or <code>?hub_scenario=</code> on a presigned URL.
        </p>
      </div>
    </details>
  );
}
