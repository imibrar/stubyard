import { useEffect, useState } from 'react';
import { api } from '../api';
import { useProject } from '../context';
import { useFetch, useHubEvents } from '../hooks';
import { Badge, ErrorBox, useToast } from './ui';

// Types live here (not in api.ts) to keep the feature self-contained.
type Feature = 'totp' | 'auth' | 'verify' | 'webhooks';
interface TimeView {
  serverTime: string;
  features: Feature[];
  offsets: Partial<Record<Feature, number>>;
  run?: { id: string; key: string; status: string; offsets: Partial<Record<Feature, number>> };
  effective: Record<Feature, string>;
  effectiveOffsets: Record<Feature, number>;
  active: Partial<Record<Feature, string>>;
}

const FEATURES: { id: Feature; label: string; help: string }[] = [
  { id: 'totp', label: 'Authenticator codes', help: 'TOTP codes shown and returned by …/authenticators/code' },
  { id: 'auth', label: 'Login providers', help: 'Token iat / exp / auth_time; code, refresh and access-token expiry' },
  { id: 'verify', label: 'Verify APIs', help: 'Twilio Verify / Vonage Verify code expiry when a code is checked' },
  { id: 'webhooks', label: 'Webhook signatures', help: 'Signed timestamp of webhooks devhub sends (replay-window tests)' },
];
const PRESETS: { label: string; value: string }[] = [
  { label: '−1h', value: '-1h' },
  { label: '+5 min', value: '+5m' },
  { label: '+1h', value: '+1h' },
  { label: '+1d', value: '+1d' },
];

/** 7200000 → "+2h", -90000 → "-1m30s". */
export function formatOffset(ms: number): string {
  if (!ms) return '0';
  let rest = Math.abs(Math.round(ms));
  let out = '';
  for (const [u, n] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]] as const) {
    if (rest >= n) {
      out += `${Math.floor(rest / n)}${u}`;
      rest %= n;
    }
  }
  if (rest) out += `${rest}ms`;
  return (ms < 0 ? '-' : '+') + out;
}

/** Settings card: per-feature clock offsets of the project ("time travel" for expiry tests). */
export function TimeOffsetsCard() {
  const { slug } = useProject();
  const toast = useToast();
  const t = useFetch<TimeView>(`/api/projects/${slug}/time`, [slug]);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState<Partial<Record<Feature, string>>>({});
  useHubEvents(slug, (e) => {
    if (e.type === 'project.updated') void t.reload();
  });
  // Keep the effective clock times fresh.
  useEffect(() => {
    const i = setInterval(() => void t.reload(), 30_000);
    return () => clearInterval(i);
  }, [t.reload]);

  const put = async (offsets: Partial<Record<Feature, string | number>>, msg: string) => {
    setError(null);
    try {
      await api.put(`/api/projects/${slug}/time`, { offsets });
      toast(msg);
      void t.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const resetAll = async () => {
    setError(null);
    try {
      await api.del(`/api/projects/${slug}/time`);
      toast('Clock offsets cleared');
      void t.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const d = t.data;
  const activeCount = d ? Object.keys(d.offsets).length : 0;

  return (
    <div className="card card-pad stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 className="grow" style={{ margin: 0 }}>
          Clock offsets
        </h2>
        {activeCount > 0 ? <Badge kind="warn">{activeCount} active</Badge> : <Badge>real time</Badge>}
        <button className="btn sm" onClick={() => void resetAll()} disabled={!activeCount}>
          Reset all
        </button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Shift devhub's own clock for one feature to test expiry without waiting: e.g. <code>auth +2h</code> makes codes and tokens issued
        earlier look expired. Your app's clock is not changed. A test run can override these with <code>PUT /api/projects/{slug}/time?run=&lt;key&gt;</code>.
      </p>
      <ErrorBox error={error ?? t.error} />
      <div className="stack" style={{ gap: 0 }}>
        {FEATURES.map((f) => {
          const ms = d?.offsets[f.id] ?? 0;
          return (
            <div key={f.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px', padding: '10px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div>
                  <b>{f.label}</b> <span className="mono small faint">{f.id}</span>{' '}
                  {ms ? <Badge kind="warn">{formatOffset(ms)}</Badge> : null}
                </div>
                <div className="small faint">{f.help}</div>
                {ms && d ? <div className="small mono faint">now {new Date(d.effective[f.id]).toLocaleString()}</div> : null}
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {PRESETS.map((p) => (
                  <button key={p.value} className="btn" onClick={() => void put({ [f.id]: p.value }, `${f.label}: ${p.label}`)}>
                    {p.label}
                  </button>
                ))}
                <form
                  className="row"
                  style={{ gap: 6 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const v = (custom[f.id] ?? '').trim();
                    if (v) void put({ [f.id]: v }, `${f.label}: ${v}`).then(() => setCustom((c) => ({ ...c, [f.id]: '' })));
                  }}
                >
                  <input
                    aria-label={`Custom offset for ${f.label}`}
                    placeholder="-90s, 2h30m"
                    value={custom[f.id] ?? ''}
                    onChange={(e) => setCustom((c) => ({ ...c, [f.id]: e.target.value }))}
                    style={{ width: 120 }}
                  />
                  <button className="btn" type="submit" disabled={!(custom[f.id] ?? '').trim()}>
                    Set
                  </button>
                </form>
                <button className="btn ghost" onClick={() => void put({ [f.id]: 0 }, `${f.label}: real time`)} disabled={!ms}>
                  Reset
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {d && <p className="small faint" style={{ margin: 0 }}>Server time {new Date(d.serverTime).toLocaleString()}</p>}
    </div>
  );
}
