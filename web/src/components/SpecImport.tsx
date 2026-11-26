import { useRef, useState } from 'react';
import { contractsApi, type ApiSpec, type RemoveMissing, type SpecImportResult, type SpecMode, type SpecRole, type SpecSourceInput } from '../contractsApi';
import { Tabs } from './layout';
import { Badge, ErrorBox, Modal, useToast } from './ui';

type SourceTab = 'paste' | 'file' | 'url';

export const SPEC_MODE_HELP: Record<SpecMode, string> = {
  off: 'Off: requests are not checked',
  report: 'Report: issues are logged, requests are answered normally',
  strict: 'Strict: requests with errors are rejected with 400',
};

export const SPEC_ROLE_HELP: Record<SpecRole, string> = {
  mock: 'API mock: stubyard answers the API (one mock per operation) and checks the requests your app sends',
  app: "Your app's API: checks your app's responses (webhooks, replays); no mocks are generated",
};

const REMOVE_HELP: Record<RemoveMissing, string> = {
  disable: 'Disable mocks whose operation left the spec',
  delete: 'Delete mocks whose operation left the spec',
  keep: 'Keep them as they are',
};

const csv = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Import an OpenAPI document (paste / file / URL) or re-import an existing spec (`spec` set). The first step is
 * always a dry run that lists what would change; Import (or Re-import) then writes.
 */
export function SpecImport({ slug, spec, onClose, onDone }: { slug: string; spec?: ApiSpec; onClose: () => void; onDone: (r: SpecImportResult) => void }) {
  const toast = useToast();
  const reimport = !!spec;
  const [tab, setTab] = useState<SourceTab>(reimport ? 'url' : 'paste');
  const [text, setText] = useState('');
  const [filename, setFilename] = useState<string | null>(null);
  const [url, setUrl] = useState(reimport ? (spec.source.url ?? '') : '');
  const [form, setForm] = useState({ name: '', prefix: '', role: 'mock' as SpecRole, mode: 'report' as SpecMode, tags: '' });
  const [overwriteEdited, setOverwriteEdited] = useState(false);
  const [removeMissing, setRemoveMissing] = useState<RemoveMissing>('disable');
  const [preview, setPreview] = useState<{ key: string; result: SpecImportResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const source = (): SpecSourceInput | undefined => {
    if (tab === 'url') return url.trim() ? { url: url.trim() } : undefined;
    if (!text.trim()) return undefined;
    return tab === 'file' && filename ? { spec: text, filename } : { spec: text };
  };
  // A preview is valid only for the inputs it was made with.
  const key = JSON.stringify([tab, text, url, form, overwriteEdited, removeMissing]);
  const previewOk = preview?.key === key;
  const canRun = reimport || !!source();

  const run = async (dryRun: boolean) => {
    setError(null);
    setBusy(true);
    try {
      const src = source();
      let r: SpecImportResult;
      if (spec) {
        r = await contractsApi.reimport(slug, spec.id, { dryRun, overwriteEdited, removeMissing }, src);
      } else {
        const tags = csv(form.tags);
        r = await contractsApi.importSpec(slug, src!, {
          dryRun,
          name: form.name.trim() || undefined,
          prefix: form.prefix.trim() || undefined,
          role: form.role,
          mode: form.mode,
          include: tags.length ? { tags } : undefined,
          overwriteEdited,
          removeMissing,
        });
      }
      if (dryRun) setPreview({ key, result: r });
      else {
        toast(r.unchanged ? 'Spec unchanged' : reimport ? `Re-imported "${r.spec.name}"` : `Imported "${r.spec.name}"`);
        onDone(r);
        onClose();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setText(await f.text());
    setFilename(f.name);
    setError(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const action = reimport ? 'Re-import' : 'Import';
  return (
    <Modal
      title={reimport ? `Re-import "${spec.name}"` : 'Import an OpenAPI spec'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={() => void run(true)} disabled={busy || !canRun}>
            Dry run
          </button>
          <button className="btn primary" onClick={() => void run(false)} disabled={busy || !canRun || !previewOk} title={previewOk ? undefined : 'Run a dry run first'}>
            {action}
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={error} />
        {reimport && (
          <p className="small muted" style={{ margin: 0 }}>
            Leave the source empty to fetch {spec.source.url ? <code>{spec.source.url}</code> : 'the stored URL'} again
            {spec.source.url ? '' : ' (or reuse the stored document)'}. Mocks you edited since the last import are kept unless you overwrite them.
          </p>
        )}
        <Tabs<SourceTab>
          label="Spec source"
          variant="segmented"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'paste', label: 'Paste' },
            { id: 'file', label: 'File' },
            { id: 'url', label: 'URL' },
          ]}
        />
        {tab === 'url' ? (
          <label className="field">
            URL <span className="hint">The hub fetches it (JSON or YAML, OpenAPI 3.0 / 3.1)</span>
            <input className="mono" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/openapi.yaml" />
          </label>
        ) : tab === 'file' ? (
          <div className="row">
            <input ref={fileRef} type="file" accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
            <button className="btn sm" onClick={() => fileRef.current?.click()}>
              Choose file…
            </button>
            <span className="small muted" aria-live="polite">
              {filename ? `${filename} · ${text.length.toLocaleString()} characters` : 'No file chosen'}
            </span>
          </div>
        ) : (
          <label className="field">
            OpenAPI document <span className="hint">JSON or YAML</span>
            <textarea className="mono spec-text" rows={10} value={text} onChange={(e) => (setText(e.target.value), setFilename(null))} placeholder={'openapi: 3.1.0\ninfo:\n  title: Users API\n  version: 1.0.0\npaths: {}'} spellCheck={false} />
          </label>
        )}
        {!reimport && (
          <div className="form form-2">
            <label className="field">
              Name <span className="hint">Defaults to the title; an existing name re-imports</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="users-api" />
            </label>
            <label className="field">
              Prefix <span className="hint">Below /mock/{slug}/api</span>
              <input className="mono" value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} placeholder="/users-api" />
            </label>
            <label className="field">
              Role
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as SpecRole })} title={SPEC_ROLE_HELP[form.role]}>
                <option value="mock">API mock</option>
                <option value="app">Your app's API</option>
              </select>
            </label>
            <label className="field">
              Contract checks
              <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as SpecMode })} title={SPEC_MODE_HELP[form.mode]}>
                <option value="report">Report</option>
                <option value="strict">Strict</option>
                <option value="off">Off</option>
              </select>
            </label>
            <label className="field">
              Tags <span className="hint">Only operations with these tags (comma-separated; empty = all)</span>
              <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="users, orders" />
            </label>
            <p className="small faint" style={{ margin: 0, alignSelf: 'end' }}>
              {SPEC_ROLE_HELP[form.role]}. {SPEC_MODE_HELP[form.mode]}.
            </p>
          </div>
        )}
        <fieldset className="spec-reimport-opts">
          <legend className="small muted">{reimport ? 'Re-import' : 'When the name already exists'}</legend>
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={overwriteEdited} onChange={(e) => setOverwriteEdited(e.target.checked)} />
            Overwrite mocks edited since the last import
          </label>
          <label className="row small" style={{ gap: 6 }}>
            Operations no longer in the spec
            <select value={removeMissing} onChange={(e) => setRemoveMissing(e.target.value as RemoveMissing)} style={{ width: 'auto' }} title={REMOVE_HELP[removeMissing]}>
              <option value="disable">Disable their mocks</option>
              <option value="delete">Delete their mocks</option>
              <option value="keep">Keep their mocks</option>
            </select>
          </label>
        </fieldset>
        {preview && (
          <div aria-live="polite">
            {!previewOk && <p className="small spec-stale">The inputs changed since this dry run; run it again before importing.</p>}
            <ImportPreview result={preview.result} />
          </div>
        )}
      </div>
    </Modal>
  );
}

/** What an import did (or, in a dry run, would do): created / updated / kept / removed mocks and warnings. */
export function ImportPreview({ result: r }: { result: SpecImportResult }) {
  const rows: { kind: string; badge: string; name: string; op: string; note?: string }[] = [
    ...r.created.map((m) => ({ kind: 'ok', badge: 'create', name: m.name, op: m.specOperation, note: `${m.method} ${m.path}` })),
    ...r.updated.map((m) => ({ kind: m.overwritten ? 'warn' : '', badge: m.overwritten ? 'overwrite' : 'update', name: m.name, op: m.specOperation, note: `${m.method} ${m.path}` })),
    ...r.kept.map((m) => ({ kind: 'accent', badge: 'keep', name: m.name, op: m.specOperation, note: 'edited since import' })),
    ...r.removed.map((m) => ({ kind: m.action === 'keep' ? '' : 'bad', badge: m.action, name: m.name, op: m.specOperation, note: 'no longer in the spec' })),
  ];
  return (
    <div className="stack spec-preview" style={{ gap: 8 }}>
      <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>
        <strong>
          {r.dryRun ? 'Dry run' : 'Result'}: {r.spec.title || r.spec.name}
          {r.spec.apiVersion && ` v${r.spec.apiVersion}`}
        </strong>
        <span className="muted">
          {r.spec.operations} operation{r.spec.operations === 1 ? '' : 's'} · {r.spec.role === 'mock' ? `prefix ${r.spec.prefix || '/'}` : "your app's API"}
        </span>
        {r.unchanged && <Badge>unchanged</Badge>}
        <Badge kind="ok">{r.created.length} created</Badge>
        <Badge>{r.updated.length} updated</Badge>
        <Badge kind={r.kept.length ? 'accent' : ''}>{r.kept.length} kept</Badge>
        <Badge kind={r.removed.length ? 'bad' : ''}>{r.removed.length} removed</Badge>
      </div>
      {r.warnings.length > 0 && (
        <ul className="small spec-warnings" aria-label="Warnings">
          {r.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        <div className="table-wrap spec-preview-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Change</th>
                <th scope="col">Mock</th>
                <th scope="col">Operation</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x, i) => (
                <tr key={i}>
                  <td>
                    <Badge kind={x.kind}>{x.badge}</Badge>
                  </td>
                  <td className="small">{x.name}</td>
                  <td className="mono small">{x.op}</td>
                  <td className="small muted mono">{x.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
