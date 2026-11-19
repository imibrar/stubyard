import { useState } from 'react';
import { api } from '../api';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { storageBase, type StorageInstance, type StoragePresets, type StorageRule } from '../storageApi';
import { Badge, useToast } from './ui';

function describe(r: StorageRule): string {
  const p = r.params;
  const arg = p.maxBytes ? ` > ${p.maxBytes} B` : p.bytesPerSec ? ` ${p.bytesPerSec} B/s` : p.delayMs ? ` ${p.delayMs} ms` : p.afterBytes ? ` after ${p.afterBytes} B` : '';
  return `${r.action.replace(/_/g, ' ')}${arg}`;
}

/** Scenario rules of a storage instance (same look as the message rules), with one-click presets. */
export function StorageRules({ slug, instance, presets }: { slug: string; instance: StorageInstance; presets: StoragePresets | null }) {
  const base = `${storageBase(slug, instance.slug)}/rules`;
  const rules = useFetch<StorageRule[]>(`${base}?all=1`, [base]);
  const reload = useDebounced(() => void rules.reload(), 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'storage.changed') reload();
  });
  const toast = useToast();
  const [action, setAction] = useState('access_denied');
  const [op, setOp] = useState('any');
  const [count, setCount] = useState('');
  const call = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const list = rules.data ?? [];
  return (
    <div className="card">
      <div className="card-head">
        <h3>Scenario rules — {instance.name}</h3>
        {list.length > 0 && (
          <button className="btn sm ghost" onClick={() => void call(() => api.del(`${base}?all=1`), 'Rules removed')}>
            Reset all
          </button>
        )}
      </div>
      <div className="card-pad stack">
        <div className="chips">
          {(presets?.rulePresets ?? []).map((p) => (
            <button key={p.id} className="chip" title={p.note} onClick={() => void call(() => api.post(base, { ...p.rule, label: p.label }), `Rule added: ${p.label}`)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="row storage-form">
          <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action">
            {(presets?.actions ?? []).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select value={op} onChange={(e) => setOp(e.target.value)} aria-label="Operation">
            {(presets?.ops ?? ['any']).map((o) => (
              <option key={o} value={o}>
                {o === 'any' ? 'any operation' : o}
              </option>
            ))}
          </select>
          <input type="number" min={1} placeholder="count (always)" value={count} onChange={(e) => setCount(e.target.value)} aria-label="Count" />
          <button className="btn sm primary" onClick={() => void call(() => api.post(base, { action, op, count: count ? Number(count) : undefined }), 'Rule added')}>
            Add rule
          </button>
        </div>
        <p className="small faint" style={{ margin: 0 }}>
          SDKs retry 5xx / 503 (AWS SDK v3: 3 attempts), so a count of 1 is usually invisible to the app. Per request: <code>X-Hub-Scenario: slow_down</code> or <code>?hub_scenario=</code> on a presigned URL.
        </p>
        {list.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            No rules: every request succeeds.
          </p>
        ) : (
          <div className="stack" style={{ gap: 4 }}>
            {list.map((r) => (
              <div key={r.id} className="row nowrap list-row">
                <div className="grow">
                  <span style={{ fontWeight: 600 }}>{r.label ?? describe(r)}</span>
                </div>
                <div className="row row-meta small">
                  <Badge>{r.op}</Badge>
                  {r.keyPrefix && <Badge>{r.keyPrefix}*</Badge>}
                  {r.runId && <Badge kind="accent">run</Badge>}
                  {r.remainingCount !== null && <Badge>{r.remainingCount} left</Badge>}
                  {!r.active && <Badge kind="warn">inactive</Badge>}
                  <span className="faint">{r.hits} hits</span>
                </div>
                <div className="row-actions">
                  <button className="btn xs ghost" onClick={() => void call(() => api.patch(`${base}/${r.id}`, { enabled: !r.enabled }), r.enabled ? 'Rule paused' : 'Rule enabled')}>
                    {r.enabled ? 'Pause' : 'Enable'}
                  </button>
                  <button className="btn xs ghost danger" onClick={() => void call(() => api.del(`${base}/${r.id}`), 'Rule deleted')}>
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
