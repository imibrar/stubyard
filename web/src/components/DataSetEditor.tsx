import { useState } from 'react';
import {
  sbApi,
  issuesOf,
  FIELD_KINDS,
  slugify,
  toDataSetInput,
  type DataEntry,
  type DataSet,
  type DataSetView,
  type FieldKind,
  type PageSnapshotBrief,
  type RenderedEntry,
  type StoryboardBrief,
} from '../storyboardsApi';
import { ApiError } from '../api';
import { Icon } from './people';
import { Badge, Empty, ErrorBox, Modal, timeAgo, useToast } from './ui';
import { Field, IssueList, IssueNotes, Tpl, TplProvider, VariablePicker, focusPath, issuesUnder, type Issues } from './StoryboardEditor';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type ValueType = 'text' | 'bool' | 'list';
const typeOf = (v: DataEntry['value']): ValueType => (typeof v === 'boolean' ? 'bool' : Array.isArray(v) ? 'list' : 'text');

/** Data sets tab: the list, the editor, and "Create from snapshot". */
export function DataSetsPanel({
  slug,
  dataSets,
  error,
  storyboards,
  snapshots,
  variables,
  reload,
}: {
  slug: string;
  dataSets: DataSetView[] | null;
  error: string | null;
  storyboards: StoryboardBrief[];
  snapshots: PageSnapshotBrief[];
  variables: { name: string; help: string }[];
  reload: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<{ initial: DataSet; existing: DataSetView | null } | null>(null);
  const [fromSnap, setFromSnap] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const remove = async (d: DataSetView) => {
    if (!confirm(`Delete data set "${d.name}"?`)) return;
    setErr(null);
    try {
      await sbApi.deleteDataSet(slug, d.slug);
      toast('Data set deleted');
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && confirm(`${e.message}\n\nDelete it anyway? Those storyboards will show a missing data set.`)) {
        await sbApi.deleteDataSet(slug, d.slug, true).then(reload, (x) => setErr(errText(x)));
        return;
      }
      setErr(errText(e));
    }
  };

  if (editing)
    return (
      <DataSetEditor
        key={`${editing.existing?.id ?? 'new'}:${editing.existing?.updatedAt ?? ''}`}
        slug={slug}
        initial={editing.initial}
        existing={editing.existing}
        storyboards={storyboards}
        variables={variables}
        onClose={() => setEditing(null)}
        onSaved={(v) => (setEditing({ initial: toDataSetInput(v), existing: v }), reload())}
      />
    );

  return (
    <div className="card">
      <div className="card-head sb-head">
        <h3>
          Data sets {dataSets && <span className="faint small">({dataSets.length})</span>}
        </h3>
        <div className="row">
          <button className="btn sm" onClick={() => setFromSnap(true)} disabled={!snapshots.length} title={snapshots.length ? 'Build a data set from a scanned page' : 'Scan a page with the extension first'}>
            From snapshot…
          </button>
          <button className="btn sm primary" onClick={() => setEditing({ initial: { slug: '', name: '', description: '', match: {}, entries: [] }, existing: null })}>
            <Icon name="plus" size={13} /> New data set
          </button>
        </div>
      </div>
      <ErrorBox error={err ?? error} />
      {!dataSets && !error && <p className="muted card-pad">Loading…</p>}
      {dataSets && !dataSets.length && (
        <Empty title="No data sets yet">
          <p className="small">A data set is the values to fill into one form: field key (id, name, label…), kind and value. Values can use template variables such as {'{{fake.email}}'}.</p>
        </Empty>
      )}
      {dataSets && dataSets.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Data set</th>
                <th className="col-sm">URL pattern</th>
                <th>Entries</th>
                <th className="col-md">Used by</th>
                <th className="col-sm">Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {dataSets.map((d) => (
                <tr key={d.id} className="clickable" onClick={() => setEditing({ initial: toDataSetInput(d), existing: d })}>
                  <td className="cell-fill">
                    <div className="ellipsis">
                      <strong>{d.name}</strong>
                    </div>
                    <code className="faint small">{d.slug}</code>
                  </td>
                  <td className="col-sm">
                    <code>{d.match?.urlPattern || '*'}</code>
                    {d.match?.formId && <span className="faint small"> #{d.match.formId}</span>}
                  </td>
                  <td>{d.entries.length}</td>
                  <td className="col-md small">{d.usedBy.length ? d.usedBy.join(', ') : <span className="faint">unused</span>}</td>
                  <td className="col-sm faint small">{timeAgo(d.updatedAt)}</td>
                  <td className="sb-actions-cell" onClick={(e) => e.stopPropagation()}>
                    <button className="btn xs ghost danger" onClick={() => void remove(d)} aria-label={`Delete ${d.name}`}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {fromSnap && (
        <FromSnapshotModal
          slug={slug}
          snapshots={snapshots}
          onClose={() => setFromSnap(false)}
          onCreated={(v) => (setFromSnap(false), reload(), setEditing({ initial: toDataSetInput(v), existing: v }))}
        />
      )}
    </div>
  );
}

/** POST /data-sets/from-snapshot: pick a snapshot (or get one passed in), a slug and a name. */
export function FromSnapshotModal({
  slug,
  snapshots,
  snapshot,
  onClose,
  onCreated,
}: {
  slug: string;
  snapshots?: PageSnapshotBrief[];
  snapshot?: PageSnapshotBrief;
  onClose: () => void;
  onCreated: (v: DataSetView) => void;
}) {
  const toast = useToast();
  const first = snapshot ?? snapshots?.[0];
  const [snap, setSnap] = useState(first?.id ?? '');
  const chosen = snapshot ?? snapshots?.find((s) => s.id === snap);
  const [name, setName] = useState(first?.title || '');
  const [dsSlug, setDsSlug] = useState(slugify(first?.title || 'form'));
  const [include, setInclude] = useState<'visible' | 'all'>('visible');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setError(null);
    setBusy(true);
    try {
      const v = await sbApi.fromSnapshot(slug, { snapshot: chosen!.id, slug: dsSlug, name: name || dsSlug, include });
      toast(`Data set "${v.name}" created with ${v.entries.length} entries`);
      onCreated(v);
    } catch (e) {
      const iss = issuesOf(e);
      setError(iss ? `${errText(e)}: ${iss.errors.map((i) => `${i.path} ${i.message}`).join('; ')}` : errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Create a data set from a snapshot"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void create()} disabled={busy || !chosen || !dsSlug}>
            Create
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={error} />
        {!snapshot && snapshots && (
          <label className="field">
            Page snapshot
            <select
              value={snap}
              onChange={(e) => {
                setSnap(e.target.value);
                const s = snapshots.find((x) => x.id === e.target.value);
                if (s?.title) (setName(s.title), setDsSlug(slugify(s.title)));
              }}
            >
              {snapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title || s.url} · {s.fields} fields · {timeAgo(s.createdAt)}
                </option>
              ))}
            </select>
          </label>
        )}
        {chosen && (
          <p className="small muted" style={{ margin: 0, overflowWrap: 'anywhere' }}>
            {chosen.url} · {chosen.fields} fields{chosen.formId ? ` · form #${chosen.formId}` : ''}
          </p>
        )}
        <div className="form form-2">
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Registration form" />
          </label>
          <label className="field">
            Slug
            <input className="mono" value={dsSlug} onChange={(e) => setDsSlug(e.target.value.toLowerCase())} />
          </label>
        </div>
        <label className="field">
          Fields
          <select value={include} onChange={(e) => setInclude(e.target.value as 'visible' | 'all')}>
            <option value="visible">Visible fields only</option>
            <option value="all">All fields (hidden ones too)</option>
          </select>
        </label>
        <p className="small faint" style={{ margin: 0 }}>
          Values start as the page's current values; edit them afterwards (for example to {'{{fake.email}}'}).
        </p>
      </div>
    </Modal>
  );
}

function DataSetEditor({
  slug,
  initial,
  existing,
  storyboards,
  variables,
  onClose,
  onSaved,
}: {
  slug: string;
  initial: DataSet;
  existing: DataSetView | null;
  storyboards: StoryboardBrief[];
  variables: { name: string; help: string }[];
  onClose: () => void;
  onSaved: (v: DataSetView) => void;
}) {
  const toast = useToast();
  const [d, setD] = useState<DataSet>(initial);
  const [saved] = useState(() => JSON.stringify(initial));
  const [issues, setIssues] = useState<Issues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ entries: RenderedEntry[]; warnings: string[] } | null>(null);
  const [pvStoryboard, setPvStoryboard] = useState(existing?.usedBy[0] ?? '');
  const [pvActor, setPvActor] = useState('');
  const isNew = !existing;
  const dirty = JSON.stringify(d) !== saved;
  const pvActors = storyboards.find((s) => s.slug === pvStoryboard)?.actors ?? [];

  const setEntry = (i: number, patch: Partial<DataEntry>) =>
    setD((x) => ({
      ...x,
      entries: x.entries.map((e, j) => {
        if (j !== i) return e;
        const n = { ...e, ...patch } as Record<string, unknown>;
        for (const k of ['selector', 'label', 'note']) if (n[k] === '') delete n[k];
        return n as unknown as DataEntry;
      }),
    }));
  const setMatch = (k: 'urlPattern' | 'formId', v: string) =>
    setD((x) => {
      const m = { ...(x.match ?? {}) };
      if (v) m[k] = v;
      else delete m[k];
      return { ...x, match: m };
    });
  const moveEntry = (i: number, to: number) =>
    setD((x) => {
      if (to < 0 || to >= x.entries.length) return x;
      const entries = [...x.entries];
      const [e] = entries.splice(i, 1);
      entries.splice(to, 0, e);
      return { ...x, entries };
    });

  const save = async () => {
    setError(null);
    const key = isNew ? d.slug : existing!.slug;
    if (!key) return setError('Give the data set a slug first.');
    setBusy(true);
    try {
      const v = await sbApi.putDataSet(slug, key, { ...d, slug: key });
      setIssues(null);
      toast(`Saved "${v.name}"`);
      onSaved(v);
    } catch (e) {
      const iss = issuesOf(e);
      setIssues(iss);
      setError(errText(e));
      if (iss?.errors[0]) focusPath(iss.errors[0].path);
    } finally {
      setBusy(false);
    }
  };
  const runPreview = async () => {
    setError(null);
    try {
      setPreview(await sbApi.previewDataSet(slug, existing!.slug, { storyboard: pvStoryboard || undefined, actor: pvActor || undefined }));
    } catch (e) {
      setError(errText(e));
    }
  };
  const close = () => {
    if (dirty && !confirm('Discard the unsaved changes?')) return;
    onClose();
  };

  return (
    <TplProvider>
      <div className="sb-editor-wrap">
        <div className="card sb-editor-bar">
          <button className="btn sm ghost" onClick={close}>
            ← Data sets
          </button>
          <div className="grow sb-editor-title">
            <strong className="ellipsis">{d.name || (isNew ? 'New data set' : existing!.name)}</strong>
            {dirty && <Badge kind="warn">unsaved</Badge>}
            {issues && issues.errors.length > 0 && <Badge kind="bad">{issues.errors.length} errors</Badge>}
          </div>
          <div className="row sb-editor-actions">
            <VariablePicker variables={variables} />
            <button className="btn sm primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
        <ErrorBox error={error} />
        {issues && (issues.errors.length > 0 || issues.warnings.length > 0) && (
          <div className="card card-pad">
            <IssueList issues={issues} onPick={focusPath} />
          </div>
        )}
        <div className="card card-pad stack">
          <div className="sb-grid">
            <Field label="Name" path="name" issues={issues}>
              <input value={d.name} data-path="name" onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Registration form" />
            </Field>
            <Field label="Slug" hint={isNew ? 'lowercase, digits, dashes' : 'cannot be changed'} path="slug" issues={issues}>
              <input className="mono" value={d.slug} data-path="slug" disabled={!isNew} onChange={(e) => setD({ ...d, slug: e.target.value.toLowerCase() })} />
            </Field>
            <Field label="URL pattern" hint="glob: /register/*, /admin/**" path="match.urlPattern" issues={issues}>
              <input className="mono" value={d.match?.urlPattern ?? ''} data-path="match.urlPattern" onChange={(e) => setMatch('urlPattern', e.target.value)} placeholder="/register/*" />
            </Field>
            <Field label="Form id" hint="optional" path="match.formId" issues={issues}>
              <input className="mono" value={d.match?.formId ?? ''} data-path="match.formId" onChange={(e) => setMatch('formId', e.target.value)} />
            </Field>
          </div>
          <Field label="Description" path="description" issues={issues}>
            <input value={d.description ?? ''} data-path="description" onChange={(e) => setD({ ...d, description: e.target.value })} />
          </Field>
          {existing && existing.usedBy.length > 0 && <p className="small faint" style={{ margin: 0 }}>Used by: {existing.usedBy.join(', ')}</p>}
        </div>

        <div className="card">
          <div className="card-head">
            <h3>
              Entries <span className="faint small">({d.entries.length})</span>
            </h3>
            <button className="btn sm" onClick={() => (setD({ ...d, entries: [...d.entries, { key: '', kind: 'auto', value: '' }] }), focusPath(`entries[${d.entries.length}].key`))}>
              <Icon name="plus" size={13} /> Add entry
            </button>
          </div>
          <IssueNotes issues={issues} path="entries" />
          {!d.entries.length && <p className="muted small card-pad" style={{ margin: 0 }}>No entries. Each entry is one form field: its key (id, name, data-testid, label or placeholder), kind and value.</p>}
          {d.entries.length > 0 && (
            <div className="sb-entries">
              <div className="sb-entry sb-entry-head" aria-hidden>
                <span>Key</span>
                <span>Kind</span>
                <span>Value</span>
                <span>Selector</span>
                <span>Label</span>
                <span />
              </div>
              {d.entries.map((e, i) => {
                const t = typeOf(e.value);
                const p = (f: string) => `entries[${i}].${f}`;
                const bad = issuesUnder(issues, `entries[${i}]`);
                return (
                  <div key={i} className={`sb-entry ${bad.errors ? 'has-error' : ''}`}>
                    <Field label={<span className="sb-entry-label">Key</span>} path={p('key')} issues={issues}>
                      <input className="mono" value={e.key} data-path={p('key')} onChange={(x) => setEntry(i, { key: x.target.value })} placeholder="email" aria-label="Key" />
                    </Field>
                    <Field label={<span className="sb-entry-label">Kind</span>} path={p('kind')} issues={issues}>
                      <select value={e.kind ?? 'auto'} data-path={p('kind')} onChange={(x) => setEntry(i, { kind: x.target.value as FieldKind })} aria-label="Kind">
                        {FIELD_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={<span className="sb-entry-label">Value</span>} path={p('value')} issues={issues}>
                      <div className="sb-value">
                        <select
                          className="sb-value-type"
                          value={t}
                          aria-label="Value type"
                          onChange={(x) => {
                            const nt = x.target.value as ValueType;
                            const cur = Array.isArray(e.value) ? e.value.join('\n') : String(e.value);
                            setEntry(i, { value: nt === 'bool' ? cur === 'true' || cur === '' : nt === 'list' ? cur.split('\n').filter(Boolean) : Array.isArray(e.value) ? e.value.join(', ') : String(e.value) });
                          }}
                        >
                          <option value="text">text</option>
                          <option value="bool">yes/no</option>
                          <option value="list">list</option>
                        </select>
                        {t === 'bool' ? (
                          <select value={String(e.value)} data-path={p('value')} onChange={(x) => setEntry(i, { value: x.target.value === 'true' })} aria-label="Value">
                            <option value="true">checked / yes</option>
                            <option value="false">unchecked / no</option>
                          </select>
                        ) : t === 'list' ? (
                          <textarea
                            rows={2}
                            className="mono"
                            data-path={p('value')}
                            value={(e.value as string[]).join('\n')}
                            onChange={(x) => setEntry(i, { value: x.target.value.split('\n') })}
                            placeholder="one value per line"
                            aria-label="Values"
                          />
                        ) : (
                          <Tpl value={e.value as string} path={p('value')} onChange={(v) => setEntry(i, { value: v })} placeholder="{{fake.firstName}}" ariaLabel="Value" />
                        )}
                      </div>
                    </Field>
                    <Field label={<span className="sb-entry-label">Selector</span>} path={p('selector')} issues={issues}>
                      <input className="mono" value={e.selector ?? ''} data-path={p('selector')} onChange={(x) => setEntry(i, { selector: x.target.value })} placeholder="optional CSS" aria-label="Selector" />
                    </Field>
                    <Field label={<span className="sb-entry-label">Label</span>} path={p('label')} issues={issues}>
                      <input value={e.label ?? ''} data-path={p('label')} onChange={(x) => setEntry(i, { label: x.target.value })} aria-label="Label" />
                    </Field>
                    <div className="sb-entry-actions">
                      <button className="icon-btn" disabled={i === 0} onClick={() => moveEntry(i, i - 1)} aria-label={`Move ${e.key || 'entry'} up`}>
                        ↑
                      </button>
                      <button className="icon-btn" disabled={i === d.entries.length - 1} onClick={() => moveEntry(i, i + 1)} aria-label={`Move ${e.key || 'entry'} down`}>
                        ↓
                      </button>
                      <button className="btn xs ghost" onClick={() => setD({ ...d, entries: d.entries.filter((_, j) => j !== i) })} aria-label={`Remove ${e.key || 'entry'}`}>
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {existing && (
          <div className="card">
            <div className="card-head">
              <h3>Preview</h3>
              <span className="faint small">{dirty ? 'Save first: the preview uses the stored data set' : 'Values rendered for one actor'}</span>
            </div>
            <div className="card-pad stack">
              <div className="row sb-preview-row">
                <label className="field grow">
                  Storyboard
                  <select value={pvStoryboard} onChange={(e) => (setPvStoryboard(e.target.value), setPvActor(''))}>
                    <option value="">(none: preview users)</option>
                    {storyboards.map((s) => (
                      <option key={s.slug} value={s.slug}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field grow">
                  Actor
                  <select value={pvActor} onChange={(e) => setPvActor(e.target.value)} disabled={!pvActors.length}>
                    <option value="">(first actor)</option>
                    {pvActors.map((a) => (
                      <option key={a.key} value={a.key}>
                        {a.key} ({a.role}
                        {a.fresh ? ', fresh' : ''})
                      </option>
                    ))}
                  </select>
                </label>
                <button className="btn sm" onClick={() => void runPreview()}>
                  Preview
                </button>
              </div>
              {preview && (
                <>
                  {preview.warnings.map((w) => (
                    <p key={w} className="small sb-warn" style={{ margin: 0 }}>
                      ⚠ {w}
                    </p>
                  ))}
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Key</th>
                          <th>Kind</th>
                          <th>Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.entries.map((e, i) => (
                          <tr key={i}>
                            <td>
                              <code>{e.key}</code>
                            </td>
                            <td className="faint">{e.kind}</td>
                            <td className="cell-fill">
                              <code>{Array.isArray(e.value) ? e.value.join(', ') : String(e.value)}</code>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </TplProvider>
  );
}
