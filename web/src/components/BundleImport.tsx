import { useRef, useState } from 'react';
import { sbApi, issuesOf, type ImportMode, type ImportResult, type StoryboardBrief } from '../storyboardsApi';
import { Badge, ErrorBox, useCopy, useToast } from './ui';
import { IssueList, type Issues } from './StoryboardEditor';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const COLLECTIONS = [
  ['users', 'Users'],
  ['loginRecipes', 'Login recipes'],
  ['dataSets', 'Data sets'],
  ['storyboards', 'Storyboards'],
] as const;
const MODE_HELP: Record<ImportMode, string> = {
  upsert: 'Create new items and update existing ones (by slug, role or email)',
  'create-only': 'Only create new items; existing ones are skipped',
  replace: 'Delete every storyboard, data set and login recipe of the project first',
};

/** Import/Export tab: paste or upload a bundle, dry-run it, import it; download the project's bundle. */
export function BundlePanel({ slug, storyboards, onImported }: { slug: string; storyboards: StoryboardBrief[]; onImported: () => void }) {
  const toast = useToast();
  const copy = useCopy();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<ImportMode>('upsert');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [issues, setIssues] = useState<Issues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dryRunOf, setDryRunOf] = useState<string | null>(null);
  const [secrets, setSecrets] = useState(false);
  const [only, setOnly] = useState<string[]>([]);

  const parse = (): unknown => {
    const t = text.trim();
    if (!t) throw new Error('Paste a bundle or choose a file first.');
    try {
      const v = JSON.parse(t) as Record<string, unknown>;
      // Accept the {bundle, mode} request body shape too.
      return v && typeof v === 'object' && 'bundle' in v && !('format' in v) ? v.bundle : v;
    } catch (e) {
      throw new Error(`Not valid JSON: ${errText(e)}`);
    }
  };
  const run = async (dryRun: boolean) => {
    setError(null);
    setIssues(null);
    setResult(null);
    if (mode === 'replace' && !dryRun && !confirm('Replace deletes every storyboard, data set and login recipe of this project before importing. Continue?')) return;
    setBusy(true);
    try {
      const bundle = parse();
      const r = await sbApi.importBundle(slug, bundle, { mode, dryRun });
      setResult(r);
      setIssues(r.warnings.length ? { errors: [], warnings: r.warnings } : null);
      if (dryRun) setDryRunOf(text + mode);
      else {
        const n = COLLECTIONS.reduce((s, [k]) => s + r.created[k].length + r.updated[k].length, 0);
        toast(`Imported: ${n} item${n === 1 ? '' : 's'} created or updated`);
        setDryRunOf(null);
        onImported();
      }
    } catch (e) {
      const iss = issuesOf(e);
      if (iss) setIssues(iss);
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setText(await f.text());
    setResult(null);
    setIssues(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = '';
  };
  const exportBundle = async (download: boolean) => {
    setError(null);
    try {
      const b = await sbApi.exportBundle(slug, { storyboards: only.length ? only.join(',') : undefined, secrets });
      const json = JSON.stringify(b, null, 2);
      if (!download) return void copy(json, 'Bundle copied');
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug}-storyboards.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(errText(e));
    }
  };

  const dryRunOk = dryRunOf === text + mode && result?.dryRun && !error;

  return (
    <div className="sb-bundle">
      <div className="card">
        <div className="card-head">
          <h3>Import a bundle</h3>
          <span className="faint small">format "stubyard-storyboards", version 1</span>
        </div>
        <div className="card-pad stack">
          <textarea
            className="mono sb-bundle-text"
            value={text}
            onChange={(e) => (setText(e.target.value), setResult(null))}
            placeholder={'{\n  "format": "stubyard-storyboards",\n  "version": 1,\n  "loginRecipes": [],\n  "dataSets": [],\n  "storyboards": []\n}'}
            spellCheck={false}
            aria-label="Bundle JSON"
          />
          <div className="row sb-bundle-actions">
            <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
            <button className="btn sm" onClick={() => fileRef.current?.click()}>
              Choose file…
            </button>
            <label className="field sb-inline-field">
              <span className="field-label">Mode</span>
              <select value={mode} onChange={(e) => (setMode(e.target.value as ImportMode), setResult(null))} title={MODE_HELP[mode]}>
                <option value="upsert">Upsert</option>
                <option value="create-only">Create only</option>
                <option value="replace">Replace</option>
              </select>
            </label>
            <span className="spacer" />
            <button className="btn sm" onClick={() => void run(true)} disabled={busy || !text.trim()}>
              Dry run
            </button>
            <button className={`btn sm ${dryRunOk ? 'primary' : ''}`} onClick={() => void run(false)} disabled={busy || !text.trim()} title={dryRunOk ? '' : 'Tip: run a dry run first'}>
              Import
            </button>
          </div>
          <p className="small faint" style={{ margin: 0 }}>
            {MODE_HELP[mode]}. Everything is validated as a whole first; nothing is written if any item is invalid.
          </p>
          <ErrorBox error={error} />
          {issues && <IssueList issues={issues} />}
          {result && <ImportSummary r={result} />}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Export</h3>
        </div>
        <div className="card-pad stack">
          <p className="small muted" style={{ margin: 0 }}>
            The bundle holds the storyboards, the data sets and login recipes they use, the users their actors name, and the project's app origins and roles.
          </p>
          {storyboards.length > 0 && (
            <fieldset className="sb-fieldset">
              <legend>Storyboards {only.length ? `(${only.length})` : '(all)'}</legend>
              <div className="sb-checks">
                {storyboards.map((s) => (
                  <label key={s.slug} className="sb-check">
                    <input type="checkbox" checked={only.includes(s.slug)} onChange={(e) => setOnly(e.target.checked ? [...only, s.slug] : only.filter((x) => x !== s.slug))} />
                    <span className="ellipsis">{s.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <label className="sb-check">
            <input type="checkbox" checked={secrets} onChange={(e) => setSecrets(e.target.checked)} /> Include secrets (passwords and literal secret values; otherwise "***")
          </label>
          <div className="row">
            <button className="btn sm primary" onClick={() => void exportBundle(true)}>
              Download JSON
            </button>
            <button className="btn sm" onClick={() => void exportBundle(false)}>
              Copy
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ImportSummary({ r }: { r: ImportResult }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row">
        <Badge kind={r.dryRun ? 'accent' : 'ok'}>{r.dryRun ? 'Dry run: nothing was written' : 'Imported'}</Badge>
      </div>
      <div className="table-wrap">
        <table className="sb-import-table">
          <thead>
            <tr>
              <th />
              <th>Created</th>
              <th>Updated</th>
              <th>Unchanged</th>
            </tr>
          </thead>
          <tbody>
            {COLLECTIONS.map(([k, label]) => (
              <tr key={k}>
                <td>
                  <strong>{label}</strong>
                </td>
                {(['created', 'updated', 'unchanged'] as const).map((c) => (
                  <td key={c}>
                    {r[c][k].length ? (
                      <>
                        <span className={`sb-n ${c}`}>{r[c][k].length}</span> <span className="small muted sb-wrap">{r[c][k].join(', ')}</span>
                      </>
                    ) : (
                      <span className="faint">0</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.skipped.length > 0 && (
        <div>
          <h4 className="section-title">Skipped</h4>
          <ul className="sb-plain-list small">
            {r.skipped.map((s, i) => (
              <li key={i}>
                <code>{s.path}</code> {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
