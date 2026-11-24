import { useState } from 'react';
import { api } from '../api';
import { useGate } from '../auth';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { payBase, QUICK_OUTCOMES, type PaymentRule } from '../paymentsApi';
import { RunChip } from './RunChip';
import { Badge, Empty, ErrorBox, timeAgo, useToast } from './ui';
import { useProject } from '../context';

/**
 * Outcome rules (forced results for the next payments): per instance, per test user or per run. Used in the
 * provider detail (instance fixed) and on the Payments page (all rules).
 */
export function PaymentRulesPanel({ slug, instance }: { slug: string; instance?: string }) {
  const toast = useToast();
  const { overview } = useProject();
  const g = useGate(slug)('project.providers');
  const base = `${payBase(slug)}/payment-rules`;
  const rules = useFetch<PaymentRule[]>(`${base}?all=1`, [slug]);
  const instances = useFetch<{ slug: string; name: string }[]>(instance ? null : `${payBase(slug)}/payment-instances`, [slug]);
  const reload = useDebounced(() => void rules.reload(), 200);
  useHubEvents(slug, (e) => {
    if (e.type === 'payments.changed' || e.type === 'project.reset' || e.type === 'runs.changed') reload();
  });
  const [form, setForm] = useState({ outcome: 'decline:insufficient_funds', instance: instance ?? '', user: '', count: '1', after: '', minutes: '', label: '' });
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    try {
      await api.post(base, {
        outcome: form.outcome,
        instance: form.instance || undefined,
        user: form.user || undefined,
        count: form.count || undefined,
        after: form.after || undefined,
        minutes: form.minutes || undefined,
        label: form.label || undefined,
      });
      toast('Rule added');
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (id: string) => {
    try {
      await api.del(`${base}/${id}`);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const clear = async () => {
    if (!confirm(instance ? `Delete every rule of ${instance}?` : 'Delete every payment rule of this project?')) return;
    try {
      const r = await api.del<{ deleted: number }>(`${base}${instance ? `?instance=${encodeURIComponent(instance)}` : ''}`);
      toast(`Deleted ${r.deleted} rule${r.deleted === 1 ? '' : 's'}`);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const shown = (rules.data ?? []).filter((r) => !instance || r.instance === instance || r.instance === null);
  const active = shown.filter((r) => r.active);
  const users = overview.users;
  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Force the next outcome</h3>
        </div>
        <div className="card-pad form">
          <ErrorBox error={error} />
          <p className="small muted" style={{ margin: 0 }}>
            Precedence: X-Hub-Payment-Outcome header &gt; run rule &gt; user rule &gt; instance rule &gt; magic card &gt; magic amount &gt; the button clicked on the page / API outcome &gt; default. Outcomes: success,
            decline[:reason], cancel, abandon, 3ds_success, 3ds_fail, pending_then_success; modifiers after a +: no_webhook, duplicate_webhook, webhook_delay=ms, no_redirect, slow=ms.
          </p>
          <div className="form form-2">
            <label className="field">
              Outcome
              <input list="pay-rule-outcomes" className="mono" value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })} />
              <datalist id="pay-rule-outcomes">
                {[...QUICK_OUTCOMES, 'success+no_webhook', 'success+duplicate_webhook', 'success+webhook_delay=10000', 'success+no_redirect'].map((o) => (
                  <option key={o} value={o} />
                ))}
              </datalist>
            </label>
            {!instance && (
              <label className="field">
                Provider
                <select value={form.instance} onChange={(e) => setForm({ ...form, instance: e.target.value })}>
                  <option value="">Any payment provider</option>
                  {(instances.data ?? []).map((i) => (
                    <option key={i.slug} value={i.slug}>
                      {i.name} ({i.slug})
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              Test user <span className="hint">customer email matches the user</span>
              <select value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })}>
                <option value="">Everyone</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                    {u.email ? ` (${u.email})` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Times <span className="hint">empty = until deleted</span>
              <input inputMode="numeric" value={form.count} onChange={(e) => setForm({ ...form, count: e.target.value })} placeholder="1" />
            </label>
            <label className="field">
              Skip first <span className="hint">let N payments through first</span>
              <input inputMode="numeric" value={form.after} onChange={(e) => setForm({ ...form, after: e.target.value })} placeholder="0" />
            </label>
            <label className="field">
              Expires after (minutes)
              <input inputMode="numeric" value={form.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value })} placeholder="never" />
            </label>
            <label className="field">
              Label
              <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="optional" />
            </label>
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => void add()} disabled={!form.outcome.trim() || !!g.disabled} title={g.title}>
              Add rule
            </button>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>
            {active.length} active rule{active.length === 1 ? '' : 's'}
          </h3>
          {shown.length > 0 && (
            <button className="btn sm ghost danger" onClick={() => void clear()} {...g}>
              Delete all
            </button>
          )}
        </div>
        <ErrorBox error={rules.error} />
        {!shown.length ? (
          <Empty title="No rules">
            <p className="small muted">Payments follow the card, the amount or the button clicked on the page.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="pay-rules">
              <thead>
                <tr>
                  <th>Outcome</th>
                  <th>Scope</th>
                  <th>Left</th>
                  <th>Hits</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className={r.active ? '' : 'pay-inactive'}>
                    <td>
                      <code>{r.outcome}</code>
                      {r.label && <div className="small faint">{r.label}</div>}
                    </td>
                    <td>
                      <div className="row pay-chips">
                        <Badge kind={r.level === 'run' ? 'accent' : r.level === 'user' ? 'warn' : ''}>{r.level}</Badge>
                        {r.run && <RunChip runKey={r.run} />}
                        {r.user && <span className="small">{r.user.name}</span>}
                        <span className="small faint">{r.instance ?? 'any provider'}</span>
                      </div>
                    </td>
                    <td className="nowrap small">
                      {r.active ? (r.remaining === null ? '∞' : r.remaining) : 'used up'}
                      {r.skipCount > 0 && <span className="faint"> · skip {r.skipCount}</span>}
                      {r.expiresAt && <div className="faint">until {new Date(r.expiresAt).toLocaleTimeString()}</div>}
                    </td>
                    <td className="small">{r.hits}</td>
                    <td className="small faint nowrap">{timeAgo(r.createdAt)}</td>
                    <td>
                      <button className="btn sm ghost" onClick={() => void remove(r.id)} aria-label="Delete rule" {...g}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
