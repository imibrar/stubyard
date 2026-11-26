import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useGate } from '../auth';
import { contractsApi, specDetailPath, specDownloadUrl, specsPath, type ApiSpec, type ApiSpecDetail, type SpecImportResult, type SpecMode, type SpecOptions, type SpecRole } from '../contractsApi';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { projectPath } from '../nav';
import { ContractCheck, RecentContractIssues } from './ContractCheck';
import { Icon } from './people';
import { ImportPreview, SPEC_MODE_HELP, SPEC_ROLE_HELP, SpecImport } from './SpecImport';
import { Badge, Empty, ErrorBox, Modal, timeAgo, useCopy, useToast } from './ui';

/** Link to this project's traffic log filtered to contract issues (TrafficLog reads ?contract=). */
export const contractIssuesLink = (slug: string) => `${projectPath(slug, 'traffic')}?contract=issues`;

/**
 * The "API specs" tab of the Mocks page: imported OpenAPI specs, their detail (operations, settings, re-import,
 * download, delete), an ad-hoc "Check a request" form and the recent contract issues.
 */
export function ContractSpecs({ slug, onOpenMock }: { slug: string; /** Open a generated mock in the mock editor. */ onOpenMock: (mockId: string) => void }) {
  const specs = useFetch<ApiSpec[]>(specsPath(slug), [slug]);
  const reload = useDebounced(() => void specs.reload(), 250);
  useHubEvents(slug, (e) => {
    if (e.type === 'contracts.changed' || e.type === 'mocks.changed' || e.type === 'project.reset') reload();
  });
  const gate = useGate(slug)('project.providers');
  const [importing, setImporting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reimporting, setReimporting] = useState<ApiSpec | null>(null);
  const [deleting, setDeleting] = useState<ApiSpec | null>(null);
  const [last, setLast] = useState<SpecImportResult | null>(null);
  const list = specs.data ?? [];
  const open = list.find((s) => s.id === openId) ?? null;
  const done = (r: SpecImportResult) => {
    setLast(r);
    if (r.spec.id) setOpenId(r.spec.id);
    void specs.reload();
  };

  return (
    <div className="stack">
      <ErrorBox error={specs.error} />
      <div className="card">
        <div className="card-head">
          <h3>API specs</h3>
          <span className="spacer" />
          <button className="btn sm primary" onClick={() => setImporting(true)} {...gate}>
            <Icon name="plus" size={12} /> Import OpenAPI
          </button>
        </div>
        {list.length === 0 && !specs.loading ? (
          <Empty title="No OpenAPI specs yet">
            <p className="muted">
              Import an OpenAPI 3 document to get one mock per operation, with example responses, and a contract check on every request your app sends to
              them. Import your app's own API (role "Your app's API") to check its webhook and replay responses.
            </p>
            <button className="btn primary" onClick={() => setImporting(true)} {...gate}>
              Import OpenAPI
            </button>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="spec-table">
              <thead>
                <tr>
                  <th scope="col">Spec</th>
                  <th scope="col">Role</th>
                  <th scope="col">Prefix / base URL</th>
                  <th scope="col">Checks</th>
                  <th scope="col">Operations</th>
                  <th scope="col">Issues (24 h)</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <SpecRow key={s.id} slug={slug} s={s} open={s.id === openId} onToggle={() => setOpenId(s.id === openId ? null : s.id)} onReimport={() => setReimporting(s)} onDelete={() => setDeleting(s)} reload={() => void specs.reload()} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {last && !last.dryRun && (
        <div className="card card-pad">
          <div className="row">
            <h3 className="grow" style={{ margin: 0 }}>
              Last import
            </h3>
            <button className="btn xs ghost" onClick={() => setLast(null)} aria-label="Dismiss the last import result">
              ✕
            </button>
          </div>
          <ImportPreview result={last} />
        </div>
      )}
      {open && <SpecDetail key={open.id} slug={slug} spec={open} onClose={() => setOpenId(null)} onReimport={() => setReimporting(open)} onDelete={() => setDeleting(open)} onOpenMock={onOpenMock} />}
      {list.length > 0 && <ContractCheck slug={slug} specs={list} />}
      <RecentContractIssues slug={slug} />
      {importing && <SpecImport slug={slug} onClose={() => setImporting(false)} onDone={done} />}
      {reimporting && <SpecImport slug={slug} spec={reimporting} onClose={() => setReimporting(null)} onDone={done} />}
      {deleting && (
        <DeleteSpec
          slug={slug}
          spec={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            if (openId === deleting.id) setOpenId(null);
            void specs.reload();
          }}
        />
      )}
    </div>
  );
}

function SpecRow({ slug, s, open, onToggle, onReimport, onDelete, reload }: { slug: string; s: ApiSpec; open: boolean; onToggle: () => void; onReimport: () => void; onDelete: () => void; reload: () => void }) {
  const copy = useCopy();
  const toast = useToast();
  const gate = useGate(slug)('project.providers');
  const setMode = async (mode: SpecMode) => {
    try {
      await contractsApi.update(slug, s.id, { mode });
      toast(`Contract checks: ${mode}`);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const issues = s.issues24h;
  return (
    <tr className={open ? 'spec-row open' : 'spec-row'}>
      <td>
        <button className="btn xs ghost spec-name" onClick={onToggle} aria-expanded={open} title="Operations, settings and re-import">
          {open ? '▾' : '▸'} <span className="mono">{s.name}</span>
        </button>
        <div className="small muted ellipsis">
          {s.title}
          {s.apiVersion && ` v${s.apiVersion}`}
          <span className="faint"> · OpenAPI {s.openapiVersion}</span>
        </div>
      </td>
      <td>
        <Badge title={SPEC_ROLE_HELP[s.role]}>{s.role === 'mock' ? 'API mock' : "Your app's API"}</Badge>
      </td>
      <td className="small">
        {s.role === 'mock' ? (
          <div className="row nowrap" style={{ gap: 4 }}>
            <span className="mono">{s.prefix || '/'}</span>
            {s.mockBaseUrl && (
              <button className="btn xs ghost" onClick={() => copy(s.mockBaseUrl!, 'Base URL copied')} title={s.mockBaseUrl} aria-label={`Copy the base URL of ${s.name}`}>
                <Icon name="copy" size={12} />
              </button>
            )}
          </div>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td>
        <select className="spec-mode" value={s.mode} onChange={(e) => void setMode(e.target.value as SpecMode)} title={gate.title ?? SPEC_MODE_HELP[s.mode]} aria-label={`Contract checks for ${s.name}`} disabled={gate.disabled}>
          <option value="report">Report</option>
          <option value="strict">Strict</option>
          <option value="off">Off</option>
        </select>
      </td>
      <td className="small">
        {s.operations} op{s.operations === 1 ? '' : 's'}
        {s.role === 'mock' && (
          <div className="faint">
            {s.mocks} mock{s.mocks === 1 ? '' : 's'}
          </div>
        )}
      </td>
      <td className="small">
        {issues.withIssues > 0 ? (
          <Link to={contractIssuesLink(slug)} title={`${issues.error} with errors, ${issues.warn} with warnings, of ${issues.checked} checked`}>
            <Badge kind={issues.error ? 'bad' : 'warn'}>
              {issues.withIssues} issue{issues.withIssues === 1 ? '' : 's'}
            </Badge>
          </Link>
        ) : issues.checked > 0 ? (
          <Badge kind="ok" title={`${issues.checked} checked`}>
            ✓ clean
          </Badge>
        ) : (
          <span className="faint">not used</span>
        )}
      </td>
      <td>
        <div className="row-actions">
          <button className="btn sm ghost" onClick={onReimport} {...gate}>
            Re-import
          </button>
          <button className="btn sm ghost danger" onClick={onDelete} {...gate}>
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

function SpecDetail({ slug, spec, onClose, onReimport, onDelete, onOpenMock }: { slug: string; spec: ApiSpec; onClose: () => void; onReimport: () => void; onDelete: () => void; onOpenMock: (id: string) => void }) {
  const detail = useFetch<ApiSpecDetail>(specDetailPath(slug, spec.id), [spec.id, spec.updatedAt, spec.mocks]);
  const gate = useGate(slug)('project.providers');
  const ops = detail.data?.operationList ?? [];
  const edited = ops.filter((o) => o.mock?.edited).length;
  return (
    <section className="card" aria-label={`Spec ${spec.name}`}>
      <div className="card-head">
        <h3>
          <span className="mono">{spec.name}</span>
          <span className="muted small">
            {' '}
            · {spec.title}
            {spec.apiVersion && ` v${spec.apiVersion}`}
          </span>
        </h3>
        <span className="spacer" />
        <a className="btn sm" href={specDownloadUrl(slug, spec.id)} download={`${spec.name}.openapi.json`}>
          Download
        </a>
        <button className="btn sm" onClick={onReimport} {...gate}>
          Re-import
        </button>
        <button className="btn sm ghost danger" onClick={onDelete} {...gate}>
          Delete
        </button>
        <button className="btn sm ghost" onClick={onClose} aria-label="Close the spec detail">
          ✕
        </button>
      </div>
      <div className="card-pad stack">
        <p className="small muted" style={{ margin: 0 }}>
          Source: {spec.source.kind === 'url' ? <code>{spec.source.url}</code> : spec.source.kind === 'upload' ? `file ${spec.source.filename ?? ''}` : 'pasted text'} · updated{' '}
          <span title={spec.updatedAt}>{timeAgo(spec.updatedAt)}</span>
          {edited > 0 && ` · ${edited} mock${edited === 1 ? '' : 's'} edited since import`}
        </p>
        {spec.warnings.length > 0 && (
          <details>
            <summary className="small muted" style={{ cursor: 'pointer' }}>
              {spec.warnings.length} import warning{spec.warnings.length === 1 ? '' : 's'}
            </summary>
            <ul className="small spec-warnings">
              {spec.warnings.map((w, i) => (
                <li key={i}>⚠ {w}</li>
              ))}
            </ul>
          </details>
        )}
        <SpecSettings slug={slug} spec={spec} />
        <ErrorBox error={detail.error} />
        <div className="table-wrap">
          <table className="spec-ops">
            <caption>Operations ({ops.length || spec.operations})</caption>
            <thead>
              <tr>
                <th scope="col">Operation</th>
                <th scope="col">Summary</th>
                <th scope="col">Mock</th>
              </tr>
            </thead>
            <tbody>
              {ops.map((o) => (
                <tr key={o.key}>
                  <td className="spec-op-cell">
                    <span className="method">{o.method}</span> <span className="mono small">{o.path}</span>
                    {o.deprecated && (
                      <>
                        {' '}
                        <Badge kind="warn">deprecated</Badge>
                      </>
                    )}
                  </td>
                  <td className="small">
                    {o.summary || <span className="faint">—</span>}
                    {o.operationId && <div className="faint mono">{o.operationId}</div>}
                    {o.tags.length > 0 && <div className="faint">{o.tags.join(', ')}</div>}
                  </td>
                  <td className="small">
                    {o.mock ? (
                      <div className="row" style={{ gap: 4 }}>
                        <button className="btn xs ghost" onClick={() => onOpenMock(o.mock!.id)} title="Open in the mock editor">
                          {o.mock.name}
                        </button>
                        {o.mock.edited && (
                          <Badge kind="accent" title="Changed by hand since the import; re-import keeps it unless you overwrite edited mocks">
                            edited
                          </Badge>
                        )}
                        {!o.mock.enabled && <Badge kind="warn">disabled</Badge>}
                      </div>
                    ) : (
                      <span className="faint">{spec.role === 'mock' ? 'no mock (filtered out)' : '—'}</span>
                    )}
                  </td>
                </tr>
              ))}
              {ops.length === 0 && !detail.loading && (
                <tr>
                  <td colSpan={3} className="small faint">
                    The spec has no operations.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function SpecSettings({ slug, spec }: { slug: string; spec: ApiSpec }) {
  const toast = useToast();
  const gate = useGate(slug)('project.providers');
  const init = () => ({ name: spec.name, prefix: spec.prefix, role: spec.role, mode: spec.mode, ...spec.options });
  const [f, setF] = useState(init);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(f) !== JSON.stringify(init());
  const save = async () => {
    setError(null);
    const options: Partial<SpecOptions> = { unknownParams: f.unknownParams, unknownFields: f.unknownFields, checkAuth: f.checkAuth };
    try {
      await contractsApi.update(slug, spec.id, { name: f.name.trim(), prefix: f.prefix.trim(), role: f.role, mode: f.mode, options });
      toast('Spec settings saved');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <details className="spec-settings">
      <summary className="small muted" style={{ cursor: 'pointer' }}>
        Settings{dirty ? ' · unsaved' : ''}
      </summary>
      <div className="form" style={{ marginTop: 8 }}>
        <ErrorBox error={error} />
        <div className="form form-2">
          <label className="field">
            Name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </label>
          <label className="field">
            Prefix <span className="hint">Mock paths follow on the next re-import</span>
            <input className="mono" value={f.prefix} onChange={(e) => setF({ ...f, prefix: e.target.value })} />
          </label>
          <label className="field">
            Role
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as SpecRole })} title={SPEC_ROLE_HELP[f.role]}>
              <option value="mock">API mock</option>
              <option value="app">Your app's API</option>
            </select>
          </label>
          <label className="field">
            Contract checks
            <select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as SpecMode })} title={SPEC_MODE_HELP[f.mode]}>
              <option value="report">Report</option>
              <option value="strict">Strict</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="field">
            Undeclared parameters
            <select value={f.unknownParams} onChange={(e) => setF({ ...f, unknownParams: e.target.value as SpecOptions['unknownParams'] })}>
              <option value="ignore">Ignore</option>
              <option value="warn">Warn</option>
            </select>
          </label>
          <label className="field">
            Undeclared body fields
            <select value={f.unknownFields} onChange={(e) => setF({ ...f, unknownFields: e.target.value as SpecOptions['unknownFields'] })}>
              <option value="ignore">Ignore</option>
              <option value="warn">Warn</option>
            </select>
          </label>
        </div>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={f.checkAuth} onChange={(e) => setF({ ...f, checkAuth: e.target.checked })} />
          Check that requests carry the credentials the spec's security section asks for
        </label>
        <div className="row">
          <span className="spacer" />
          <button className="btn sm" onClick={() => setF(init())} disabled={!dirty}>
            Reset
          </button>
          <button className="btn sm primary" onClick={() => void save()} disabled={!dirty || gate.disabled} title={gate.title}>
            Save settings
          </button>
        </div>
      </div>
    </details>
  );
}

function DeleteSpec({ slug, spec, onClose, onDeleted }: { slug: string; spec: ApiSpec; onClose: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const [mocks, setMocks] = useState<'keep' | 'delete'>('keep');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await contractsApi.remove(slug, spec.id, mocks);
      toast(`Spec deleted${r.mocksDeleted ? ` with ${r.mocksDeleted} mock${r.mocksDeleted === 1 ? '' : 's'}` : r.mocksKept ? `; ${r.mocksKept} mock${r.mocksKept === 1 ? '' : 's'} kept` : ''}`);
      onDeleted();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Delete spec "${spec.name}"?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" onClick={() => void remove()} disabled={busy}>
            Delete spec
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={error} />
        {spec.mocks > 0 ? (
          <fieldset className="spec-reimport-opts">
            <legend className="small muted">
              Its {spec.mocks} generated mock{spec.mocks === 1 ? '' : 's'}
            </legend>
            <label className="row small" style={{ gap: 6 }}>
              <input type="radio" name="spec-delete-mocks" checked={mocks === 'keep'} onChange={() => setMocks('keep')} />
              Keep them as hand-made mocks
            </label>
            <label className="row small" style={{ gap: 6 }}>
              <input type="radio" name="spec-delete-mocks" checked={mocks === 'delete'} onChange={() => setMocks('delete')} />
              Delete them too
            </label>
          </fieldset>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            The spec has no generated mocks. Contract checks against it stop.
          </p>
        )}
      </div>
    </Modal>
  );
}
