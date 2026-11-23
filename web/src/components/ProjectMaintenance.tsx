import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useProject, useProjects } from '../context';
import { useFetch } from '../hooks';
import { ErrorBox, Modal, useToast } from './ui';

interface StorageRetention {
  retention: { logRetentionDays: number; maxDbMb: number };
}

interface ImportResult {
  project: { slug: string; name: string };
  imported: Record<string, number>;
  warnings: string[];
}

export type MaintenancePart = 'retention' | 'export' | 'rules';

/** Settings page cards: retention + auto-reset, export / import, "Reset all rules" (pick with `parts`; default all). */
export function ProjectMaintenance({ parts = ['retention', 'export', 'rules'] }: { parts?: MaintenancePart[] } = {}) {
  const { overview, reload } = useProject();
  const { reload: reloadProjects } = useProjects();
  const p = overview.project;
  const toast = useToast();
  const nav = useNavigate();
  const storage = useFetch<StorageRetention>('/api/system/storage');
  const globalDays = storage.data?.retention.logRetentionDays;
  const [retentionDays, setRetentionDays] = useState(p.settings.retentionDays ? String(p.settings.retentionDays) : '');
  const [autoResetDays, setAutoResetDays] = useState(p.settings.autoResetDays ? String(p.settings.autoResetDays) : '');
  const [secrets, setSecrets] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ json: unknown; name: string; slug: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const days = (v: string) => {
    const n = Number(v);
    return v.trim() && n > 0 ? Math.round(n) : null;
  };

  const saveRetention = async () => {
    setError(null);
    try {
      await api.patch(`/api/projects/${p.slug}`, { settings: { retentionDays: days(retentionDays), autoResetDays: days(autoResetDays) } });
      toast('Retention saved');
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const resetRules = async () => {
    if (!confirm('Remove every scenario rule of every test user and provider instance? Everything goes back to normal delivery.')) return;
    const r = await api.post<{ deleted: number }>(`/api/projects/${p.slug}/rules/reset`);
    toast(`Removed ${r.deleted} rule${r.deleted === 1 ? '' : 's'}`);
    reload();
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    try {
      const json = JSON.parse(await f.text());
      if (json?.format !== 'stubyard-project') throw new Error('This is not a stubyard project export');
      setPending({ json, name: f.name, slug: `${json.project?.slug ?? 'imported'}-copy` });
    } catch (e) {
      setError(`Could not read ${f.name}: ${(e as Error).message}`);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const runImport = async (mode: 'create' | 'replace') => {
    if (!pending) return;
    if (mode === 'replace' && !confirm(`Replace the users, providers, rules and mocks of "${p.name}" with the file's? Captured messages and logs are kept.`)) return;
    try {
      const r = await api.post<ImportResult>('/api/projects/import', { json: pending.json, mode, slug: mode === 'replace' ? p.slug : pending.slug });
      const counts = Object.entries(r.imported)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ');
      toast(`Imported ${counts}`);
      if (r.warnings.length) alert(`Imported with warnings:\n\n${r.warnings.join('\n')}`);
      setPending(null);
      reloadProjects();
      if (mode === 'create') nav(`/p/${r.project.slug}`);
      else reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      {parts.includes('retention') && (
      <div className="card card-pad form">
        <h2>Data retention</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Traffic logs are deleted after {globalDays ?? 7} days by default, and the oldest logs go first when the database passes{' '}
          {storage.data?.retention.maxDbMb ?? 500} MB (set with <code>STUBYARD_LOG_RETENTION_DAYS</code> / <code>STUBYARD_MAX_DB_MB</code>).
        </p>
        <div className="form form-2">
          <label className="field">
            Keep this project's logs for (days) <span className="hint">Empty = default ({globalDays ?? 7})</span>
            <input type="number" min={1} value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} placeholder={String(globalDays ?? 7)} />
          </label>
          <label className="field">
            Auto-reset after (days) <span className="hint">Messages, emails and logs older than this are removed automatically. Empty = off.</span>
            <input type="number" min={1} value={autoResetDays} onChange={(e) => setAutoResetDays(e.target.value)} placeholder="off" />
          </label>
        </div>
        <ErrorBox error={error} />
        <div className="row">
          <button className="btn primary" onClick={saveRetention}>
            Save retention
          </button>
        </div>
      </div>
      )}

      {parts.includes('export') && (
      <div className="card card-pad stack">
        <h2>Export / import</h2>
        <p className="muted small" style={{ margin: 0 }}>
          The project's configuration as JSON: settings, test users (with passwords and pins), provider instances, rules and API mocks. Commit it to your app's
          repository so others can import it. Messages and logs are not included.
        </p>
        <div className="row">
          <a className="btn" href={`/api/projects/${p.slug}/export?download=1${secrets ? '&secrets=1' : ''}`} download={`stubyard-${p.slug}.json`}>
            Download export
          </a>
          <label className="row small" style={{ gap: 4 }}>
            <input type="checkbox" checked={secrets} onChange={(e) => setSecrets(e.target.checked)} /> include authenticator (2FA) keys — these are secrets
          </label>
          <span className="grow" />
          <button className="btn" onClick={() => fileRef.current?.click()}>
            Import file…
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
        </div>
        {!parts.includes('retention') && <ErrorBox error={error} />}
      </div>
      )}

      {parts.includes('rules') && (
      <div className="card card-pad stack">
        <div className="row">
          <div className="grow">
            <h3>Reset all rules</h3>
            <p className="muted small" style={{ margin: 0 }}>
              Removes every scenario rule (users and provider instances): all messages are delivered normally again.
            </p>
          </div>
          <button className="btn" onClick={resetRules}>
            Reset all rules
          </button>
        </div>
      </div>
      )}

      {pending && (
        <Modal
          title={`Import ${pending.name}`}
          onClose={() => setPending(null)}
          footer={
            <>
              <button className="btn" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => runImport('replace')}>
                Replace "{p.slug}"
              </button>
              <button className="btn primary" onClick={() => runImport('create')}>
                Create new project
              </button>
            </>
          }
        >
          <div className="form">
            <p style={{ margin: 0 }}>Create a new project from the file, or replace this project's configuration with it.</p>
            <label className="field">
              Slug for the new project
              <input value={pending.slug} onChange={(e) => setPending({ ...pending, slug: e.target.value })} />
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}
