// Page data (§6.10.6, works without a walkthrough): scan the page and compare it with the matching data sets;
// fill from a data set, save the page as a data set, send it to stubyard as a snapshot, copy the scan as JSON.
import { useEffect, useRef, useState } from 'react';
import { listDataSets, savePageSnapshot, upsertDataSet } from '@stubyard/client/storyboards';
import type { DataSetView } from '@stubyard/client/storyboard-types';
import type { FillReport, ScanResult } from '../../shared/protocol';
import { derivePattern } from '../../shared/urlPattern';
import { ErrorBox, useAction, usePanel } from '../context';
import { previewDataSet } from '../hub';
import { comparePage, entriesFromScan, fillSummary, slugify } from '../state';
import { sendToTab } from '../tabs';

const show = (v: unknown) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v));

export function PageDataScreen() {
  const p = usePanel();
  const act = useAction();
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [sets, setSets] = useState<DataSetView[]>([]);
  const [chosen, setChosen] = useState<string>('');
  const [report, setReport] = useState<FillReport | null>(null);
  const [saveForm, setSaveForm] = useState<{ slug: string; name: string } | null>(null);
  const project = p.project;
  const tab = p.tab;

  const doScan = () =>
    act.run('scan', async () => {
      if (!tab || !project) return;
      const [s, ds] = await Promise.all([sendToTab(tab.id, { type: 'scan' }), listDataSets(p.target(project), { url: tab.url })]);
      setScan(s);
      setSets(ds);
      setChosen((c) => (ds.some((d) => d.slug === c) ? c : (ds[0]?.slug ?? '')));
      setReport(null);
    });

  // Rescan when the page or the data sets change.
  useEffect(() => {
    if (tab?.status === 'complete' || tab?.status === undefined) void doScan();
  }, [tab?.id, tab?.url, project, p.ticks.storyboards]);

  const dataSet = sets.find((d) => d.slug === chosen) ?? null;

  const fill = () =>
    act.run('fill', async () => {
      if (!tab || !project || !dataSet) return;
      const walkthrough = p.active?.project === project ? p.active.id : undefined;
      const { entries } = await previewDataSet(p.target(project), dataSet.slug, { walkthrough });
      setReport(await sendToTab(tab.id, { type: 'fill', entries, formId: dataSet.match.formId ?? null, overwrite: true }));
    });

  const first = useRef(p.fillRequest);
  useEffect(() => {
    if (p.fillRequest !== first.current) void fill();
  }, [p.fillRequest]);

  if (!tab || !p.origin) return <p className="muted">Open your app in this tab first.</p>;
  if (!project) return <p className="muted">Choose the project for {p.origin} on Home first.</p>;

  const { rows, missing } = scan ? comparePage(scan.fields, dataSet) : { rows: [], missing: [] };
  const formId = scan?.forms.find((f) => f.formId)?.formId ?? null;

  const save = () =>
    act.run('save', async () => {
      if (!scan || !saveForm) return;
      const ds = await upsertDataSet(p.target(project), {
        slug: saveForm.slug,
        name: saveForm.name,
        match: { urlPattern: derivePattern(scan.url), ...(formId ? { formId } : {}) },
        entries: entriesFromScan(scan.fields),
      });
      p.notify(`Saved data set ${ds.slug} (${ds.entries.length} values).`);
      setSaveForm(null);
      setSets((s) => [ds, ...s.filter((x) => x.slug !== ds.slug)]);
      setChosen(ds.slug);
    });

  const snapshot = () =>
    act.run('snapshot', async () => {
      const full = await sendToTab(tab.id, { type: 'scan', includeHidden: true });
      const s = await savePageSnapshot(p.target(project), {
        url: full.url,
        urlPattern: derivePattern(full.url),
        title: full.title,
        formId,
        fields: full.fields,
        source: 'extension',
      });
      p.notify(`Snapshot ${s.id} sent to stubyard (${full.fields.length} fields).`);
    });

  return (
    <div className="stack">
      <section className="card">
        <div className="row wrap">
          <button className="primary" disabled={!!act.busy} onClick={() => void doScan()}>
            {act.busy === 'scan' ? 'Scanning…' : 'Scan'}
          </button>
          <select value={chosen} onChange={(e) => setChosen(e.target.value)}>
            <option value="">(no data set)</option>
            {sets.map((d) => (
              <option key={d.slug} value={d.slug}>
                {d.name}
              </option>
            ))}
          </select>
          <button disabled={!dataSet || !!act.busy} onClick={() => void fill()}>
            Fill from {dataSet?.name ?? 'data set'}
          </button>
        </div>
        {report && <p className="status">{fillSummary(report)}</p>}
        <div className="row wrap">
          <button disabled={!scan || !!act.busy} onClick={() => setSaveForm({ slug: slugify(scan?.title || derivePattern(scan?.url ?? '')) || 'page', name: scan?.title || 'Page' })}>
            Save page as data set
          </button>
          <button disabled={!!act.busy} onClick={() => void snapshot()}>Send to stubyard</button>
          <button disabled={!scan} onClick={() => void navigator.clipboard.writeText(JSON.stringify(scan, null, 2)).then(() => p.notify('Copied'))}>
            Copy JSON
          </button>
        </div>
        {saveForm && (
          <div className="stack">
            <label className="field">
              <span>Slug</span>
              <input value={saveForm.slug} onChange={(e) => setSaveForm({ ...saveForm, slug: e.target.value })} />
            </label>
            <label className="field">
              <span>Name</span>
              <input value={saveForm.name} onChange={(e) => setSaveForm({ ...saveForm, name: e.target.value })} />
            </label>
            <p className="muted small">
              URL pattern <code>{scan ? derivePattern(scan.url) : ''}</code>; values are what the page shows now. An existing data set with this slug is replaced.
            </p>
            <div className="row">
              <button className="primary" disabled={!saveForm.slug || !saveForm.name || !!act.busy} onClick={() => void save()}>Save</button>
              <button onClick={() => setSaveForm(null)}>Cancel</button>
            </div>
          </div>
        )}
        <ErrorBox error={act.error} />
      </section>

      {scan && (
        <section className="card">
          <div className="muted small">
            {scan.fields.length} fields on {scan.title || scan.url}
          </div>
          {scan.duplicates.length > 0 && <div className="error">Duplicate keys: {scan.duplicates.join(', ')}. Ids/names must be unique per form.</div>}
          <table className="fields">
            <thead>
              <tr>
                <th>Key</th>
                <th>Kind</th>
                <th>Value</th>
                {dataSet && <th>Set</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ field: f, entryKey }) => (
                <tr key={`${f.formId ?? ''}:${f.key}`} className={f.duplicateKey ? 'dup' : ''}>
                  <td>
                    <code>{f.key}</code>
                    {f.label && f.label !== f.key && <div className="muted small">{f.label}</div>}
                  </td>
                  <td className="small">{f.kind}</td>
                  <td className="small">{show(f.value)}</td>
                  {dataSet && <td className={entryKey ? 'ok' : 'muted'}>{entryKey ? '✓' : '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {dataSet && missing.length > 0 && <p className="muted small">Not on this page: {missing.join(', ')}</p>}
        </section>
      )}
    </div>
  );
}
