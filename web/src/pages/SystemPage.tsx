import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type SystemInfo } from '../api';
import { ErrorBox, Modal, fmtBytes, timeAgo, useToast } from '../components/ui';
import { useProjects } from '../context';
import { useFetch } from '../hooks';

interface MaintenanceReport {
  at: string;
  durationMs: number;
  logsExpired: number;
  logsForSize: number;
  vacuumed: boolean;
  autoReset: { project: string; messages: number; logs: number }[];
  dbBytes: number;
  error?: string;
}

interface Storage {
  fileBytes: number;
  usedBytes: number;
  freeBytes: number;
  counts: Record<string, number>;
  oldestLogAt: string | null;
  retention: { logRetentionDays: number; maxDbMb: number; intervalMs: number };
  lastRun: MaintenanceReport | null;
  versions: { node: string; sqlite: string | null };
  dataDir: string;
}

const COUNT_LABELS: Record<string, string> = {
  projects: 'Projects',
  test_users: 'Test users',
  provider_instances: 'Provider instances',
  messages: 'Messages',
  traffic_logs: 'Traffic log entries',
  rules: 'Scenario rules',
  authenticators: 'Authenticator keys',
  api_mocks: 'API mocks',
  scheduled_jobs: 'Scheduled jobs',
};

const PHRASE = 'DELETE EVERYTHING';

/** /system — storage, retention, versions and factory reset. */
export default function SystemPage() {
  const sys = useFetch<SystemInfo>('/api/system');
  const storage = useFetch<Storage>('/api/system/storage');
  const { reload: reloadProjects } = useProjects();
  const toast = useToast();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const s = storage.data;
  const max = (s?.retention.maxDbMb ?? 0) * 1024 * 1024;

  const runNow = async () => {
    setBusy(true);
    try {
      const r = await api.post<MaintenanceReport>('/api/system/maintenance');
      toast(`Clean-up done: ${r.logsExpired + r.logsForSize} log entries removed`);
      void storage.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const factoryReset = async () => {
    try {
      const r = await api.post<{ projects: number; messages: number; logs: number }>('/api/factory-reset', { confirm: phrase });
      toast(`Factory reset: ${r.projects} projects, ${r.messages} messages, ${r.logs} log entries deleted`);
      setConfirmOpen(false);
      reloadProjects();
      nav('/');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>System</h1>
          <p>Storage, automatic clean-up and versions of this devhub instance.</p>
        </div>
      </div>
      <ErrorBox error={storage.error ?? error} />
      <div className="stack" style={{ maxWidth: 900 }}>
        {s && (
          <div className="card card-pad stack">
            <h2>Storage</h2>
            <dl className="kv" style={{ padding: 0, border: 0, gridTemplateColumns: '180px 1fr' }}>
              <dt>Database</dt>
              <dd>
                {fmtBytes(s.fileBytes)} on disk · {fmtBytes(s.usedBytes)} used{max > 0 && ` of ${s.retention.maxDbMb} MB limit`}
                {max > 0 && (
                  <div className="totp-bar" style={{ marginTop: 6, maxWidth: 360 }}>
                    <span style={{ width: `${Math.min(100, (s.usedBytes / max) * 100)}%` }} />
                  </div>
                )}
              </dd>
              <dt>Data directory</dt>
              <dd className="mono">{s.dataDir}</dd>
              {Object.entries(s.counts).map(([k, n]) => (
                <Row key={k} label={COUNT_LABELS[k] ?? k} value={n.toLocaleString()} />
              ))}
              <dt>Oldest log entry</dt>
              <dd>{s.oldestLogAt ? `${new Date(s.oldestLogAt).toLocaleString()} (${timeAgo(s.oldestLogAt)})` : '—'}</dd>
            </dl>
          </div>
        )}
        {s && (
          <div className="card card-pad stack">
            <div className="row">
              <h2 className="grow">Automatic clean-up</h2>
              <button className="btn" disabled={busy} onClick={runNow}>
                {busy ? 'Running…' : 'Run now'}
              </button>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              Every {Math.round(s.retention.intervalMs / 60000) || '—'} min: traffic logs older than <b>{s.retention.logRetentionDays || '∞'} days</b> are deleted
              (projects can override this in their settings); above <b>{s.retention.maxDbMb || '∞'} MB</b> the oldest logs are deleted first and the file is
              compacted; projects with auto-reset lose captured data older than their limit. Configure with <code>DEVHUB_LOG_RETENTION_DAYS</code>,{' '}
              <code>DEVHUB_MAX_DB_MB</code> and <code>DEVHUB_MAINTENANCE_INTERVAL_MS</code>.
            </p>
            {s.lastRun ? (
              <p className="small" style={{ margin: 0 }}>
                Last run {timeAgo(s.lastRun.at)}: {s.lastRun.logsExpired} expired and {s.lastRun.logsForSize} oversize log entries removed
                {s.lastRun.vacuumed && ', database compacted'}
                {s.lastRun.autoReset.length > 0 && `, auto-reset ${s.lastRun.autoReset.map((a) => a.project).join(', ')}`}
                {s.lastRun.error && <span style={{ color: 'var(--bad)' }}> · error: {s.lastRun.error}</span>}
              </p>
            ) : (
              <p className="small faint" style={{ margin: 0 }}>
                Not run yet since the last start.
              </p>
            )}
          </div>
        )}
        <div className="card card-pad stack">
          <h2>Versions</h2>
          <dl className="kv" style={{ padding: 0, border: 0, gridTemplateColumns: '180px 1fr' }}>
            <dt>devhub</dt>
            <dd>{sys.data?.version ?? '…'}</dd>
            <dt>Node.js</dt>
            <dd>{s?.versions.node ?? '…'}</dd>
            <dt>SQLite</dt>
            <dd>{s?.versions.sqlite ?? '…'}</dd>
            <dt>Ports</dt>
            <dd>{sys.data ? `HTTP ${sys.data.ports.http} · HTTPS ${sys.data.ports.https} · SMTP ${sys.data.ports.smtp}` : '…'}</dd>
          </dl>
        </div>
        <div className="card card-pad stack" style={{ borderColor: 'var(--bad)' }}>
          <div className="row">
            <div className="grow">
              <h2>Factory reset</h2>
              <p className="muted small" style={{ margin: 0 }}>
                Deletes every project, test user, provider, rule, mock, message, email and log entry. The HTTPS certificate authority is kept, so apps that
                trust it keep working.
              </p>
            </div>
            <button className="btn danger" onClick={() => (setPhrase(''), setConfirmOpen(true))}>
              Factory reset…
            </button>
          </div>
        </div>
      </div>
      {confirmOpen && (
        <Modal
          title="Factory reset"
          onClose={() => setConfirmOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmOpen(false)}>
                Cancel
              </button>
              <button className="btn primary" style={{ background: 'var(--bad)', borderColor: 'var(--bad)' }} disabled={phrase !== PHRASE} onClick={factoryReset}>
                Delete everything
              </button>
            </>
          }
        >
          <div className="form">
            <p style={{ margin: 0 }}>
              This deletes {s ? `${s.counts.projects ?? 0} projects, ${(s.counts.messages ?? 0).toLocaleString()} messages and ${(s.counts.traffic_logs ?? 0).toLocaleString()} log entries` : 'all data'}.
              It cannot be undone. Type <code>{PHRASE}</code> to confirm.
            </p>
            <input value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={PHRASE} autoFocus />
          </div>
        </Modal>
      )}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
